import type { SessionRequestId } from '@agentrans/api-session-controller/types'
import type { ArtifactCsvComparisonAttachment, ArtifactCsvComparisonDraft } from '@agentrans/artifact-followup/types'
import type { ArtifactId } from '@agentrans/artifact/types'
import { MessageId } from '@agentrans/llm/brand'
import { SessionId } from '@agentrans/session/types'
import { expect, it, vi } from 'vitest'
import { CsvComparisonDraftOwner, type CsvComparisonDraftCommands } from '../src/client/csv-comparison-draft.ts'

const sessionId = SessionId('parent')
const questionId = MessageId('question')
const requestId = 'accepted-prompt' as SessionRequestId
const original = { groupKey: 'Warm', aggregate: 'mean', value: 30, count: 2, valueColumn: 'LatencyMs' } as const
const attachment: ArtifactCsvComparisonAttachment = { proof: 'a'.repeat(64), facts: {
  kind: 'csv-question-comparison', sessionId, question: { eventSeq: 5, messageId: questionId },
  source: { eventSeq: 2, messageId: MessageId('adopted'), artifactId: 'latency' as ArtifactId, revision: 1 },
  comparison: { original, current: { ...original, aggregate: 'sum', value: 60 }, kept: 2, excluded: 0, added: 0, total: 2, offset: 0,
    rows: [{ record: 4, status: 'kept', value: '25' }, { record: 5, status: 'kept', value: '35' }] },
} }
const first = { receiptId: 'first', facts: attachment.facts }
const second: ArtifactCsvComparisonDraft = { receiptId: 'second', facts: { ...attachment.facts,
  comparison: { ...attachment.facts.comparison, current: { ...original, aggregate: 'max', value: 35 } } } }

function harness() {
  const commands = { read: vi.fn<CsvComparisonDraftCommands['read']>(), save: vi.fn<CsvComparisonDraftCommands['save']>(),
    clear: vi.fn<CsvComparisonDraftCommands['clear']>(),
    reconcile: vi.fn<NonNullable<CsvComparisonDraftCommands['reconcile']>>().mockResolvedValue({ status: 'untracked' }),
    check: vi.fn<NonNullable<CsvComparisonDraftCommands['check']>>().mockResolvedValue({ status: 'unconfirmed' }) }
  const publish = vi.fn<(draft: ArtifactCsvComparisonDraft | null, explicit: boolean) => void>()
  return { commands, publish, owner: new CsvComparisonDraftOwner(sessionId, commands, publish) }
}

it('keeps the restored chip while the exact prior request is pending, then releases only the accepted chip', async () => {
  vi.useFakeTimers()
  try {
    const { commands, publish, owner } = harness()
    const pending = { ...first, pendingRequestId: requestId }
    const status = Promise.withResolvers<{ status: 'accepted'; requestId: SessionRequestId }>()
    commands.read.mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValueOnce(null)
    commands.reconcile.mockResolvedValueOnce({ status: 'pending', requestId }).mockReturnValueOnce(status.promise)
    owner.allowConfirmationPolling(true)
    owner.restore()
    await vi.advanceTimersByTimeAsync(0)
    expect(owner.phase.getSnapshot()).toBe('awaiting-confirmation')
    expect(owner.blocksSubmission).toBe(true)
    expect(publish).toHaveBeenLastCalledWith(pending, false)
    await owner.remove(first.receiptId)
    expect(commands.clear).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(commands.reconcile).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(commands.reconcile).toHaveBeenCalledTimes(2)
    status.resolve({ status: 'accepted', requestId })
    await vi.advanceTimersByTimeAsync(0)
    expect(publish).toHaveBeenLastCalledWith(null, false)
    expect(owner.blocksSubmission).toBe(false)
    expect(owner.outcome.getSnapshot()).toEqual({ status: 'accepted' })
    expect(commands.reconcile.mock.calls).toEqual([[requestId], [requestId]])
    owner.clearOutcome()
    expect(owner.outcome.getSnapshot()).toBeUndefined()
    expect(commands.save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(commands.read).toHaveBeenCalledTimes(3)
    owner.dispose()
  } finally { vi.useRealTimers() }
})

it('tracks Host pending without a browser marker and stops checks without discarding the unsent draft', async () => {
  vi.useFakeTimers()
  try {
    const { commands, publish, owner } = harness()
    const pending = { ...first, pendingRequestId: requestId }
    commands.read.mockResolvedValueOnce(pending).mockResolvedValueOnce(first)
    commands.check.mockResolvedValueOnce({ status: 'pending' })
    owner.allowConfirmationPolling(true)
    owner.restore()
    await vi.advanceTimersByTimeAsync(0)
    expect(owner.phase.getSnapshot()).toBe('awaiting-confirmation')
    owner.allowConfirmationPolling(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(commands.read).toHaveBeenCalledTimes(1)
    owner.allowConfirmationPolling(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(owner.phase.getSnapshot()).toBe('ready')
    expect(publish).toHaveBeenLastCalledWith(first, false)
    expect(commands.check.mock.calls).toEqual([[requestId], [requestId]])
    expect(owner.outcome.getSnapshot()).toEqual({ status: 'unconfirmed' })
    expect(commands.save).not.toHaveBeenCalled()
    expect(commands.clear).not.toHaveBeenCalled()
    owner.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(commands.read).toHaveBeenCalledTimes(2)
  } finally { vi.useRealTimers() }
})

it('never infers a previous outcome from a newer draft or a missing receipt alone', async () => {
  vi.useFakeTimers()
  try {
    const { commands, publish, owner } = harness()
    const unrelated = 'later-request' as SessionRequestId
    commands.read.mockResolvedValueOnce({ ...first, pendingRequestId: requestId }).mockResolvedValueOnce(second)
    commands.reconcile.mockResolvedValueOnce({ status: 'untracked' }).mockResolvedValue({ status: 'accepted', requestId: unrelated })
    commands.check.mockResolvedValueOnce({ status: 'pending' })
    owner.allowConfirmationPolling(true)
    owner.restore()
    await vi.advanceTimersByTimeAsync(0)
    expect(owner.outcome.getSnapshot()).toBeUndefined()
    commands.read.mockResolvedValueOnce(second)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(publish).toHaveBeenLastCalledWith(second, false)
    expect(owner.outcome.getSnapshot()).toBeUndefined()
    owner.dispose()

    const fresh = harness()
    fresh.commands.read.mockResolvedValueOnce(null)
    fresh.commands.reconcile.mockResolvedValueOnce({ status: 'accepted', requestId })
    fresh.owner.restore()
    await vi.advanceTimersByTimeAsync(0)
    expect(fresh.owner.phase.getSnapshot()).toBe('ready')
    expect(fresh.owner.outcome.getSnapshot()).toBeUndefined()
    fresh.owner.dispose()
  } finally { vi.useRealTimers() }
})

it('checks the first pending request before adopting another pending Host draft', async () => {
  vi.useFakeTimers()
  try {
    const { commands, publish, owner } = harness()
    const nextRequest = 'next-request' as SessionRequestId
    const firstPending = { ...first, pendingRequestId: requestId }
    const nextPending = { ...second, pendingRequestId: nextRequest }
    commands.read.mockResolvedValueOnce(firstPending).mockResolvedValueOnce(nextPending)
      .mockResolvedValueOnce(nextPending).mockResolvedValueOnce(second)
    commands.reconcile.mockResolvedValueOnce({ status: 'pending', requestId })
      .mockResolvedValueOnce({ status: 'accepted', requestId })
    owner.allowConfirmationPolling(true)
    owner.restore()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(commands.reconcile.mock.calls).toEqual([[requestId], [requestId]])
    expect(owner.outcome.getSnapshot()).toBeUndefined()
    expect(owner.blocksSubmission).toBe(true)
    expect(publish).toHaveBeenLastCalledWith(nextPending, false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(commands.check).toHaveBeenCalledExactlyOnceWith(nextRequest)
    expect(owner.outcome.getSnapshot()).toEqual({ status: 'unconfirmed' })
    expect(publish).toHaveBeenLastCalledWith(second, false)
    owner.dispose()
  } finally { vi.useRealTimers() }
})

it('offers only a durable history location for a queued accepted question and keeps submission available', async () => {
  vi.useFakeTimers()
  try {
    const { commands, owner } = harness()
    const queuedMessageId = MessageId('queued-and-sent')
    const message = { eventSeq: 14, messageId: queuedMessageId }
    commands.read.mockResolvedValueOnce({ ...first, pendingRequestId: requestId }).mockResolvedValue(null)
    commands.reconcile.mockResolvedValueOnce({ status: 'pending', requestId })
      .mockResolvedValueOnce({ status: 'accepted', requestId, queuedMessageId })
    commands.check.mockResolvedValueOnce({ status: 'accepted', message })
    owner.allowConfirmationPolling(true)
    owner.restore()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(owner.outcome.getSnapshot()).toEqual({ status: 'accepted', queuedMessageId })
    expect(owner.selectSentQuestion(message)).toBe(false)
    expect(owner.blocksSubmission).toBe(false)
    expect(commands.check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(owner.outcome.getSnapshot()).toEqual({ status: 'accepted', message })
    expect(owner.selectSentQuestion({ ...message, eventSeq: 15 })).toBe(false)
    expect(owner.selectSentQuestion(message)).toBe(true)
    owner.clearReturnToDraft({ ...message, messageId: MessageId('different-question') })
    expect(owner.returnToDraftTarget.getSnapshot()).toEqual(message)
    owner.clearReturnToDraft(message)
    expect(owner.returnToDraftTarget.getSnapshot()).toBeUndefined()
    expect(owner.selectSentQuestion(message)).toBe(true)
    owner.allowConfirmationPolling(false)
    expect(owner.returnToDraftTarget.getSnapshot()).toBeUndefined()
    expect(owner.selectSentQuestion(message)).toBe(true)
    owner.clearOutcome()
    expect(owner.returnToDraftTarget.getSnapshot()).toBeUndefined()
    expect(commands.check).toHaveBeenCalledExactlyOnceWith(requestId)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(commands.check).toHaveBeenCalledTimes(1)
    owner.dispose()
  } finally { vi.useRealTimers() }
})

it('bounds queued checks and resumes only when the matching transcript message arrives', async () => {
  vi.useFakeTimers()
  try {
    const { commands, owner } = harness()
    const queued = { status: 'accepted', queuedMessageId: MessageId('never-materialized') } as const
    commands.read.mockResolvedValueOnce({ ...first, pendingRequestId: requestId }).mockResolvedValue(null)
    commands.reconcile.mockResolvedValueOnce({ status: 'pending', requestId }).mockResolvedValueOnce({ ...queued, requestId })
    commands.check.mockResolvedValue(queued)
    owner.allowConfirmationPolling(true)
    owner.restore()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(commands.check).toHaveBeenCalledTimes(15)
    expect(owner.outcome.getSnapshot()).toEqual(queued)
    expect(owner.blocksSubmission).toBe(false)
    owner.observeSentQuestion(MessageId('unrelated'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(commands.check).toHaveBeenCalledTimes(15)
    const message = { eventSeq: 15, messageId: queued.queuedMessageId }
    commands.check.mockResolvedValueOnce({ status: 'accepted', message })
    owner.observeSentQuestion(queued.queuedMessageId)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(commands.check).toHaveBeenCalledTimes(16)
    expect(owner.outcome.getSnapshot()).toEqual({ status: 'accepted', message })
    await vi.advanceTimersByTimeAsync(90_000)
    expect(commands.check).toHaveBeenCalledTimes(16)
    owner.dispose()
  } finally { vi.useRealTimers() }
})

it('gates submission while restoring and saving and always uses the last observed exact receipt', async () => {
  const { commands, publish, owner } = harness()
  const restore = Promise.withResolvers<ArtifactCsvComparisonDraft | null>()
  commands.read.mockReturnValueOnce(restore.promise)
  owner.restore()
  expect(owner.blocksSubmission).toBe(true)
  await expect(owner.save(attachment)).resolves.toBe(false)
  expect(commands.save).not.toHaveBeenCalled()
  restore.resolve(first)
  await vi.waitFor(() => { expect(owner.blocksSubmission).toBe(false) })
  expect(publish).toHaveBeenLastCalledWith(first, false)

  const save = Promise.withResolvers<ArtifactCsvComparisonDraft>()
  commands.save.mockReturnValueOnce(save.promise)
  const choosing = owner.save(attachment)
  expect(owner.blocksSubmission).toBe(true)
  save.resolve(second)
  await expect(choosing).resolves.toBe(true)
  expect(commands.save).toHaveBeenCalledExactlyOnceWith(attachment, first.receiptId)
  expect(publish).toHaveBeenLastCalledWith(second, true)
  expect(owner.blocksSubmission).toBe(false)
})

it('uses receipt and accepted request identity to retry cleanup without clearing a newer draft', async () => {
  const { commands, publish, owner } = harness()
  commands.read.mockResolvedValueOnce(first)
  commands.save.mockResolvedValueOnce(second)
  commands.clear.mockRejectedValueOnce(new Error('Cleanup response lost')).mockResolvedValueOnce(false)
  owner.restore()
  await vi.waitFor(() => { expect(owner.phase.getSnapshot()).toBe('ready') })
  await expect(owner.save(attachment)).resolves.toBe(true)
  owner.accept(first.receiptId, requestId)
  await vi.waitFor(() => { expect(owner.cleanupFailed.getSnapshot()).toBe(true) })
  expect(publish).toHaveBeenLastCalledWith(second, true)
  expect(owner.blocksSubmission).toBe(false)
  owner.retryCleanup()
  await vi.waitFor(() => { expect(owner.cleanupFailed.getSnapshot()).toBe(false) })
  expect(commands.clear.mock.calls).toEqual([[first.receiptId, requestId], [first.receiptId, requestId]])
  expect(publish).toHaveBeenLastCalledWith(second, true)
})

it('refreshes on a stale discard and retains the authoritative newer receipt', async () => {
  const { commands, publish, owner } = harness()
  commands.read.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
  commands.clear.mockResolvedValueOnce(false)
  owner.restore()
  await vi.waitFor(() => { expect(owner.phase.getSnapshot()).toBe('ready') })
  await owner.remove(first.receiptId)
  expect(commands.clear).toHaveBeenCalledExactlyOnceWith(first.receiptId)
  expect(publish).toHaveBeenLastCalledWith(second, false)
  owner.dispose()
  expect(commands.clear).toHaveBeenCalledTimes(1)
})
