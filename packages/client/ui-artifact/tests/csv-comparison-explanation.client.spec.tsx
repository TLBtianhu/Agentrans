// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  CSV_COMPARISON_EXPLANATION_PREFIX, CSV_COMPARISON_QUESTION_PREFIX, IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX,
  IMPORTED_CSV_EXPLANATION_SOURCE_TEXT, IMPORTED_CSV_RETURN_SOURCE_TEXT, IMPORTED_CSV_SINGLE_SOURCE_TEXT,
} from '@agentrans/artifact/runtime-values'
import type { ArtifactId } from '@agentrans/artifact/types'
import type { ArtifactCsvComparisonAttachment } from '@agentrans/artifact-followup/types'
import { bindSnapshotSelector, makeTranslate, sessionSnapshot } from '@agentrans/client-test-runtime'
import { createSnapshotStore } from '@agentrans/client-store'
import { MessageId } from '@agentrans/llm/brand'
import { SessionId } from '@agentrans/session/types'
import { CsvAttachedComparison } from '../src/client/CsvQuestionComparison.tsx'
import { CsvComparisonImport, type LoadCsvComparisonImport } from '../src/client/CsvComparisonImport.tsx'
import { ArtifactPromptContextDock } from '../src/client/ArtifactPromptContext.tsx'
import { CsvComparisonContextNode } from '../src/client/QuestionContextMessage.tsx'
import { csvSentQuestionFocus, type CsvComparisonSourceTrail, type CsvComparisonSourceVisit } from '../src/client/csv-comparison-draft.ts'
import { CsvExplanationSelectionOwner } from '../src/client/csv-comparison-explanation.ts'
import { en } from '../src/client/locales.ts'
import type { ArtifactPromptBinding } from '../src/client/particle-runtime-owner.ts'
import { csvComparisonContextTextRule } from '../src/client/question-context-text.ts'

const t = makeTranslate(en)
const sessionId = SessionId('saved-explanation-session')
const aggregation = { eventSeq: 16, messageId: MessageId('aggregation-question') }
const filtering = { eventSeq: 22, messageId: MessageId('filtering-question') }
const reading = { groupKey: 'Warm', valueColumn: 'LatencyMs', aggregate: 'mean', value: 30, count: 2 } as const
const summed = { ...reading, aggregate: 'sum', value: 60 } as const
const aggregatePage = { original: reading, current: summed, kept: 2, excluded: 0, added: 0, total: 2, offset: 0,
  rows: [{ record: 4, status: 'kept', value: '25' }, { record: 5, status: 'kept', value: '35' }] } as const
const filteredPage = { ...aggregatePage, current: { ...summed, value: 35, count: 1, filter: { column: 'Batch', value: 'B' } },
  kept: 1, excluded: 1, rows: [{ record: 4, status: 'excluded', value: '25', currentFilterValue: 'A' },
    { record: 5, status: 'kept', value: '35', currentFilterValue: 'B' }] } as const
const explanation = { aggregation: { message: aggregation, comparison: aggregatePage }, filtering }
const attachment = { proof: 'opaque', facts: { kind: 'csv-question-comparison', sessionId,
  question: { eventSeq: 12, messageId: MessageId('locked-filter') },
  source: { eventSeq: 9, messageId: MessageId('earlier-return'), artifactId: 'csv-summary' as ArtifactId, revision: 1 },
  comparison: filteredPage, explanation,
} } as const satisfies ArtifactCsvComparisonAttachment

afterEach(cleanup)

it('presents the Host order after reverse selection and saves only on explicit confirmation of the selected review', async () => {
  const owner = new CsvExplanationSelectionOwner()
  const review = vi.fn(async () => attachment)
  const save = vi.fn(async () => true)
  const commands = { current: () => true, replacesContext: true, review, save }
  await owner.select(filtering, commands)
  expect(owner.state.getSnapshot()).toEqual({ phase: 'first', first: filtering })
  expect(review).not.toHaveBeenCalled()
  await owner.select(aggregation, commands)
  expect(review).toHaveBeenCalledExactlyOnceWith(filtering, aggregation)
  expect(owner.state.getSnapshot()).toEqual({ phase: 'review', first: filtering, second: aggregation,
    preview: { page: filteredPage, explanation, replacesContext: true } })
  await owner.confirm(filtering)
  expect(save).not.toHaveBeenCalled()
  await owner.confirm(aggregation)
  expect(save).toHaveBeenCalledExactlyOnceWith(attachment)
  expect(owner.state.getSnapshot()).toBeUndefined()
})

it('discards a late preview after the Session seat leaves and ignores a stale confirm on reentry', async () => {
  const owner = new CsvExplanationSelectionOwner()
  const delayed = Promise.withResolvers<ArtifactCsvComparisonAttachment>()
  const review = vi.fn<() => Promise<ArtifactCsvComparisonAttachment>>().mockReturnValueOnce(delayed.promise)
  const save = vi.fn(async () => true)
  const commands = { current: () => true, replacesContext: false, review, save }
  await owner.select(filtering, commands)
  const abandoned = owner.select(aggregation, commands)
  expect(owner.state.getSnapshot()?.phase).toBe('loading')
  owner.clear()
  await owner.select(filtering, commands)
  delayed.resolve(attachment)
  await abandoned
  await owner.confirm(aggregation)
  expect(owner.state.getSnapshot()).toEqual({ phase: 'first', first: filtering })
  expect(save).not.toHaveBeenCalled()
})

it('replays ordered readings, opens their exact originals, and downloads the sent explanation in both formats', async () => {
  const canonical = JSON.stringify({ kind: 'artifact-question-context', sessionId, facts: attachment.facts })
  const raw = CSV_COMPARISON_EXPLANATION_PREFIX + canonical
  const facts = { read: () => undefined }
  expect(csvComparisonContextTextRule.match(CSV_COMPARISON_QUESTION_PREFIX + canonical, 0, facts)).toBeUndefined()
  const node = csvComparisonContextTextRule.match(raw, 0, facts)
  if (node?.id !== 'artifact-csv-comparison-context') throw new Error('Missing paired replay')
  const openView = vi.fn()
  const messageRef = { eventSeq: 28, messageId: MessageId('sent-pair') }
  const visitCsvComparisonSource = vi.fn(() => true)
  const downloadSentCsvComparison = vi.fn<ComponentProps<typeof CsvComparisonContextNode>['downloadSentCsvComparison']>()
    .mockResolvedValue({ status: 'requested' })
  const props = { node, raw, sessionId, interactive: true, messageRef, visitCsvComparisonSource, downloadSentCsvComparison,
    openView, t, useAccess: () => true, useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot(sessionId))),
    useReturnToCsvDraft: () => false, useCsvHistoryDraftPhase: () => true, useCsvExplanationSelection: () => undefined,
    useCsvComparisonSourceTrail: () => undefined, useCsvComparisonSourceRecovery: () => undefined,
  } as unknown as ComponentProps<typeof CsvComparisonContextNode>
  const view = render(<CsvComparisonContextNode {...props} />)
  const downloadExplanation = { name: 'Download explanation as HTML' }
  expect(screen.queryByRole('button', downloadExplanation)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Replay attached comparison' }))
  const first = screen.getByRole('region', { name: 'First change aggregation' })
  const second = screen.getByRole('region', { name: 'Then add filter' })
  const values = (step: HTMLElement): Array<string | null> => Array.from(step.querySelectorAll('[data-csv-reading="value"]'),
    item => item.textContent)
  expect(values(first)).toEqual(['30', '60'])
  expect(values(second)).toEqual(['60', '35'])
  expect(within(first).getByText('Calculation method changed')).toBeDefined()
  expect(within(second).queryByText('Calculation method changed')).toBeNull()
  expect(within(second).getByText('Filter changed')).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Reuse comparison in next question' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Reuse entire explanation' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Download comparison as HTML' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Download comparison as JSON' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Select for two-step explanation' })).toBeNull()
  fireEvent.click(within(first).getByRole('button', { name: 'View source question' }))
  fireEvent.click(within(second).getByRole('button', { name: 'View source question' }))
  expect(visitCsvComparisonSource.mock.calls).toEqual([
    [{ source: aggregation, origin: { kind: 'explanation', message: messageRef, step: 'aggregation' } }],
    [{ source: filtering, origin: { kind: 'explanation', message: messageRef, step: 'filtering' } }],
  ])
  expect(openView.mock.calls).toEqual([['chat', csvSentQuestionFocus(aggregation)], ['chat', csvSentQuestionFocus(filtering)]])
  expect(downloadSentCsvComparison).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', downloadExplanation))
  expect(downloadSentCsvComparison).toHaveBeenCalledExactlyOnceWith(messageRef, 'html')
  await screen.findByText(en['export.requested'])
  fireEvent.click(screen.getByRole('button', { name: 'Download explanation as JSON' }))
  expect(downloadSentCsvComparison).toHaveBeenLastCalledWith(messageRef, 'json')
  await screen.findByText(en['csvCompare.jsonDownloadRequested'])
  view.rerender(<CsvComparisonContextNode {...props}
    useAccess={endpoint => endpoint !== 'artifactBranchResults/exportSentCsvComparison'} />)
  expect(screen.queryByRole('button', downloadExplanation)).toBeNull()
  view.rerender(<CsvAttachedComparison page={filteredPage} explanation={explanation} draft t={t}
    downloadSent={() => downloadSentCsvComparison(messageRef, 'html')} />)
  fireEvent.click(screen.getByRole('button', { name: 'Review attached comparison' }))
  expect(values(screen.getByRole('region', { name: 'First change aggregation' }))).toEqual(['30', '60'])
  expect(values(screen.getByRole('region', { name: 'Then add filter' }))).toEqual(['60', '35'])
  expect(screen.queryByRole('button', downloadExplanation)).toBeNull()
})

it('reviews imported transitions and exact pages, preserving the same data in draft and immutable sent replay', async () => {
  const portableExplanation = { aggregation: { comparison: aggregatePage } }
  const facts = { kind: 'csv-question-comparison', sessionId, provenance: 'user-imported', comparison: filteredPage,
    explanation: portableExplanation } as const
  const context = { kind: 'artifact-question-context', sessionId, facts }
  const canonical = IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX + JSON.stringify(context)
  const source = IMPORTED_CSV_EXPLANATION_SOURCE_TEXT
  const raw = canonical + source
  const parse = (text: string) => csvComparisonContextTextRule.match(text, 0, { read: () => undefined })
  expect(parse(IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX + JSON.stringify({ ...context, facts: { ...facts, explanation } }) + source))
    .toBeUndefined()
  expect(parse(CSV_COMPARISON_EXPLANATION_PREFIX + JSON.stringify(context))).toBeUndefined()
  expect(parse(canonical)?.end).toBe(canonical.length)
  for (const unmatched of [source.slice(0, -1), source + ' Extra unrecognized text.', '\nSeparate note.' + source,
    IMPORTED_CSV_RETURN_SOURCE_TEXT, IMPORTED_CSV_SINGLE_SOURCE_TEXT]) {
    expect(parse(canonical + unmatched)?.end).toBe(canonical.length)
  }
  const native = CSV_COMPARISON_EXPLANATION_PREFIX + JSON.stringify({ ...context, facts: attachment.facts })
  expect(parse(native + source)?.end).toBe(native.length)
  expect(parse(source)).toBeUndefined()
  const question = 'What changed at each step?'
  const node = parse(question + raw)
  if (node?.id !== 'artifact-csv-comparison-context') throw new Error('Missing imported explanation')
  expect([node.start, node.end]).toEqual([question.length, question.length + raw.length])
  expect(node.data.explanation).toEqual(portableExplanation)

  const assertAttribution = (): void => {
    expect(screen.getByText('User imported')).toBeDefined()
    expect(screen.getByText('JSON two-step explanation with two original locked pages')
      .getAttribute('data-csv-import-source')).toBe('two-step-explanation')
  }
  const assertSteps = (): void => {
    assertAttribution()
    expect(screen.queryByRole('button', { name: 'View source question' })).toBeNull()
    const first = screen.getByRole('region', { name: 'First change aggregation' })
    const second = screen.getByRole('region', { name: 'Then add filter' })
    const values = (step: HTMLElement, selector: string): Array<string | null> =>
      Array.from(step.querySelectorAll(`${selector} [data-csv-reading="value"]`), item => item.textContent)
    expect(values(first, '[data-csv-explanation-transition]')).toEqual(['30', '60'])
    expect(values(second, '[data-csv-explanation-transition]')).toEqual(['60', '35'])
    const firstDetails = first.querySelector<HTMLDetailsElement>('[data-csv-explanation-original]')
    const secondDetails = second.querySelector<HTMLDetailsElement>('[data-csv-explanation-original]')
    expect(firstDetails?.open).toBe(false)
    expect(secondDetails?.open).toBe(false)
    fireEvent.click(within(first).getByText('View locked source comparison'))
    expect(firstDetails?.open).toBe(true)
    expect(secondDetails?.open).toBe(false)
    expect(values(first, '[data-csv-explanation-original]')).toEqual(['30', '60'])
    fireEvent.click(within(second).getByText('View locked source comparison'))
    expect(secondDetails?.open).toBe(true)
    expect(values(second, '[data-csv-explanation-original]')).toEqual(['30', '35'])
    expect(secondDetails?.querySelector('[data-csv-compare-record="4"]')?.getAttribute('data-csv-compare-status')).toBe('excluded')
  }

  const confirm = vi.fn(async () => true)
  const load = vi.fn<LoadCsvComparisonImport>().mockResolvedValue({ page: filteredPage, explanation: portableExplanation,
    replacesContext: true, confirm })
  const view = render(<CsvComparisonImport load={load} disabled={false} t={t} />)
  const json = '{"format":"agentrans-csv-comparison-explanation","version":1}'
  const file = new File([json], 'pair.json', { type: 'application/json' })
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(new TextEncoder().encode(json).buffer) })
  const input = view.container.querySelector('input')
  if (input === null) throw new Error('Missing file picker')
  fireEvent.change(input, { target: { files: [file] } })
  await screen.findByRole('region', { name: 'Review comparison to attach' })
  expect(load).toHaveBeenCalledExactlyOnceWith(json, expect.any(AbortSignal))
  assertSteps()
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Attach comparison' }))
  await vi.waitFor(() => { expect(confirm).toHaveBeenCalledOnce() })

  view.rerender(<CsvAttachedComparison page={filteredPage} explanation={portableExplanation} userImported draft t={t} />)
  assertAttribution()
  fireEvent.click(screen.getByRole('button', { name: 'Review attached comparison' }))
  assertSteps()

  const openView = vi.fn()
  const downloadSentCsvComparison = vi.fn<ComponentProps<typeof CsvComparisonContextNode>['downloadSentCsvComparison']>()
    .mockResolvedValue({ status: 'requested' })
  const confirmReuse = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
  const reviewSentCsvComparison = vi.fn<ComponentProps<typeof CsvComparisonContextNode>['reviewSentCsvComparison']>()
    .mockReturnValue({ replacesContext: true, confirm: confirmReuse })
  const messageRef = { eventSeq: 40, messageId: MessageId('imported-pair') }
  const props = { node, raw, sessionId, interactive: true, messageRef, openView, t, downloadSentCsvComparison, reviewSentCsvComparison,
    useAccess: () => true, useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot(sessionId))),
    useReturnToCsvDraft: () => false, useCsvHistoryDraftPhase: () => true, useCsvExplanationSelection: () => undefined,
    useCsvComparisonSourceTrail: () => undefined, useCsvComparisonSourceRecovery: () => undefined,
  } as unknown as ComponentProps<typeof CsvComparisonContextNode>
  view.rerender(<CsvComparisonContextNode {...props} />)
  expect(view.container.querySelector('details')?.open).toBe(false)
  assertAttribution()
  fireEvent.click(screen.getByRole('button', { name: 'Replay attached comparison' }))
  assertSteps()
  expect(view.container.querySelector('[data-artifact-question-context-raw]')?.textContent).toBe(raw)
  fireEvent.click(screen.getByRole('button', { name: 'Download explanation as JSON' }))
  expect(downloadSentCsvComparison).toHaveBeenCalledExactlyOnceWith(messageRef, 'json')
  expect(openView).not.toHaveBeenCalled()
  await screen.findByText(en['csvCompare.jsonDownloadRequested'])
  const reuse = { name: 'Reuse entire explanation' }
  const review = { name: 'Review comparison to attach' }
  expect(screen.getByRole('button', reuse).hasAttribute('data-csv-reuse-entire-explanation')).toBe(true)
  fireEvent.click(screen.getByRole('button', reuse))
  expect(reviewSentCsvComparison).toHaveBeenCalledExactlyOnceWith(messageRef, filteredPage, portableExplanation)
  expect(within(screen.getByRole('region', review)).getByText('Confirming will replace the selected question context.')).toBeDefined()
  assertSteps()
  expect(confirmReuse).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('region', review)).toBeNull()
  expect(confirmReuse).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', reuse))
  assertSteps()
  fireEvent.click(screen.getByRole('button', { name: 'Attach comparison' }))
  await screen.findByText('Selected for the next question.')
  expect(confirmReuse).toHaveBeenCalledOnce()
})

it('only offers return on the active source and focuses the exact departure step on the pair', () => {
  const { explanation: _pair, ...recorded } = attachment.facts
  const raw = CSV_COMPARISON_QUESTION_PREFIX + JSON.stringify({ kind: 'artifact-question-context', sessionId, facts: recorded })
  const node = csvComparisonContextTextRule.match(raw, 0, { read: () => undefined })
  if (node?.id !== 'artifact-csv-comparison-context') throw new Error('Missing source replay')
  const openView = vi.fn()
  const trail = createSnapshotStore<CsvComparisonSourceTrail | undefined>(undefined)
  const message = { eventSeq: 28, messageId: MessageId('sent-pair') }
  const visit = (source: typeof aggregation, step: 'aggregation' | 'filtering'): CsvComparisonSourceVisit => ({
    origin: { kind: 'explanation', message, step }, source,
  })
  const returnFromCsvComparisonSource = vi.fn((target: CsvComparisonSourceVisit) => {
    if (target.origin.kind !== 'explanation') throw new Error('Unexpected origin')
    trail.set(undefined)
    return target.origin.message
  })
  const props = { node, raw, sessionId, interactive: true, openView, returnFromCsvComparisonSource, t,
    useAccess: (action: string) => action === 'session/events',
    useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot(sessionId))),
    useReturnToCsvDraft: () => false, useCsvHistoryDraftPhase: () => true, useCsvExplanationSelection: () => undefined,
    useCsvComparisonSourceTrail: bindSnapshotSelector(trail), useCsvComparisonSourceRecovery: () => undefined,
    sourceQuestionLabel: () => 'How did the reading change?',
  } as unknown as ComponentProps<typeof CsvComparisonContextNode>
  render(<>
    <div data-testid="aggregation"><CsvComparisonContextNode {...props} messageRef={aggregation} /></div>
    <div data-testid="filtering"><CsvComparisonContextNode {...props} messageRef={filtering} /></div>
    <div data-testid="same-seq"><CsvComparisonContextNode {...props}
      messageRef={{ ...aggregation, messageId: MessageId('different-message') }} /></div>
  </>)
  const name = { name: 'Return to two-step explanation' }
  for (const toggle of screen.getAllByRole('button', { name: 'Replay attached comparison' })) fireEvent.click(toggle)
  expect(screen.queryByRole('button', name)).toBeNull()
  for (const [source, step] of [[aggregation, 'aggregation'], [filtering, 'filtering']] as const) {
    const current = visit(source, step)
    act(() => { trail.set([current]) })
    const sourceCard = within(screen.getByTestId(step))
    expect(screen.getAllByRole('button', name)).toHaveLength(1)
    expect(sourceCard.getByRole('navigation', { name: 'Source path' }).querySelector('[data-csv-source-trail-stop]')
      ?.getAttribute('data-csv-source-message-id')).toBe(message.messageId)
    fireEvent.click(sourceCard.getByRole('button', name))
    expect(openView).toHaveBeenLastCalledWith('chat', csvSentQuestionFocus(message, step))
    expect(returnFromCsvComparisonSource).toHaveBeenLastCalledWith(current)
    expect(screen.queryByRole('button', name)).toBeNull()
  }
})

it('opens each exact source from the paired draft with its own captured caret and the same receipt', () => {
  const draft = { receiptId: 'reviewed-pair', facts: attachment.facts }
  const context = { kind: 'csv-question-comparison', draft } satisfies ArtifactPromptBinding
  const selection = createSnapshotStore<ArtifactPromptBinding | null>(context)
  const session = sessionSnapshot(sessionId)
  const openView = vi.fn()
  const firstCaret = { start: 6, end: 6, draftRev: 3 }
  const secondCaret = { start: 9, end: 9, draftRev: 4 }
  const captureInsertion = vi.fn<() => typeof firstCaret>().mockReturnValueOnce(firstCaret).mockReturnValueOnce(secondCaret)
  const visitCsvDraftSource = vi.fn<ComponentProps<typeof ArtifactPromptContextDock>['visitCsvDraftSource']>()
    .mockImplementation((_source, _receipt, _caret, open) => { open() })
  const props = {
    session, t, openView, visitCsvDraftSource, inputActions: { captureInsertion }, useAccess: () => true,
    useSession: bindSnapshotSelector(createSnapshotStore(session)), useArtifactPromptContext: bindSnapshotSelector(selection),
    useCsvComparisonDraft: () => 'ready', useCsvComparisonDraftOutcome: () => undefined,
    useCsvComparisonDraftCleanupFailed: () => false, usePendingCsvComparisonSourceTrail: () => undefined,
    useCsvComparisonSourceRecovery: () => undefined,
  } as unknown as ComponentProps<typeof ArtifactPromptContextDock>
  const view = render(<ArtifactPromptContextDock {...props} />)
  const openSource = { name: 'View source question' }
  expect(screen.queryByRole('button', openSource)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Review attached comparison' }))
  const aggregateStep = within(screen.getByRole('region', { name: 'First change aggregation' }))
  const filterStep = within(screen.getByRole('region', { name: 'Then add filter' }))
  fireEvent.click(aggregateStep.getByRole('button', openSource))
  fireEvent.click(filterStep.getByRole('button', openSource))
  expect(visitCsvDraftSource.mock.calls).toEqual([
    [aggregation, draft.receiptId, firstCaret, expect.any(Function), 'aggregation'],
    [filtering, draft.receiptId, secondCaret, expect.any(Function), 'filtering'],
  ])
  expect(openView.mock.calls).toEqual([['chat', csvSentQuestionFocus(aggregation)], ['chat', csvSentQuestionFocus(filtering)]])
  expect(selection.getSnapshot()).toBe(context)

  view.rerender(<ArtifactPromptContextDock {...props} useAccess={endpoint => endpoint !== 'session/events'} />)
  expect(screen.queryByRole('button', openSource)).toBeNull()
  expect(selection.getSnapshot()).toBe(context)
})
