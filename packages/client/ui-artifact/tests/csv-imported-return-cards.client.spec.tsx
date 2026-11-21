// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { IMPORTED_CSV_COMPARISON_QUESTION_PREFIX } from '@agentrans/artifact/runtime-values'
import type { ArtifactCsvComparisonPage, ArtifactCsvComparisonReturnCards } from '@agentrans/artifact-followup/types'
import { createSnapshotStore } from '@agentrans/client-store'
import { bindSnapshotSelector, makeTranslate, sessionSnapshot } from '@agentrans/client-test-runtime'
import { MessageId } from '@agentrans/llm/brand'
import { SessionId } from '@agentrans/session/types'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ArtifactPromptContext, ArtifactPromptContextDock } from '../src/client/ArtifactPromptContext.tsx'
import { CsvComparisonImport, type LoadCsvComparisonImport } from '../src/client/CsvComparisonImport.tsx'
import { CsvAttachedComparison } from '../src/client/CsvQuestionComparison.tsx'
import { CsvComparisonContextNode } from '../src/client/QuestionContextMessage.tsx'
import { csvSentQuestionFocus, type CsvComparisonSourceTrail } from '../src/client/csv-comparison-draft.ts'
import { en } from '../src/client/locales.ts'
import type { ArtifactPromptBinding } from '../src/client/particle-runtime-owner.ts'
import { csvComparisonContextTextRule } from '../src/client/question-context-text.ts'

const original = { groupKey: 'Warm', aggregate: 'mean', value: 30, count: 2, valueColumn: 'LatencyMs' } as const
const page: ArtifactCsvComparisonPage = {
  original, current: { ...original, aggregate: 'sum', value: 60 },
  kept: 1, excluded: 1, added: 1, total: 3, offset: 0, rows: [
    { record: 4, status: 'excluded', value: '25' }, { record: 5, status: 'kept', value: '35' },
    { record: 6, status: 'added', value: '25' },
  ],
}
const returnCards: ArtifactCsvComparisonReturnCards = {
  first: { title: 'Mean latency', revision: 1, groupBy: 'Trial', conclusion: ['Warm mean 30 ms.', '<script>Visible only as text</script>'],
    groups: [{ key: 'Warm', value: 30, count: 2 }, { key: 'Cold', value: 50, count: 2 }] },
  second: { title: 'Total latency', revision: 2, groupBy: 'Trial', conclusion: ['Warm total 60 ms.'],
    groups: [{ key: 'Warm', value: 60, count: 2 }, { key: 'Cold', value: 100, count: 2 }] },
}
const t = makeTranslate(en)

afterEach(cleanup)

function readAttribution(): void {
  expect(screen.getByText('User imported', { exact: true })).toBeDefined()
  expect(screen.getByText('JSON comparison with two original return cards', { exact: true })
    .getAttribute('data-csv-import-source')).toBe('return-comparison')
}

function readEmbeddedCards(): void {
  readAttribution()
  const first = document.querySelector<HTMLDetailsElement>('[data-csv-imported-return-card="first"]')!
  const second = document.querySelector<HTMLDetailsElement>('[data-csv-imported-return-card="second"]')!
  expect(first.open).toBe(false)
  expect(second.open).toBe(false)
  fireEvent.click(within(first).getByText('Earlier return', { selector: 'summary' }))
  expect(first.open).toBe(true)
  expect(second.open).toBe(false)
  expect(first.querySelector('[data-csv-return-title]')?.textContent).toBe('Mean latency')
  expect(first.querySelector('[data-csv-return-revision]')?.textContent).toBe('Revision 1')
  expect(first.querySelector('[data-csv-return-reading] [data-csv-reading="value"]')?.textContent).toBe('30')
  expect(first.querySelector('[data-csv-return-conclusion]')?.textContent).toBe(returnCards.first.conclusion.join(''))
  expect(first.querySelector('script')).toBeNull()
  expect(within(first).getByRole('row', { name: 'Cold 50 2' })).toBeDefined()
  expect(within(first).getByRole('row', { name: '4 25' })).toBeDefined()
  expect(within(first).getByRole('row', { name: '5 35' })).toBeDefined()
  expect(first.querySelector('[data-csv-return-record="6"]')).toBeNull()
  fireEvent.click(within(second).getByText('Later return', { selector: 'summary' }))
  expect(first.open).toBe(true)
  expect(second.open).toBe(true)
  expect(second.querySelector('[data-csv-return-revision]')?.textContent).toBe('Revision 2')
  expect(second.querySelector('[data-csv-return-reading] [data-csv-reading="value"]')?.textContent).toBe('60')
  expect(second.querySelector('[data-csv-return-conclusion]')?.textContent).toBe('Warm total 60 ms.')
  expect(within(second).getByRole('row', { name: 'Cold 100 2' })).toBeDefined()
  expect(within(second).getByRole('row', { name: '5 35' })).toBeDefined()
  expect(within(second).getByRole('row', { name: '6 25' })).toBeDefined()
  expect(second.querySelector('[data-csv-return-record="4"]')).toBeNull()
  expect(document.querySelector('[data-csv-return-source]')).toBeNull()
}

it('reviews the imported source cards before explicit attachment confirmation', async () => {
  const confirm = vi.fn(async () => true)
  const load = vi.fn<LoadCsvComparisonImport>().mockResolvedValue({ page, returnCards, replacesContext: false, confirm })
  const view = render(<CsvComparisonImport load={load} disabled={false} t={t} />)
  const input = view.container.querySelector<HTMLInputElement>('[data-csv-import-comparison-input]')!
  const file = new File(['{}'], 'pair.json', { type: 'application/json' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('{}').buffer })
  fireEvent.change(input, { target: { files: [file] } })
  await screen.findByRole('region', { name: 'Review comparison to attach' })
  readEmbeddedCards()
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Attach comparison' }))
  await waitFor(() => { expect(screen.queryByRole('region', { name: 'Review comparison to attach' })).toBeNull() })
  expect(confirm).toHaveBeenCalledOnce()
})

it('keeps the two imported cards in draft and sent replay without local return links', () => {
  const sessionId = SessionId('destination')
  const snapshot = sessionSnapshot(sessionId)
  const view = render(<ArtifactPromptContext t={t} useSession={selector => selector(snapshot)} clearArtifactPromptContext={vi.fn()}
    useArtifactPromptContext={selector => selector({ kind: 'csv-question-comparison', draft: { receiptId: 'confirmed-import', facts: {
      kind: 'csv-question-comparison', sessionId, attribution: 'user-imported', comparison: page, returnCards,
    } } })} />)
  readAttribution()
  expect(document.querySelector('[data-csv-imported-return-card]')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Review attached comparison' }))
  readEmbeddedCards()
  view.unmount()

  const openReturnedSource = vi.fn()
  render(<CsvAttachedComparison page={page} userImported returnCards={returnCards} openReturnedSource={openReturnedSource} t={t} />)
  readAttribution()
  fireEvent.click(screen.getByRole('button', { name: 'Replay attached comparison' }))
  readEmbeddedCards()
  expect(openReturnedSource).not.toHaveBeenCalled()
})

it('reviews the whole imported return comparison before attaching it again', async () => {
  const confirm = vi.fn(async () => true)
  const openReturnedSource = vi.fn()
  const reviewSent = vi.fn(() => ({ replacesContext: true, confirm }))
  render(<CsvAttachedComparison page={page} userImported returnCards={returnCards} openReturnedSource={openReturnedSource}
    reviewSent={reviewSent} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: 'Replay attached comparison' }))
  const reuse = screen.getByRole('button', { name: 'Reuse entire return comparison' })
  expect(reuse.hasAttribute('data-csv-reuse-entire-return-comparison')).toBe(true)
  expect(reuse.hasAttribute('data-csv-compare-reuse')).toBe(false)
  expect(reuse.hasAttribute('data-csv-reuse-entire-explanation')).toBe(false)
  fireEvent.click(reuse)

  const review = screen.getByRole('region', { name: 'Review comparison to attach' })
  expect(review.querySelectorAll('[data-csv-imported-return-card]')).toHaveLength(2)
  expect(within(review).getByText(en['csvCompare.replaceContext'])).toBeDefined()
  readEmbeddedCards()
  expect(reviewSent).toHaveBeenCalledOnce()
  expect(confirm).not.toHaveBeenCalled()
  expect(openReturnedSource).not.toHaveBeenCalled()
  fireEvent.click(within(review).getByRole('button', { name: 'Attach comparison' }))
  await screen.findByText(en['csvCompare.attached'])
  expect(confirm).toHaveBeenCalledOnce()
})

it('opens the exact sent imported comparison source only with history access and a verified visit', () => {
  const sessionId = SessionId('destination')
  const reusedFrom = { eventSeq: 20, messageId: MessageId('source-comparison') }
  const messageRef = { eventSeq: 30, messageId: MessageId('reused-comparison') }
  const raw = IMPORTED_CSV_COMPARISON_QUESTION_PREFIX + JSON.stringify({
    kind: 'artifact-question-context', sessionId,
    facts: { kind: 'csv-question-comparison', sessionId, attribution: 'user-imported', comparison: page, returnCards, reusedFrom },
  })
  const node = csvComparisonContextTextRule.match(raw, 0, { read: () => undefined })
  if (node?.id !== 'artifact-csv-comparison-context') throw new Error('Missing imported comparison text')
  expect(node.data.reusedFrom).toEqual(reusedFrom)
  const openView = vi.fn()
  const visitCsvComparisonSource = vi.fn(() => false).mockReturnValueOnce(false).mockReturnValueOnce(true)
  const props = { node, raw, sessionId, interactive: true, messageRef, openView, t, visitCsvComparisonSource,
    useAccess: () => false, useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot(sessionId))),
    useReturnToCsvDraft: () => false, useCsvHistoryDraftPhase: () => true, useCsvExplanationSelection: () => undefined,
    useCsvComparisonSourceTrail: () => undefined, useCsvComparisonSourceRecovery: () => undefined,
  } as unknown as ComponentProps<typeof CsvComparisonContextNode>
  const view = render(<CsvComparisonContextNode {...props} />)
  const source = { name: 'View source question' }
  fireEvent.click(screen.getByRole('button', { name: 'Replay attached comparison' }))
  expect(screen.queryByRole('button', source)).toBeNull()

  view.rerender(<CsvComparisonContextNode {...props} useAccess={method => method === 'session/events'} />)
  const action = screen.getByRole('button', source)
  fireEvent.click(action)
  expect(visitCsvComparisonSource).toHaveBeenCalledExactlyOnceWith({
    source: reusedFrom, origin: { kind: 'comparison', message: messageRef }, sourceKind: 'imported-return-comparison',
  })
  expect(openView).not.toHaveBeenCalled()
  fireEvent.click(action)
  expect(openView).toHaveBeenCalledExactlyOnceWith('chat', csvSentQuestionFocus(reusedFrom))
  expect(view.container.querySelector('[data-csv-return-source]')).toBeNull()
})

it('requires history access to preview or restore an imported return draft source chain', async () => {
  const sessionId = SessionId('destination')
  const session = sessionSnapshot(sessionId)
  const source = { eventSeq: 20, messageId: MessageId('source-comparison') }
  const earlier = { eventSeq: 10, messageId: MessageId('earlier-comparison') }
  const receiptId = 'imported-return-draft'
  const selection = { start: 4, end: 4, draftRev: -1 }
  const binding = { kind: 'csv-question-comparison', draft: { receiptId, facts: {
    kind: 'csv-question-comparison', sessionId, attribution: 'user-imported', comparison: page, returnCards, reusedFrom: source,
  } } } as const satisfies ArtifactPromptBinding
  const trail: CsvComparisonSourceTrail = [
    { source, origin: { kind: 'draft', receiptId, selection }, sourceKind: 'imported-return-comparison' },
    { source: earlier, origin: { kind: 'comparison', message: source }, sourceKind: 'imported-return-comparison' },
  ]
  const openView = vi.fn()
  const restoreCsvSourceTrail = vi.fn<ComponentProps<typeof ArtifactPromptContextDock>['restoreCsvSourceTrail']>(
    (_trail, _signal, open) => { open(earlier) },
  )
  const loadCsvSourceChain = vi.fn<ComponentProps<typeof ArtifactPromptContextDock>['loadCsvSourceChain']>()
    .mockResolvedValue({ status: 'complete', sources: [source, earlier] })
  const props = {
    t, openView, session, restoreCsvSourceTrail, loadCsvSourceChain,
    useSession: bindSnapshotSelector(createSnapshotStore(session)),
    usePendingCsvComparisonSourceTrail: bindSnapshotSelector(createSnapshotStore(trail)),
    useArtifactPromptContext: bindSnapshotSelector(createSnapshotStore(binding)),
    useAccess: (method: string) => method !== 'session/events',
    useCsvComparisonDraft: () => 'ready', useCsvComparisonDraftOutcome: () => undefined,
    useCsvComparisonDraftCleanupFailed: () => false, useCsvComparisonSourceRecovery: () => undefined,
    inputActions: { captureInsertion: () => selection }, sourceQuestionLabel: () => undefined,
  } as unknown as ComponentProps<typeof ArtifactPromptContextDock>
  const view = render(<ArtifactPromptContextDock {...props} />)
  const preview = { name: 'View full source chain' }
  expect(screen.queryByRole('button', preview)).toBeNull()
  expect(restoreCsvSourceTrail).not.toHaveBeenCalled()
  expect(openView).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Review attached comparison' }))
  expect(view.container.querySelectorAll('[data-csv-imported-return-card]')).toHaveLength(2)

  view.rerender(<ArtifactPromptContextDock {...props} useAccess={() => true} />)
  expect(restoreCsvSourceTrail).toHaveBeenCalledExactlyOnceWith(trail, expect.any(AbortSignal), expect.any(Function))
  expect(openView).toHaveBeenCalledExactlyOnceWith('chat', csvSentQuestionFocus(earlier))
  expect(loadCsvSourceChain).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', preview))
  const dialog = within(screen.getByRole('dialog', { name: 'Source chain' }))
  await dialog.findByRole('list')
  expect(loadCsvSourceChain).toHaveBeenCalledExactlyOnceWith(source, receiptId, expect.any(AbortSignal))
  expect(dialog.getAllByRole('listitem').map(row => row.getAttribute('data-csv-source-message-id')))
    .toEqual([source.messageId, earlier.messageId])
})
