/** Proof for explicit confirmation of a Host-computed comparison page. */
import { Buffer } from 'node:buffer'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  CSV_COMPARISON_EXPLANATION_PREFIX, CSV_COMPARISON_QUESTION_PREFIX, IMPORTED_CSV_COMPARISON_QUESTION_PREFIX,
  IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX, IMPORTED_CSV_EXPLANATION_SOURCE_TEXT, IMPORTED_CSV_RETURN_SOURCE_TEXT,
  IMPORTED_CSV_SINGLE_SOURCE_TEXT,
} from '@agentrans/artifact/runtime-values'
import type { Context } from '@agentrans/cordis'
import type { TextBlock } from '@agentrans/llm'
import type { SessionId } from '@agentrans/session/types'
import { isComparisonFacts } from './csv-comparison-facts.ts'
import type { ArtifactCsvComparisonAttachment, ArtifactCsvComparisonQuestionFacts } from './types.ts'

interface ArtifactCsvComparisonSigner {
  seal(facts: ArtifactCsvComparisonQuestionFacts): ArtifactCsvComparisonAttachment | undefined
  verify(attachment: ArtifactCsvComparisonAttachment): boolean
}

const signers = new WeakMap<Context, ArtifactCsvComparisonSigner>()
const questionPrefixes = [
  CSV_COMPARISON_QUESTION_PREFIX, IMPORTED_CSV_COMPARISON_QUESTION_PREFIX, CSV_COMPARISON_EXPLANATION_PREFIX,
  IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX,
] as const

function questionPrefix(facts: ArtifactCsvComparisonQuestionFacts): string {
  if (facts.explanation !== undefined) {
    return facts.provenance === 'user-imported' ? IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX : CSV_COMPARISON_EXPLANATION_PREFIX
  }
  return facts.provenance === 'user-imported' ? IMPORTED_CSV_COMPARISON_QUESTION_PREFIX : CSV_COMPARISON_QUESTION_PREFIX
}

/** Construct the durable question block and exclude the transient proof from model input. */
export function csvComparisonQuestionBlock(facts: ArtifactCsvComparisonQuestionFacts): TextBlock {
  const context = { kind: 'artifact-question-context', sessionId: facts.sessionId, facts }
  return { type: 'text', text: questionPrefix(facts) + JSON.stringify(context) }
}

/** Keep the canonical comparison for draft verification and credit the source of its imported evidence. */
export function csvComparisonRequiredBlocks(facts: ArtifactCsvComparisonQuestionFacts): readonly TextBlock[] {
  const comparison = csvComparisonQuestionBlock(facts)
  if (facts.provenance === 'user-imported') {
    const source = facts.explanation !== undefined ? IMPORTED_CSV_EXPLANATION_SOURCE_TEXT
      : facts.returnCards !== undefined ? IMPORTED_CSV_RETURN_SOURCE_TEXT : IMPORTED_CSV_SINGLE_SOURCE_TEXT
    return [comparison, { type: 'text', text: source }]
  }
  return [comparison]
}

/**
 * Decode an archived comparison and check that its text matches its recorded source.
 * @param text - Candidate comparison block from an ordinary question.
 * @param sessionId - Receiving Session that owns the block.
 * @returns Parsed facts for a recognized prefix, or undefined for other blocks and invalid facts.
 */
export function readCsvComparisonQuestionBlock(text: string, sessionId: SessionId): ArtifactCsvComparisonQuestionFacts | undefined {
  const prefix = questionPrefixes.find(candidate => text.startsWith(candidate))
  if (prefix === undefined) return undefined
  let context: unknown
  try {
    context = JSON.parse(text.slice(prefix.length))
  } catch { return undefined }
  if (context === null || typeof context !== 'object' || !('kind' in context) || context.kind !== 'artifact-question-context'
    || !('sessionId' in context) || context.sessionId !== sessionId || !('facts' in context)) return undefined
  const { facts } = context
  if (!isComparisonFacts(facts) || facts.sessionId !== sessionId || questionPrefix(facts) !== prefix) return undefined
  return facts
}

function createCsvComparisonSigner(maxContextBytes: number): ArtifactCsvComparisonSigner {
  const key = randomBytes(32)
  function proofFor(facts: ArtifactCsvComparisonQuestionFacts): Buffer {
    const canonical = JSON.stringify(facts, (_name, value: unknown) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
      const entries = Object.entries(value)
      entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      return Object.fromEntries(entries)
    })
    return createHmac('sha256', key).update(canonical).digest()
  }
  return {
    seal(facts) {
      const bytes = Buffer.byteLength(JSON.stringify(csvComparisonRequiredBlocks(facts)), 'utf8')
      if (bytes > maxContextBytes) return undefined
      return { facts, proof: proofFor(facts).toString('hex') }
    },
    verify({ facts, proof }) {
      return /^[a-f\d]{64}$/u.test(proof) && timingSafeEqual(Buffer.from(proof, 'hex'), proofFor(facts))
    },
  }
}

/** Register comparison proof handling within one mounted Host prompt provider. */
export function registerCsvComparisonSigner(ctx: Context, maxContextBytes: number): ArtifactCsvComparisonSigner {
  const signer = createCsvComparisonSigner(maxContextBytes)
  ctx.effect(() => {
    const root = ctx.root
    signers.set(root, signer)
    return () => { if (signers.get(root) === signer) signers.delete(root) }
  }, 'CSV comparison prompt boundary')
  return signer
}

/** Seal one authorized comparison for admission through the ordinary prompt provider. */
export function sealCsvComparisonQuestion(ctx: Context,
  facts: ArtifactCsvComparisonQuestionFacts): ArtifactCsvComparisonAttachment | undefined {
  return signers.get(ctx.root)?.seal(facts)
}

/** Verify a review capability before saving its bounded, exact comparison as a draft. */
export function verifyCsvComparisonQuestion(ctx: Context, attachment: ArtifactCsvComparisonAttachment): boolean {
  return signers.get(ctx.root)?.verify(attachment) ?? false
}
