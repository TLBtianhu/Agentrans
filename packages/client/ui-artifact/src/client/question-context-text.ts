/** Display-only recognition of exact experiment-context text; this grants no authority. */
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES, isBoundedArtifactJson } from '@deepseek-ai/dsh-artifact/runtime-values'

/** Exact version-one text spelling emitted by the Host question-context provider. */
export const QUESTION_CONTEXT_PREFIX = 'The user selected the following experiment context for this question. '
  + 'Particle values are recomputed by the Host from the recorded source and checkpoint; no causal conclusion is inferred.\n'

/** Exact program-report spelling; display recognition does not authenticate its claims. */
export const PROGRAM_CONTEXT_PREFIX = 'The user selected the following program-reported context for this question. '
  + 'The Host checked the source identity and revision; the runtime identity, status, state and error are Client/program reports, '
  + 'not independently verified or recomputed. This does not establish replayability or a causal conclusion.\n'

/** Compact display fields; the Slot keeps the original complete substring as `raw`. */
export interface QuestionContextSummary {
  readonly title: string
  readonly revision: number
  readonly stepCount: number
  readonly variantTitle?: string
  readonly variantRevision?: number
}

/** Neutral display category for a complete program-reported state or error. */
export interface ProgramContextSummary {
  readonly title: string
  readonly revision: number
  readonly status: 'ready' | 'error'
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    /** Expandable display of a recognizable experiment-context text block, without verification claims. */
    'artifact-question-context': QuestionContextSummary
    /** Expandable program reports; the recognized format is not a verification mark. */
    'artifact-program-context': ProgramContextSummary
  }
}

function programSummary(input: unknown): ProgramContextSummary | undefined {
  if (!record(input) || input.kind !== 'artifact-question-context' || typeof input.sessionId !== 'string'
    || input.sessionId.length === 0 || !record(input.facts)) return undefined
  const facts = input.facts
  if (facts.kind !== 'html-runtime' || facts.attribution !== 'program-reported'
    || typeof facts.runtimeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(facts.runtimeId)
    || !record(facts.artifact) || !record(facts.capture)) return undefined
  const { artifact, capture } = facts
  if (artifact.format !== 'html' || typeof artifact.source !== 'string' || artifact.source.length === 0
    || typeof artifact.artifactId !== 'string' || artifact.artifactId.length === 0
    || typeof artifact.title !== 'string' || artifact.title.trim().length === 0 || !integer(artifact.revision, 1)
    || !isBoundedArtifactJson(capture, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES)) return undefined
  if (capture.status === 'ready' && Object.keys(capture).length === 2 && Object.hasOwn(capture, 'state')) {
    return { title: artifact.title, revision: artifact.revision, status: 'ready' }
  }
  if (capture.status !== 'error' || Object.keys(capture).length !== 2 || !record(capture.error)
    || Object.keys(capture.error).length !== 2 || typeof capture.error.code !== 'string'
    || !/^[A-Za-z][A-Za-z0-9._-]{0,95}$/.test(capture.error.code) || typeof capture.error.message !== 'string') return undefined
  return { title: artifact.title, revision: artifact.revision, status: 'error' }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function particle(value: unknown): QuestionContextSummary | undefined {
  if (!record(value) || !record(value.artifact) || !record(value.checkpoint) || !record(value.values)) return undefined
  const { artifact, checkpoint, values } = value
  if (artifact.format !== 'scene' || !record(artifact.spec) || artifact.spec.kind !== 'particle-system'
    || typeof artifact.artifactId !== 'string' || artifact.artifactId.length === 0
    || typeof artifact.title !== 'string' || artifact.title.trim().length === 0 || !integer(artifact.revision, 1)
    || checkpoint.runtimeVersion !== 1 || !integer(checkpoint.stepCount, 0)
    || typeof values.time !== 'number' || !Number.isFinite(values.time) || !Array.isArray(values.particles)) return undefined
  return { title: artifact.title, revision: artifact.revision, stepCount: checkpoint.stepCount }
}

function summary(input: unknown): QuestionContextSummary | undefined {
  if (!record(input) || input.kind !== 'artifact-question-context' || typeof input.sessionId !== 'string'
    || input.sessionId.length === 0 || !record(input.facts)) return undefined
  const facts = input.facts
  if (facts.kind === 'current-particle') return particle(facts)
  if (facts.kind === 'observation') {
    if (!record(facts.observation) || typeof facts.observation.observationId !== 'string'
      || facts.observation.observationId.length === 0) return undefined
    return particle(facts.observation)
  }
  if (facts.kind !== 'comparison' || typeof facts.group !== 'string' || facts.group.length === 0
    || !record(facts.conditions)) return undefined
  const control = particle(facts.control)
  const variant = particle(facts.variant)
  if (control === undefined || variant === undefined || control.stepCount !== variant.stepCount
    || facts.conditions.runtimeVersion !== 1 || facts.conditions.stepCount !== control.stepCount) return undefined
  return { ...control, variantTitle: variant.title, variantRevision: variant.revision }
}

/** Recognize a complete prefix and single JSON line; malformed or unknown text stays ordinary text. */
export const questionContextTextRule: UserTextRule<'artifact-question-context'> = {
  id: 'artifact-question-context', order: 5,
  match(text, from) {
    for (let start = text.indexOf(QUESTION_CONTEXT_PREFIX, from); start >= 0;
      start = text.indexOf(QUESTION_CONTEXT_PREFIX, start + QUESTION_CONTEXT_PREFIX.length)) {
      const jsonStart = start + QUESTION_CONTEXT_PREFIX.length
      const nextLine = text.indexOf('\n', jsonStart)
      const end = nextLine < 0 ? text.length : nextLine
      let parsed: unknown
      try { parsed = JSON.parse(text.slice(jsonStart, end)) } catch (_error) {
        // Partial or authored non-JSON text remains visible.
        continue
      }
      const data = summary(parsed)
      if (data !== undefined) return { id: 'artifact-question-context', start, end, data }
    }
    return undefined
  },
}

/** Recognize only the program-report format; the existing evaluator orders this beside particle contexts. */
export const programContextTextRule: UserTextRule<'artifact-program-context'> = {
  id: 'artifact-program-context', order: 5,
  match(text, from) {
    for (let start = text.indexOf(PROGRAM_CONTEXT_PREFIX, from); start >= 0;
      start = text.indexOf(PROGRAM_CONTEXT_PREFIX, start + PROGRAM_CONTEXT_PREFIX.length)) {
      const jsonStart = start + PROGRAM_CONTEXT_PREFIX.length
      const nextLine = text.indexOf('\n', jsonStart)
      const end = nextLine < 0 ? text.length : nextLine
      let parsed: unknown
      try { parsed = JSON.parse(text.slice(jsonStart, end)) } catch (_error) {
        // Partial or authored non-JSON text remains visible.
        continue
      }
      const data = programSummary(parsed)
      if (data !== undefined) return { id: 'artifact-program-context', start, end, data }
    }
    return undefined
  },
}
