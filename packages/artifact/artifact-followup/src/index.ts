/** Source-bound experiment facts and attributed program reports on an ordinary question. @module @agentrans/artifact-followup */
import { Buffer } from 'node:buffer'
import type { Context } from '@agentrans/cordis'
import z from '@agentrans/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@agentrans/agent'
import type {} from '@agentrans/api-session-controller'
import { ArtifactError } from '@agentrans/artifact'
import type ArtifactService from '@agentrans/artifact'
import type { ArtifactId, ArtifactObservationId } from '@agentrans/artifact/types'
import { buildParticleObservationComparison, ParticleObservationComparisonError } from '@agentrans/artifact/observation-comparison'
import { createParticleCheckpoint, observeParticleState, restoreParticleCheckpoint, ParticleRuntimeError } from '@agentrans/artifact/particle-runtime'
import {
  isBoundedArtifactJson, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES, ARTIFACT_RUNTIME_FAILURE_MAX_BYTES,
} from '@agentrans/artifact/runtime-values'
import type { ArtifactRuntimeId } from '@agentrans/artifact-runtime/types'
import { brandString } from '@agentrans/brand'
import type { TextBlock } from '@agentrans/llm'
import type { SessionId } from '@agentrans/session/types'
import { RemoteError } from '@agentrans/typert-protocol'
import { assertNever, type JsonValue } from '@agentrans/util-values'
import type {
  ArtifactProgramQuestionCapture, ArtifactPromptContextFacts, ArtifactPromptContextRejectionReason,
  ArtifactPromptContextSelection, ArtifactQuestionContext,
} from './types.ts'

/** Context contribution registered with the ordinary prompt admission owner. */
export const name = 'artifact-followup'
/** Source and ordinary prompt registration owners; no filesystem or separate Remote is required. */
export const inject = ['artifacts', 'sessionController']

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
  if (value.status === 'ready') return Object.keys(value).length === 2 && Object.hasOwn(value, 'state')
  if (value.status !== 'error' || Object.keys(value).length !== 2 || !record(value.error)) return false
  const error = value.error
  return Object.keys(error).length === 2 && typeof error.code === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,95}$/.test(error.code)
    && typeof error.message === 'string' && Buffer.byteLength(JSON.stringify(error), 'utf8') <= ARTIFACT_RUNTIME_FAILURE_MAX_BYTES
}

const selectionSchema: zod.ZodType<ArtifactPromptContextSelection> = zod.discriminatedUnion('kind', [
  zod.object({
    kind: zod.literal('current-particle'), artifactId,
    revision: zod.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    checkpoint: zod.object({ runtimeVersion: zod.literal(1), stepCount: zod.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict(),
  }).strict(),
  zod.object({ kind: zod.literal('observation'), ref }).strict(),
  zod.object({ kind: zod.literal('comparison'), group: zod.string().regex(/^[a-z][a-z0-9-]{0,63}$/), control: ref, variant: ref }).strict(),
  zod.object({
    kind: zod.literal('html-runtime'),
    capturedSessionId: zod.string().min(1).transform(value => brandString<SessionId>(value)), artifactId,
    revision: zod.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    runtimeId: zod.string().regex(/^[A-Za-z0-9_-]{1,128}$/).transform(value => brandString<ArtifactRuntimeId>(value)),
    capture: zod.custom<ArtifactProgramQuestionCapture>(programCapture),
  }).strict(),
])

function rejected(reason: ArtifactPromptContextRejectionReason, cause?: Error): never {
  throw new RemoteError('artifact-followup/context-rejected', 'The selected experiment cannot be attached to this question.',
    { reason }, cause === undefined ? undefined : { cause })
}

function facts(artifacts: ArtifactService, agent: Agent, selection: ArtifactPromptContextSelection): ArtifactPromptContextFacts {
  try {
    switch (selection.kind) {
      case 'current-particle': {
        const source = artifacts.resolveSceneSource(agent, { kind: 'current', artifactId: selection.artifactId,
          revision: selection.revision, checkpoint: selection.checkpoint })
        if (source.artifact.spec.kind !== 'particle-system') return rejected('UNSUPPORTED_SOURCE')
        const state = restoreParticleCheckpoint(source.artifact.spec, source.checkpoint)
        return { kind: 'current-particle', artifact: source.artifact,
          checkpoint: createParticleCheckpoint(state), values: observeParticleState(state) }
      }
      case 'observation': return { kind: 'observation', observation: artifacts.resolveSavedObservation(agent, selection.ref) }
      case 'comparison': {
        const control = artifacts.resolveSavedObservation(agent, selection.control)
        const variant = artifacts.resolveSavedObservation(agent, selection.variant)
        const comparison = buildParticleObservationComparison(selection.group, control, variant)
        return { kind: 'comparison', group: comparison.group, conditions: comparison.conditions, control, variant }
      }
      case 'html-runtime': {
        if (selection.capturedSessionId !== agent.session.id) return rejected('SESSION_MISMATCH')
        const artifact = artifacts.currentSnapshot(agent, selection.artifactId)
        if (artifact === undefined) return rejected('SOURCE_NOT_FOUND')
        if (artifact.revision !== selection.revision) return rejected('STALE_REVISION')
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

function contextBlocks(artifacts: ArtifactService, agent: Agent, input: JsonValue, maxContextBytes: number): readonly TextBlock[] {
  const parsed = selectionSchema.safeParse(input)
  if (!parsed.success) return rejected('INVALID_SELECTION', parsed.error)
  const context: ArtifactQuestionContext = {
    kind: 'artifact-question-context', sessionId: agent.session.id, facts: facts(artifacts, agent, parsed.data),
  }
  const prefix = context.facts.kind === 'html-runtime'
    ? 'The user selected the following program-reported context for this question. '
      + 'The Host checked the source identity and revision; the runtime identity, status, state and error are Client/program reports, '
      + 'not independently verified or recomputed. This does not establish replayability or a causal conclusion.\n'
    : 'The user selected the following experiment context for this question. '
      + 'Particle values are recomputed by the Host from the recorded source and checkpoint; no causal conclusion is inferred.\n'
  const blocks: readonly TextBlock[] = [{ type: 'text', text:
    prefix + JSON.stringify(context),
  }]
  if (Buffer.byteLength(JSON.stringify(blocks), 'utf8') > maxContextBytes) {
    throw new RemoteError('artifact-followup/context-rejected', 'The selected experiment exceeds the question-context size limit.', {
      reason: 'CONTEXT_TOO_LARGE', limit: maxContextBytes,
    })
  }
  return blocks
}

/**
 * Register source resolution, particle computation and attributed program reports for explicit question context.
 * @param ctx - Artifact source and ordinary Session prompt owners.
 * @param config - Complete contributed-context byte budget.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const { maxContextBytes } = Config(config)
  ctx.effect(() => ctx.sessionController.registerPromptContext('artifact', (agent, input) =>
    contextBlocks(ctx.artifacts, agent, input, maxContextBytes)), 'Artifact question context')
}
