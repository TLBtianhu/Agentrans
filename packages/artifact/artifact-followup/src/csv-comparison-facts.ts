/** Validation shared by the private comparison draft and portable comparison snapshots. */
import { isDeepStrictEqual } from 'node:util'
import { ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES, isBoundedArtifactJson } from '@agentrans/artifact/runtime-values'
import { z } from 'zod'
import type { ArtifactCsvComparisonPage, ArtifactCsvComparisonQuestionFacts, ArtifactCsvComparisonReturnCards } from './types.ts'

const cell = z.string().max(4096).optional()
const seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const rowCount = z.number().int().min(0).max(20_000)
const text = z.string().min(1)
const messageRef = { eventSeq: seq, messageId: text }
const returnRef = z.strictObject({ ...messageRef, artifactId: text, revision: z.number().int().min(1) })
const reading = z.strictObject({
  groupKey: z.string().max(256), aggregate: z.enum(['count', 'sum', 'mean', 'min', 'max']),
  value: z.number(), count: rowCount, valueColumn: z.string().min(1).max(128).optional(),
  filter: z.strictObject({ column: z.string().min(1).max(128), value: z.string().max(1024) }).optional(),
})
const pageSchema = z.strictObject({
  original: reading, current: reading,
  rows: z.array(z.strictObject({
    record: z.number().int().min(2).max(20_001), status: z.enum(['kept', 'excluded', 'added']), value: cell,
    originalFilterValue: cell, currentFilterValue: cell,
  })).max(8),
  kept: rowCount, excluded: rowCount, added: rowCount, total: rowCount, offset: rowCount, nextOffset: rowCount.optional(),
})
const utf8 = new TextEncoder()
const returnCard = z.strictObject({
  title: z.string().min(1).max(120).refine(value => value.trim() === value),
  revision: z.number().int().positive(),
  conclusion: z.array(z.string()).refine(parts => parts.some(part => part.trim() !== '')),
  groupBy: z.string().refine(value => value.trim() !== '' && utf8.encode(value).byteLength <= 128),
  groups: z.array(z.strictObject({
    key: z.string().refine(value => utf8.encode(value).byteLength <= 256),
    value: z.number(),
    count: rowCount.min(1),
  })).min(1).max(64),
})
const returnCardsSchema = z.strictObject({ first: returnCard, second: returnCard })
const portableReturns = z.strictObject({ comparison: pageSchema, returnCards: returnCardsSchema })
const commonFacts = {
  kind: z.literal('csv-question-comparison'), sessionId: text, comparison: pageSchema,
}
const reusedFrom = z.strictObject(messageRef).optional()
const localSource = {
  ...commonFacts,
  question: z.strictObject(messageRef),
  source: returnRef,
}
const localFacts = z.strictObject({ ...localSource, reusedFrom })
const returnedFacts = z.strictObject({
  ...commonFacts, reusedFrom,
  returns: z.strictObject({ branchSessionId: text, first: returnRef, second: returnRef }),
})
const importedFacts = z.strictObject({ ...commonFacts, reusedFrom, attribution: z.literal('user-imported') })
const importedReturnedFacts = importedFacts.extend({ returnCards: returnCardsSchema })
const portableExplanation = z.strictObject({ aggregation: pageSchema, filtering: pageSchema })
const explanationFacts = z.strictObject({
  ...localSource,
  explanation: z.strictObject({
    aggregation: z.strictObject({ message: z.strictObject(messageRef), comparison: pageSchema }),
    filtering: z.strictObject(messageRef),
  }),
})
const importedExplanationFacts = z.strictObject({
  ...commonFacts,
  attribution: z.literal('user-imported'),
  reusedFrom,
  explanation: z.strictObject({ aggregation: z.strictObject({ comparison: pageSchema }) }),
})

function consistentPage({
  original, current, rows, kept, excluded, added, total, offset, nextOffset,
}: z.infer<typeof pageSchema>): boolean {
  if (original.groupKey !== current.groupKey || kept + excluded !== original.count || kept + added !== current.count
    || kept + excluded + added !== total) return false
  if (original.valueColumn !== undefined && current.valueColumn !== undefined && original.valueColumn !== current.valueColumn) return false
  const hasValue = original.valueColumn !== undefined || current.valueColumn !== undefined
  const originalFilter = original.filter?.column
  const currentFilter = current.filter?.column
  const end = offset + rows.length
  if (end > total || (rows.length === 0 && offset !== total) || nextOffset !== (end < total ? end : undefined)) return false
  const pageCounts = { kept: 0, excluded: 0, added: 0 }
  let previousRecord = 1
  for (const { record, status, value, originalFilterValue, currentFilterValue } of rows) {
    if (record <= previousRecord || (value !== undefined) !== hasValue
      || (originalFilterValue !== undefined) !== (originalFilter !== undefined)
      || (currentFilterValue !== undefined) !== (currentFilter !== undefined)
      || (originalFilter === currentFilter && originalFilterValue !== currentFilterValue)) return false
    previousRecord = record
    pageCounts[status]++
  }
  return pageCounts.kept <= kept && pageCounts.excluded <= excluded && pageCounts.added <= added
}

function consistentExplanation(base: z.infer<typeof pageSchema>, filtered: z.infer<typeof pageSchema>): boolean {
  const { original } = base
  const filter = filtered.current.filter
  if (!consistentPage(base) || !consistentPage(filtered) || !isDeepStrictEqual(original, filtered.original)
    || original.aggregate !== 'mean' || original.filter !== undefined || original.valueColumn === undefined
    || base.current.aggregate !== 'sum' || base.current.filter !== undefined || base.current.valueColumn !== original.valueColumn
    || base.kept === 0 || base.excluded !== 0 || base.added !== 0
    || filtered.current.aggregate !== 'sum' || filter === undefined || filtered.current.valueColumn !== original.valueColumn
    || filtered.kept === 0 || filtered.excluded === 0 || filtered.added !== 0) return false
  const baseRows = new Map(base.rows.map(row => [row.record, row.value]))
  return filtered.rows.every(row => (!baseRows.has(row.record) || baseRows.get(row.record) === row.value)
    && (row.status === 'kept') === (row.currentFilterValue === filter.value))
}

function matchesReturnCard(card: z.infer<typeof returnCard>, saved: z.infer<typeof reading>): boolean {
  const seen = new Set<string>()
  let rows = 0
  let matched = false
  const countOnly = saved.aggregate === 'count'
  if (countOnly !== (saved.valueColumn === undefined)) return false
  for (const { key, value, count } of card.groups) {
    if (seen.has(key) || (countOnly && value !== count)) return false
    seen.add(key)
    rows += count
    if (key === saved.groupKey) matched = value === saved.value && count === saved.count
  }
  return matched && rows <= 20_000
}

function consistentReturns({ comparison, returnCards: { first, second } }: z.infer<typeof portableReturns>): boolean {
  const { original, current, rows, added, excluded } = comparison
  const sameFilter = isDeepStrictEqual(original.filter, current.filter)
  if (!consistentPage(comparison) || first.groupBy !== second.groupBy
    || (original.filter === undefined && added !== 0) || (current.filter === undefined && excluded !== 0)
    || (sameFilter && (added !== 0 || excluded !== 0))
    || !matchesReturnCard(first, original) || !matchesReturnCard(second, current)) return false
  return rows.every(row => (row.status !== 'added') === (original.filter === undefined || row.originalFilterValue === original.filter.value)
    && (row.status !== 'excluded') === (current.filter === undefined || row.currentFilterValue === current.filter.value))
}

/**
 * Check the standalone page, counts, and visible cells without recomputing CSV values.
 * @param value - Untrusted page from a portable snapshot.
 * @returns Whether it can be presented as a single reviewed page.
 */
export function isPortableCsvComparisonPage(value: unknown): value is ArtifactCsvComparisonPage {
  if (!isBoundedArtifactJson(value, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES)) return false
  const result = pageSchema.safeParse(value)
  return result.success && consistentPage(result.data)
}

/**
 * Validate two recorded pages and their shared baseline, in recipe order.
 * @param value - Untrusted pair from an import or exact witnessed pages from history.
 * @returns Whether both reviewed pages support the ordered explanation.
 */
export function isPortableCsvComparisonExplanation(value: unknown): value is {
  readonly aggregation: ArtifactCsvComparisonPage
  readonly filtering: ArtifactCsvComparisonPage
} {
  if (!isBoundedArtifactJson(value, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES)) return false
  const result = portableExplanation.safeParse(value)
  return result.success && consistentExplanation(result.data.aggregation, result.data.filtering)
}

/**
 * Validate both saved cards and their selected readings without accessing a CSV source.
 * @param value - Untrusted portable comparison page and the two accompanying return cards.
 * @returns Whether the cards, saved readings, and reviewed membership agree.
 */
export function isPortableCsvReturnedComparison(value: unknown): value is {
  readonly comparison: ArtifactCsvComparisonPage
  readonly returnCards: ArtifactCsvComparisonReturnCards
} {
  if (!isBoundedArtifactJson(value, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES)) return false
  const result = portableReturns.safeParse(value)
  return result.success && consistentReturns(result.data)
}

/**
 * Validate known single-page and paired facts for persisted drafts or admitted prompt text.
 * @param value - Bounded comparison selection or a decoded archived block.
 * @returns Whether the facts match one recognized source form.
 */
export function isComparisonFacts(value: unknown): value is ArtifactCsvComparisonQuestionFacts {
  if (!isBoundedArtifactJson(value, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES)) return false
  if (localFacts.safeParse(value).success) return true
  const returned = returnedFacts.safeParse(value)
  if (returned.success) {
    const { sessionId, comparison, returns: { branchSessionId, first, second } } = returned.data
    return sessionId !== branchSessionId && first.eventSeq < second.eventSeq && first.messageId !== second.messageId
      && consistentPage(comparison)
  }
  const imported = importedFacts.safeParse(value)
  if (imported.success) return consistentPage(imported.data.comparison)
  const importedReturned = importedReturnedFacts.safeParse(value)
  if (importedReturned.success) return consistentReturns(importedReturned.data)
  const pair = explanationFacts.safeParse(value)
  if (pair.success) return consistentExplanation(pair.data.explanation.aggregation.comparison, pair.data.comparison)
  const importedPair = importedExplanationFacts.safeParse(value)
  return importedPair.success && consistentExplanation(importedPair.data.explanation.aggregation.comparison, importedPair.data.comparison)
}
