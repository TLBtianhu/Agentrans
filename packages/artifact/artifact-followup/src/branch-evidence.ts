/** Resolve the experiment source and original facts stored in one exact branch-return notice. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { createParticleCheckpoint, observeParticleState, ParticleRuntimeError, particleSpecAtGravity, restoreParticleCheckpoint } from '@agentrans/artifact/particle-runtime'
import {
  ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES, isArtifactHtmlCheckpoint, isBoundedArtifactJson,
  isNumericParameters, recordedComparison, type ArtifactHtmlCheckpoint, type ArtifactHtmlCheckpointKind,
} from '@agentrans/artifact/runtime-values'
import { analyzeFunctionPlotSelection } from '@agentrans/artifact/scene-renderers'
import { normalizeSceneSpec } from '@agentrans/artifact/scene'
import type { ArtifactId, HtmlArtifactSnapshot, SceneArtifactSnapshot } from '@agentrans/artifact/types'
import { brandString } from '@agentrans/brand'
import type { MessageId } from '@agentrans/llm'
import type { SessionEvent, SessionId } from '@agentrans/session/types'
import type { ProjectionDefinition } from '@agentrans/session-projection'
import type { ArtifactPromptContextFacts, ArtifactQuestionBranchResult, NativeArtifactQuestionReadings } from './types.ts'

const RETURNED_READINGS_PREFIX = 'The user selected the following Artifact readings from a branch question to accompany this conclusion. '
  + 'This does not state that the assistant used them when producing the conclusion.\n'
const ARTIFACT_ID = /^[a-z][a-z0-9-]{0,63}$/

/** Durable prefix for the program-reported checkpoint sent from returned BFS evidence. */
export const BRANCH_BFS_QUESTION_PREFIX = 'The user selected the following program-reported BFS checkpoint for this question. '
  + 'Use facts.state for the selected current node, queue and visited nodes. '
  + 'The HTML source and revision come from the verified returned branch notice.\n'

/** Durable prefix for the program-reported checkpoint sent from returned half-adder evidence. */
export const BRANCH_HALF_ADDER_QUESTION_PREFIX = 'The user selected the following program-reported half-adder checkpoint for this question. '
  + 'Use facts.state for the selected input bits a and b and output bits sum and carry. '
  + 'The HTML source and revision come from the verified returned branch notice.\n'

const noticeSchema = z.object({
  messageId: z.string().min(1).transform(value => brandString<MessageId>(value)),
  branchSessionId: z.string().min(1).transform(value => brandString<SessionId>(value)),
  resultSeq: z.number().int().nonnegative(),
  text: z.string().startsWith(RETURNED_READINGS_PREFIX),
  artifactEvidence: z.enum(['bfs-checkpoint', 'half-adder-checkpoint']).optional(),
}).strict()
const stateSchema = z.record(z.string().regex(/^(0|[1-9][0-9]*)$/), noticeSchema)
type Notice = z.infer<typeof noticeSchema>
type State = z.infer<typeof stateSchema>

/**
 * Extract the returned-reading text from an append-origin branch-result message.
 * @param event - Exact durable source event.
 * @returns Its immutable notice identity and text, or undefined for other events.
 */
export function returnedReadingNotice(event: SessionEvent): Notice | undefined {
  if (event.type !== 'user/message' || event.surfaceOp !== 'append') return undefined
  const { source, content, id } = event.data
  if (source.kind !== 'branch-result' || content.length < 2) return undefined
  const last = content.at(-1)
  if (last?.type !== 'text' || !last.text.startsWith(RETURNED_READINGS_PREFIX)) return undefined
  const conclusion = content.slice(0, -1)
  if (!conclusion.every(block => block.type === 'text') || !conclusion.some(block => block.text.trim() !== '')) return undefined
  const { artifactEvidence } = source
  return { messageId: id, branchSessionId: source.branchSessionId, resultSeq: source.resultSeq, text: last.text,
    ...(artifactEvidence === undefined ? {} : { artifactEvidence }) }
}

/** Host-only index of immutable question evidence notices, including the visible inherited prefix. */
export const branchEvidenceProjection = {
  key: 'artifactFollowup/branchEvidence',
  stateVersion: 2,
  stateSchema,
  init: (): State => ({}),
  apply: (state, event) => {
    const notice = returnedReadingNotice(event)
    return notice === undefined ? state : { ...state, [event.seq]: notice }
  },
} satisfies ProjectionDefinition<'artifactFollowup/branchEvidence', State>

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const htmlSourceSchema = z.object({
  artifactId: z.string().regex(ARTIFACT_ID).transform(value => brandString<ArtifactId>(value)),
  revision: z.number().int().positive(),
  title: z.string().min(1).max(120).refine(value => value.trim() === value),
  format: z.literal('html'),
  presentation: z.enum(['inline', 'focus']),
  source: z.string().refine(value => value.trim() !== ''),
  comparison: z.object({ group: z.string().regex(ARTIFACT_ID), role: z.enum(['control', 'variant']) }).strict().optional(),
}).strict().transform(({ comparison, ...artifact }): HtmlArtifactSnapshot =>
  comparison === undefined ? artifact : { ...artifact, comparison })

function canonicalNativeSource(value: unknown): SceneArtifactSnapshot | undefined {
  if (!record(value) || value.format !== 'scene') return undefined
  const { artifactId, revision, title, presentation, comparison, spec } = value
  if (typeof artifactId !== 'string' || !ARTIFACT_ID.test(artifactId)
    || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1
    || typeof title !== 'string' || title.trim() !== title || title.length < 1 || title.length > 120
    || (presentation !== 'inline' && presentation !== 'focus') || !record(spec)
    || (spec.kind !== 'function-plot' && spec.kind !== 'particle-system' && spec.kind !== 'csv-bar-chart')
    || (record(spec.parameters) && Object.hasOwn(spec.parameters, '__proto__'))) return undefined
  const relation = recordedComparison(comparison)
  if (relation === false) return undefined
  try {
    return { artifactId: brandString<ArtifactId>(artifactId), revision, title, presentation, format: 'scene',
      spec: normalizeSceneSpec(spec), ...(relation === undefined ? {} : { comparison: relation }) }
  } catch (_error) { return undefined }
}

function agreesWithRecorded(recorded: unknown, computed: object): boolean {
  // Both admitted records are JSON text, where signed zero is stored as zero.
  const normalized: unknown = JSON.parse(JSON.stringify(computed))
  return isDeepStrictEqual(recorded, normalized)
}

function readingsFrom(value: unknown): NativeArtifactQuestionReadings | undefined {
  if (!record(value) || !record(value.artifact)) return undefined
  const source = value.artifact
  const artifact = canonicalNativeSource(source)
  if (artifact === undefined) return undefined
  if (artifact.spec.kind === 'csv-bar-chart' && value.kind === 'current-csv-bar-chart') {
    const { kind, groupKey } = value
    const values = artifact.spec.groups.find(group => group.key === groupKey)
    return typeof groupKey === 'string' && values !== undefined && agreesWithRecorded(value.values, values)
      ? { kind, artifact, groupKey, values } : undefined
  }
  if (artifact.spec.kind === 'function-plot' && value.kind === 'current-function-plot') {
    const { kind, functionId, x, parameters } = value
    if (typeof functionId !== 'string' || typeof x !== 'number' || !isNumericParameters(parameters)) return undefined
    const values = analyzeFunctionPlotSelection(artifact.spec, { functionId, x, parameters })
    return values !== undefined && agreesWithRecorded(value.values, values)
      ? { kind, artifact, functionId, x, parameters, values } : undefined
  }
  if (artifact.spec.kind !== 'particle-system' || value.kind !== 'current-particle') return undefined
  const { checkpoint, gravityY } = value
  if (gravityY !== undefined && typeof gravityY !== 'number') return undefined
  const continuation = source.particleContinuation
  const baseline = record(continuation) && record(continuation.baseline) ? continuation.baseline.checkpoint : undefined
  const spec = particleSpecAtGravity(artifact.spec, checkpoint, gravityY, baseline)
  if (spec === undefined) return undefined
  try {
    const state = restoreParticleCheckpoint(spec, checkpoint)
    const values = observeParticleState(state)
    return agreesWithRecorded(value.values, values)
      ? { kind: value.kind, artifact, checkpoint: createParticleCheckpoint(state),
        ...(gravityY === undefined ? {} : { gravityY }), values } : undefined
  } catch (error) {
    if (!(error instanceof ParticleRuntimeError)) throw error
    return undefined
  }
}

function returnedQuestion(notice: Notice, eventSeq: number) {
  let value: unknown
  try { value = JSON.parse(notice.text.slice(RETURNED_READINGS_PREFIX.length)) } catch (_error) { return undefined }
  if (!isBoundedArtifactJson(value, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES) || !record(value)
    || value.kind !== 'branch-result-artifact-evidence' || value.branchSessionId !== notice.branchSessionId
    || !record(value.evidence) || value.evidence.kind !== 'question') return undefined
  const { questionSeq, facts } = value.evidence
  if (typeof questionSeq !== 'number' || !Number.isSafeInteger(questionSeq) || questionSeq < 0 || questionSeq >= notice.resultSeq) return undefined
  const { messageId, branchSessionId, resultSeq } = notice
  return { branchResult: { eventSeq, messageId, branchSessionId, resultSeq, questionSeq }, facts }
}

/**
 * Recompute the native readings embedded in one original branch-return text.
 * @param notice - Index entry from the receiving Session's append-origin notice.
 * @param eventSeq - Position of that same notice in the receiving Session.
 * @returns Self-contained native readings with the notice identity, or absence for invalid evidence.
 */
export function resolveReturnedReadings(notice: Notice, eventSeq: number): Extract<ArtifactPromptContextFacts, { kind: 'branch-evidence' }> | undefined {
  if (notice.artifactEvidence !== undefined) return undefined
  const result = returnedQuestion(notice, eventSeq)
  if (result === undefined) return undefined
  const readings = readingsFrom(result.facts)
  return readings === undefined ? undefined : { kind: 'branch-evidence', branchResult: result.branchResult, readings }
}

/**
 * Resolve the exact HTML source from a Host-marked branch-return notice.
 * @param notice - Index entry from the receiving Session's append-origin notice.
 * @param eventSeq - Position of that same notice in the receiving Session.
 * @param checkpointKind - Checkpoint kind selected for the new question.
 * @returns The original HTML revision and its branch-result identity, or absence for invalid evidence.
 */
export function resolveReturnedHtmlSource(notice: Notice, eventSeq: number, checkpointKind: ArtifactHtmlCheckpointKind): {
  readonly artifact: HtmlArtifactSnapshot
  readonly branchResult: ArtifactQuestionBranchResult
  readonly checkpoint: ArtifactHtmlCheckpoint
} | undefined {
  if (notice.artifactEvidence !== checkpointKind) return undefined
  const result = returnedQuestion(notice, eventSeq)
  if (result === undefined) return undefined
  const { facts, branchResult } = result
  if (!record(facts) || facts.kind !== 'html-runtime' || facts.attribution !== 'program-reported'
    || typeof facts.runtimeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(facts.runtimeId)) return undefined
  const { capture } = facts
  if (!record(capture) || Object.keys(capture).length !== 3 || capture.status !== 'ready' || capture.restore !== checkpointKind
    || !isArtifactHtmlCheckpoint(capture.state) || capture.state.kind !== checkpointKind) return undefined
  const artifact = htmlSourceSchema.safeParse(facts.artifact)
  return artifact.success ? { artifact: artifact.data, branchResult, checkpoint: capture.state } : undefined
}
