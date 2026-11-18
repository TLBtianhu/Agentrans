/** The portable file validates the exact reviewed page before consuming it. */
import type { ArtifactCsvComparisonPage } from '@agentrans/artifact-followup/types'
import { describe, expect, it } from 'vitest'
import { encodeCsvComparisonSnapshot, encodeCsvReturnedComparisonSnapshot, readCsvComparisonSnapshot } from '../src/csv-comparison-snapshot.ts'

const comparison: ArtifactCsvComparisonPage = {
  original: { groupKey: '暖', value: 30, aggregate: 'mean', valueColumn: 'Latency', count: 3 },
  current: { groupKey: '暖', value: 35, aggregate: 'sum', valueColumn: 'Latency', count: 2 },
  total: 4, kept: 1, excluded: 2, added: 1, offset: 1, nextOffset: 3,
  rows: [
    { record: 4, status: 'excluded', value: '25' },
    { record: 6, status: 'kept', value: '15' },
  ],
}
const format = 'agentrans-csv-comparison'
const envelope = { format, version: 1, comparison }
const invalid = { code: 'artifact-branch/csv-comparison-import-invalid', details: { reason: 'INVALID_SNAPSHOT' } }

describe('portable comparison snapshots', () => {
  it('round trips just the locked page without calculating new readings', () => {
    const json = new TextDecoder().decode(encodeCsvComparisonSnapshot(comparison))
    expect(JSON.parse(json)).toEqual(envelope)
    expect(readCsvComparisonSnapshot(json)).toEqual(envelope)
    const exactBudget = json + ' '.repeat(65_536 - Buffer.byteLength(json, 'utf8'))
    expect(readCsvComparisonSnapshot(exactBudget)).toEqual(envelope)
    expect(() => readCsvComparisonSnapshot(exactBudget + ' ')).toThrow(
      expect.objectContaining({ code: invalid.code, details: { reason: 'SNAPSHOT_TOO_LARGE' } }),
    )
  })

  it.each([
    ['unknown version', { ...envelope, version: 2 }],
    ['different format', { ...envelope, format: 'artifact' }],
    ['unexpected private reference', { ...envelope, sessionId: 'another-session' }],
    ['unexpected page field', { ...envelope, comparison: { ...comparison, question: { eventSeq: 3 } } }],
    ['wrong total', { ...envelope, comparison: { ...comparison, total: 5 } }],
    ['wrong reading count', { ...envelope, comparison: { ...comparison, original: { ...comparison.original, count: 1 } } }],
    ['wrong range', { ...envelope, comparison: { ...comparison, nextOffset: 4 } }],
    ['missing rows before the last position', { ...envelope, comparison: { ...comparison, rows: [], nextOffset: 1 } }],
    ['wrong record order', { ...envelope, comparison: { ...comparison, rows: [...comparison.rows].reverse() } }],
    ['unexpected status totals', { ...envelope, comparison: {
      ...comparison, rows: comparison.rows.map(row => ({ ...row, status: 'added' })),
    } }],
    ['hidden selection cells', { ...envelope, comparison: {
      ...comparison, rows: comparison.rows.map(row => ({ ...row, originalFilterValue: 'hidden' })),
    } }],
    ['different raw values under one merged column', { ...envelope, comparison: {
      ...comparison,
      original: { ...comparison.original, filter: { column: 'Batch', value: 'A' } },
      current: { ...comparison.current, filter: { column: 'Batch', value: 'B' } },
      rows: comparison.rows.map(row => ({ ...row, originalFilterValue: 'A', currentFilterValue: 'B' })),
    } }],
  ])('rejects %s', (_label, body) => {
    expect(() => readCsvComparisonSnapshot(JSON.stringify(body))).toThrow(expect.objectContaining(invalid))
  })

  it('rejects malformed JSON', () => {
    expect(() => readCsvComparisonSnapshot('{')).toThrow(expect.objectContaining(invalid))
  })
})

const aggregation: ArtifactCsvComparisonPage = {
  original: comparison.original,
  current: { ...comparison.original, aggregate: 'sum', value: 90 },
  total: 3, kept: 3, excluded: 0, added: 0, offset: 0, nextOffset: 2,
  rows: [{ record: 2, status: 'kept', value: '50' }, { record: 4, status: 'kept', value: '25' }],
}
const filtering: ArtifactCsvComparisonPage = {
  ...comparison,
  current: { ...comparison.current, value: 15, count: 1, filter: { column: 'Batch', value: 'B' } },
  total: 3, kept: 1, excluded: 2, added: 0, offset: 1,
  rows: [
    { record: 4, status: 'excluded', value: '25', currentFilterValue: 'A' },
    { record: 6, status: 'kept', value: '15', currentFilterValue: 'B' },
  ],
}
// The filtered page is the last page of three records, so there is no next offset.
const { nextOffset: _nextOffset, ...lastPage } = filtering
const orderedPair = { format: 'agentrans-csv-comparison-explanation', version: 1, aggregation, filtering: lastPage }

describe('portable ordered explanations', () => {
  it('round trips two exact reviewed ranges in recipe order', () => {
    const json = new TextDecoder().decode(encodeCsvComparisonSnapshot(lastPage, aggregation))
    expect(JSON.parse(json)).toEqual(orderedPair)
    expect(readCsvComparisonSnapshot(json)).toEqual(orderedPair)
  })

  it.each([
    ['unknown version', { ...orderedPair, version: 2 }],
    ['history identity', { ...orderedPair, source: { eventSeq: 10, messageId: 'private' } }],
    ['history identity in a page', { ...orderedPair, aggregation: { ...aggregation, message: { eventSeq: 10 } } }],
    ['reversed recipe order', { ...orderedPair, aggregation: lastPage, filtering: aggregation }],
    ['incompatible baseline', { ...orderedPair, filtering: { ...lastPage, original: { ...lastPage.original, value: 29 } } }],
    ['incompatible raw cell', { ...orderedPair, filtering: {
      ...lastPage, rows: lastPage.rows.map(row => ({ ...row, value: '99' })),
    } }],
    ['row contradicting the applied filter', { ...orderedPair, filtering: {
      ...lastPage, rows: lastPage.rows.map(row => ({ ...row, currentFilterValue: 'B' })),
    } }],
  ])('rejects %s', (_label, body) => {
    expect(() => readCsvComparisonSnapshot(JSON.stringify(body))).toThrow(expect.objectContaining(invalid))
  })
})

const returnCards = {
  first: { title: 'Trial latency', revision: 1, conclusion: ['A mean of 30.'], groupBy: 'Trial',
    groups: [{ key: '暖', value: 30, count: 3 }] },
  second: { title: 'Trial latency', revision: 2, conclusion: ['A filtered sum of 15.'], groupBy: 'Trial',
    groups: [{ key: '暖', value: 15, count: 1 }] },
}
const returnedComparison = { format: 'agentrans-csv-return-comparison', version: 1, comparison: lastPage, returnCards }

describe('portable comparisons with return cards', () => {
  it('round trips a filtered comparison and both cards without adding private addresses', () => {
    const json = new TextDecoder().decode(encodeCsvReturnedComparisonSnapshot(lastPage, returnCards))
    expect(JSON.parse(json)).toEqual(returnedComparison)
    expect(readCsvComparisonSnapshot(json)).toEqual(returnedComparison)
  })

  it.each([
    ['unknown version', { ...returnedComparison, version: 2 }],
    ['unexpected envelope property', { ...returnedComparison, source: 'private-session' }],
    ['unexpected card property', { ...returnedComparison, returnCards: {
      ...returnCards, first: { ...returnCards.first, artifactId: 'private-artifact' },
    } }],
    ['unexpected group property', { ...returnedComparison, returnCards: {
      ...returnCards, first: { ...returnCards.first, groups: [{ ...returnCards.first.groups[0], attachmentId: 'private-csv' }] },
    } }],
    ['reversed cards', { ...returnedComparison, returnCards: { first: returnCards.second, second: returnCards.first } }],
    ['different grouping columns', { ...returnedComparison, returnCards: {
      ...returnCards, second: { ...returnCards.second, groupBy: 'Trial cohort' },
    } }],
    ['duplicate selected group', { ...returnedComparison, returnCards: {
      ...returnCards, first: { ...returnCards.first, groups: [...returnCards.first.groups, ...returnCards.first.groups] },
    } }],
    ['wrong selected value', { ...returnedComparison, returnCards: {
      ...returnCards, second: { ...returnCards.second, groups: [{ key: '暖', value: 14, count: 1 }] },
    } }],
    ['wrong selected count', { ...returnedComparison, returnCards: {
      ...returnCards, second: { ...returnCards.second, groups: [{ key: '暖', value: 15, count: 2 }] },
    } }],
    ['empty conclusion', { ...returnedComparison, returnCards: {
      ...returnCards, second: { ...returnCards.second, conclusion: [' ', '\n'] },
    } }],
    ['row contradicting the recorded filter', { ...returnedComparison, comparison: {
      ...lastPage, rows: lastPage.rows.map(row => ({ ...row, currentFilterValue: 'B' })),
    } }],
  ])('rejects %s', (_label, body) => {
    expect(() => readCsvComparisonSnapshot(JSON.stringify(body))).toThrow(expect.objectContaining(invalid))
  })
})
