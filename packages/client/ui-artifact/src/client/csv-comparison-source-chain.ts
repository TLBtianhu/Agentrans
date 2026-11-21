/** Follow the comparison sources recorded on sent questions. */
import type { ArtifactCsvComparisonQuestionFacts } from '@agentrans/artifact-followup/types'
import {
  isCsvReturnedSourceOrigin, sameCsvSentQuestion, type CsvComparisonSourceKind, type CsvComparisonSourceTrail,
  type CsvComparisonSourceVisit,
  type CsvExplanationStep, type CsvReturnedSourceOrigin, type CsvSentQuestion,
} from './csv-comparison-draft.ts'

interface CsvSourceLink {
  readonly reusedFrom?: CsvSentQuestion
  readonly invalidReuseSource?: true
  readonly explanation?: { readonly aggregation: { readonly message?: CsvSentQuestion }; readonly filtering?: CsvSentQuestion }
}

/** Verified sources in visit order. An invalid level is the one-based missing destination. */
export type CsvComparisonSourceChain = {
  readonly sources: readonly CsvSentQuestion[]
  readonly status: 'complete' | 'unavailable'
} | {
  readonly sources: readonly CsvSentQuestion[]
  readonly status: 'invalid'
  readonly level: number
}

/** Result of resolving one historical comparison against the Session event window. */
export type CsvComparisonSourceRead = CsvSourceLink | 'unavailable' | 'invalid'
/** Imported source kind of a resolved link, or `explanation` for a Host-reviewed two-step source. */
export type CsvComparisonSourceReadKind = CsvComparisonSourceKind | 'explanation'

/** Verify the exact returned reading tied to the selected comparison side. */
export type CheckCsvReturnedComparisonSource = (
  source: CsvSentQuestion, origin: CsvReturnedSourceOrigin,
) => 'matched' | 'unavailable' | 'invalid'

type CsvSourceInterruption = { readonly status: 'unavailable'; readonly pending?: true }
  | { readonly status: 'invalid'; readonly level: number }

/** A restore interruption shown on the last verified source or in the composer dock. */
export type CsvComparisonSourceRecovery = CsvSourceInterruption & { readonly source?: CsvSentQuestion }

/** The exact saved route prefix that can be reopened and why verification stopped. */
export interface VerifiedCsvComparisonSourceTrail {
  readonly trail?: CsvComparisonSourceTrail
  readonly interruption?: CsvSourceInterruption
}

interface CsvSourceHistoryRange {
  readonly open: boolean
  readonly hasMore: boolean
  readonly firstSeq: number | undefined
  readonly lastSeq: number | undefined
}

/**
 * A live window may still acquire earlier history or a newer tail.
 * @param seq - Missing source event sequence.
 * @param history - Current durable event range and paging state.
 * @returns Whether the missing source could still arrive or its reference is invalid.
 */
export function classifyMissingCsvSource(seq: number, history: CsvSourceHistoryRange): 'unavailable' | 'invalid' {
  const { open, hasMore, firstSeq, lastSeq } = history
  if (!open) return 'unavailable'
  if (hasMore && (firstSeq === undefined || seq < firstSeq)) return 'unavailable'
  return lastSeq !== undefined && seq > lastSeq ? 'unavailable' : 'invalid'
}

function isEarlierSource(source: CsvSentQuestion, from: CsvSentQuestion): boolean {
  return source.eventSeq < from.eventSeq && source.messageId !== from.messageId
}

/**
 * Get the exact historical question recorded for one explanation step.
 * @param explanation - Recorded explanation steps, if the link has them.
 * @param step - Step whose source question is requested.
 * @returns The recorded question, or `undefined` without an explanation.
 */
export function csvExplanationSource(explanation: CsvSourceLink['explanation'], step: CsvExplanationStep): CsvSentQuestion | undefined {
  return step === 'aggregation' ? explanation?.aggregation.message : explanation?.filtering
}

/**
 * Get the one saved source selected from a single comparison or from a step of an explanation.
 * @param facts - Facts of the draft attachment.
 * @param step - Explanation step, or `undefined` for the reused single comparison.
 * @returns The selected source question, if recorded.
 */
export function csvDraftSource(facts: ArtifactCsvComparisonQuestionFacts, step?: CsvExplanationStep): CsvSentQuestion | undefined {
  return step === undefined ? facts.reusedFrom : csvExplanationSource(facts.explanation, step)
}

/**
 * Select the persisted source kind for a draft's immediate reference.
 * @param facts - Attribution, explanation and return cards of the draft facts.
 * @returns The imported source kind, or `undefined` for evidence that was not user-imported.
 */
export function csvComparisonSourceKind(
  facts?: Pick<ArtifactCsvComparisonQuestionFacts, 'attribution' | 'explanation' | 'returnCards'>,
): CsvComparisonSourceKind | undefined {
  if (facts?.attribution !== 'user-imported') return undefined
  if (facts.returnCards !== undefined) return 'imported-return-comparison'
  return facts.explanation === undefined ? undefined : 'imported-explanation'
}

/**
 * Read the chain up to its original comparison or the first unverifiable link.
 * @param first - Immediate source recorded on the current draft attachment.
 * @param read - Resolve one exact question, loading retained history on demand.
 * @param signal - Stop when the preview closes or the current draft changes.
 * @returns Only the verified prefix and whether it is complete.
 */
export async function loadCsvComparisonSourceChain(first: CsvSentQuestion,
  read: (target: CsvSentQuestion) => Promise<CsvComparisonSourceRead>, signal: AbortSignal): Promise<CsvComparisonSourceChain> {
  const sources: CsvSentQuestion[] = []
  const ids = new Set<CsvSentQuestion['messageId']>()
  let target: CsvSentQuestion | undefined = first
  while (target !== undefined) {
    signal.throwIfAborted()
    ids.add(target.messageId)
    const comparison = await read(target)
    signal.throwIfAborted()
    if (comparison === 'unavailable') return { sources, status: 'unavailable' }
    if (comparison === 'invalid') return { sources, status: 'invalid', level: sources.length + 1 }
    sources.push(target)
    const previous: CsvSentQuestion | undefined = comparison.reusedFrom
    if (comparison.invalidReuseSource === true
      || (previous !== undefined && (!isEarlierSource(previous, target) || ids.has(previous.messageId)))) {
      return { sources, status: 'invalid', level: sources.length + 1 }
    }
    target = previous
  }
  return { sources, status: 'complete' }
}

/**
 * Verify the saved route without following any replacement source reference.
 * @param requested - Route captured before reload.
 * @param read - Read a source from the currently loaded history.
 * @param checkReturned - Resolve both sides of a route link to a returned reading. Omit to disallow that link.
 * @returns The longest verified prefix and the first interruption, if any.
 */
export function verifyCsvComparisonSourceTrail(requested: CsvComparisonSourceTrail,
  read: (target: CsvSentQuestion, kind?: CsvComparisonSourceReadKind) => CsvComparisonSourceRead,
  checkReturned?: CheckCsvReturnedComparisonSource): VerifiedCsvComparisonSourceTrail {
  const verified: CsvComparisonSourceVisit[] = []
  let previous: CsvComparisonSourceRead | undefined
  let previousKind: CsvComparisonSourceKind | undefined
  for (const visit of requested) {
    const { origin, source, sourceKind } = visit
    if (isCsvReturnedSourceOrigin(origin)) {
      const tip = verified.at(-1)
      const connected = origin.kind === 'draft' ? tip === undefined
        : isEarlierSource(source, origin.message) && (tip === undefined
          || tip.sourceKind === undefined && sameCsvSentQuestion(tip.source, origin.message))
      if (sourceKind !== undefined || !connected || verified.length !== requested.length - 1) return stoppedCsvSourceTrail(verified, 'invalid')
      const status = checkReturned?.(source, origin) ?? 'invalid'
      return status === 'matched' ? { trail: requested } : stoppedCsvSourceTrail(verified, status)
    }
    if ((previous !== undefined && sourceKind !== previousKind)
      || (sourceKind !== undefined && (origin.kind === 'explanation' || origin.kind === 'draft' && origin.step !== undefined))) {
      return stoppedCsvSourceTrail(verified, 'invalid')
    }
    if (origin.kind !== 'draft') {
      const fromKind = origin.kind === 'explanation' ? 'explanation' : sourceKind
      const from = previous ?? (fromKind === undefined ? read(origin.message) : read(origin.message, fromKind))
      if (from === 'unavailable') return stoppedCsvSourceTrail(verified, 'unavailable')
      if (from === 'invalid') return stoppedCsvSourceTrail(verified, 'invalid')
      const linked = origin.kind === 'explanation' ? csvExplanationSource(from.explanation, origin.step)
        : from.invalidReuseSource === true ? undefined : from.reusedFrom
      if (!sameCsvSentQuestion(linked, source)) {
        return stoppedCsvSourceTrail(verified, 'invalid')
      }
    }
    const comparison = sourceKind === undefined ? read(source) : read(source, sourceKind)
    if (typeof comparison === 'string') return stoppedCsvSourceTrail(verified, comparison)
    verified.push(visit)
    previous = comparison
    previousKind = sourceKind
  }
  return { trail: requested }
}

function stoppedCsvSourceTrail([first, ...rest]: readonly CsvComparisonSourceVisit[],
  status: 'unavailable' | 'invalid'): VerifiedCsvComparisonSourceTrail {
  return {
    ...(first === undefined ? {} : { trail: [first, ...rest] }),
    interruption: status === 'unavailable' ? { status } : { status, level: first === undefined ? 1 : rest.length + 2 },
  }
}
