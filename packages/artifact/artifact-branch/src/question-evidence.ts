/** Resolve historical question evidence against the branch log before returning a conclusion. */
import { isDeepStrictEqual } from 'node:util'
import { createParticleCheckpoint, observeParticleState, ParticleRuntimeError, particleSpecAtGravity, restoreParticleCheckpoint } from '@agentrans/artifact/particle-runtime'
import {
  ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES, CONTINUED_CSV_QUESTION_PREFIX,
  isArtifactHtmlCheckpoint, isBoundedArtifactJson, type ArtifactHtmlCheckpoint, type ArtifactHtmlCheckpointKind,
} from '@agentrans/artifact/runtime-values'
import { analyzeFunctionPlotSelection } from '@agentrans/artifact/scene-renderers'
import type { CsvBarChartSpec } from '@agentrans/artifact/scene'
import type { ArtifactCsvContinuation, ArtifactSnapshot, HtmlArtifactSnapshot, SceneArtifactSnapshot } from '@agentrans/artifact/types'
import {
  BRANCH_BFS_QUESTION_PREFIX, BRANCH_HALF_ADDER_QUESTION_PREFIX, resolveReturnedHtmlSource, returnedReadingNotice,
} from '@agentrans/artifact-followup'
import type { NativeArtifactQuestionReadings } from '@agentrans/artifact-followup/types'
import type { MessageId } from '@agentrans/llm'
import type { SessionSeq } from '@agentrans/session/types'
import type { SessionObservation } from '@agentrans/session-query'
import type { ArtifactBranchEvidenceSelection } from './types.ts'

const QUESTION_CONTEXT_START = 'The user selected the following experiment context for this question. '
const PARTICLE_PREFIX = QUESTION_CONTEXT_START
  + 'Particle values are recomputed by the Host from the recorded source and checkpoint; no causal conclusion is inferred.\n'
const ADJUSTED_PARTICLE_PREFIX = QUESTION_CONTEXT_START
  + 'This question uses the adjusted particle experiment. Use facts.gravityY for the selected vertical gravity '
  + 'and facts.values for the readings the Host recomputed at the confirmed checkpoint. The source spec records the baseline gravity.\n'
const PLOT_PREFIX = QUESTION_CONTEXT_START
  + 'Function-plot values are recomputed by the Host from the recorded source, selected function, parameters and trace position. '
  + 'Derivative and integral readings are numerical approximations.\n'
const CSV_PREFIX = QUESTION_CONTEXT_START + 'CSV readings come from the Host-computed group result stored in the selected chart revision.\n'
const BFS_PREFIX = 'The user selected the following program-reported context for this question. '
  + 'The Host checked the source identity and revision and validated the BFS checkpoint shape. '
  + 'Use facts.capture.state for the selected current node, queue and visited nodes. '
  + 'This program-reported checkpoint can be reopened with the recorded HTML revision.\n'
const HALF_ADDER_PREFIX = 'The user selected the following program-reported context for this question. '
  + 'The Host checked the source identity and revision and validated the half-adder checkpoint. '
  + 'Use facts.capture.state for the selected input bits a and b and output bits sum and carry. '
  + 'This program-reported checkpoint can be reopened with the recorded HTML revision.\n'

const QUESTION_FACT_KINDS = [
  [PARTICLE_PREFIX, 'current-particle'], [ADJUSTED_PARTICLE_PREFIX, 'current-particle'],
  [CSV_PREFIX, 'current-csv-bar-chart'],
  [CONTINUED_CSV_QUESTION_PREFIX, 'current-csv-bar-chart'],
  [PLOT_PREFIX, 'current-function-plot'], [BFS_PREFIX, 'html-runtime', 'bfs-checkpoint'],
  [HALF_ADDER_PREFIX, 'html-runtime', 'half-adder-checkpoint'],
] as const

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numericParameters(value: unknown): value is Record<string, number> {
  return record(value) && !Object.hasOwn(value, '__proto__')
    && Object.values(value).every(entry => typeof entry === 'number' && Number.isFinite(entry))
}

function matchesRecordedJson(recorded: unknown, computed: object): boolean {
  // Both the question and the return travel as JSON text, where signed zero is stored as zero.
  return isDeepStrictEqual(recorded, JSON.parse(JSON.stringify(computed)))
}

function findRecordedSource(
  child: SessionObservation, questionSeq: number, recorded: unknown,
): ArtifactSnapshot | undefined {
  if (!record(recorded) || typeof recorded.artifactId !== 'string' || typeof recorded.revision !== 'number') return undefined
  for (let seq = questionSeq - 1; seq >= 0; seq--) {
    const event = child.events[seq]
    if (event?.type !== 'artifact/upsert'
      || event.data.artifactId !== recorded.artifactId || event.data.revision !== recorded.revision) continue
    return matchesRecordedJson(recorded, event.data) ? event.data : undefined
  }
  return undefined
}

function nativeFacts(artifact: SceneArtifactSnapshot, facts: Record<string, unknown>) {
  if (artifact.spec.kind === 'csv-bar-chart' && facts.kind === 'current-csv-bar-chart') {
    const { kind, groupKey } = facts
    if (artifact.csvContinuation !== undefined && artifact.csvContinuation.groupKey !== groupKey) return undefined
    const values = artifact.spec.groups.find(group => group.key === groupKey)
    return typeof groupKey === 'string' && values !== undefined && matchesRecordedJson(facts.values, values)
      ? { kind, artifact, groupKey, values } as const : undefined
  }
  if (artifact.spec.kind === 'particle-system' && facts.kind === 'current-particle') {
    const spec = particleSpecAtGravity(artifact.spec, facts.checkpoint, facts.gravityY, artifact.particleContinuation?.baseline.checkpoint)
    if (spec === undefined) return undefined
    try {
      const state = restoreParticleCheckpoint(spec, facts.checkpoint)
      const values = observeParticleState(state)
      return matchesRecordedJson(facts.values, values)
        ? { kind: facts.kind, artifact, checkpoint: createParticleCheckpoint(state), values,
          ...(facts.gravityY === undefined ? {} : { gravityY: spec.gravity.y }) } as const : undefined
    } catch (error) {
      if (!(error instanceof ParticleRuntimeError)) throw error
      return undefined
    }
  }
  if (artifact.spec.kind !== 'function-plot' || facts.kind !== 'current-function-plot') return undefined
  const { kind, functionId, x, parameters } = facts
  if (typeof functionId !== 'string' || typeof x !== 'number' || !numericParameters(parameters)) return undefined
  const values = analyzeFunctionPlotSelection(artifact.spec, { functionId, x, parameters })
  return values !== undefined && matchesRecordedJson(facts.values, values)
    ? { kind, artifact, functionId, x, parameters, values } as const : undefined
}

function htmlFacts(artifact: HtmlArtifactSnapshot, facts: Record<string, unknown>, checkpointKind: ArtifactHtmlCheckpointKind) {
  const { kind, runtimeId, attribution, capture } = facts
  if (kind !== 'html-runtime' || attribution !== 'program-reported' || typeof runtimeId !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(runtimeId) || !record(capture) || Object.keys(capture).length !== 3
    || capture.status !== 'ready' || capture.restore !== checkpointKind || !isArtifactHtmlCheckpoint(capture.state)
    || capture.state.kind !== checkpointKind) return undefined
  return { kind, artifact, runtimeId, attribution, capture: {
    status: capture.status, restore: checkpointKind, state: capture.state,
  } } as const
}

interface ResolvedQuestionEvidence {
  readonly kind: 'question'
  readonly questionSeq: number
  readonly facts: NonNullable<ReturnType<typeof nativeFacts> | ReturnType<typeof htmlFacts>>
}

/**
 * Validate one selected attachment against the original question's child-local source.
 * @param child - Immutable branch cut also used to select the conclusion.
 * @param resultSeq - Child-owned conclusion sequence.
 * @param selection - Child-owned ordinary question and its attached text block position.
 * @returns Native readings or an attributed HTML checkpoint, or undefined for unavailable evidence.
 */
export function resolveQuestionEvidence(
  child: SessionObservation, resultSeq: SessionSeq,
  selection: Extract<ArtifactBranchEvidenceSelection, { kind: 'question' }>,
): ResolvedQuestionEvidence | undefined {
  const { questionSeq, blockIndex } = selection
  if (questionSeq >= resultSeq) return undefined
  return resolveRecordedQuestion(child, questionSeq, blockIndex)
}

function resolveRecordedQuestion(child: SessionObservation, questionSeq: number, blockIndex: number): ResolvedQuestionEvidence | undefined {
  if (!Number.isSafeInteger(questionSeq) || questionSeq < child.inheritedEventCount
    || !Number.isSafeInteger(blockIndex) || blockIndex < 1) return undefined
  const event = child.events[questionSeq]
  if (event?.seq !== questionSeq || event.type !== 'user/message' || event.data.source.kind !== 'user') return undefined
  const block = event.data.content[blockIndex]
  if (block?.type !== 'text') return undefined
  const matching = QUESTION_FACT_KINDS.find(([prefix]) => block.text.startsWith(prefix))
  if (matching === undefined) return undefined
  const [prefix, kind, checkpointKind] = matching
  // The input is durable, but ordinary user-authored text can also spell the attachment prefix.
  let context: unknown
  try { context = JSON.parse(block.text.slice(prefix.length)) } catch { return undefined }
  if (!isBoundedArtifactJson(context, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES)
    || !record(context) || context.kind !== 'artifact-question-context' || context.sessionId !== child.header.id
    || !record(context.facts) || context.facts.kind !== kind
    || checkpointKind !== undefined && event.surfaceOp !== 'append'
    || prefix === ADJUSTED_PARTICLE_PREFIX && typeof context.facts.gravityY !== 'number') return undefined
  const artifact = findRecordedSource(child, questionSeq, context.facts.artifact)
  if (artifact === undefined) return undefined
  if (prefix === CONTINUED_CSV_QUESTION_PREFIX && (artifact.format !== 'scene' || artifact.csvContinuation === undefined)) return undefined
  const facts = artifact.format === 'scene' ? nativeFacts(artifact, context.facts)
    : checkpointKind === undefined ? undefined : htmlFacts(artifact, context.facts, checkpointKind)
  return facts === undefined ? undefined : { kind: 'question' as const, questionSeq, facts }
}

function ownedSentAttachment(session: SessionObservation, questionSeq: SessionSeq, messageId: MessageId, ...prefixes: readonly string[]) {
  const question = session.events[questionSeq]
  if (session.header.origin === 'subagent' || questionSeq < session.inheritedEventCount || question?.seq !== questionSeq
    || question.type !== 'user/message' || question.surfaceOp !== 'append' || question.data.id !== messageId) return undefined
  const { source, content } = question.data
  if (source.kind !== 'user' || !('rpcId' in source) || typeof source.rpcId !== 'string'
    || source.rpcId.trim() === '' || source.principal !== undefined) return undefined
  const matching = content.flatMap((block, index) => {
    if (block.type !== 'text') return []
    const prefix = prefixes.find(value => block.text.startsWith(value))
    return prefix === undefined ? [] : [{ index, body: block.text.slice(prefix.length) }]
  })
  const [attachment] = matching
  return attachment !== undefined && attachment.index >= 1 && matching.length === 1 ? attachment : undefined
}

/**
 * Resolve a native experiment locked on an exact sent question.
 * @param session - Fixed history of the Session that owns the question.
 * @param questionSeq - Sequence of the exact sent follow-up.
 * @param messageId - ID of that follow-up.
 * @param kind - Native experiment required on the sent follow-up.
 * @returns The verified source and readings selected on the sent question.
 */
export function resolveSentNativeQuestion(
  session: SessionObservation, questionSeq: SessionSeq, messageId: MessageId, kind: 'function-plot' | 'particle-system',
): Extract<NativeArtifactQuestionReadings, { readonly kind: 'current-function-plot' | 'current-particle' }> | undefined {
  const prefixes = kind === 'particle-system' ? [PARTICLE_PREFIX, ADJUSTED_PARTICLE_PREFIX] : [PLOT_PREFIX]
  const attachment = ownedSentAttachment(session, questionSeq, messageId, ...prefixes)
  if (attachment === undefined) return undefined
  const facts = resolveRecordedQuestion(session, questionSeq, attachment.index)?.facts
  return facts?.kind === 'current-function-plot' || facts?.kind === 'current-particle' ? facts : undefined
}

/**
 * Resolve a sent program checkpoint against the prior owning return in the same Session cut.
 * @param session - Fixed history of the Session that owns the question.
 * @param questionSeq - Sequence of the exact sent follow-up.
 * @param messageId - ID of that follow-up.
 * @param checkpointKind - Kind required in both the sent attachment and its prior return.
 * @returns The source revision from the return and the program-reported state attached to the follow-up.
 */
export function resolveSentHtmlQuestion(
  session: SessionObservation, questionSeq: SessionSeq, messageId: MessageId, checkpointKind: ArtifactHtmlCheckpointKind,
): { readonly artifact: HtmlArtifactSnapshot; readonly checkpoint: ArtifactHtmlCheckpoint } | undefined {
  const prefix = checkpointKind === 'bfs-checkpoint' ? BRANCH_BFS_QUESTION_PREFIX : BRANCH_HALF_ADDER_QUESTION_PREFIX
  const attachment = ownedSentAttachment(session, questionSeq, messageId, prefix)
  if (attachment === undefined) return undefined
  let context: unknown
  try { context = JSON.parse(attachment.body) } catch { return undefined }
  if (!isBoundedArtifactJson(context, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES)
    || !record(context) || !record(context.facts) || !record(context.facts.branchResult)
    || !isArtifactHtmlCheckpoint(context.facts.state) || context.facts.state.kind !== checkpointKind) return undefined
  const { state: checkpoint, branchResult } = context.facts
  const { eventSeq } = branchResult
  if (typeof eventSeq !== 'number' || !Number.isSafeInteger(eventSeq)
    || eventSeq < session.inheritedEventCount || eventSeq >= questionSeq) return undefined
  const origin = session.events[eventSeq]
  if (origin?.seq !== eventSeq) return undefined
  const notice = returnedReadingNotice(origin)
  const returned = notice === undefined ? undefined : resolveReturnedHtmlSource(notice, eventSeq, checkpointKind)
  if (returned === undefined || !matchesRecordedJson(context, {
    kind: 'artifact-question-context', sessionId: session.header.id,
    facts: { kind: `branch-${checkpointKind}`, branchResult: returned.branchResult,
      artifact: returned.artifact, attribution: 'program-reported', state: checkpoint },
  })) return undefined
  return { artifact: returned.artifact, checkpoint }
}

/**
 * Match the single continued CSV attachment to its previously committed lock in this exact question.
 * @param session - Fixed history of the Session that owns the question.
 * @param questionSeq - Sequence of the exact sent follow-up.
 * @param messageId - ID of that follow-up.
 * @returns The continuation source, the locked chart revision and its locked group.
 */
export function resolveContinuedCsvQuestion(session: SessionObservation, questionSeq: SessionSeq, messageId: string): {
  readonly source: ArtifactCsvContinuation['source']
  readonly spec: CsvBarChartSpec
  readonly group: CsvBarChartSpec['groups'][number]
} | undefined {
  const event = session.events[questionSeq]
  if (event?.type !== 'user/message' || event.data.id !== messageId || event.data.source.kind !== 'user') return undefined
  const matching = event.data.content.flatMap((block, index) =>
    block.type === 'text' && block.text.startsWith(CONTINUED_CSV_QUESTION_PREFIX) ? [index] : [])
  const [blockIndex] = matching
  if (blockIndex === undefined || matching.length !== 1) return undefined
  const evidence = resolveRecordedQuestion(session, questionSeq, blockIndex)?.facts
  if (evidence?.kind !== 'current-csv-bar-chart' || evidence.artifact.spec.kind !== 'csv-bar-chart') return undefined
  const continuation = evidence.artifact.csvContinuation
  if (continuation === undefined || continuation.source.sessionId !== session.header.id
    || continuation.source.eventSeq >= questionSeq) return undefined
  return { source: continuation.source, spec: evidence.artifact.spec, group: evidence.values }
}
