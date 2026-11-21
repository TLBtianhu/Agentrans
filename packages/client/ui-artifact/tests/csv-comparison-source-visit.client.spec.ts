// @vitest-environment jsdom
import type { MessageId } from '@agentrans/llm/brand'
import type { ArtifactId } from '@agentrans/artifact/types'
import type { ArtifactCsvComparisonDraft } from '@agentrans/artifact-followup/types'
import type { SessionId } from '@agentrans/session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CsvComparisonSourceVisit } from '../src/client/csv-comparison-draft.ts'
import { readCsvComparisonSourceTrail, writeCsvComparisonSourceTrail } from '../src/client/csv-comparison-source-visit.ts'
import { createSnapshotStore } from '@agentrans/client-store'
import { ArtifactInteractionOwner } from '../src/client/particle-runtime-owner.ts'

const sessionId = 'session-a' as SessionId
const otherSession = 'session-b' as SessionId
const source = { messageId: 'source' as MessageId, eventSeq: 20 }
const originMessage = { messageId: 'origin' as MessageId, eventSeq: 30 }
const comparison: CsvComparisonSourceVisit = { source, origin: { kind: 'comparison', message: originMessage } }
const key = 'dsh.artifact.csv-comparison-source.v1'

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('CSV source navigation storage', () => {
  it('keeps one visit in this tab and only lets its session clear it', () => {
    writeCsvComparisonSourceTrail(sessionId, [comparison])
    expect(readCsvComparisonSourceTrail(sessionId)).toEqual([comparison])
    expect(readCsvComparisonSourceTrail(otherSession)).toBeUndefined()
    writeCsvComparisonSourceTrail(otherSession)
    expect(readCsvComparisonSourceTrail(sessionId)).toEqual([comparison])
    writeCsvComparisonSourceTrail(otherSession, [comparison])
    expect(readCsvComparisonSourceTrail(sessionId)).toBeUndefined()
    writeCsvComparisonSourceTrail(otherSession)
    expect(readCsvComparisonSourceTrail(otherSession)).toBeUndefined()
  })

  it('keeps the receipt, digest and offsets without persisting the old editor revision', () => {
    const origin = { kind: 'draft' as const, receiptId: 'locked-receipt', selection: { start: 4, end: 7, draftRev: 51 }, digest: '7'.repeat(64) }
    const first = { source: originMessage, origin }
    writeCsvComparisonSourceTrail(sessionId, [first, comparison])
    expect(sessionStorage.getItem(key)).not.toContain('draftRev')
    expect(readCsvComparisonSourceTrail(sessionId)).toEqual([{ ...first, origin: { ...origin,
      selection: { start: 4, end: 7, draftRev: -1 },
    } }, comparison])
  })

  it('reads existing single-visit data as a one-step route', () => {
    sessionStorage.setItem(key, JSON.stringify({ sessionId, visit: comparison }))
    expect(readCsvComparisonSourceTrail(sessionId)).toEqual([comparison])
  })

  it.each([undefined, 'imported-return-comparison'] as const)('restores only the exact imported return draft route with kind %s', (kind) => {
    const receiptId = 'imported-return-draft'
    const selection = { start: 4, end: 7, draftRev: 12 }
    const visit: CsvComparisonSourceVisit = { source, origin: { kind: 'draft', receiptId, selection },
      ...(kind === undefined ? {} : { sourceKind: kind }) }
    const reading = { groupKey: 'Warm', aggregate: 'mean', valueColumn: 'LatencyMs', value: 30, count: 2 } as const
    const card = { title: 'Trial latency', revision: 1, conclusion: ['Mean 30 ms.'], groupBy: 'Trial', groups: [{ key: 'Warm', value: 30, count: 2 }] }
    const draft: ArtifactCsvComparisonDraft = { receiptId, facts: { kind: 'csv-question-comparison', sessionId, attribution: 'user-imported',
      returnCards: { first: card, second: card }, reusedFrom: source,
      comparison: { original: reading, current: reading, kept: 2, excluded: 0, added: 0, total: 2, offset: 0, rows: [] } } }
    writeCsvComparisonSourceTrail(sessionId, [visit])
    const owner = new ArtifactInteractionOwner(() => createSnapshotStore(undefined))
    const release = owner.bindCsvSourceVisitStorage(() => readCsvComparisonSourceTrail(sessionId),
      (trail) => { writeCsvComparisonSourceTrail(sessionId, trail) })
    const requested = owner.pendingCsvComparisonSourceTrail.getSnapshot()
    if (requested === undefined) throw new Error('Expected a saved imported return route')
    expect(requested[0]).toEqual({ ...visit, origin: { ...visit.origin, selection: { ...selection, draftRev: -1 } } })
    owner.selection.set({ kind: 'csv-question-comparison', draft: { ...draft, receiptId: 'newer-draft' } })
    expect(owner.restoreCsvComparisonSourceTrail(requested)).toBe(false)
    owner.selection.set({ kind: 'csv-question-comparison', draft })
    expect(owner.isCsvComparisonSourceAvailable({ ...requested[0], source: { ...source, messageId: originMessage.messageId } })).toBe(false)
    expect(owner.isCsvComparisonSourceAvailable({ ...requested[0], sourceKind: 'imported-explanation' })).toBe(false)
    expect(owner.restoreCsvComparisonSourceTrail(requested)).toBe(true)
    expect(owner.returnToCsvComparisonSourceStop(requested[0], requested[0])).toBe(true)
    expect(readCsvComparisonSourceTrail(sessionId)).toBeUndefined()
    release()
    owner.dispose()
  })

  it('rejects a saved route that changes source kind between imported visits', () => {
    const compare: CsvComparisonSourceVisit = { ...comparison, sourceKind: 'imported-return-comparison' }
    const second: CsvComparisonSourceVisit = { source: { messageId: 'earlier' as MessageId, eventSeq: 10 },
      origin: { kind: 'comparison', message: source }, sourceKind: 'imported-explanation' }
    writeCsvComparisonSourceTrail(sessionId, [compare, second])
    expect(readCsvComparisonSourceTrail(sessionId)).toBeUndefined()
  })

  it('stores the explanation step on the active source and consumes it on return', () => {
    const owner = new ArtifactInteractionOwner(() => createSnapshotStore(undefined))
    const release = owner.bindCsvSourceVisitStorage(() => readCsvComparisonSourceTrail(sessionId),
      (trail) => { writeCsvComparisonSourceTrail(sessionId, trail) })
    const aggregation: CsvComparisonSourceVisit = { source, origin: { kind: 'explanation', message: originMessage, step: 'aggregation' } }
    const filtering: CsvComparisonSourceVisit = { source: { messageId: 'filtered' as MessageId, eventSeq: 24 },
      origin: { kind: 'explanation', message: originMessage, step: 'filtering' } }
    expect(owner.visitCsvComparisonSource(aggregation)).toBe(true)
    expect(readCsvComparisonSourceTrail(sessionId)).toEqual([aggregation])
    expect(owner.visitCsvComparisonSource(filtering)).toBe(true)
    expect(readCsvComparisonSourceTrail(sessionId)).toEqual([filtering])
    expect(owner.returnToCsvComparisonSourceStop(aggregation, aggregation)).toBe(false)
    expect(owner.returnToCsvComparisonSourceStop(filtering, filtering)).toBe(true)
    expect(readCsvComparisonSourceTrail(sessionId)).toBeUndefined()
    release()
    owner.dispose()
  })

  it.each(['first', 'second'] as const)('stores the %s side of a returned comparison as a final stop', (side) => {
    const target = { messageId: 'exact-return' as MessageId, eventSeq: 16 }
    const returned: CsvComparisonSourceVisit = { source: target, origin: { kind: 'returned-comparison', message: source, side } }
    const beyond: CsvComparisonSourceVisit = { source: { messageId: 'previous-return' as MessageId, eventSeq: 12 },
      origin: { kind: 'comparison', message: target } }
    const owner = new ArtifactInteractionOwner(() => createSnapshotStore(undefined))
    const release = owner.bindCsvSourceVisitStorage(() => readCsvComparisonSourceTrail(sessionId),
      (trail) => { writeCsvComparisonSourceTrail(sessionId, trail) })
    expect(owner.visitCsvComparisonSource(comparison)).toBe(true)
    expect(owner.visitCsvComparisonSource(returned)).toBe(true)
    expect(readCsvComparisonSourceTrail(sessionId)).toEqual([comparison, returned])
    expect(owner.visitCsvComparisonSource(beyond)).toBe(false)
    expect(owner.openCsvComparisonSourceTrail([returned, beyond])).toBe(false)
    expect(owner.returnToCsvComparisonSourceStop(returned, returned)).toBe(true)
    expect(readCsvComparisonSourceTrail(sessionId)).toEqual([comparison])
    expect(owner.returnToCsvComparisonSourceStop(returned, returned)).toBe(false)
    release()
    owner.dispose()
  })

  it.each(['first', 'second'] as const)('restores the %s returned reading only for the matching locked draft', (returnSide) => {
    const receiptId = 'returned-readings-receipt'
    const earlier = { messageId: 'earlier-return' as MessageId, eventSeq: 12 }
    const artifactId = 'csv-locked' as ArtifactId
    const returns = { branchSessionId: otherSession, first: { ...earlier, artifactId, revision: 1 },
      second: { ...source, artifactId, revision: 2 } }
    const target = returnSide === 'first' ? earlier : source
    const otherSide = returnSide === 'first' ? source : earlier
    const selection = { start: 4, end: 7, draftRev: 12 }
    const visit: CsvComparisonSourceVisit = { source: target, origin: { kind: 'draft', selection, receiptId,
      digest: '7'.repeat(64), returnSide } }
    const reading = { groupKey: 'Warm', aggregate: 'mean', value: 30, count: 2 } as const
    const draft: ArtifactCsvComparisonDraft = { receiptId, facts: { kind: 'csv-question-comparison', sessionId, returns,
      comparison: { original: reading, current: reading, kept: 2, excluded: 0, added: 0, total: 2, offset: 0, rows: [] } } }
    writeCsvComparisonSourceTrail(sessionId, [visit])
    const owner = new ArtifactInteractionOwner(() => createSnapshotStore(undefined))
    const release = owner.bindCsvSourceVisitStorage(() => readCsvComparisonSourceTrail(sessionId),
      (trail) => { writeCsvComparisonSourceTrail(sessionId, trail) })
    const requested = owner.pendingCsvComparisonSourceTrail.getSnapshot()
    if (requested === undefined) throw new Error('Expected a saved draft return route')
    expect(requested[0]).toEqual({ ...visit, origin: { ...visit.origin, selection: { ...selection, draftRev: -1 } } })
    owner.selection.set({ kind: 'csv-question-comparison', draft: { ...draft, receiptId: 'changed-draft' } })
    expect(owner.restoreCsvComparisonSourceTrail(requested)).toBe(false)
    owner.selection.set({ kind: 'csv-question-comparison', draft })
    expect(owner.isCsvComparisonSourceAvailable({ ...requested[0], source: otherSide })).toBe(false)
    expect(owner.restoreCsvComparisonSourceTrail(requested)).toBe(true)
    expect(owner.returnToCsvComparisonSourceStop(requested[0], requested[0])).toBe(true)
    expect(readCsvComparisonSourceTrail(sessionId)).toBeUndefined()
    expect(owner.selection.getSnapshot()).toEqual({ kind: 'csv-question-comparison', draft })
    release()
    owner.dispose()
  })

  it.each([{ step: 'aggregation' }, { returnSide: 'other' }, { sourceKind: 'imported-explanation' },
    { sourceKind: 'imported-return-comparison' }])(
    'rejects an incompatible draft return route field %j', ({ sourceKind, ...fields }) => {
      const visit = { source, sourceKind, origin: { kind: 'draft', receiptId: 'receipt', start: 4, end: 7,
        returnSide: 'first', ...fields } }
      sessionStorage.setItem(key, JSON.stringify({ sessionId, trail: [visit] }))
      expect(readCsvComparisonSourceTrail(sessionId)).toBeUndefined()
    },
  )

  it.each([
    '{broken',
    JSON.stringify({ sessionId, visit: { source, origin: { kind: 'comparison', message: source } } }),
    JSON.stringify({ sessionId, visit: { source, origin: { kind: 'draft', receiptId: 'receipt', start: 7, end: 4 } } }),
    JSON.stringify({ sessionId, visit: { source, origin: { kind: 'draft', receiptId: 'receipt', start: 4, end: 7, step: 'other' } } }),
    JSON.stringify({ sessionId, visit: { source: { ...source, eventSeq: -1 }, origin: comparison.origin } }),
    JSON.stringify({ sessionId, visit: { source: {}, origin: comparison.origin } }),
    JSON.stringify({ sessionId, visit: { source, origin: { kind: 'returned-comparison', message: originMessage, side: 'later' } } }),
  ])('ignores malformed data %s', (raw) => {
    sessionStorage.setItem(key, raw)
    expect(readCsvComparisonSourceTrail(sessionId)).toBeUndefined()
  })

  it.each([
    [],
    [comparison, comparison],
    [comparison, { ...comparison, source: { ...source, eventSeq: 10 }, origin: { kind: 'comparison', message: { ...source, messageId: 'wrong' } } }],
    [comparison, { source, origin: { kind: 'draft', receiptId: 'receipt', start: 0, end: 4 } }],
  ])('rejects an empty, disconnected or non-decreasing route %j', (...trail) => {
    sessionStorage.setItem(key, JSON.stringify({ sessionId, trail }))
    expect(readCsvComparisonSourceTrail(sessionId)).toBeUndefined()
  })

  it('works when browser storage is unavailable', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('no storage') },
      setItem: () => { throw new Error('no storage') },
    })
    expect(() => { writeCsvComparisonSourceTrail(sessionId, [comparison]) }).not.toThrow()
    expect(readCsvComparisonSourceTrail(sessionId)).toBeUndefined()
  })

  it('persists only the earlier steps when jumping over comparisons', () => {
    const middle = { messageId: 'middle' as MessageId, eventSeq: 15 }
    const earliest = { messageId: 'earliest' as MessageId, eventSeq: 10 }
    const second: CsvComparisonSourceVisit = { source: middle, origin: { kind: 'comparison', message: source } }
    const last: CsvComparisonSourceVisit = { source: earliest, origin: { kind: 'comparison', message: middle } }
    const owner = new ArtifactInteractionOwner(() => createSnapshotStore(undefined))
    const release = owner.bindCsvSourceVisitStorage(() => readCsvComparisonSourceTrail(sessionId),
      (trail) => { writeCsvComparisonSourceTrail(sessionId, trail) })

    expect(owner.visitCsvComparisonSource(comparison)).toBe(true)
    expect(owner.visitCsvComparisonSource(second)).toBe(true)
    expect(owner.visitCsvComparisonSource(last)).toBe(true)
    expect(owner.returnToCsvComparisonSourceStop(second, comparison)).toBe(false)
    expect(owner.returnToCsvComparisonSourceStop(last, { ...second })).toBe(false)
    expect(readCsvComparisonSourceTrail(sessionId)).toEqual([comparison, second, last])

    expect(owner.returnToCsvComparisonSourceStop(last, second)).toBe(true)
    expect(owner.csvComparisonSourceTrail.getSnapshot()).toEqual([comparison])
    expect(readCsvComparisonSourceTrail(sessionId)).toEqual([comparison])
    expect(owner.returnToCsvComparisonSourceStop(last, comparison)).toBe(false)
    expect(owner.returnToCsvComparisonSourceStop(comparison, comparison)).toBe(true)
    expect(readCsvComparisonSourceTrail(sessionId)).toBeUndefined()
    release()
    owner.dispose()
  })

  it('extends a route with all selected history stops only from its exact current source', () => {
    const middle = { messageId: 'middle' as MessageId, eventSeq: 15 }
    const earliest = { messageId: 'earliest' as MessageId, eventSeq: 10 }
    const viaMiddle: CsvComparisonSourceVisit = { source: middle, origin: { kind: 'comparison', message: source } }
    const toEarliest: CsvComparisonSourceVisit = { source: earliest, origin: { kind: 'comparison', message: middle } }
    const owner = new ArtifactInteractionOwner(() => createSnapshotStore(undefined))
    const release = owner.bindCsvSourceVisitStorage(() => readCsvComparisonSourceTrail(sessionId),
      (trail) => { writeCsvComparisonSourceTrail(sessionId, trail) })

    expect(owner.visitCsvComparisonSource(comparison)).toBe(true)
    expect(owner.openCsvComparisonSourceTrail([viaMiddle, toEarliest])).toBe(true)
    expect(readCsvComparisonSourceTrail(sessionId)).toEqual([comparison, viaMiddle, toEarliest])
    expect(owner.openCsvComparisonSourceTrail([comparison, viaMiddle, toEarliest])).toBe(true)
    expect(readCsvComparisonSourceTrail(sessionId)).toEqual([comparison, viaMiddle, toEarliest])

    const other: CsvComparisonSourceVisit = { ...viaMiddle,
      origin: { kind: 'comparison', message: { ...source, messageId: 'different-origin' as MessageId } } }
    expect(owner.openCsvComparisonSourceTrail([other, toEarliest])).toBe(true)
    expect(readCsvComparisonSourceTrail(sessionId)).toEqual([other, toEarliest])
    release()
    owner.dispose()
  })

  it('persists the requested destination during fallback and rejects a retry after returning', () => {
    const earlier = { messageId: 'earlier' as MessageId, eventSeq: 12 }
    const leaf: CsvComparisonSourceVisit = { source: earlier, origin: { kind: 'comparison', message: source } }
    writeCsvComparisonSourceTrail(sessionId, [comparison, leaf])
    const owner = new ArtifactInteractionOwner(() => createSnapshotStore(undefined))
    const release = owner.bindCsvSourceVisitStorage(() => readCsvComparisonSourceTrail(sessionId),
      (trail) => { writeCsvComparisonSourceTrail(sessionId, trail) })
    const requested = owner.pendingCsvComparisonSourceTrail.getSnapshot()
    if (requested === undefined) throw new Error('Expected the requested route')
    const [first] = requested
    expect(owner.restoreCsvComparisonSourceTrail(requested, { trail: [first], interruption: { status: 'unavailable' } })).toBe(true)
    expect(owner.pendingCsvComparisonSourceTrail.getSnapshot()).toBeUndefined()
    expect(owner.csvComparisonSourceTrail.getSnapshot()).toEqual([first])
    expect(readCsvComparisonSourceTrail(sessionId)).toEqual(requested)
    const recovery = owner.csvComparisonSourceRecovery.getSnapshot()
    if (recovery === undefined) throw new Error('Expected a retry control')
    const attempt = owner.beginCsvSourceRecovery(recovery)
    if (attempt === undefined) throw new Error('Expected a retry attempt')
    expect(owner.beginCsvSourceRecovery(attempt.retry)).toBeUndefined()
    expect(owner.returnToCsvComparisonSourceStop(first, first)).toBe(true)
    expect(owner.restoreCsvComparisonSourceTrail(requested, { trail: requested }, attempt.retry)).toBe(false)
    owner.finishCsvSourceRecovery(attempt.retry, recovery)
    expect(owner.csvComparisonSourceRecovery.getSnapshot()).toBeUndefined()
    expect(readCsvComparisonSourceTrail(sessionId)).toBeUndefined()
    release()
    owner.dispose()
  })

  function restoreDraftSourceFallback() {
    const receiptId = 'locked-receipt'
    const draft: CsvComparisonSourceVisit = { source: originMessage,
      origin: { kind: 'draft', receiptId, selection: { start: 4, end: 4, draftRev: 2 } } }
    writeCsvComparisonSourceTrail(sessionId, [draft, comparison])
    const owner = new ArtifactInteractionOwner(() => createSnapshotStore(undefined))
    const reading = { groupKey: 'Warm', aggregate: 'mean', value: 30, count: 2 } as const
    owner.selection.set({ kind: 'csv-question-comparison', draft: { receiptId, facts: {
      kind: 'csv-question-comparison', sessionId, reusedFrom: originMessage, question: originMessage,
      source: { ...source, artifactId: 'csv' as ArtifactId, revision: 1 },
      comparison: { original: reading, current: reading, kept: 2, excluded: 0, added: 0, total: 2, offset: 0, rows: [] },
    } } })
    const release = owner.bindCsvSourceVisitStorage(() => readCsvComparisonSourceTrail(sessionId),
      (trail) => { writeCsvComparisonSourceTrail(sessionId, trail) })
    const requested = owner.pendingCsvComparisonSourceTrail.getSnapshot()
    if (requested === undefined) throw new Error('Expected the saved route')
    const [first] = requested
    expect(owner.restoreCsvComparisonSourceTrail(requested, { trail: [first], interruption: { status: 'unavailable' } })).toBe(true)
    const recovery = owner.csvComparisonSourceRecovery.getSnapshot()
    if (recovery === undefined) throw new Error('Expected the fallback recovery')
    const attempt = owner.beginCsvSourceRecovery(recovery)
    if (attempt === undefined) throw new Error('Expected a retry attempt')
    return { owner, release, requested, first, recovery, attempt }
  }

  it.each([['aggregation', originMessage], ['filtering', source]] as const)('restores the %s step only for its exact draft and source', (step, target) => {
    const receiptId = 'paired-receipt'
    const visit: CsvComparisonSourceVisit = { source: target, origin: { kind: 'draft', receiptId, step,
      selection: { start: 4, end: 7, draftRev: 2 }, digest: '7'.repeat(64) } }
    writeCsvComparisonSourceTrail(sessionId, [visit])
    const owner = new ArtifactInteractionOwner(() => createSnapshotStore(undefined))
    const reading = { groupKey: 'Warm', aggregate: 'mean', value: 30, count: 2 } as const
    const page = { original: reading, current: reading, kept: 2, excluded: 0, added: 0, total: 2, offset: 0, rows: [] }
    owner.selection.set({ kind: 'csv-question-comparison', draft: { receiptId, facts: {
      kind: 'csv-question-comparison', sessionId, question: originMessage, source: { ...source, artifactId: 'csv' as ArtifactId, revision: 1 },
      comparison: page, explanation: { aggregation: { message: originMessage, comparison: page }, filtering: source },
    } } })
    const release = owner.bindCsvSourceVisitStorage(() => readCsvComparisonSourceTrail(sessionId),
      (trail) => { writeCsvComparisonSourceTrail(sessionId, trail) })
    const requested = owner.pendingCsvComparisonSourceTrail.getSnapshot()
    if (requested === undefined || visit.origin.kind !== 'draft') throw new Error('Expected the draft source visit')
    const [first] = requested
    expect(first).toEqual({ ...visit, origin: { ...visit.origin, selection: { start: 4, end: 7, draftRev: -1 } } })
    expect(owner.isCsvComparisonSourceAvailable({ ...visit, origin: { ...visit.origin, receiptId: 'other' } })).toBe(false)
    expect(owner.isCsvComparisonSourceAvailable({ ...visit, source: target === source ? originMessage : source })).toBe(false)
    expect(owner.restoreCsvComparisonSourceTrail(requested)).toBe(true)
    const returning = owner.beginCsvSourceDraftReturn(first, first)
    if (returning === undefined) throw new Error('Expected to return to the paired draft')
    expect(owner.returnToCsvComparisonSourceStop(first, first)).toBe(true)
    owner.finishCsvDraftNavigation(returning)
    expect(readCsvComparisonSourceTrail(sessionId)).toBeUndefined()
    release()
    owner.dispose()
  })

  it('supersedes a retry before draft focus completes and lets the active fallback retry after a failed focus', () => {
    const { owner, release, requested, first, recovery, attempt } = restoreDraftSourceFallback()
    const returning = owner.beginCsvSourceDraftReturn(first, first)
    if (returning === undefined) throw new Error('Expected draft return to take priority')

    expect(owner.restoreCsvComparisonSourceTrail(requested, { trail: requested }, attempt.retry)).toBe(false)
    owner.finishCsvSourceRecovery(attempt.retry, recovery)
    const fallback = owner.csvComparisonSourceRecovery.getSnapshot()
    if (fallback === undefined) throw new Error('Expected the fallback to remain available')
    expect(owner.beginCsvSourceRecovery(fallback)).toBeUndefined()
    expect(owner.csvComparisonSourceTrail.getSnapshot()).toEqual([first])
    expect(readCsvComparisonSourceTrail(sessionId)).toEqual(requested)

    owner.finishCsvDraftNavigation(returning)
    const nextAttempt = owner.beginCsvSourceRecovery(fallback)
    if (nextAttempt === undefined) throw new Error('Expected retry to be available after focus failed')
    const finalReturn = owner.beginCsvSourceDraftReturn(first, first)
    if (finalReturn === undefined) throw new Error('Expected a second draft return')
    expect(owner.returnToCsvComparisonSourceStop(first, first)).toBe(true)
    owner.finishCsvDraftNavigation(finalReturn)
    expect(owner.restoreCsvComparisonSourceTrail(requested, { trail: requested }, nextAttempt.retry)).toBe(false)
    expect(owner.csvComparisonSourceRecovery.getSnapshot()).toBeUndefined()
    expect(readCsvComparisonSourceTrail(sessionId)).toBeUndefined()
    release()
    owner.dispose()
  })

  it('keeps the newest draft source choice when the old retry completes during bookmark capture', () => {
    const { owner, release, requested, first, recovery, attempt } = restoreDraftSourceFallback()
    const firstChoice = owner.beginCsvDraftNavigation()
    const newestChoice = owner.beginCsvDraftNavigation()

    expect(owner.restoreCsvComparisonSourceTrail(requested, { trail: requested }, attempt.retry)).toBe(false)
    owner.finishCsvSourceRecovery(attempt.retry, recovery)
    expect(owner.isCurrentCsvSourceVisitGesture(firstChoice)).toBe(false)
    owner.finishCsvDraftNavigation(firstChoice)
    const fallback = owner.csvComparisonSourceRecovery.getSnapshot()
    if (fallback === undefined) throw new Error('Expected the fallback to remain available')
    expect(owner.beginCsvSourceRecovery(fallback)).toBeUndefined()
    expect(owner.isCurrentCsvSourceVisitGesture(newestChoice)).toBe(true)
    expect(owner.openCsvComparisonSourceTrail([first])).toBe(true)
    owner.finishCsvDraftNavigation(newestChoice)

    expect(owner.restoreCsvComparisonSourceTrail(requested, { trail: requested }, attempt.retry)).toBe(false)
    expect(owner.csvComparisonSourceRecovery.getSnapshot()).toBeUndefined()
    expect(readCsvComparisonSourceTrail(sessionId)).toEqual([first])
    release()
    owner.dispose()
  })
})
