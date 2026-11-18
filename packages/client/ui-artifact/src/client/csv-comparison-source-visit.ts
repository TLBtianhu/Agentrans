/** Keep one CSV source return route in the current tab across reload. */
import type { MessageId } from '@agentrans/llm/brand'
import type { SessionId } from '@agentrans/session/types'
import {
  isCsvReturnedSourceOrigin, sameCsvSentQuestion, type CsvComparisonSourceTrail, type CsvComparisonSourceVisit,
  type CsvExplanationStep, type CsvReturnComparisonSide, type CsvSentQuestion,
} from './csv-comparison-draft.ts'

const KEY = 'dsh.artifact.csv-comparison-source.v1'

function messageRef(value: unknown): CsvSentQuestion | undefined {
  if (typeof value !== 'object' || value === null || !('messageId' in value) || !('eventSeq' in value)) return undefined
  const { messageId, eventSeq } = value
  if (typeof messageId !== 'string' || messageId.length === 0 || typeof eventSeq !== 'number'
    || !Number.isSafeInteger(eventSeq) || eventSeq < 0) return undefined
  return { messageId: messageId as MessageId, eventSeq }
}

function offset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isExplanationStep(value: unknown): value is CsvExplanationStep {
  return value === 'aggregation' || value === 'filtering'
}

function isReturnSide(value: unknown): value is CsvReturnComparisonSide {
  return value === 'first' || value === 'second'
}

function parseVisit(value: unknown): CsvComparisonSourceVisit | undefined {
  if (typeof value !== 'object' || value === null || !('source' in value) || !('origin' in value)) return undefined
  const { origin } = value
  const source = messageRef(value.source)
  if (source === undefined || typeof origin !== 'object' || origin === null || !('kind' in origin)) return undefined
  const sourceKind = 'sourceKind' in value ? value.sourceKind : undefined
  if (sourceKind !== undefined && sourceKind !== 'imported-explanation' && sourceKind !== 'imported-return-comparison') return undefined
  const kindFields = sourceKind === undefined ? {} : { sourceKind } as const
  if ((origin.kind === 'comparison' || origin.kind === 'explanation' || origin.kind === 'returned-comparison') && 'message' in origin) {
    const message = messageRef(origin.message)
    if (message === undefined || message.eventSeq <= source.eventSeq || message.messageId === source.messageId) return undefined
    if (origin.kind === 'comparison') return { source, origin: { kind: 'comparison', message }, ...kindFields }
    if (sourceKind === undefined && origin.kind === 'explanation' && 'step' in origin && isExplanationStep(origin.step)) {
      return { source, origin: { kind: 'explanation', message, step: origin.step } }
    }
    if (sourceKind === undefined && origin.kind === 'returned-comparison' && 'side' in origin && isReturnSide(origin.side)) {
      return { source, origin: { kind: 'returned-comparison', message, side: origin.side } }
    }
  }
  if (origin.kind === 'draft' && 'receiptId' in origin && typeof origin.receiptId === 'string' && origin.receiptId.length > 0
    && 'start' in origin && 'end' in origin && offset(origin.start) && offset(origin.end) && origin.start <= origin.end) {
    const digest = 'digest' in origin && typeof origin.digest === 'string' && /^[a-f0-9]{64}$/u.test(origin.digest) ? origin.digest : undefined
    const step = 'step' in origin ? origin.step : undefined
    const returnSide = 'returnSide' in origin ? origin.returnSide : undefined
    if (step !== undefined && (!isExplanationStep(step) || sourceKind !== undefined)) return undefined
    if (returnSide !== undefined && (!isReturnSide(returnSide) || step !== undefined || sourceKind !== undefined)) return undefined
    // Revision numbers belong to one editor instance. The digest guards restored offsets.
    return { source, origin: { kind: 'draft', receiptId: origin.receiptId,
      selection: { start: origin.start, end: origin.end, draftRev: -1 }, ...(digest === undefined ? {} : { digest }),
      ...(returnSide === undefined ? (step === undefined ? {} : { step }) : { returnSide }) }, ...kindFields }
  }
  return undefined
}

function parseTrail(value: unknown): CsvComparisonSourceTrail | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const values: readonly unknown[] = value
  const first = parseVisit(values[0])
  if (first === undefined) return undefined
  const trail: [CsvComparisonSourceVisit, ...CsvComparisonSourceVisit[]] = [first]
  let previous = first
  for (const next of values.slice(1)) {
    const visit = parseVisit(next)
    if (isCsvReturnedSourceOrigin(previous.origin) || visit === undefined
      || (visit.origin.kind !== 'comparison' && visit.origin.kind !== 'returned-comparison')
      || visit.sourceKind !== previous.sourceKind
      || !sameCsvSentQuestion(previous.source, visit.origin.message)) return undefined
    trail.push(visit)
    previous = visit
  }
  return trail
}

/**
 * Read the route only for the Session that opened it, including older single-visit records.
 * @param sessionId - Current Session identity.
 * @returns Valid navigation state for this tab, if present.
 */
export function readCsvComparisonSourceTrail(sessionId: SessionId): CsvComparisonSourceTrail | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const raw = globalThis.sessionStorage.getItem(KEY)
    if (raw === null) return undefined
    const saved: unknown = JSON.parse(raw)
    if (typeof saved !== 'object' || saved === null || !('sessionId' in saved) || saved.sessionId !== sessionId) return undefined
    if ('trail' in saved) return parseTrail(saved.trail)
    const legacy = 'visit' in saved ? parseVisit(saved.visit) : undefined
    return legacy === undefined ? undefined : [legacy]
  } catch (_error) {
    // Storage is optional and its contents may be malformed.
    return undefined
  }
}

/**
 * Store navigation coordinates and an optional draft digest for the current tab.
 * @param sessionId - Session identity that owns the visit.
 * @param trail - Navigation state, or undefined to remove this Session's route.
 */
export function writeCsvComparisonSourceTrail(sessionId: SessionId, trail?: CsvComparisonSourceTrail): void {
  if (typeof window === 'undefined') return
  try {
    const storage = globalThis.sessionStorage
    if (trail === undefined) {
      if (readCsvComparisonSourceTrail(sessionId) !== undefined) storage.removeItem(KEY)
      return
    }
    const saved = trail.map(({ source, origin, sourceKind }) => ({ source, sourceKind, origin: origin.kind !== 'draft' ? origin : {
      kind: origin.kind, receiptId: origin.receiptId, start: origin.selection.start, end: origin.selection.end,
      digest: origin.digest, step: origin.step, returnSide: origin.returnSide,
    } }))
    storage.setItem(KEY, JSON.stringify({ sessionId, trail: saved }))
  } catch (_error) {
    // A live visit remains usable with storage disabled or full.
  }
}
