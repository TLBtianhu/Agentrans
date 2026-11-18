import type { MessageId } from '@agentrans/llm/brand'
import { describe, expect, it, vi } from 'vitest'
import type { CsvComparisonSourceTrail, CsvComparisonSourceVisit, CsvSentQuestion } from '../src/client/csv-comparison-draft.ts'
import { classifyMissingCsvSource, csvComparisonSourceKind, loadCsvComparisonSourceChain, verifyCsvComparisonSourceTrail,
  type CsvComparisonSourceReadKind } from '../src/client/csv-comparison-source-chain.ts'

const latest = { eventSeq: 42, messageId: 'latest' as MessageId }
const middle = { eventSeq: 18, messageId: 'middle' as MessageId }
const earliest = { eventSeq: 7, messageId: 'earliest' as MessageId }

describe('verifying a saved source route after reload', () => {
  const trail: CsvComparisonSourceTrail = [
    { source: middle, origin: { kind: 'comparison', message: latest } },
    { source: earliest, origin: { kind: 'comparison', message: middle } },
  ]

  it('returns the verified prefix through temporarily unavailable history', () => {
    const read = vi.fn().mockReturnValueOnce({ reusedFrom: middle }).mockReturnValueOnce({ reusedFrom: earliest })
      .mockReturnValueOnce('unavailable')
    expect(verifyCsvComparisonSourceTrail(trail, read)).toEqual({ trail: [trail[0]], interruption: { status: 'unavailable' } })
    expect(read.mock.calls).toEqual([[latest], [middle], [earliest]])
  })

  it('keeps the saved route on success and stops before a newly mismatched link', () => {
    const read = vi.fn().mockReturnValueOnce({ reusedFrom: middle }).mockReturnValueOnce({ reusedFrom: earliest }).mockReturnValueOnce({})
    expect(verifyCsvComparisonSourceTrail(trail, read).trail).toBe(trail)
    read.mockReset().mockReturnValueOnce({ reusedFrom: middle })
      .mockReturnValueOnce({ reusedFrom: { ...earliest, messageId: latest.messageId } })
    expect(verifyCsvComparisonSourceTrail(trail, read)).toEqual({ trail: [trail[0]], interruption: { status: 'invalid', level: 2 } })
    expect(read.mock.calls).toEqual([[latest], [middle]])
  })

  it('reports a broken first stop without opening another comparison', () => {
    const read = vi.fn().mockReturnValueOnce('invalid')
    expect(verifyCsvComparisonSourceTrail(trail, read)).toEqual({ interruption: { status: 'invalid', level: 1 } })
    expect(read.mock.calls).toEqual([[latest]])
  })

  it.each([['aggregation', middle], ['filtering', earliest]] as const)('checks the exact %s step in the stored explanation', (step, source) => {
    const explanation = { aggregation: { message: middle }, filtering: earliest }
    const read = vi.fn((target: CsvSentQuestion, kind?: CsvComparisonSourceReadKind) =>
      target === latest && kind === 'explanation' ? { explanation } : {})
    const origin = { kind: 'explanation' as const, message: latest, step }
    const selected: CsvComparisonSourceTrail = [{ source, origin }]
    expect(verifyCsvComparisonSourceTrail(selected, read).trail).toBe(selected)
    expect(read.mock.calls).toEqual([[latest, 'explanation'], [source]])
    read.mockClear()

    const sibling = source === middle ? earliest : middle
    expect(verifyCsvComparisonSourceTrail([{ source: sibling, origin }], read))
      .toEqual({ interruption: { status: 'invalid', level: 1 } })
    expect(read.mock.calls).toEqual([[latest, 'explanation']])
  })

  it.each(['imported-explanation', 'imported-return-comparison'] as const)('verifies the exact address for %s', (sourceKind) => {
    const origin = { kind: 'comparison', message: latest } as const
    const read = vi.fn((target: CsvSentQuestion, kind?: CsvComparisonSourceReadKind) => {
      if (kind !== sourceKind) return 'invalid' as const
      return target === latest ? { reusedFrom: middle } : {}
    })
    const trail: CsvComparisonSourceTrail = [{ source: middle, sourceKind, origin }]
    expect(verifyCsvComparisonSourceTrail(trail, read).trail).toBe(trail)
    expect(read.mock.calls).toEqual([[latest, sourceKind], [middle, sourceKind]])
    expect(verifyCsvComparisonSourceTrail([{ source: earliest, sourceKind, origin }], read))
      .toEqual({ interruption: { status: 'invalid', level: 1 } })
  })

  it.each(['imported-explanation', 'imported-return-comparison'] as const)('restores two hops with source kind %s', (sourceKind) => {
    const trail: CsvComparisonSourceTrail = [
      { source: middle, sourceKind, origin: { kind: 'comparison', message: latest } },
      { source: earliest, sourceKind, origin: { kind: 'comparison', message: middle } },
    ]
    const read = vi.fn().mockReturnValueOnce({ reusedFrom: middle }).mockReturnValueOnce({ reusedFrom: earliest }).mockReturnValueOnce({})
    expect(verifyCsvComparisonSourceTrail(trail, read).trail).toBe(trail)
    expect(read.mock.calls).toEqual([[latest, sourceKind], [middle, sourceKind], [earliest, sourceKind]])
    read.mockReset().mockReturnValueOnce({ reusedFrom: middle }).mockReturnValueOnce({ reusedFrom: earliest }).mockReturnValueOnce('invalid')
    expect(verifyCsvComparisonSourceTrail(trail, read)).toEqual({ trail: [trail[0]], interruption: { status: 'invalid', level: 2 } })
  })

  it('stops before switching from an imported return comparison to another source kind', () => {
    const trail: CsvComparisonSourceTrail = [
      { source: middle, sourceKind: 'imported-return-comparison', origin: { kind: 'comparison', message: latest } },
      { source: earliest, sourceKind: 'imported-explanation', origin: { kind: 'comparison', message: middle } },
    ]
    const read = vi.fn().mockReturnValueOnce({ reusedFrom: middle }).mockReturnValueOnce({ reusedFrom: earliest })
    expect(verifyCsvComparisonSourceTrail(trail, read)).toEqual({ trail: [trail[0]], interruption: { status: 'invalid', level: 2 } })
    expect(read.mock.calls).toEqual([[latest, 'imported-return-comparison'], [middle, 'imported-return-comparison']])
  })

  it('checks only the addressed side when the return is the last route stop', () => {
    const leaf: CsvComparisonSourceVisit = { source: earliest, origin: { kind: 'returned-comparison', message: middle, side: 'second' } }
    const requested: CsvComparisonSourceTrail = [trail[0], leaf]
    const read = vi.fn().mockReturnValueOnce({ reusedFrom: middle }).mockReturnValue({})
    const check = vi.fn(() => 'matched' as const)
    expect(verifyCsvComparisonSourceTrail(requested, read, check).trail).toBe(requested)
    expect(read.mock.calls).toEqual([[latest], [middle]])
    expect(check).toHaveBeenCalledExactlyOnceWith(earliest, leaf.origin)
    read.mockReset().mockReturnValueOnce({ reusedFrom: middle }).mockReturnValue({})
    expect(verifyCsvComparisonSourceTrail(requested, read, () => 'unavailable'))
      .toEqual({ trail: [trail[0]], interruption: { status: 'unavailable' } })
  })

  it('stops at a mismatched or intermediate return', () => {
    const leaf: CsvComparisonSourceVisit = { source: earliest, origin: { kind: 'returned-comparison', message: middle, side: 'first' } }
    const check = vi.fn(() => 'invalid' as const)
    const read = vi.fn(() => ({}))
    expect(verifyCsvComparisonSourceTrail([leaf], read, check)).toEqual({ interruption: { status: 'invalid', level: 1 } })
    expect(check).toHaveBeenCalledExactlyOnceWith(earliest, leaf.origin)
    check.mockClear()
    expect(verifyCsvComparisonSourceTrail([leaf, leaf], read, check)).toEqual({ interruption: { status: 'invalid', level: 1 } })
    expect(check).not.toHaveBeenCalled()
    expect(verifyCsvComparisonSourceTrail([leaf], read)).toEqual({ interruption: { status: 'invalid', level: 1 } })
    expect(read).not.toHaveBeenCalled()
  })

  it.each(['first', 'second'] as const)('verifies the %s draft return as its only stop', (returnSide) => {
    const draft: CsvComparisonSourceVisit = { source: middle, origin: { kind: 'draft', receiptId: 'saved-receipt', returnSide,
      selection: { start: 4, end: 7, draftRev: -1 } } }
    const next: CsvComparisonSourceVisit = { source: earliest, origin: { kind: 'comparison', message: middle } }
    const requested: CsvComparisonSourceTrail = [draft]
    const read = vi.fn(() => ({}))
    const check = vi.fn(() => 'matched' as const)
    expect(verifyCsvComparisonSourceTrail(requested, read, check).trail).toBe(requested)
    expect(check).toHaveBeenCalledExactlyOnceWith(draft.source, draft.origin)
    expect(verifyCsvComparisonSourceTrail(requested, read, () => 'unavailable')).toEqual({ interruption: { status: 'unavailable' } })
    expect(verifyCsvComparisonSourceTrail([draft, next], read, check)).toEqual({ interruption: { status: 'invalid', level: 1 } })
    expect(check).toHaveBeenCalledOnce()
    expect(read).not.toHaveBeenCalled()
  })
})

it('selects a distinct source kind only for an imported comparison with embedded return cards', () => {
  const card = { title: 'Trial latency', revision: 1, conclusion: ['Mean 30 ms.'], groupBy: 'Trial',
    groups: [{ key: 'Warm', value: 30, count: 2 }] }
  const returnCards = { first: card, second: card }
  expect(csvComparisonSourceKind({ provenance: 'user-imported', returnCards })).toBe('imported-return-comparison')
  expect(csvComparisonSourceKind({ provenance: 'user-imported' })).toBeUndefined()
  expect(csvComparisonSourceKind({ returnCards })).toBeUndefined()
})

describe('missing source history', () => {
  const history = { open: true, hasMore: true, firstSeq: 18, lastSeq: 42 }

  it('allows retry while the referenced history can still load', () => {
    expect(classifyMissingCsvSource(7, history)).toBe('unavailable')
    expect(classifyMissingCsvSource(60, history)).toBe('unavailable')
    expect(classifyMissingCsvSource(7, { ...history, open: false })).toBe('unavailable')
  })

  it('marks a missing record in the loaded or exhausted history as invalid', () => {
    expect(classifyMissingCsvSource(18, history)).toBe('invalid')
    expect(classifyMissingCsvSource(30, history)).toBe('invalid')
    expect(classifyMissingCsvSource(7, { ...history, hasMore: false })).toBe('invalid')
  })
})

describe('the saved comparison source chain', () => {
  it('reads immediate through earliest in order and stops at the first original comparison', async () => {
    const older = new Map([[latest, { reusedFrom: middle }], [middle, { reusedFrom: earliest }], [earliest, {}]])
    const read = vi.fn(async (target: typeof latest) => older.get(target) ?? 'invalid' as const)
    const signal = new AbortController().signal

    await expect(loadCsvComparisonSourceChain(latest, read, signal))
      .resolves.toEqual({ sources: [latest, middle, earliest], status: 'complete' })
    expect(read.mock.calls).toEqual([[latest], [middle], [earliest]])
  })

  it('returns the verified prefix and resolves more on retry when an older comparison becomes available', async () => {
    const read = vi.fn().mockResolvedValueOnce({ reusedFrom: middle }).mockResolvedValueOnce('unavailable')
      .mockResolvedValueOnce({ reusedFrom: middle }).mockResolvedValueOnce({})
    const signal = new AbortController().signal
    await expect(loadCsvComparisonSourceChain(latest, read, signal)).resolves.toEqual({ sources: [latest], status: 'unavailable' })
    await expect(loadCsvComparisonSourceChain(latest, read, signal)).resolves.toEqual({ sources: [latest, middle], status: 'complete' })
    expect(read.mock.calls).toEqual([[latest], [middle], [latest], [middle]])
  })

  it('shows level one when the immediate reference is invalid', async () => {
    await expect(loadCsvComparisonSourceChain(latest, async () => 'invalid', new AbortController().signal))
      .resolves.toEqual({ sources: [], status: 'invalid', level: 1 })
  })

  it('keeps the verified question before an invalid destination found in history', async () => {
    const read = vi.fn().mockResolvedValueOnce({ reusedFrom: middle }).mockResolvedValueOnce('invalid')
    await expect(loadCsvComparisonSourceChain(latest, read, new AbortController().signal))
      .resolves.toEqual({ sources: [latest], status: 'invalid', level: 2 })
    expect(read.mock.calls).toEqual([[latest], [middle]])
  })

  it.each([latest, { ...latest, eventSeq: 5 }, { ...earliest, eventSeq: 20 }])('stops at an invalid link %j', async (source) => {
    const read = vi.fn().mockResolvedValueOnce({ reusedFrom: middle }).mockResolvedValueOnce({ reusedFrom: source })
    await expect(loadCsvComparisonSourceChain(latest, read, new AbortController().signal))
      .resolves.toEqual({ sources: [latest, middle], status: 'invalid', level: 3 })
    expect(read.mock.calls).toEqual([[latest], [middle]])
  })

  it('keeps a valid comparison even when its saved source reference is malformed', async () => {
    const read = vi.fn().mockResolvedValueOnce({ invalidReuseSource: true })
    await expect(loadCsvComparisonSourceChain(latest, read, new AbortController().signal))
      .resolves.toEqual({ sources: [latest], status: 'invalid', level: 2 })
    expect(read.mock.calls).toEqual([[latest]])
  })

  it('does not publish a prefix when the initiating attachment or history is superseded', async () => {
    const read = vi.fn().mockResolvedValueOnce({ reusedFrom: middle }).mockRejectedValueOnce(new Error('Source changed'))
    await expect(loadCsvComparisonSourceChain(latest, read, new AbortController().signal)).rejects.toThrow('Source changed')
    expect(read.mock.calls).toEqual([[latest], [middle]])
  })

  it('discards an in-flight result when the preview is closed', async () => {
    const controller = new AbortController()
    const read = vi.fn(async () => {
      controller.abort()
      return { reusedFrom: middle }
    })

    await expect(loadCsvComparisonSourceChain(latest, read, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(read.mock.calls).toEqual([[latest]])
  })
})
