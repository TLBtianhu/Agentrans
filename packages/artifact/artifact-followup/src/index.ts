/** Source-bound experiment facts and attributed program reports on an ordinary question. @module @agentrans/artifact-followup */
import { Buffer } from 'node:buffer'
import type { Context } from '@agentrans/cordis'
import z from '@agentrans/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@agentrans/agent'
import type {} from '@agentrans/api-session-controller'
import type { SessionRequestId } from '@agentrans/api-session-controller/types'
import { ArtifactError } from '@agentrans/artifact'
import type ArtifactService from '@agentrans/artifact'
import type { ArtifactId, ArtifactObservationId } from '@agentrans/artifact/types'
import { buildParticleObservationComparison, ParticleObservationComparisonError } from '@agentrans/artifact/observation-comparison'
import { createParticleCheckpoint, observeParticleState, particleSpecAtGravity, restoreParticleCheckpoint, ParticleRuntimeError } from '@agentrans/artifact/particle-runtime'
import { analyzeFunctionPlotSelection } from '@agentrans/artifact/scene-renderers'
import {
  csvComparisonChangesText, isArtifactBfsCheckpoint, isArtifactHalfAdderCheckpoint, isArtifactHtmlCheckpoint, isBoundedArtifactJson,
  ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES, ARTIFACT_RUNTIME_FAILURE_MAX_BYTES, CONTINUED_CSV_QUESTION_PREFIX,
  type ArtifactBfsCheckpoint, type ArtifactHalfAdderCheckpoint,
} from '@agentrans/artifact/runtime-values'
import type { ArtifactRuntimeId } from '@agentrans/artifact-runtime/types'
import { brandString } from '@agentrans/brand'
import type { MessageId, TextBlock } from '@agentrans/llm'
import type { SessionId } from '@agentrans/session/types'
import { RemoteError } from '@agentrans/typert-protocol'
import { assertNever, type JsonValue } from '@agentrans/util-values'
import {
  BRANCH_BFS_QUESTION_PREFIX, BRANCH_HALF_ADDER_QUESTION_PREFIX,
  branchEvidenceProjection, resolveReturnedHtmlSource, resolveReturnedReadings,
} from './branch-evidence.ts'
import { csvComparisonRequiredBlocks, registerCsvComparisonSigner } from './csv-comparison.ts'
import { registerCsvComparisonDrafts } from './csv-comparison-draft.ts'
export {
  BRANCH_BFS_QUESTION_PREFIX, BRANCH_HALF_ADDER_QUESTION_PREFIX, resolveReturnedHtmlSource, resolveReturnedReadings, returnedReadingNotice,
} from './branch-evidence.ts'
export { csvComparisonQuestionBlock, readCsvComparisonQuestionBlock, sealCsvComparisonQuestion } from './csv-comparison.ts'
export { csvComparisonDrafts, csvComparisonDraftUnavailable } from './csv-comparison-draft.ts'
export { isComparisonFacts, isPortableCsvComparisonExplanation, isPortableCsvComparisonPage, isPortableCsvReturnedComparison } from './csv-comparison-facts.ts'
import type {
  ArtifactCsvComparisonQuestionFacts, ArtifactProgramQuestionCapture, ArtifactPromptContextFacts, ArtifactPromptContextRejectionReason,
  ArtifactPromptContextSelection, ArtifactQuestionContext,
} from './types.ts'

/** Context contribution registered with the ordinary prompt admission owner. */
export const name = 'artifact-followup'
/** Source and ordinary prompt registration owners; draft storage mounts independently if available. */
export const inject = ['artifacts', 'sessionController', 'sessionProjections']

/** Deployment budget for complete serialized question-context blocks. */
export interface Config {
  /** Maximum UTF-8 bytes of the complete contributed text-block array; default 16384. */
  readonly maxContextBytes?: number
}

/** Validate the budget before registering the provider. */
export const Config: z<Config, Required<Config>> = z.object({
  maxContextBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
})

const artifactId = zod.string().regex(/^[a-z][a-z0-9-]{0,63}$/).transform(value => brandString<ArtifactId>(value))
const observationId = zod.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .transform(value => brandString<ArtifactObservationId>(value))
const ref = zod.object({ artifactId, observationId }).strict()

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function programCapture(value: unknown): value is ArtifactProgramQuestionCapture {
  if (!isBoundedArtifactJson(value, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES) || !record(value)) return false
  if (value.status === 'ready') {
    if (!Object.hasOwn(value, 'state')) return false
    if (!Object.hasOwn(value, 'restore')) return Object.keys(value).length === 2
    return Object.keys(value).length === 3 && isArtifactHtmlCheckpoint(value.state) && value.restore === value.state.kind
  }
  if (value.status !== 'error' || Object.keys(value).length !== 2 || !record(value.error)) return false
  const error = value.error
  return Object.keys(error).length === 2 && typeof error.code === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,95}$/.test(error.code)
    && typeof error.message === 'string' && Buffer.byteLength(JSON.stringify(error), 'utf8') <= ARTIFACT_RUNTIME_FAILURE_MAX_BYTES
}

const plotParameterValues = zod.custom<Record<string, unknown>>(value => record(value) && !Object.hasOwn(value, '__proto__'))
  .pipe(zod.record(zod.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), zod.number()))

const branchEvidenceReference = {
  capturedSessionId: zod.string().min(1).transform(value => brandString<SessionId>(value)),
  eventSeq: zod.number().int().nonnegative(),
  messageId: zod.string().min(1).transform(value => brandString<MessageId>(value)),
}

const selectionSchema: zod.ZodType<ArtifactPromptContextSelection> = zod.discriminatedUnion('kind', [
  zod.object({
    kind: zod.literal('current-particle'), artifactId,
    revision: zod.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    checkpoint: zod.object({ runtimeVersion: zod.literal(1), stepCount: zod.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict(),
    gravityY: zod.number().optional(),
  }).strict(),
  zod.object({
    kind: zod.literal('current-function-plot'), artifactId,
    revision: zod.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    functionId: zod.string().regex(/^[a-z][a-z0-9-]{0,31}$/), x: zod.number(),
    parameters: plotParameterValues,
  }).strict(),
  zod.object({ kind: zod.literal('current-csv-bar-chart'), artifactId,
    revision: zod.number().int().min(1).max(Number.MAX_SAFE_INTEGER), groupKey: zod.string().max(256),
  }).strict(),
  zod.object({
    kind: zod.literal('csv-question-comparison'),
    facts: zod.custom<ArtifactCsvComparisonQuestionFacts>(value => record(value) && value.kind === 'csv-question-comparison'
      && isBoundedArtifactJson(value, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES)),
    proof: zod.string().regex(/^[a-f\d]{64}$/u),
  }).strict(),
  zod.object({ kind: zod.literal('csv-comparison-draft'), receiptId: zod.uuid() }).strict(),
  zod.object({ kind: zod.literal('observation'), ref }).strict(),
  zod.object({
    kind: zod.literal('branch-evidence'),
    ...branchEvidenceReference,
  }).strict(),
  zod.object({
    kind: zod.literal('branch-bfs-checkpoint'),
    ...branchEvidenceReference,
    state: zod.custom<ArtifactBfsCheckpoint>(value => isBoundedArtifactJson(value, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES)
      && isArtifactBfsCheckpoint(value)),
  }).strict(),
  zod.object({
    kind: zod.literal('branch-half-adder-checkpoint'),
    ...branchEvidenceReference,
    state: zod.custom<ArtifactHalfAdderCheckpoint>(value => isBoundedArtifactJson(value, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES)
      && isArtifactHalfAdderCheckpoint(value)),
  }).strict(),
  zod.object({ kind: zod.literal('comparison'), group: zod.string().regex(/^[a-z][a-z0-9-]{0,63}$/), control: ref, variant: ref }).strict(),
  zod.object({
    kind: zod.literal('html-runtime'),
    capturedSessionId: zod.string().min(1).transform(value => brandString<SessionId>(value)), artifactId,
    revision: zod.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    runtimeId: zod.string().regex(/^[A-Za-z0-9_-]{1,128}$/).transform(value => brandString<ArtifactRuntimeId>(value)),
    capture: zod.custom<ArtifactProgramQuestionCapture>(programCapture),
  }).strict(),
]).transform((value): ArtifactPromptContextSelection => {
  if (value.kind !== 'current-particle') return value
  const { gravityY, ...selection } = value
  return gravityY === undefined ? selection : { ...selection, gravityY }
})

function rejected(reason: ArtifactPromptContextRejectionReason, cause?: Error): never {
  throw new RemoteError('artifact-followup/context-rejected', 'The selected experiment cannot be attached to this question.',
    { reason }, cause === undefined ? undefined : { cause })
}

function currentArtifact(artifacts: ArtifactService, agent: Agent, artifactId: ArtifactId, revision: number) {
  const artifact = artifacts.currentSnapshot(agent, artifactId)
  if (artifact === undefined) return rejected('SOURCE_NOT_FOUND')
  if (artifact.revision !== revision) return rejected('STALE_REVISION')
  return artifact
}

type ReadBranchEvidence = (session: Agent['session']) => ReturnType<typeof branchEvidenceProjection.init>
type CsvComparisonSigner = ReturnType<typeof registerCsvComparisonSigner>
type CsvComparisonDrafts = Awaited<ReturnType<typeof registerCsvComparisonDrafts>>

function facts(artifacts: ArtifactService, agent: Agent, selection: ArtifactPromptContextSelection,
  readBranchEvidence: ReadBranchEvidence, csvComparison: CsvComparisonSigner, csvDrafts: CsvComparisonDrafts | undefined,
  requestId?: SessionRequestId): ArtifactPromptContextFacts {
  try {
    switch (selection.kind) {
      case 'current-particle': {
        const { artifactId, revision, checkpoint, gravityY } = selection
        const artifact = currentArtifact(artifacts, agent, artifactId, revision)
        if (artifact.format !== 'scene' || artifact.spec.kind !== 'particle-system') return rejected('UNSUPPORTED_SOURCE')
        const spec = particleSpecAtGravity(artifact.spec, checkpoint, gravityY, artifact.particleContinuation?.baseline.checkpoint)
        if (spec === undefined) return rejected('INVALID_SELECTION')
        const state = restoreParticleCheckpoint(spec, checkpoint)
        const values = observeParticleState(state)
        return gravityY === undefined
          ? { kind: 'current-particle', artifact, checkpoint: createParticleCheckpoint(state), values }
          : { kind: 'current-particle', gravityY, values, checkpoint: createParticleCheckpoint(state), artifact }
      }
      case 'current-function-plot': {
        const { kind, artifactId, revision, functionId, x, parameters } = selection
        const artifact = currentArtifact(artifacts, agent, artifactId, revision)
        if (artifact.format !== 'scene' || artifact.spec.kind !== 'function-plot') return rejected('UNSUPPORTED_SOURCE')
        const values = analyzeFunctionPlotSelection(artifact.spec, selection)
        if (values === undefined) return rejected('INVALID_SELECTION')
        return { kind, artifact, functionId, x, parameters, values }
      }
      case 'current-csv-bar-chart': {
        const { kind, artifactId, revision, groupKey } = selection
        const artifact = currentArtifact(artifacts, agent, artifactId, revision)
        if (artifact.format !== 'scene' || artifact.spec.kind !== 'csv-bar-chart') return rejected('UNSUPPORTED_SOURCE')
        const lock = artifact.csvContinuation
        if (lock !== undefined && (lock.source.sessionId !== agent.session.id || lock.groupKey !== groupKey)) return rejected('INVALID_SELECTION')
        const values = artifact.spec.groups.find(group => group.key === groupKey)
        if (values === undefined) return rejected('INVALID_SELECTION')
        return { kind, artifact, groupKey, values }
      }
      case 'csv-question-comparison':
        if (selection.facts.sessionId !== agent.session.id) return rejected('SESSION_MISMATCH')
        if (selection.facts.provenance !== undefined || selection.facts.explanation !== undefined || selection.facts.returns !== undefined
          || !csvComparison.verify(selection)) return rejected('INVALID_SELECTION')
        return selection.facts
      case 'csv-comparison-draft': {
        if (requestId === undefined) return rejected('SOURCE_NOT_FOUND')
        return csvDrafts?.resolve(agent.session.id, selection.receiptId, requestId) ?? rejected('SOURCE_NOT_FOUND')
      }
      case 'observation': return { kind: 'observation', observation: artifacts.resolveSavedObservation(agent, selection.ref) }
      case 'branch-evidence':
      case 'branch-half-adder-checkpoint':
      case 'branch-bfs-checkpoint': {
        if (selection.capturedSessionId !== agent.session.id) return rejected('SESSION_MISMATCH')
        const notice = readBranchEvidence(agent.session)[selection.eventSeq]
        if (notice === undefined || notice.messageId !== selection.messageId) return rejected('SOURCE_NOT_FOUND')
        if (selection.kind === 'branch-evidence') return resolveReturnedReadings(notice, selection.eventSeq) ?? rejected('INVALID_SELECTION')
        const { artifact, branchResult } = resolveReturnedHtmlSource(notice, selection.eventSeq, selection.state.kind)
          ?? rejected('INVALID_SELECTION')
        const facts = { artifact, branchResult, attribution: 'program-reported' } as const
        return selection.kind === 'branch-bfs-checkpoint'
          ? { ...facts, kind: 'branch-bfs-checkpoint', state: selection.state }
          : { ...facts, kind: 'branch-half-adder-checkpoint', state: selection.state }
      }
      case 'comparison': {
        const control = artifacts.resolveSavedObservation(agent, selection.control)
        const variant = artifacts.resolveSavedObservation(agent, selection.variant)
        const comparison = buildParticleObservationComparison(selection.group, control, variant)
        return { kind: 'comparison', group: comparison.group, conditions: comparison.conditions, control, variant }
      }
      case 'html-runtime': {
        if (selection.capturedSessionId !== agent.session.id) return rejected('SESSION_MISMATCH')
        const artifact = currentArtifact(artifacts, agent, selection.artifactId, selection.revision)
        if (artifact.format !== 'html') return rejected('UNSUPPORTED_SOURCE')
        return { kind: 'html-runtime', artifact, runtimeId: selection.runtimeId, attribution: 'program-reported', capture: selection.capture }
      }
      default: return assertNever(selection)
    }
  } catch (error) {
    if (error instanceof ParticleObservationComparisonError) return rejected(error.code, error)
    if (error instanceof ParticleRuntimeError) return rejected('INVALID_CHECKPOINT', error)
    if (error instanceof ArtifactError) {
      return rejected(error.code === 'ARTIFACT_NOT_FOUND' ? 'SOURCE_NOT_FOUND'
        : error.code === 'STALE_REVISION' ? 'STALE_REVISION' : 'UNSUPPORTED_SOURCE', error)
    }
    throw error
  }
}

function contextBlocks(artifacts: ArtifactService, agent: Agent, input: JsonValue, maxContextBytes: number,
  readBranchEvidence: ReadBranchEvidence, csvComparison: CsvComparisonSigner, csvDrafts: CsvComparisonDrafts | undefined,
  requestId?: SessionRequestId): readonly TextBlock[] {
  const parsed = selectionSchema.safeParse(input)
  if (!parsed.success) return rejected('INVALID_SELECTION', parsed.error)
  const resolved = facts(artifacts, agent, parsed.data, readBranchEvidence, csvComparison, csvDrafts, requestId)
  const context: ArtifactQuestionContext = { kind: 'artifact-question-context', sessionId: agent.session.id, facts: resolved }
  const blocks: readonly TextBlock[] = resolved.kind === 'csv-question-comparison' ? csvComparisonRequiredBlocks(resolved)
    : [{ type: 'text', text: questionContextPrefix(resolved) + JSON.stringify(context) }]
  if (Buffer.byteLength(JSON.stringify(blocks), 'utf8') > maxContextBytes) {
    throw new RemoteError('artifact-followup/context-rejected', 'The selected experiment exceeds the question-context size limit.', {
      reason: 'CONTEXT_TOO_LARGE', limit: maxContextBytes,
    })
  }
  if (resolved.kind === 'csv-question-comparison' && resolved.explanation === undefined) {
    const augmented: readonly TextBlock[] = [...blocks, { type: 'text', text: csvComparisonChangesText(resolved.comparison) }]
    if (Buffer.byteLength(JSON.stringify(augmented), 'utf8') <= maxContextBytes) return augmented
  }
  return blocks
}

function questionContextPrefix(facts: Exclude<ArtifactPromptContextFacts, ArtifactCsvComparisonQuestionFacts>): string {
  const experiment = 'The user selected the following experiment context for this question. '
  const particle = experiment + 'Particle values are recomputed by the Host from the recorded source and checkpoint; no causal conclusion is inferred.\n'
  switch (facts.kind) {
    case 'current-function-plot':
      return experiment
        + 'Function-plot values are recomputed by the Host from the recorded source, selected function, parameters and trace position. '
        + 'Derivative and integral readings are numerical approximations.\n'
    case 'current-csv-bar-chart':
      return facts.artifact.csvContinuation === undefined
        ? experiment + 'CSV readings come from the Host-computed group result stored in the selected chart revision.\n'
        : CONTINUED_CSV_QUESTION_PREFIX
    case 'html-runtime':
      if (facts.capture.status === 'ready' && facts.capture.restore === 'half-adder-checkpoint') {
        return 'The user selected the following program-reported context for this question. '
          + 'The Host checked the source identity and revision and validated the half-adder checkpoint. '
          + 'Use facts.capture.state for the selected input bits a and b and output bits sum and carry. '
          + 'This program-reported checkpoint can be reopened with the recorded HTML revision.\n'
      }
      if (facts.capture.status === 'ready' && facts.capture.restore === 'bfs-checkpoint') {
        return 'The user selected the following program-reported context for this question. '
          + 'The Host checked the source identity and revision and validated the BFS checkpoint shape. '
          + 'Use facts.capture.state for the selected current node, queue and visited nodes. '
          + 'This program-reported checkpoint can be reopened with the recorded HTML revision.\n'
      }
      return 'The user selected the following program-reported context for this question. '
        + 'The Host checked the source identity and revision; the runtime identity, status, state and error are Client/program reports, '
        + 'not independently verified or recomputed. This does not establish replayability or a causal conclusion.\n'
    case 'branch-evidence':
      return 'The user selected the following returned branch evidence for this question. '
        + 'The readings come from the original source revision recorded on the selected branch result.\n'
    case 'branch-bfs-checkpoint':
      return BRANCH_BFS_QUESTION_PREFIX
    case 'branch-half-adder-checkpoint':
      return BRANCH_HALF_ADDER_QUESTION_PREFIX
    case 'current-particle':
      if (facts.gravityY !== undefined) {
        return experiment
          + 'This question uses the adjusted particle experiment. Use facts.gravityY for the selected vertical gravity '
          + 'and facts.values for the readings the Host recomputed at the confirmed checkpoint. The source spec records the baseline gravity.\n'
      }
      return particle
    case 'observation':
    case 'comparison':
      return particle
    default: return assertNever(facts)
  }
}

/**
 * Register source resolution, native numerical analysis and attributed program reports for explicit question context.
 * @param ctx - Artifact source and ordinary Session prompt owners.
 * @param config - Complete contributed-context byte budget.
 * @returns When the Session projection and prompt provider are ready.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const { maxContextBytes } = Config(config)
  const branchEvidence = await ctx.sessionProjections.register(branchEvidenceProjection)
  let csvDrafts: CsvComparisonDrafts | undefined
  await ctx.inject(['storageDomain'], async (scope) => {
    csvDrafts = await registerCsvComparisonDrafts(scope)
    scope.effect(() => () => { csvDrafts = undefined }, 'CSV comparison draft provider')
  })
  const csvComparison = registerCsvComparisonSigner(ctx, maxContextBytes)
  ctx.effect(() => ctx.sessionController.registerPromptContext('artifact', (agent, input, requestId) => contextBlocks(
    ctx.artifacts, agent, input, maxContextBytes, session => branchEvidence.stateOf(session), csvComparison, csvDrafts, requestId,
  )),
  'Artifact question context')
}
