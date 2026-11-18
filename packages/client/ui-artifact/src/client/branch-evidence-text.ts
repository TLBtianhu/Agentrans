/** Read experiment evidence from a durable branch-return context message. */
import type { ContextMessageNode } from '@agentrans/client-ui-chat/client'
import {
  MAX_REPLAY_CONTEXT_LENGTH, htmlQuestionFactsReplay, nativeQuestionFactsReplay, savedParticleReplay,
  type ArtifactQuestionReplay, type HtmlQuestionReplay,
} from './question-context-text.ts'

const SAVED_PREFIX = 'The user selected the following saved Artifact evidence to accompany this conclusion. '
  + 'This does not state that the assistant used it when producing the conclusion.\n'
const QUESTION_PREFIX = 'The user selected the following Artifact readings from a branch question to accompany this conclusion. '
  + 'This does not state that the assistant used them when producing the conclusion.\n'

type EvidenceItem =
  | { readonly role: 'observation' | 'control' | 'variant'; readonly label: string; readonly replay: ArtifactQuestionReplay }
  | { readonly role: 'question'; readonly replay: ArtifactQuestionReplay }
  | { readonly role: 'question'; readonly html: HtmlQuestionReplay; readonly questionSeq: number }

type SavedEvidenceItem = Extract<EvidenceItem, { readonly label: string }>

/** Replayable evidence and original text from a returned branch conclusion. */
export interface BranchEvidenceNotice {
  readonly conclusion: readonly string[]
  readonly items: readonly EvidenceItem[]
  readonly raw: string
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function savedItem(role: SavedEvidenceItem['role'], value: unknown): SavedEvidenceItem | undefined {
  if (!record(value) || typeof value.label !== 'string' || value.label.trim() === '') return undefined
  const replay = savedParticleReplay(value)
  return replay === undefined ? undefined : { role, label: value.label, replay }
}

function comparisonItems(evidence: Record<string, unknown>): readonly EvidenceItem[] | undefined {
  const control = savedItem('control', evidence.control)
  const variant = savedItem('variant', evidence.variant)
  if (control === undefined || variant === undefined || typeof evidence.group !== 'string' || !record(evidence.conditions)) return undefined
  const { group, conditions } = evidence
  for (const { role, replay: { artifact, state } } of [control, variant]) {
    if (artifact.spec.kind !== 'particle-system' || state.kind !== 'particle-system'
      || artifact.comparison?.group !== group || artifact.comparison.role !== role
      || conditions.runtimeVersion !== state.checkpoint.runtimeVersion || conditions.stepCount !== state.checkpoint.stepCount
      || conditions.timeStep !== artifact.spec.timeStep || conditions.time !== state.values.time) return undefined
  }
  return [control, variant]
}

function evidenceItems(evidence: Record<string, unknown>, prefix: string): readonly EvidenceItem[] | undefined {
  if (prefix === QUESTION_PREFIX) {
    if (evidence.kind !== 'question' || typeof evidence.questionSeq !== 'number'
      || !Number.isSafeInteger(evidence.questionSeq) || evidence.questionSeq < 0) return undefined
    const replay = nativeQuestionFactsReplay(evidence.facts)
    return replay === undefined ? undefined : [{ role: 'question', replay }]
  }
  if (evidence.kind === 'comparison') return comparisonItems(evidence)
  if (evidence.kind !== 'observation') return undefined
  const item = savedItem('observation', evidence.observation)
  return item === undefined ? undefined : [item]
}

/**
 * Select the branch-specific display only for a supported evidence block on a durable branch return.
 * @param message - Chat context record containing the recorded source and model-visible text blocks.
 * @returns The preserved conclusion and experiment evidence, or null for the default context renderer.
 */
export function parseBranchEvidenceNotice(message: Pick<ContextMessageNode, 'source' | 'content'>): BranchEvidenceNotice | null {
  const { source, content } = message
  if (!record(source) || source.kind !== 'branch-result' || typeof source.branchSessionId !== 'string' || source.branchSessionId === '') return null
  const attachment = content.at(-1)
  if (attachment?.type !== 'text') return null
  const raw = attachment.text
  const prefix = raw.startsWith(SAVED_PREFIX) ? SAVED_PREFIX : QUESTION_PREFIX
  if (!raw.startsWith(prefix) || raw.length - prefix.length > MAX_REPLAY_CONTEXT_LENGTH || raw.indexOf('\n', prefix.length) !== -1) return null
  let value: unknown
  try { value = JSON.parse(raw.slice(prefix.length)) } catch (_error) { return null }
  if (!record(value) || value.kind !== 'branch-result-artifact-evidence' || value.branchSessionId !== source.branchSessionId
    || !record(value.evidence)) return null
  const { evidence } = value
  const marker = source.artifactEvidence
  const items = source.form === 'notice' && (marker === 'bfs-checkpoint' || marker === 'half-adder-checkpoint')
    ? htmlItems(evidence, prefix, source.resultSeq, marker)
    : evidenceItems(evidence, prefix)
  if (items === undefined) return null
  const conclusion: string[] = []
  for (const block of content.slice(0, -1)) {
    if (block.type !== 'text') return null
    conclusion.push(block.text)
  }
  if (conclusion.every(text => text.trim() === '')) return null
  return { conclusion, items, raw }
}

function htmlItems(
  evidence: Record<string, unknown>, prefix: string, resultSeq: unknown, marker: HtmlQuestionReplay['state']['kind'],
): readonly EvidenceItem[] | undefined {
  if (prefix !== QUESTION_PREFIX || evidence.kind !== 'question' || typeof evidence.questionSeq !== 'number'
    || !Number.isSafeInteger(evidence.questionSeq) || evidence.questionSeq < 0
    || typeof resultSeq !== 'number' || !Number.isSafeInteger(resultSeq) || evidence.questionSeq >= resultSeq) return undefined
  const html = htmlQuestionFactsReplay(evidence.facts)
  return html?.state.kind !== marker ? undefined : [{ role: 'question', html, questionSeq: evidence.questionSeq }]
}
