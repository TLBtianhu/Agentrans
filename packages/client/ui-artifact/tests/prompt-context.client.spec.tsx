// @vitest-environment jsdom
import type { SessionEvent, SessionId } from '@agentrans/session/types'
import { sessionSnapshot } from '@agentrans/client-test-runtime'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { bindSnapshotSelector, makeTranslate } from '@agentrans/client-test-runtime'
import { createSnapshotStore } from '@agentrans/client-store'
import { MessageId } from '@agentrans/llm/brand'
import type { ArtifactId, ArtifactObservationId, ArtifactSnapshot, SavedParticleObservation, SceneArtifactSnapshot } from '@agentrans/artifact/types'
import { restoreParticleCheckpoint, observeParticleState } from '@agentrans/artifact/particle-runtime'
import { ArtifactInteractionOwner, particleQuestionReadings, particleRuntimeKey, type ArtifactPromptBinding } from '../src/client/particle-runtime-owner.ts'
import { ArtifactPromptContext, ArtifactPromptContextDock } from '../src/client/ArtifactPromptContext.tsx'
import { CsvSourceChain } from '../src/client/CsvSourceChain.tsx'
import type { CsvComparisonSourceRecovery } from '../src/client/csv-comparison-source-chain.ts'
import type {
  CsvComparisonDraftOutcome, CsvComparisonDraftPhase, CsvComparisonSourceTrail, CsvComparisonSourceVisit,
} from '../src/client/csv-comparison-draft.ts'
import { ArtifactCard } from './runtime-harness.tsx'
import { ArtifactCard as ArtifactCardView } from '../src/client/ArtifactNodeView.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)
const artifact: SceneArtifactSnapshot = {
  artifactId: 'experiment' as ArtifactId, revision: 1, format: 'scene', title: 'Experiment A', presentation: 'inline',
  spec: { kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 1, vx: 3, vy: 8, mass: 1 }],
    gravity: { x: 0, y: -9.8 }, timeStep: 1 / 30, trails: true },
}
const key = particleRuntimeKey('artifact:experiment', artifact.artifactId)

function bench() {
  const source = createSnapshotStore<ArtifactSnapshot | undefined>(artifact)
  const owner = new ArtifactInteractionOwner(() => source)
  const runtime = owner.runtime(key)
  const release = runtime.subscribe(() => {})
  return { source, owner, runtime, release,
    choose: () => owner.chooseCurrent(key, artifact, particleQuestionReadings(runtime.getSnapshot()!)) }
}

function observation(label: string, source = artifact): SavedParticleObservation {
  if (source.spec.kind !== 'particle-system') throw new Error('Particle source required')
  const checkpoint = { runtimeVersion: 1 as const, stepCount: 6 }
  return { observationId: label as ArtifactObservationId, label, artifact: source, checkpoint,
    values: observeParticleState(restoreParticleCheckpoint(source.spec, checkpoint)) }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('sends a chat focus request only for a verified sent question and does not change the composer', () => {
  const status = createSnapshotStore<CsvComparisonDraftOutcome | undefined>({ status: 'unconfirmed' })
  const openView = vi.fn()
  const selectCsvSentQuestion = vi.fn(() => true)
  const dismiss = vi.fn()
  const clear = vi.fn()
  const recordedMessage = { eventSeq: 12, messageId: MessageId('exact-question') }
  const session = sessionSnapshot('test-session' as SessionId)
  const props = {
    openView, t, useAccess: () => true,
    session, input: { phase: 'plain', draft: 'A new question', draftRev: 3, attachmentIds: [], occurrences: [], queue: [] },
    useSession: bindSnapshotSelector(createSnapshotStore(session)),
    useArtifactPromptContext: bindSnapshotSelector(createSnapshotStore<null>(null)),
    useCsvComparisonDraft: bindSnapshotSelector(createSnapshotStore<CsvComparisonDraftPhase>('ready')),
    useCsvComparisonDraftOutcome: bindSnapshotSelector(status),
    useCsvComparisonDraftCleanupFailed: bindSnapshotSelector(createSnapshotStore(false)),
    usePendingCsvComparisonSourceTrail: () => undefined,
    useCsvComparisonSourceRecovery: () => undefined,
    dismissCsvComparisonDraftOutcome: dismiss, selectCsvSentQuestion, clearArtifactPromptContext: clear,
    restoreCsvComparisonDraft: vi.fn(), retryCsvComparisonDraftCleanup: vi.fn(),
    visitCsvDraftSource: vi.fn(), restoreCsvSourceTrail: vi.fn(),
  } as unknown as ComponentProps<typeof ArtifactPromptContextDock>
  const view = render(<ArtifactPromptContextDock {...props} />)
  const selector = { name: 'View sent question' }
  expect(screen.queryByRole('button', selector)).toBeNull()
  act(() => { status.set({ status: 'accepted', queuedMessageId: recordedMessage.messageId }) })
  expect(screen.getByText('The previous question was sent.')).toBeDefined()
  expect(screen.queryByRole('button', selector)).toBeNull()
  act(() => { status.set({ status: 'accepted', message: recordedMessage }) })
  fireEvent.click(screen.getByRole('button', selector))
  expect(selectCsvSentQuestion).toHaveBeenCalledExactlyOnceWith(recordedMessage)
  expect(openView).toHaveBeenCalledExactlyOnceWith('chat', JSON.stringify({
    kind: 'message', ...recordedMessage, control: 'artifact-csv-comparison',
  }))
  expect(clear).not.toHaveBeenCalled()
  expect(dismiss).not.toHaveBeenCalled()
  const { openView: _navigation, ...withoutNavigation } = props
  view.rerender(<ArtifactPromptContextDock {...withoutNavigation} />)
  expect(screen.queryByRole('button', selector)).toBeNull()
})

it('previews a chosen comparison and discards a late file preview when the composer changes Sessions', async () => {
  const session = { ...sessionSnapshot('import-session' as SessionId), blank: true }
  const comparison = {
    original: { groupKey: 'Warm', value: 30, count: 2, aggregate: 'mean', valueColumn: 'LatencyMs' },
    current: { groupKey: 'Warm', value: 35, count: 1, aggregate: 'sum', valueColumn: 'LatencyMs' },
    kept: 1, excluded: 1, added: 0, total: 2, offset: 1, rows: [{ record: 5, status: 'kept', value: '35' }],
  } as const
  const confirm = vi.fn(async () => true)
  const imported = { page: comparison, replacesContext: true, confirm }
  const late = Promise.withResolvers<typeof imported>()
  const load = vi.fn<ComponentProps<typeof ArtifactPromptContextDock>['loadCsvComparisonImport']>()
    .mockResolvedValueOnce(imported).mockReturnValueOnce(late.promise)
  const props = {
    t, session, useAccess: () => true, loadCsvComparisonImport: load,
    useSession: bindSnapshotSelector(createSnapshotStore(session)),
    useArtifactPromptContext: () => null, useCsvComparisonDraft: () => 'ready',
    useCsvComparisonDraftOutcome: () => undefined, useCsvComparisonDraftCleanupFailed: () => false,
    usePendingCsvComparisonSourceTrail: () => undefined, useCsvComparisonSourceRecovery: () => undefined,
    clearArtifactPromptContext: vi.fn(),
  } as unknown as ComponentProps<typeof ArtifactPromptContextDock>
  const view = render(<ArtifactPromptContextDock {...props} />)
  const picker = (): HTMLInputElement => view.container.querySelector<HTMLInputElement>('[data-csv-import-comparison-input]')!
  fireEvent.change(picker(), { target: { files: [new File(['x'.repeat(65_537)], 'too-large.json')] } })
  expect(screen.getByRole('alert').textContent).toBe('Choose a JSON file no larger than 64 KiB.')
  expect(load).not.toHaveBeenCalled()

  const json = '{"format":"agentrans-csv-comparison","version":1}'
  const choose = (): void => {
    const file = new File([json], 'comparison.json', { type: 'application/json' })
    Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(new TextEncoder().encode(json).buffer) })
    fireEvent.change(picker(), { target: { files: [file] } })
  }
  choose()
  const review = within(await screen.findByRole('region', { name: 'Review comparison to attach' }))
  expect(load).toHaveBeenCalledExactlyOnceWith(json, expect.any(AbortSignal))
  expect(review.getByText('User imported')).toBeDefined()
  expect(review.getByText('JSON comparison with one locked page').getAttribute('data-csv-import-source')).toBe('single-page')
  expect(review.getByText('Confirming will replace the selected question context.')).toBeDefined()
  expect(review.getByRole('row', { name: '5 Kept 35' })).toBeDefined()
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(review.getByRole('button', { name: 'Attach comparison' }))
  expect(confirm).toHaveBeenCalledOnce()
  await vi.waitFor(() => { expect(screen.queryByRole('region', { name: 'Review comparison to attach' })).toBeNull() })

  choose()
  await vi.waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
  const next = sessionSnapshot('other-import-session' as SessionId)
  view.rerender(<ArtifactPromptContextDock {...props} session={next} useSession={bindSnapshotSelector(createSnapshotStore(next))} />)
  expect(load.mock.calls[1]?.[1].aborted).toBe(true)
  await act(async () => { late.resolve(imported) })
  expect(screen.queryByRole('region', { name: 'Review comparison to attach' })).toBeNull()
  expect(confirm).toHaveBeenCalledOnce()
})

it('previews the restored comparison’s source chain before opening an exact question', async () => {
  const sessionId = 'test-session' as SessionId
  const openView = vi.fn()
  const clear = vi.fn()
  const comparison = {
    original: { groupKey: 'Warm', value: 30, count: 2, aggregate: 'mean', valueColumn: 'LatencyMs' },
    current: { groupKey: 'Warm', value: 35, count: 1, aggregate: 'sum', valueColumn: 'LatencyMs' },
    kept: 1, excluded: 1, added: 0, total: 2, offset: 1,
    rows: [{ record: 5, status: 'kept', value: '35' }],
  } as const
  const source = { eventSeq: 17, messageId: MessageId('source-question') }
  const earlier = { eventSeq: 14, messageId: MessageId('earlier-source') }
  const binding = { kind: 'csv-question-comparison', draft: { receiptId: 'retained', facts: {
    kind: 'csv-question-comparison', sessionId, comparison, reusedFrom: source,
    question: { eventSeq: 12, messageId: MessageId('original-question') },
    source: { eventSeq: 8, messageId: MessageId('original-return'), artifactId: artifact.artifactId, revision: 1 },
  } } } as const satisfies ArtifactPromptBinding
  const selection = createSnapshotStore<ArtifactPromptBinding | null>(binding)
  const session = sessionSnapshot(sessionId)
  const caret = { start: 3, end: 3, draftRev: 7 }
  const captureInsertion = vi.fn(() => caret)
  type OpenDraftSource = ComponentProps<typeof ArtifactPromptContextDock>['visitCsvDraftSource']
  const visitCsvDraftSource = vi.fn<OpenDraftSource>((_source, _receiptId, _selection, open) => { open() })
  type OpenDraftChain = ComponentProps<typeof ArtifactPromptContextDock>['visitCsvDraftSourceChain']
  const visitCsvDraftSourceChain = vi.fn<OpenDraftChain>((_sources, _receiptId, _selection, open) => { open() })
  const loadCsvSourceChain = vi.fn<CsvSourceChainLoader>().mockResolvedValue({ sources: [source, earlier], status: 'complete' })
  const props = {
    t, openView, session, clearArtifactPromptContext: clear, useArtifactPromptContext: bindSnapshotSelector(selection),
    input: { phase: 'plain', draft: 'An unsent draft', draftRev: caret.draftRev, attachmentIds: [], occurrences: [], queue: [] },
    useSession: bindSnapshotSelector(createSnapshotStore(session)),
    useAccess: () => true, inputActions: { captureInsertion }, visitCsvDraftSource, visitCsvDraftSourceChain, loadCsvSourceChain,
    sourceQuestionLabel: (question: typeof source) => question.messageId === source.messageId ? 'Check the most recent comparison' : undefined,
    useCsvComparisonDraft: bindSnapshotSelector(createSnapshotStore<CsvComparisonDraftPhase>('ready')),
    useCsvComparisonDraftOutcome: () => undefined,
    useCsvComparisonDraftCleanupFailed: () => false,
    usePendingCsvComparisonSourceTrail: () => undefined,
    useCsvComparisonSourceRecovery: () => undefined,
    restoreCsvSourceTrail: vi.fn(),
    restoreCsvComparisonDraft: vi.fn(), retryCsvComparisonDraftCleanup: vi.fn(),
    dismissCsvComparisonDraftOutcome: vi.fn(), selectCsvSentQuestion: vi.fn(),
  } as unknown as ComponentProps<typeof ArtifactPromptContextDock>
  const view = render(<ArtifactPromptContextDock {...props} />)
  const label = { name: 'View source question' }
  fireEvent.click(screen.getByRole('button', label))
  expect(openView).toHaveBeenCalledExactlyOnceWith('chat', JSON.stringify({ kind: 'message', ...source, control: 'artifact-csv-comparison' }))
  expect(captureInsertion).toHaveBeenCalledOnce()
  expect(visitCsvDraftSource).toHaveBeenCalledExactlyOnceWith(source, 'retained', caret, expect.any(Function))
  expect(clear).not.toHaveBeenCalled()
  expect(selection.getSnapshot()).toBe(binding)
  openView.mockClear()
  captureInsertion.mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'View full source chain' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Source chain' }))
  await dialog.findByRole('list')
  expect(loadCsvSourceChain).toHaveBeenCalledExactlyOnceWith(source, 'retained', expect.any(AbortSignal))
  expect(dialog.getAllByRole('listitem').map(row => row.getAttribute('data-csv-source-message-id')))
    .toEqual([source.messageId, earlier.messageId])
  expect(dialog.getByRole('button', { name: 'Check the most recent comparison' })).toBeDefined()
  expect(visitCsvDraftSourceChain).not.toHaveBeenCalled()
  expect(openView).not.toHaveBeenCalled()
  expect(selection.getSnapshot()).toBe(binding)
  fireEvent.click(dialog.getByRole('button', { name: 'Question 14' }))
  expect(screen.queryByRole('dialog', { name: 'Source chain' })).toBeNull()
  expect(captureInsertion).toHaveBeenCalledOnce()
  expect(visitCsvDraftSourceChain).toHaveBeenCalledExactlyOnceWith([source, earlier], 'retained', caret, expect.any(Function))
  expect(openView).toHaveBeenCalledExactlyOnceWith('chat', JSON.stringify({ kind: 'message', ...earlier, control: 'artifact-csv-comparison' }))
  expect(clear).not.toHaveBeenCalled()
  expect(selection.getSnapshot()).toBe(binding)
  fireEvent.click(screen.getByRole('button', { name: 'Review attached comparison' }))
  expect(screen.getByRole('row', { name: '5 Kept 35' })).toBeDefined()
  const { openView: _navigation, ...withoutNavigation } = props
  view.rerender(<ArtifactPromptContextDock {...withoutNavigation} />)
  expect(screen.queryByRole('button', label)).toBeNull()
})

it('opens each original return from the expanded draft comparison with the same receipt and exact caret', () => {
  const sessionId = 'test-session' as SessionId
  const session = sessionSnapshot(sessionId)
  const first = { eventSeq: 8, messageId: MessageId('first-return') }
  const second = { eventSeq: 12, messageId: MessageId('second-return') }
  const original = { groupKey: 'Warm', value: 30, count: 2, aggregate: 'mean', valueColumn: 'LatencyMs' } as const
  const binding = { kind: 'csv-question-comparison', draft: { receiptId: 'retained', facts: {
    kind: 'csv-question-comparison', sessionId, returns: {
      branchSessionId: 'inquiry' as SessionId,
      first: { ...first, artifactId: artifact.artifactId, revision: 1 },
      second: { ...second, artifactId: artifact.artifactId, revision: 2 },
    },
    comparison: { original, current: { ...original, value: 60, aggregate: 'sum' }, kept: 2, excluded: 0, added: 0, total: 2, offset: 0,
      rows: [{ record: 4, status: 'kept' }, { record: 5, status: 'kept' }] },
  } } } as const satisfies ArtifactPromptBinding
  const caret = { start: 4, end: 7, draftRev: 2 }
  const captureInsertion = vi.fn(() => caret)
  const openView = vi.fn()
  const clear = vi.fn()
  const visitCsvDraftReturn = vi.fn<ComponentProps<typeof ArtifactPromptContextDock>['visitCsvDraftReturn']>()
    .mockImplementation((_source, _receipt, _selection, open) => { open() })
  const context = createSnapshotStore<ArtifactPromptBinding | null>(binding)
  const props = {
    session, t, openView, visitCsvDraftReturn, inputActions: { captureInsertion }, useAccess: () => true,
    useSession: bindSnapshotSelector(createSnapshotStore(session)), useArtifactPromptContext: bindSnapshotSelector(context),
    clearArtifactPromptContext: clear, useCsvComparisonDraft: () => 'ready', useCsvComparisonDraftOutcome: () => undefined,
    useCsvComparisonDraftCleanupFailed: () => false, usePendingCsvComparisonSourceTrail: () => undefined,
    useCsvComparisonSourceRecovery: () => undefined,
  } as unknown as ComponentProps<typeof ArtifactPromptContextDock>
  const view = render(<ArtifactPromptContextDock {...props} />)
  const sourceButton = { name: 'View original return' }
  expect(screen.queryByRole('button', sourceButton)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Review attached comparison' }))
  const buttons = screen.getAllByRole('button', sourceButton)
  expect(buttons.map(button => button.getAttribute('data-csv-return-source'))).toEqual(['first', 'second'])
  expect(buttons.every(button => !button.hasAttribute('data-chat-message-control'))).toBe(true)
  expect(view.container.querySelectorAll('[data-csv-compare-reading]')).toHaveLength(2)
  for (const button of buttons) fireEvent.click(button)
  expect(captureInsertion).toHaveBeenCalledTimes(2)
  expect(visitCsvDraftReturn.mock.calls).toEqual([
    [first, binding.draft.receiptId, caret, expect.any(Function), 'first'],
    [second, binding.draft.receiptId, caret, expect.any(Function), 'second'],
  ])
  expect(openView.mock.calls).toEqual([first, second].map(target => ['chat', JSON.stringify({
    kind: 'message', ...target, control: 'artifact-branch-result',
  })]))
  expect(clear).not.toHaveBeenCalled()
  expect(context.getSnapshot()).toBe(binding)

  view.rerender(<ArtifactPromptContextDock {...props} useAccess={endpoint => endpoint !== 'session/events'} />)
  expect(screen.queryByRole('button', sourceButton)).toBeNull()
})

type CsvSourceChainLoader = ComponentProps<typeof CsvSourceChain>['load']

it('retries unavailable source history and discards late results after closing the preview', async () => {
  const request = Promise.withResolvers<Awaited<ReturnType<CsvSourceChainLoader>>>()
  const load = vi.fn<CsvSourceChainLoader>().mockRejectedValueOnce(new Error('History unavailable')).mockReturnValueOnce(request.promise)
  const openQuestion = vi.fn()
  render(<CsvSourceChain load={load} captureOpen={() => openQuestion} questionLabel={() => undefined} t={t} />)
  const trigger = screen.getByRole('button', { name: 'View full source chain' })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = within(screen.getByRole('dialog', { name: 'Source chain' }))
  expect((await dialog.findByRole('alert')).textContent).toBe('Could not load the full source chain.')
  fireEvent.click(dialog.getByRole('button', { name: 'Retry' }))
  const signal = load.mock.calls[1]![0]
  expect(signal.aborted).toBe(false)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(signal.aborted).toBe(true)
  expect(document.activeElement).toBe(trigger)
  await act(async () => { request.resolve({ sources: [{ eventSeq: 15, messageId: MessageId('late-source') }], status: 'complete' }) })
  expect(screen.queryByRole('dialog', { name: 'Source chain' })).toBeNull()
  expect(openQuestion).not.toHaveBeenCalled()
})

it('keeps verified source stops usable while retrying and replaces the list when history completes', async () => {
  type Loader = ComponentProps<typeof CsvSourceChain>['load']
  const first = { eventSeq: 19, messageId: MessageId('immediate-source') }
  const earlier = { eventSeq: 14, messageId: MessageId('earlier-source') }
  const request = Promise.withResolvers<Awaited<ReturnType<Loader>>>()
  const load = vi.fn<Loader>().mockResolvedValueOnce({ sources: [first], status: 'unavailable' }).mockReturnValueOnce(request.promise)
  const openQuestion = vi.fn()
  render(<CsvSourceChain load={load} captureOpen={() => openQuestion} questionLabel={() => undefined} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: 'View full source chain' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Source chain' }))
  const firstStop = await dialog.findByRole('button', { name: 'Question 19' })
  expect(dialog.getByRole('status').textContent).toBe('Some earlier sources are unavailable.')
  expect(dialog.queryByRole('alert')).toBeNull()
  const retry = dialog.getByRole('button', { name: 'Retry' })
  retry.focus()
  fireEvent.click(retry)
  expect(dialog.getByRole('button', { name: 'Question 19' })).toBe(firstStop)
  expect(firstStop.hasAttribute('disabled')).toBe(false)
  expect(document.activeElement).toBe(retry)
  fireEvent.click(retry)
  expect(load).toHaveBeenCalledTimes(2)
  await act(async () => { request.resolve({ sources: [first, earlier], status: 'complete' }) })
  expect(dialog.queryByRole('button', { name: 'Retry' })).toBeNull()
  expect(document.activeElement).toBe(firstStop)
  fireEvent.click(dialog.getByRole('button', { name: 'Question 14' }))
  expect(openQuestion).toHaveBeenCalledExactlyOnceWith([first, earlier])
})

it('allows selecting a verified source during retry and drops obsolete stops after an empty settled retry', async () => {
  type Loader = ComponentProps<typeof CsvSourceChain>['load']
  const source = { eventSeq: 19, messageId: MessageId('immediate-source') }
  const request = Promise.withResolvers<Awaited<ReturnType<Loader>>>()
  const empty = { sources: [], status: 'unavailable' } as const
  const load = vi.fn<Loader>().mockResolvedValue({ sources: [source], status: 'unavailable' })
    .mockResolvedValueOnce({ sources: [source], status: 'unavailable' }).mockResolvedValueOnce(empty)
  const openQuestion = vi.fn()
  render(<CsvSourceChain load={load} captureOpen={() => openQuestion} questionLabel={() => undefined} t={t} />)
  const trigger = screen.getByRole('button', { name: 'View full source chain' })
  fireEvent.click(trigger)
  let dialog = within(screen.getByRole('dialog', { name: 'Source chain' }))
  await dialog.findByRole('button', { name: 'Question 19' })
  fireEvent.click(dialog.getByRole('button', { name: 'Retry' }))
  expect((await dialog.findByRole('alert')).textContent).toBe('Could not load the full source chain.')
  expect(dialog.queryByRole('button', { name: 'Question 19' })).toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: 'Close Source chain' }))
  fireEvent.click(trigger)
  dialog = within(screen.getByRole('dialog', { name: 'Source chain' }))
  const sourceButton = await dialog.findByRole('button', { name: 'Question 19' })
  load.mockReturnValueOnce(request.promise)
  fireEvent.click(dialog.getByRole('button', { name: 'Retry' }))
  fireEvent.click(sourceButton)
  expect(load.mock.calls.at(-1)?.[0]?.aborted).toBe(true)
  expect(openQuestion).toHaveBeenCalledExactlyOnceWith([source])
  await act(async () => { request.resolve(empty) })
  expect(screen.queryByRole('dialog', { name: 'Source chain' })).toBeNull()
})

it.each([1, 2])('shows a broken source level %s without Retry and keeps earlier verified stops', async (level) => {
  const source = { eventSeq: 19, messageId: MessageId('immediate-source') }
  const sources = level === 1 ? [] : [source]
  const load = vi.fn<CsvSourceChainLoader>().mockResolvedValueOnce({ sources: [source], status: 'unavailable' })
    .mockResolvedValueOnce({ sources, status: 'invalid', level })
  const openQuestion = vi.fn()
  render(<CsvSourceChain load={load} captureOpen={() => openQuestion} questionLabel={() => undefined} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: 'View full source chain' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Source chain' }))
  const retry = await dialog.findByRole('button', { name: 'Retry' })
  retry.focus()
  fireEvent.click(retry)
  const notice = await dialog.findByText(`Source at level ${level} is invalid.`)
  expect(notice.getAttribute('data-csv-source-chain-status')).toBe('invalid')
  expect(notice.getAttribute('data-csv-source-chain-level')).toBe(String(level))
  expect(dialog.queryByRole('button', { name: 'Retry' })).toBeNull()
  if (level === 1) {
    expect(dialog.queryByRole('list')).toBeNull()
    expect(document.activeElement).toBe(notice)
    expect(openQuestion).not.toHaveBeenCalled()
  } else {
    const firstStop = dialog.getByRole('button', { name: 'Question 19' })
    expect(document.activeElement).toBe(firstStop)
    fireEvent.click(firstStop)
    expect(openQuestion).toHaveBeenCalledExactlyOnceWith([source])
  }
})

it.each(['comparison', 'draft'] as const)('opens the verified %s trail destination after the owning session is ready', (kind) => {
  const sessionId = 'test-session' as SessionId
  const source = { eventSeq: 15, messageId: MessageId('source') }
  const bookmark: CsvComparisonSourceVisit = { source, origin: kind === 'comparison'
    ? { kind, message: { eventSeq: 18, messageId: MessageId('origin') } }
    : { kind, receiptId: 'retained', selection: { start: 4, end: 4, draftRev: -1 } } }
  const deepest = { eventSeq: 11, messageId: MessageId('older-source') }
  const trail: CsvComparisonSourceTrail = [bookmark, { source: deepest, origin: { kind: 'comparison', message: source } }]
  const pending = createSnapshotStore<CsvComparisonSourceTrail | undefined>(trail)
  const phase = createSnapshotStore<CsvComparisonDraftPhase>('restoring')
  const openView = vi.fn()
  const restored = kind === 'comparison' ? deepest : source
  type Restore = ComponentProps<typeof ArtifactPromptContextDock>['restoreCsvSourceTrail']
  const restoreCsvSourceTrail = vi.fn<Restore>((_trail, signal, open) => {
    if (!signal.aborted) open(restored)
  })
  const session = sessionSnapshot(sessionId)
  const props = {
    t, session: { ...session, openState: 'loading' }, openView, restoreCsvSourceTrail, useAccess: () => true,
    useSession: bindSnapshotSelector(createSnapshotStore(session)),
    useArtifactPromptContext: () => null, useCsvComparisonDraftOutcome: () => undefined, useCsvComparisonDraftCleanupFailed: () => false,
    usePendingCsvComparisonSourceTrail: bindSnapshotSelector(pending), useCsvComparisonDraft: bindSnapshotSelector(phase),
    useCsvComparisonSourceRecovery: () => undefined,
  } as unknown as ComponentProps<typeof ArtifactPromptContextDock>
  const view = render(<ArtifactPromptContextDock {...props} />)
  expect(restoreCsvSourceTrail).not.toHaveBeenCalled()
  view.rerender(<ArtifactPromptContextDock {...props} session={{ ...session, openState: 'open' }} />)
  if (kind === 'draft') {
    expect(restoreCsvSourceTrail).not.toHaveBeenCalled()
    act(() => { phase.set('ready') })
  }
  expect(restoreCsvSourceTrail).toHaveBeenCalledExactlyOnceWith(trail, expect.any(AbortSignal), expect.any(Function))
  expect(openView).toHaveBeenCalledExactlyOnceWith('chat', JSON.stringify({ kind: 'message', ...restored, control: 'artifact-csv-comparison' }))
  const signal = restoreCsvSourceTrail.mock.calls[0]![1]
  act(() => { pending.set(undefined) })
  expect(signal.aborted).toBe(true)
  act(() => { phase.set('ready') })
  expect(openView).toHaveBeenCalledOnce()
})

it('renders a retry in the composer only when refresh has no verified fallback comparison', () => {
  const session = sessionSnapshot('test-session' as SessionId)
  const recovery = createSnapshotStore<CsvComparisonSourceRecovery | undefined>({ status: 'unavailable' })
  const target = { eventSeq: 20, messageId: MessageId('restored-comparison') }
  const openView = vi.fn()
  type Retry = ComponentProps<typeof ArtifactPromptContextDock>['retryCsvSourceRecovery']
  const retryCsvSourceRecovery = vi.fn<Retry>((_value, open) => { open(target) })
  const props = {
    t, session, openView, retryCsvSourceRecovery, useAccess: (action: string) => action === 'session/events',
    useSession: bindSnapshotSelector(createSnapshotStore(session)),
    useArtifactPromptContext: () => null, useCsvComparisonDraftOutcome: () => undefined, useCsvComparisonDraftCleanupFailed: () => false,
    usePendingCsvComparisonSourceTrail: () => undefined, useCsvComparisonDraft: () => 'ready',
    useCsvComparisonSourceRecovery: bindSnapshotSelector(recovery),
  } as unknown as ComponentProps<typeof ArtifactPromptContextDock>
  render(<ArtifactPromptContextDock {...props} />)
  expect(screen.getByRole('status').textContent).toBe('Could not load the full source chain.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(retryCsvSourceRecovery).toHaveBeenCalledExactlyOnceWith(recovery.getSnapshot(), expect.any(Function))
  expect(openView).toHaveBeenCalledExactlyOnceWith('chat', JSON.stringify({ kind: 'message', ...target, control: 'artifact-csv-comparison' }))
  act(() => { recovery.set({ status: 'unavailable', source: target }) })
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})

it('keeps the source trail across owner teardown and consumes only the active visit on return', () => {
  const source = { eventSeq: 15, messageId: MessageId('source') }
  const origin = { kind: 'comparison', message: { eventSeq: 18, messageId: MessageId('origin') } } as const
  const first: CsvComparisonSourceVisit = { source, origin }
  const second: CsvComparisonSourceVisit = { source: { eventSeq: 11, messageId: MessageId('older-source') },
    origin: { kind: 'comparison', message: source } }
  let current: CsvComparisonSourceTrail | undefined
  const write = vi.fn((trail?: CsvComparisonSourceTrail) => { current = trail })
  const owner = new ArtifactInteractionOwner(() => createSnapshotStore(undefined))
  const detach = owner.bindCsvSourceVisitStorage(() => current, write)
  expect(owner.visitCsvComparisonSource(first)).toBe(true)
  expect(owner.visitCsvComparisonSource(second)).toBe(true)
  owner.clearCsvComparisonSourceVisit(first)
  expect(current).toEqual([first, second])
  detach()
  owner.dispose()
  expect(write.mock.calls).toEqual([[[first]], [[first, second]]])
  const reopened = new ArtifactInteractionOwner(() => createSnapshotStore(undefined))
  const release = reopened.bindCsvSourceVisitStorage(() => current, write)
  const pending = reopened.pendingCsvComparisonSourceTrail.getSnapshot()
  expect(pending).toEqual([first, second])
  expect(reopened.csvComparisonSourceTrail.getSnapshot()).toBeUndefined()
  expect(reopened.restoreCsvComparisonSourceTrail(pending!)).toBe(true)
  expect(reopened.pendingCsvComparisonSourceTrail.getSnapshot()).toBeUndefined()
  expect(reopened.returnToCsvComparisonSourceStop(first, first)).toBe(false)
  expect(reopened.returnToCsvComparisonSourceStop(second, second)).toBe(true)
  expect(current).toEqual([first])
  expect(reopened.csvComparisonSourceTrail.getSnapshot()?.at(-1)).toBe(first)
  expect(reopened.returnToCsvComparisonSourceStop(first, first)).toBe(true)
  expect(current).toBeUndefined()
  release()
  reopened.dispose()
})

it('captures the reviewed step even when the current run advances before confirmation or sending', () => {
  const { owner, runtime, release } = bench()
  expect(owner.capture('Unavailable')).toBeUndefined()
  owner.command(key, 'step')
  const reviewed = particleQuestionReadings(runtime.getSnapshot()!)
  for (let step = 1; step < 6; step++) owner.command(key, 'step')
  expect(owner.chooseCurrent(key, artifact, reviewed)).toBe(true)
  const sent = owner.capture('Unavailable')
  expect(sent).toEqual({ kind: 'current-particle', artifactId: 'experiment', revision: 1, checkpoint: { runtimeVersion: 1, stepCount: 1 } })
  owner.command(key, 'step')
  expect(runtime.getSnapshot()?.run.state.stepCount).toBe(7)
  expect(owner.capture('Unavailable')).toEqual(sent)
  release()
  owner.dispose()
})

it('shares one runtime across subscribers and invalidates an old choice after last-unmount and same-revision remount', () => {
  const { owner, runtime, release, choose } = bench()
  const secondRelease = runtime.subscribe(() => {})
  owner.command(key, 'step')
  const reviewed = particleQuestionReadings(runtime.getSnapshot()!)
  expect(choose()).toBe(true)
  release()
  expect(owner.capture('Unavailable')).toMatchObject({ checkpoint: { stepCount: 1 } })
  secondRelease()
  expect(() => owner.capture('Unavailable')).toThrow('Unavailable')
  const remountRelease = runtime.subscribe(() => {})
  expect(runtime.getSnapshot()?.run.state.stepCount).toBe(0)
  expect(() => owner.capture('Unavailable')).toThrow('Unavailable')
  expect(owner.chooseCurrent(key, artifact, reviewed)).toBe(false)
  expect(choose()).toBe(true)
  expect(owner.capture('Unavailable')).toMatchObject({ checkpoint: { stepCount: 0 } })
  remountRelease()
  owner.dispose()
})

it('rejects a selected old revision and resets the calculation when the existing node changes source', () => {
  const { owner, runtime, source, release, choose } = bench()
  owner.command(key, 'step')
  expect(choose()).toBe(true)
  source.set({ ...artifact, revision: 2, title: 'Experiment B' })
  expect(runtime.getSnapshot()).toMatchObject({ revision: 2, run: { state: { stepCount: 0 } } })
  expect(owner.selection.getSnapshot()).toMatchObject({ revision: 1, available: false })
  expect(() => owner.capture('Choose again')).toThrow('Choose again')
  release()
  owner.dispose()
})

it('keeps saved observations and comparison references fixed without copying their sources into selection state', () => {
  const { owner, source, release } = bench()
  const control = observation('A')
  const variant = observation('B', { ...artifact, artifactId: 'variant' as ArtifactId })
  owner.chooseObservation(control)
  source.set({ ...artifact, revision: 2 })
  expect(owner.capture('Unavailable')).toEqual({ kind: 'observation', ref: { artifactId: 'experiment', observationId: 'A' } })
  expect(JSON.stringify(owner.selection.getSnapshot())).not.toContain('gravity')
  owner.chooseComparison('study', control, variant)
  expect(owner.capture('Unavailable')).toEqual({ kind: 'comparison', group: 'study',
    control: { artifactId: 'experiment', observationId: 'A' }, variant: { artifactId: 'variant', observationId: 'B' } })
  release()
  owner.dispose()
})

it('does not inherit selection into a different Session owner and clears without changing the visible experiment', () => {
  const { owner, runtime, release, choose } = bench()
  owner.command(key, 'step')
  expect(choose()).toBe(true)
  const other = new ArtifactInteractionOwner(() => createSnapshotStore(artifact))
  expect(other.capture('Unavailable')).toBeUndefined()
  const props = { useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot('test-session' as SessionId))), useArtifactPromptContext: bindSnapshotSelector(owner.selection),
    clearArtifactPromptContext: () => { owner.clear() }, t } as ComponentProps<typeof ArtifactPromptContext>
  render(<ArtifactPromptContext {...props} />)
  expect(screen.getByRole('region', { name: 'Question context' }).getAttribute('data-artifact-prompt-context')).toBe('current-particle')
  fireEvent.click(screen.getByRole('button', { name: 'Remove question context' }))
  expect(screen.queryByRole('region', { name: 'Question context' })).toBeNull()
  expect(runtime.getSnapshot()?.run.state.stepCount).toBe(1)
  release()
  owner.dispose()
  other.dispose()
})

it('reviews branch evidence in the composer and captures only its durable message reference', () => {
  const sessionId = 'test-session' as SessionId
  const messageId = 'returned-experiment' as SessionEvent<'user/message'>['data']['id']
  const request = { kind: 'branch-evidence' as const, capturedSessionId: sessionId, eventSeq: 8, messageId }
  const sourceFor = vi.fn(() => createSnapshotStore<ArtifactSnapshot | undefined>(undefined))
  const owner = new ArtifactInteractionOwner(sourceFor)
  const saved = observation('Checkpoint')
  owner.chooseBranchEvidence(request, { artifact: saved.artifact, state: {
    kind: 'particle-system', checkpoint: saved.checkpoint, values: saved.values,
  } })
  const props = { useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot(sessionId))),
    useArtifactPromptContext: bindSnapshotSelector(owner.selection),
    clearArtifactPromptContext: () => { owner.clear() }, t } as ComponentProps<typeof ArtifactPromptContext>
  const view = render(<ArtifactPromptContext {...props} />)
  expect(screen.getByRole('region', { name: 'Question context' }).getAttribute('data-artifact-prompt-context')).toBe('branch-evidence')
  expect(screen.getByRole('status').textContent).toContain('Returned branch evidence')
  fireEvent.click(screen.getByRole('button', { name: 'Replay experiment' }))
  expect(view.container.querySelector('[data-artifact-question-replay-revision="1"] [data-particle-step="6"]')).toBeTruthy()
  expect(owner.capture('Unavailable')).toEqual(request)
  expect(sourceFor).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Remove question context' }))
  expect(owner.capture('Unavailable')).toBeUndefined()
  owner.dispose()
})

it('requires an explicit card action and identifies unsupported runtime conditions', () => {
  const chooseCurrent = vi.fn(() => true)
  const chooseObservation = vi.fn()
  const props = { snapshot: artifact, origin: { kind: 'current' as const }, placement: 'inline' as const,
    recordAction: vi.fn(), t, promptContext: { chooseCurrent, chooseObservation } }
  const view = render(<ArtifactCard {...props} />)
  expect(chooseCurrent).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Use for next question' }))
  expect(chooseCurrent).not.toHaveBeenCalled()
  expect(screen.getByRole('region', { name: 'Review particle readings' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(chooseCurrent).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Use for next question' }))
  fireEvent.click(screen.getByRole('button', { name: 'Attach readings' }))
  expect(chooseCurrent).toHaveBeenCalledOnce()
  view.rerender(<ArtifactCard {...props} snapshot={{ ...artifact, revision: 2, spec: { kind: 'flowchart', nodes: [], edges: [] } }} />)
  expect(screen.queryByRole('button', { name: 'Use for next question' })).toBeNull()
  expect(screen.getByText(en['promptContext.unsupported'])).toBeTruthy()
})

it('keeps the reviewed returned BFS checkpoint in the composer independently of the preview', () => {
  const sourceFor = vi.fn(() => createSnapshotStore<ArtifactSnapshot | undefined>(undefined))
  const owner = new ArtifactInteractionOwner(sourceFor)
  const sessionId = 'test-session' as SessionId
  const messageId = 'returned-bfs' as SessionEvent<'user/message'>['data']['id']
  const state = { kind: 'bfs-checkpoint' as const, current: 'C', queue: ['D', 'E', 'F'], visited: ['A', 'B', 'C'] }
  const request = { kind: 'branch-bfs-checkpoint' as const, capturedSessionId: sessionId, eventSeq: 8, messageId, state }
  expect(owner.chooseBranchHtml(request, { title: 'BFS', revision: 1 })).toBe(true)
  state.queue.shift()
  expect(owner.capture('Unavailable')).toEqual({ ...request, state: { ...state, queue: ['D', 'E', 'F'] } })
  expect(sourceFor).not.toHaveBeenCalled()
  owner.clear()
  expect(owner.capture('Unavailable')).toBeUndefined()
  owner.dispose()
})

it('keeps the unavailable choice visible instead of silently substituting a new source', () => {
  const { owner, source, release, choose } = bench()
  expect(choose()).toBe(true)
  const props = { useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot('test-session' as SessionId))), useArtifactPromptContext: bindSnapshotSelector(owner.selection),
    clearArtifactPromptContext: () => { owner.clear() }, t } as ComponentProps<typeof ArtifactPromptContext>
  render(<ArtifactPromptContext {...props} />)
  act(() => { source.set({ ...artifact, revision: 2 }) })
  expect(screen.getByRole('alert').textContent).toBe(en['promptContext.unavailable'])
  release()
  owner.dispose()
})

it('keeps reviewed plot parameters fixed and requires reselection after a revision change', () => {
  const plot: SceneArtifactSnapshot = { ...artifact, spec: { kind: 'function-plot',
    functions: [{ id: 'line', label: 'Line', expression: 'a*x' }], parameters: { a: { value: 1, min: 0, max: 3, step: 1 } },
    viewport: { x: [-2, 2], y: [-4, 4] }, trace: { x: 1, derivative: false, integral: false } } }
  const source = createSnapshotStore<ArtifactSnapshot | undefined>(plot)
  const owner = new ArtifactInteractionOwner(() => source)
  const parameters = { a: 1 }
  expect(owner.chooseFunctionPlot(key, plot, { functionId: 'line', x: 1, parameters })).toBe(true)
  parameters.a = 2
  expect(owner.capture('Choose again')).toEqual({ kind: 'current-function-plot', artifactId: plot.artifactId,
    revision: 1, functionId: 'line', x: 1, parameters: { a: 1 } })
  source.set({ ...plot, revision: 2 })
  expect(owner.selection.getSnapshot()).toMatchObject({ available: false })
  expect(() => owner.capture('Choose again')).toThrow('Choose again')
  owner.dispose()
})

it('does not export or attach a particle source before its sole runtime is available', () => {
  const create = vi.fn()
  const chooseCurrent = vi.fn()
  render(<ArtifactCardView snapshot={artifact} origin={{ kind: 'current' }} placement="inline" recordAction={vi.fn()} t={t}
    particleRuntime={{ current: undefined, command: vi.fn() }}
    promptContext={{ chooseCurrent, chooseObservation: vi.fn() }}
    exportControls={{ ready: true, records: [], create, download: vi.fn() }} />)
  expect(screen.getByText('Preparing particle experiment…')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Use for next question' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Export animation' }))
  expect(create).not.toHaveBeenCalled()
  expect(chooseCurrent).not.toHaveBeenCalled()
})

it('retains an existing choice with removal and a route explanation when the chat becomes a subagent continuation', () => {
  const { owner, release, choose } = bench()
  expect(choose()).toBe(true)
  const lifecycle = sessionSnapshot('test-session' as SessionId)
  const session = createSnapshotStore(lifecycle)
  const props = { useSession: bindSnapshotSelector(session), useArtifactPromptContext: bindSnapshotSelector(owner.selection),
    clearArtifactPromptContext: () => { owner.clear() }, t } as ComponentProps<typeof ArtifactPromptContext>
  render(<ArtifactPromptContext {...props} />)
  act(() => { session.set({ ...lifecycle, subagent: {
    address: { parentSessionId: 'parent' as SessionId, childSessionId: lifecycle.sessionId, mode: 'continuable' }, parentAvailable: true,
  } }) })
  expect(screen.getByRole('alert').textContent).toBe(en['promptContext.subagentUnsupported'])
  expect(owner.selection.getSnapshot()).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en['promptContext.clear'] }))
  expect(screen.queryByRole('region', { name: en['promptContext.label'] })).toBeNull()
  release()
  owner.dispose()
})
