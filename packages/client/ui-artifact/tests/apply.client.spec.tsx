// @vitest-environment jsdom
import { act, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime, RemoteError } from '@agentrans/client-test-runtime'
import { LocaleRuntime } from '@agentrans/client-locale/client'
import { createSnapshotStore } from '@agentrans/client-store'
import { runtimeChannel } from './runtime-channel.client.ts'
import { apply as hostApply } from '../src/index.ts'
import { CHAT_NODE_INJECT } from '../../ui-chat/src/client/apply.ts'
import { apply, inject } from '../src/client/index.ts'
import {
  ArtifactActionRequestError, ArtifactComparisonRequestError, ArtifactObservationSaveError, confirmArtifactObservationComparison,
  ArtifactBranchReturnError, recordArtifactAction, returnArtifactBranchResult, saveArtifactObservation, sendArtifactObservation,
  ArtifactExportRequestError, createArtifactExport, downloadArtifactExport,
} from '../src/client/protocol.ts'
import type { ArtifactId, ArtifactNodeInjected } from '../src/client/protocol.ts'
import type { ArtifactPromptContextInjected } from '../src/client/ArtifactPromptContext.tsx'
import type { CsvComparisonSourceTrail, CsvSentQuestion } from '../src/client/csv-comparison-draft.ts'
import { writeCsvComparisonSourceTrail } from '../src/client/csv-comparison-source-visit.ts'
import { readFunctionPlotDraft, writeFunctionPlotDraft } from '../src/client/function-plot-draft.ts'
import { particleRuntimeKey } from '../src/client/particle-runtime-owner.ts'
import type { BranchEvidenceFollowupInjected } from '../src/client/BranchEvidenceMessage.tsx'
import type { CsvComparisonContextInjected } from '../src/client/QuestionContextMessage.tsx'
import { en } from '../src/client/locales.ts'
import { SessionId, SessionSeq } from '@agentrans/session/types'
import { MessageId } from '@agentrans/llm/brand'
import type { SessionEventLikeEntry } from '@agentrans/api-session-controller/client'
import type { SessionRequestId } from '@agentrans/api-session-controller/types'
import type { JsonValue } from '@agentrans/util-values'
import { createParticleState, observeParticleState } from '@agentrans/artifact/particle-runtime'
import { CSV_COMPARISON_QUESTION_PREFIX } from '@agentrans/artifact/runtime-values'
import type { ArtifactActionRequest, ArtifactObservationId, SavedParticleObservation, SceneArtifactSnapshot } from '@agentrans/artifact/types'
import type { ArtifactCsvComparisonAttachment, ArtifactCsvComparisonDraft } from '@agentrans/artifact-followup/types'
import type {
  ArtifactBranchBindCsvComparisonDraftRequest, ArtifactBranchCheckCsvComparisonDraftRequest, ArtifactBranchResultRequest,
  ArtifactBranchExportSentCsvComparisonRequest, ArtifactBranchImportCsvComparisonRequest, ArtifactBranchReviewSentCsvComparisonRequest,
  ArtifactBranchSaveCsvComparisonDraftRequest,
} from '@agentrans/artifact-branch/types'
import type { ArtifactHtmlExportRequest, ArtifactHtmlExportRecord, ArtifactExportId } from '@agentrans/artifact-export/types'
import type { FileActions } from '@agentrans/client-ui-file-actions/client'

let runtime: SlotTestRuntime | undefined
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
})

function csvTrailQuestion(sessionId: SessionId, target: CsvSentQuestion, reusedFrom?: CsvSentQuestion): SessionEventLikeEntry {
  const reading = { groupKey: 'Warm', aggregate: 'mean', count: 1, value: 35, valueColumn: 'LatencyMs' }
  const facts = { kind: 'csv-question-comparison', sessionId, reusedFrom, question: { eventSeq: 3, messageId: 'original-question' },
    source: { eventSeq: 2, messageId: 'original-return', artifactId: 'chart', revision: 1 },
    comparison: { original: reading, current: reading, kept: 1, excluded: 0, added: 0, total: 1, offset: 0,
      rows: [{ record: 5, status: 'kept', value: '35' }] },
  }
  return { type: 'event', event: { type: 'user/message', seq: SessionSeq(target.eventSeq), time: target.eventSeq, surfaceOp: 'append',
    data: { id: target.messageId, role: 'user', source: { kind: 'user' }, content: [
      { type: 'text', text: CSV_COMPARISON_QUESTION_PREFIX + JSON.stringify({ kind: 'artifact-question-context', sessionId, facts }) },
    ] },
  } }
}

describe('Artifact plugin registration', () => {
  it.each([2, 3, 9, 12].flatMap(retryCount =>
    (['shared', 'superseded-first', 'latest-first'] as const).map(delivery => ({ delivery, retryCount })),
  ))('lets only the latest of $retryCount source retries open with $delivery history delivery', async ({ delivery, retryCount }) => {
    runtime = await SlotTestRuntime.create()
    const h = runtime
    h.remote.provideNamespaces({ artifactRuntime: { attach: () => runtimeChannel() },
      artifacts: { submitAction: vi.fn() }, artifactExports: { create: vi.fn(), read: vi.fn() } })
    h.ctx.provide('fileActions', { save: vi.fn(), copyImage: vi.fn(), canSaveAs: false })
    h.ctx.provide('locale', new LocaleRuntime(h.ctx))
    h.slots.installLocale(h.ctx.get('locale') as LocaleRuntime)
    h.ctx.provide('uiConversation', { userText: { register: () => () => {} }, events: { register: () => () => {} },
      binding: () => ({ target: () => ({ getSnapshot: () => undefined }) }) } as never)
    h.ctx.provide('conversation', { registerPromptContext: () => () => {} } as never)

    const a = SessionId('retained-csv-retry')
    const departure = { eventSeq: 20, messageId: MessageId('sent-comparison') }
    const fallback = { eventSeq: 15, messageId: MessageId('last-verified-source') }
    const requested = { eventSeq: 10, messageId: MessageId('delayed-source') }
    const trail: CsvComparisonSourceTrail = [
      { origin: { kind: 'comparison', message: departure }, source: fallback },
      { origin: { kind: 'comparison', message: fallback }, source: requested },
    ]
    const sharedPage = Promise.withResolvers<undefined>()
    const attempts = Array.from({ length: retryCount }, () => ({
      page: delivery === 'shared' ? sharedPage : Promise.withResolvers<undefined>(),
      open: vi.fn(),
    }))
    const loadThrough = vi.fn<(_seq: SessionSeq) => Promise<void>>().mockResolvedValueOnce(undefined)
    for (const { page } of attempts) loadThrough.mockReturnValueOnce(page.promise)
    await h.sessions.add({ id: a, session: { loadThrough }, hasMore: true,
      events: [csvTrailQuestion(a, fallback, requested), csvTrailQuestion(a, departure, fallback)] })
    const b = await h.sessions.add({ id: 'other-session' })
    writeCsvComparisonSourceTrail(a, trail)
    onTestFinished(() => { writeCsvComparisonSourceTrail(a) })
    using sidebar = h.sessions.retain(a, { source: 'sidebarChat' })
    let main = h.sessions.retainFor(h.ctx, a, { source: 'mainView' })
    await main.ready
    const binding = sidebar.binding
    await h.declare({ 'conversation.input.dock': { kind: 'list', scope: 'session' } })
    await h.mount({ inject: [...inject], apply })
    const dock = h.slots.entriesOfSlot('conversation.input.dock').find(entry => entry.options.id === 'artifact-question-context')
    if (dock?.inject === undefined) throw new Error('Missing Artifact dock registration')
    const injected = dock.inject(a as never)
    const { pendingCsvComparisonSourceTrail, csvComparisonSourceRecovery } = injected.hooks as ArtifactPromptContextInjected['hooks']
    const restore = injected.restoreCsvSourceTrail as ArtifactPromptContextInjected['restoreCsvSourceTrail']
    const retry = injected.retryCsvSourceRecovery as ArtifactPromptContextInjected['retryCsvSourceRecovery']
    const savedTrail = pendingCsvComparisonSourceTrail.getSnapshot()
    if (savedTrail === undefined) throw new Error('Missing saved source trail')
    const opened = vi.fn()
    restore(savedTrail, new AbortController().signal, opened)
    await vi.waitFor(() => { expect(opened).toHaveBeenCalledExactlyOnceWith(fallback) })
    const recovery = csvComparisonSourceRecovery.getSnapshot()
    if (recovery === undefined) throw new Error('Missing fallback recovery')
    expect(recovery).toEqual({ status: 'unavailable', source: fallback })
    const pendingAttempts = new Set<ReturnType<typeof csvComparisonSourceRecovery.getSnapshot>>()
    for (const [index, attempt] of attempts.entries()) {
      if (index > 0) {
        using otherMain = h.sessions.retain(b, { source: 'mainView' })
        main.release()
        expect(h.sessions.binding(a)).toBe(binding)
        expect(csvComparisonSourceRecovery.getSnapshot()).toBe(recovery)
        expect(h.sessions.retainInfo(a).getSnapshot().retainedBy).toEqual({ sidebarChat: 1 })
        await otherMain.ready
        main = h.sessions.retainFor(h.ctx, a, { source: 'mainView' })
        otherMain.release()
        expect(await main.ready).toBe(binding)
      }
      retry(recovery, attempt.open)
      const pending = csvComparisonSourceRecovery.getSnapshot()
      expect(pending).toEqual({ ...recovery, pending: true })
      expect(pendingAttempts.has(pending)).toBe(false)
      pendingAttempts.add(pending)
      expect(loadThrough).toHaveBeenCalledTimes(index + 2)
    }

    const latest = attempts.at(-1)
    if (latest === undefined) throw new Error('Missing the latest retry')
    const superseded = attempts.slice(0, -1)
    const latestPending = csvComparisonSourceRecovery.getSnapshot()
    await h.sessions.prependEvents(a, [csvTrailQuestion(a, requested)], false)
    const settleSuperseded = async (expectedRecovery: typeof latestPending): Promise<void> => {
      for (const { page, open } of superseded.toReversed()) {
        await act(async () => { page.resolve(undefined); await page.promise })
        expect(open).not.toHaveBeenCalled()
        expect(csvComparisonSourceRecovery.getSnapshot()).toBe(expectedRecovery)
      }
    }
    if (delivery === 'superseded-first') {
      await settleSuperseded(latestPending)
      expect(latest.open).not.toHaveBeenCalled()
    }

    latest.page.resolve(undefined)
    await vi.waitFor(() => { expect(latest.open).toHaveBeenCalledExactlyOnceWith(requested) })
    if (delivery === 'latest-first') await settleSuperseded(undefined)
    for (const { open } of superseded) expect(open).not.toHaveBeenCalled()
    expect(latest.open).toHaveBeenCalledExactlyOnceWith(requested)
    expect(csvComparisonSourceRecovery.getSnapshot()).toBeUndefined()
    expect(loadThrough.mock.calls).toEqual(Array.from({ length: retryCount + 1 }, () => [requested.eventSeq]))
  })

  it('owns a send-only block during restored confirmation and releases it when the route or request resolves', async () => {
    runtime = await SlotTestRuntime.create()
    const h = runtime
    const setSubmission = vi.fn()
    const read = vi.fn(async () => ({ ok: true as const, value: null }))
    const requestId = 'waiting-request' as SessionRequestId
    const check = vi.fn<() => Promise<{ ok: true; value: { accepted: false; pending?: true } }>>()
      .mockResolvedValueOnce({ ok: true, value: { accepted: false, pending: true } })
      .mockResolvedValueOnce({ ok: true, value: { accepted: false } })
    const reconcilePromptContext = vi.fn(async (_sessionId: SessionId, _kind: string,
      statusOf: (id: SessionRequestId) => Promise<boolean | 'pending'>) => {
      const status = await statusOf(requestId)
      return status === 'pending' ? 'pending' : 'unconfirmed'
    })
    h.remote.provideNamespaces({ artifactRuntime: { attach: () => runtimeChannel() },
      artifacts: { submitAction: vi.fn() }, artifactExports: { create: vi.fn(), read: vi.fn() },
      artifactBranchResults: { readCsvComparisonDraft: read, checkCsvComparisonDraftRequest: check } })
    h.ctx.provide('fileActions', { save: vi.fn(), copyImage: vi.fn(), canSaveAs: false })
    h.ctx.provide('locale', new LocaleRuntime(h.ctx))
    h.slots.installLocale(h.ctx.get('locale') as LocaleRuntime)
    h.ctx.provide('uiConversation', { userText: { register: () => () => {} }, events: { register: () => () => {} },
      binding: () => ({ target: () => ({ getSnapshot: () => undefined }) }) } as never)
    let capture: ((sessionId: SessionId) => JsonValue | undefined) | undefined
    h.ctx.provide('conversation', { blocks: { setSubmission }, reconcilePromptContext,
      registerPromptContext: (_kind: string, reader: (sessionId: SessionId) => JsonValue | undefined) => {
        capture = reader
        return () => {}
      } } as never)
    const parent = await h.sessions.add({ id: 'waiting-csv' })
    h.sessions.retainFor(h.ctx, parent)
    await h.mount({ inject: [...inject], apply })
    if (capture === undefined) throw new Error('Missing Artifact registration')
    expect(() => capture?.(parent)).toThrow(en['promptContext.unavailableSend'])
    expect(setSubmission).not.toHaveBeenCalled()
    const source = 'artifact-csv-draft'
    await vi.waitFor(() => { expect(setSubmission).toHaveBeenLastCalledWith(parent, source, true) })
    await h.sessions.updateSessionSnapshot(parent, (snapshot) => { snapshot.removed = true })
    expect(setSubmission).toHaveBeenLastCalledWith(parent, source, false)
    await h.sessions.updateSessionSnapshot(parent, (snapshot) => { snapshot.removed = false })
    expect(setSubmission).toHaveBeenLastCalledWith(parent, source, true)
    await vi.waitFor(() => { expect(setSubmission).toHaveBeenCalledTimes(4) }, { timeout: 2_500 })
    expect(setSubmission).toHaveBeenLastCalledWith(parent, source, false)
    expect(capture(parent)).toBeUndefined()
  })

  it('binds a comparison receipt before dispatch and waits for exact recovery when restoring the composer', async () => {
    runtime = await SlotTestRuntime.create()
    const h = runtime
    const requestId = 'question-request' as SessionRequestId
    const bind = vi.fn(async (_request: ArtifactBranchBindCsvComparisonDraftRequest) =>
      ({ ok: true as const, value: { bound: true as const } }))
    const check = vi.fn(async (_request: ArtifactBranchCheckCsvComparisonDraftRequest) =>
      ({ ok: true as const, value: { accepted: true } }))
    const read = vi.fn(async (_request: { sessionId: SessionId }) => ({ ok: true as const, value: null }))
    h.remote.provideNamespaces({ artifactRuntime: { attach: () => runtimeChannel() },
      artifacts: { submitAction: vi.fn() }, artifactExports: { create: vi.fn(), read: vi.fn() },
      artifactBranchResults: { readCsvComparisonDraft: read, bindCsvComparisonDraftRequest: bind, checkCsvComparisonDraftRequest: check } })
    h.ctx.provide('fileActions', { save: vi.fn(), copyImage: vi.fn(), canSaveAs: false })
    h.ctx.provide('locale', new LocaleRuntime(h.ctx))
    h.slots.installLocale(h.ctx.get('locale') as LocaleRuntime)
    h.ctx.provide('uiConversation', { userText: { register: () => () => {} }, events: { register: () => () => {} },
      binding: () => ({ target: () => ({ getSnapshot: () => undefined }) }) } as never)
    type Capture = (sessionId: SessionId) => JsonValue | undefined
    type Prepare = (sessionId: SessionId, value: JsonValue, requestId: SessionRequestId, signal?: AbortSignal) => Promise<boolean>
    let capture: Capture | undefined
    let prepare: Prepare | undefined
    const recovery = Promise.withResolvers<'accepted'>()
    const reconcile = vi.fn(async (_sessionId: SessionId, _kind: string, accepted: (requestId: SessionRequestId) => Promise<boolean | 'pending'>) => {
      expect(await accepted(requestId)).toBe(true)
      return await recovery.promise
    })
    h.ctx.provide('conversation', { registerPromptContext: (_kind: string, reader: Capture, _accepted: unknown, sender: Prepare) => {
      capture = reader
      prepare = sender
      return () => {}
    }, reconcilePromptContext: reconcile } as never)
    const sessionId = await h.sessions.add({ id: 'draft-session' })
    h.sessions.retainFor(h.ctx, sessionId)
    await h.mount({ inject: [...inject], apply })
    if (capture === undefined || prepare === undefined) throw new Error('Missing Artifact registration')
    expect(() => capture?.(sessionId)).toThrow(en['promptContext.unavailableSend'])
    await vi.waitFor(() => { expect(check).toHaveBeenCalledExactlyOnceWith({ sessionId, requestId }) })
    expect(read).toHaveBeenCalledExactlyOnceWith({ sessionId })
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(sessionId, 'artifact', expect.any(Function), undefined)
    expect(() => capture?.(sessionId)).toThrow(en['promptContext.unavailableSend'])
    recovery.resolve('accepted')
    await vi.waitFor(() => { expect(capture?.(sessionId)).toBeUndefined() })
    await expect(prepare(sessionId, { kind: 'observation' }, requestId)).resolves.toBe(false)
    expect(bind).not.toHaveBeenCalled()
    const selection = { kind: 'csv-comparison-draft', receiptId: 'exact-receipt' }
    const aborted = new AbortController()
    aborted.abort()
    await expect(prepare(sessionId, selection, requestId, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(bind).not.toHaveBeenCalled()
    await expect(prepare(sessionId, selection, requestId)).resolves.toBe(true)
    expect(bind).toHaveBeenCalledExactlyOnceWith({ sessionId, requestId, receiptId: 'exact-receipt' })
  })

  it.each([
    'accepted', 'removed before load', 'busy history', 'retry after failed read', 'missing source', 'main view switch',
  ] as const)('restores only the matching function plot draft with %s', async (ending) => {
    runtime = await SlotTestRuntime.create()
    const h = runtime
    h.remote.provideNamespaces({ artifactRuntime: { attach: () => runtimeChannel() },
      artifacts: { submitAction: vi.fn() }, artifactExports: { create: vi.fn(), read: vi.fn() } })
    h.ctx.provide('fileActions', { save: vi.fn(), copyImage: vi.fn(), canSaveAs: false })
    h.ctx.provide('locale', new LocaleRuntime(h.ctx))
    h.slots.installLocale(h.ctx.get('locale') as LocaleRuntime)
    const plot: SceneArtifactSnapshot = { artifactId: 'locked-plot' as ArtifactId, revision: 2, format: 'scene',
      title: 'Locked plot source', presentation: 'inline', spec: { kind: 'function-plot',
        functions: [{ id: 'line', label: 'Line', expression: 'a*x' }], parameters: { a: { value: 1, min: 0, max: 3, step: 1 } },
        viewport: { x: [-2, 2], y: [-4, 4] }, trace: { x: 0, derivative: true, integral: false } } }
    const source = createSnapshotStore<{ kind: 'artifact'; data: { snapshot: SceneArtifactSnapshot } } | undefined>(undefined)
    const chat = createSnapshotStore({ nodes: { source: () => source } })
    h.ctx.provide('uiConversation', { userText: { register: () => () => {} }, events: { register: () => () => {} },
      binding: () => ({ target: () => chat }) } as never)
    const setSubmission = vi.fn()
    type Capture = (sessionId: SessionId) => JsonValue | undefined
    type Accept = (sessionId: SessionId, value: JsonValue, requestId: SessionRequestId) => void
    let capture: Capture | undefined
    let accept: Accept | undefined
    h.ctx.provide('conversation', { blocks: { setSubmission }, registerPromptContext: (_kind: string, reader: Capture, onAccept: Accept) => {
      capture = reader
      accept = onAccept
      return () => {}
    } } as never)
    const page = Promise.withResolvers<undefined>()
    const retryPage = Promise.withResolvers<undefined>()
    const loadThrough = vi.fn<(_seq: SessionSeq) => Promise<void>>()
      .mockReturnValueOnce(page.promise).mockReturnValueOnce(retryPage.promise)
    const sessionId = await h.sessions.add({ id: 'function-plot-draft', session: { loadThrough }, hasMore: true,
      snapshot: { loadingOlder: ending === 'busy history' } })
    const otherSession = SessionId('different-plot-draft')
    const sourceSeq = SessionSeq(7)
    const key = particleRuntimeKey('artifact:locked-plot', plot.artifactId)
    const request = { kind: 'current-function-plot', artifactId: plot.artifactId, revision: 2, functionId: 'line', x: 1, parameters: { a: 2 } } as const
    const saved = { key, sourceSeq, request }
    writeFunctionPlotDraft(sessionId, saved)
    writeFunctionPlotDraft(otherSession, saved)
    onTestFinished(() => { writeFunctionPlotDraft(sessionId); writeFunctionPlotDraft(otherSession) })
    const main = h.sessions.retainFor(h.ctx, sessionId, { source: 'mainView' })
    await h.declare({ 'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: CHAT_NODE_INJECT } })
    await h.mount({ inject: [...inject], apply })
    const dock = h.slots.entriesOfSlot('conversation.input.dock').find(entry => entry.options.id === 'artifact-question-context')
    const node = h.slots.entriesOfSlot('conversation.chat.node').find(entry => entry.options.key === 'artifact')
    if (dock?.inject === undefined || node?.inject === undefined || capture === undefined || accept === undefined) {
      throw new Error('Missing Artifact registrations')
    }
    const ui = dock.inject(sessionId as never)
    const { artifactPromptContext } = ui.hooks as ArtifactPromptContextInjected['hooks']
    expect(artifactPromptContext.getSnapshot()).toMatchObject({ available: false, restoration: 'reading', request })
    expect(setSubmission).toHaveBeenLastCalledWith(sessionId, 'artifact-function-plot-draft', true)
    expect(() => capture?.(sessionId)).toThrow(en['promptContext.unavailableSend'])
    if (ending === 'busy history') {
      expect(loadThrough).not.toHaveBeenCalled()
      await h.sessions.updateSessionSnapshot(sessionId, (snapshot) => { snapshot.loadingOlder = false })
    }
    expect(loadThrough).toHaveBeenCalledExactlyOnceWith(sourceSeq)
    const clear = ui.clearArtifactPromptContext as ArtifactPromptContextInjected['clearArtifactPromptContext']
    const retry = ui.retryFunctionPlotDraft as ArtifactPromptContextInjected['retryFunctionPlotDraft']
    if (ending === 'removed before load') clear()
    if (ending === 'retry after failed read') {
      await act(async () => { page.resolve(undefined); await page.promise })
      expect(artifactPromptContext.getSnapshot()).toMatchObject({ available: false, restoration: 'retry', request })
      expect(setSubmission).toHaveBeenLastCalledWith(sessionId, 'artifact-function-plot-draft', true)
      expect(() => capture?.(sessionId)).toThrow(en['promptContext.unavailableSend'])
      expect(readFunctionPlotDraft(sessionId)).toEqual(saved)
      expect(loadThrough).toHaveBeenCalledTimes(1)
      retry()
      retry()
      expect(loadThrough.mock.calls).toEqual([[sourceSeq], [sourceSeq]])
      expect(artifactPromptContext.getSnapshot()).toMatchObject({ available: false, restoration: 'reading', request })
    }
    if (ending === 'missing source') {
      await h.sessions.replaceEvents(sessionId, [], false)
      await act(async () => { page.resolve(undefined); await page.promise })
      expect(artifactPromptContext.getSnapshot()).toMatchObject({ available: false, request })
      expect(artifactPromptContext.getSnapshot()).not.toHaveProperty('restoration')
      expect(() => capture?.(sessionId)).toThrow(en['promptContext.unavailableSend'])
      retry()
      expect(loadThrough).toHaveBeenCalledTimes(1)
      clear()
    }
    if (ending === 'main view switch') {
      h.sessions.retainFor(h.ctx, sessionId)
      main.release()
    }

    source.set({ kind: 'artifact', data: { snapshot: plot } })
    await h.sessions.prependEvents(sessionId, [{ type: 'event', event: { type: 'artifact/upsert', seq: sourceSeq, time: 7, data: plot } }], false)
    await act(async () => { page.resolve(undefined); retryPage.resolve(undefined); await page.promise })
    if (ending === 'main view switch') {
      expect(artifactPromptContext.getSnapshot()).toMatchObject({ available: false, restoration: 'reading', request })
      expect(setSubmission).toHaveBeenLastCalledWith(sessionId, 'artifact-function-plot-draft', true)
      h.sessions.retainFor(h.ctx, sessionId, { source: 'mainView' })
      expect(loadThrough).toHaveBeenCalledExactlyOnceWith(sourceSeq)
    }
    expect(setSubmission).toHaveBeenLastCalledWith(sessionId, 'artifact-function-plot-draft', false)
    if (ending !== 'removed before load' && ending !== 'missing source') {
      expect(artifactPromptContext.getSnapshot()).toMatchObject({ available: true, title: 'Locked plot source', request })
      expect(capture(sessionId)).toEqual(request)
      const requestId = 'native-question-request' as SessionRequestId
      accept(sessionId, { ...request, x: 2 }, requestId)
      expect(readFunctionPlotDraft(sessionId)).toEqual(saved)
      accept(sessionId, request, requestId)
      const choose = node.inject(sessionId as never).choosePlotPromptContext as ArtifactNodeInjected['choosePlotPromptContext']
      const next = { ...request, x: 0, parameters: { a: 1 } }
      expect(choose(key, plot, next)).toBe(true)
      expect(readFunctionPlotDraft(sessionId)).toEqual({ ...saved, request: next })
      accept(sessionId, request, requestId)
      expect(capture(sessionId)).toEqual(next)
      accept(sessionId, next, requestId)
    }
    expect(capture(sessionId)).toBeUndefined()
    expect(artifactPromptContext.getSnapshot()).toBeNull()
    expect(readFunctionPlotDraft(sessionId)).toBeUndefined()
    expect(readFunctionPlotDraft(otherSession)).toEqual(saved)
  })

  it.each(['continuable', 'one-shot', 'unknown'] as const)('leaves context choices unchanged for the %s subagent route without throwing from an old button', async (mode) => {
    runtime = await SlotTestRuntime.create()
    const h = runtime
    h.remote.provideNamespaces({ artifactRuntime: { attach: () => runtimeChannel() },
      artifacts: { submitAction: vi.fn() }, artifactExports: { create: vi.fn(), read: vi.fn() } })
    h.ctx.provide('fileActions', { save: vi.fn(), copyImage: vi.fn(), canSaveAs: false })
    h.ctx.provide('locale', new LocaleRuntime(h.ctx))
    h.slots.installLocale(h.ctx.get('locale') as LocaleRuntime)
    const binding = vi.fn(() => ({ target: () => ({ getSnapshot: () => ({ nodes: { source: () => ({
      getSnapshot: () => undefined, subscribe: () => () => {},
    }) } }) }) }))
    h.ctx.provide('uiConversation', { userText: { register: () => () => {} }, events: { register: () => () => {} }, binding } as never)
    let capture: ((sessionId: SessionId) => JsonValue | undefined) | undefined
    h.ctx.provide('conversation', { registerPromptContext: (_kind: string, reader: (sessionId: SessionId) => JsonValue | undefined) => {
      capture = reader
      return () => { capture = undefined }
    } } as never)
    const id = await h.sessions.add({ id: 'question-route', summary: { parentId: 'manual-parent' as SessionId } })
    h.sessions.retainFor(h.ctx, id)
    await h.declare({
      'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: CHAT_NODE_INJECT },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
    })
    await h.mount({ inject: [...inject], apply })
    const entry = h.slots.entriesOfSlot('conversation.chat.node').find(entry => entry.options.key === 'artifact')
    const dock = h.slots.entriesOfSlot('conversation.input.dock').find(entry => entry.options.id === 'artifact-question-context')
    if (entry?.inject === undefined || dock?.inject === undefined || capture === undefined) throw new Error('Missing Artifact registrations')
    const injected = entry.inject(id as never)
    const chooseSaved = injected.chooseObservationPromptContext as ArtifactNodeInjected['chooseObservationPromptContext']
    const chooseCurrent = injected.chooseParticlePromptContext as ArtifactNodeInjected['chooseParticlePromptContext']
    const chooseRuntime = injected.chooseRuntimePromptContext as ArtifactNodeInjected['chooseRuntimePromptContext']
    const chooseComparison = injected.chooseComparisonPromptContext as ArtifactNodeInjected['chooseComparisonPromptContext']
    const artifact = { artifactId: 'particle' as ArtifactId, revision: 1, format: 'scene', presentation: 'inline', title: 'Particle',
      spec: { kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 0, vx: 1, vy: 0, mass: 1 }],
        gravity: { x: 0, y: 0 }, timeStep: 0.1, trails: false } } as const
    const saved: SavedParticleObservation = {
      observationId: 'zero' as ArtifactObservationId, label: 'Zero', artifact,
      checkpoint: { runtimeVersion: 1, stepCount: 0 }, values: observeParticleState(createParticleState(artifact.spec)),
    }
    const chooseAll = (): void => {
      chooseSaved(saved)
      chooseCurrent('unused', saved.artifact, { generation: 1, checkpoint: saved.checkpoint, values: saved.values })
      chooseRuntime('unused', saved.artifact, { artifactId: saved.artifact.artifactId, revision: 1,
        runtimeId: 'unused' as never, renderer: 'html' })
      chooseComparison('pair', saved, saved)
    }
    await h.sessions.updateSessionSnapshot(id, (snapshot) => {
      snapshot.subagent = { address: { parentSessionId: 'parent' as SessionId, childSessionId: id, mode }, parentAvailable: true }
    })
    expect(chooseAll).not.toThrow()
    expect(capture(id)).toBeUndefined()
    expect(binding).not.toHaveBeenCalled()
    const recordAction = injected.recordAction as ArtifactNodeInjected['recordAction']
    const saveObservation = injected.saveObservation as ArtifactNodeInjected['saveObservation']
    const sendObservation = injected.sendObservation as ArtifactNodeInjected['sendObservation']
    const confirmComparison = injected.confirmObservationComparison as ArtifactNodeInjected['confirmObservationComparison']
    const exports = injected.exports as NonNullable<ArtifactNodeInjected['exports']>
    const exportRequest: ArtifactHtmlExportRequest = { exportId: 'unavailable' as ArtifactExportId, format: 'html',
      source: { kind: 'current', artifactId: artifact.artifactId, revision: 1 } }
    await expect(recordAction(artifact.artifactId, 1, 'physics.inspected', {}, true,
      'blocked-action' as ArtifactActionRequest['requestId'])).rejects.toThrow(en['route.subagentLocalOnly'])
    await expect(saveObservation(artifact.artifactId, 1, saved.observationId, saved.label, saved.checkpoint))
      .rejects.toThrow(en['route.subagentLocalOnly'])
    await expect(sendObservation(artifact.artifactId, saved.observationId, true)).rejects.toThrow(en['route.subagentLocalOnly'])
    await expect(confirmComparison('pair', { artifactId: artifact.artifactId, observationId: saved.observationId },
      { artifactId: artifact.artifactId, observationId: saved.observationId }, true)).rejects.toThrow(en['route.subagentLocalOnly'])
    await expect(exports.create(exportRequest)).rejects.toThrow(en['route.subagentLocalOnly'])
    const record: ArtifactHtmlExportRecord & { status: 'ready' } = { request: exportRequest, frozen: {
      sessionId: id, artifact, exporterVersion: 1, parameters: 'particle-checkpoint', checkpoint: saved.checkpoint }, status: 'ready',
    file: { attachmentId: 'sha256:unread' as never, name: 'unread.html', bytes: 1 } }
    await expect(exports.download(record)).rejects.toThrow(en['route.subagentLocalOnly'])
    await h.sessions.updateSessionSnapshot(id, (snapshot) => { snapshot.subagent = null })
    chooseSaved(saved)
    expect(capture(id)).toEqual({ kind: 'observation', ref: { artifactId: saved.artifact.artifactId, observationId: saved.observationId } })
    const injectedDock = dock.inject(id as never)
    const hooks = injectedDock.hooks as ArtifactPromptContextInjected['hooks']
    const selected = hooks.artifactPromptContext.getSnapshot()
    await h.sessions.updateSessionSnapshot(id, (snapshot) => {
      snapshot.subagent = { address: { parentSessionId: 'parent' as SessionId, childSessionId: id, mode }, parentAvailable: true }
    })
    expect(chooseAll).not.toThrow()
    expect(hooks.artifactPromptContext.getSnapshot()).toBe(selected)
    expect(() => { capture?.(id) }).toThrow(en['promptContext.subagentUnsupported'])
    expect(binding).toHaveBeenCalledOnce()
    const clear = injectedDock.clearArtifactPromptContext as ArtifactPromptContextInjected['clearArtifactPromptContext']
    clear()
    expect(capture(id)).toBeUndefined()
  })

  it('binds Session Remote arguments through Slot inject and removes registrations on disposal', async () => {
    runtime = await SlotTestRuntime.create()
    const h = runtime
    const record = vi.fn(async (_sessionId: SessionId, _request: ArtifactActionRequest) => ({ ok: true as const, value: undefined }))
    h.remote.provideNamespaces({ artifactRuntime: { attach: () => runtimeChannel() },
      artifacts: { submitAction: record }, artifactExports: { create: vi.fn(), read: vi.fn() } })
    h.ctx.provide('fileActions', { save: vi.fn(), copyImage: vi.fn(), canSaveAs: false })
    h.ctx.provide('locale', new LocaleRuntime(h.ctx))
    h.slots.installLocale(h.ctx.get('locale') as LocaleRuntime)
    const unregisterText = vi.fn()
    const registerText = vi.fn(() => unregisterText)
    const unregisterCapture = vi.fn()
    const registerCapture = vi.fn(() => unregisterCapture)
    const unregisterDefinition = vi.fn()
    const register = vi.fn(() => unregisterDefinition)
    h.ctx.provide('uiConversation', { userText: { register: registerText }, events: { register }, binding: () => ({ target: () => ({ getSnapshot: () => ({
      nodes: { source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) },
    }) }) }) } as never)
    h.ctx.provide('conversation', { registerPromptContext: registerCapture } as never)
    const sessionId = await h.sessions.add({ id: 'artifact-session' })
    const reference = h.sessions.retainFor(h.ctx, sessionId)
    await h.declare({
      'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: CHAT_NODE_INJECT },
    })
    const feature = await h.mount({ inject: [...inject], apply })
    const data = {
      artifactId: 'integrated', revision: 3, format: 'html', title: 'Integrated',
      source: '<p>Integrated</p>', presentation: 'inline',
    } as const
    const owner = {
      node: {
        key: 'artifact:integrated', id: 'integrated', kind: 'artifact', target: 'chat', anchorSeq: 3,
        location: { kind: 'session' }, visibility: 'visible', data: { snapshot: data, history: null, firstSeq: 1 },
      },
      openFile: vi.fn(), inspectCall: undefined, forkAt: vi.fn(), loadImage: vi.fn(),
    }
    const slot = h.renderSlot('conversation.chat.node', owner, {
      entryKey: 'artifact', session: reference,
      hookContext: {
        turnData: undefined,
        disclosureReset: createSnapshotStore(0),
        useGroupAction: () => { throw new Error('unused group action') },
      },
    })
    const iframe = slot.container.querySelector('iframe')!
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: { kind: 'artifact-action', artifactId: 'integrated', revision: 3, action: 'publish', payload: { path: 'index.html' } },
      }))
    })
    fireEvent.click(await slot.view.findByRole('button', { name: 'Send to Agent' }))
    await slot.view.findByText('Integrated')
    expect(record).toHaveBeenCalledExactlyOnceWith(sessionId, { requestId: record.mock.calls[0]![1].requestId, artifactId: 'integrated', revision: 3,
      action: 'publish', payload: { path: 'index.html' }, wake: true })
    expect(register).toHaveBeenCalledTimes(3)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'artifact-branch-evidence' }))
    expect(registerText).toHaveBeenCalledTimes(3)
    expect(registerText).toHaveBeenCalledWith(expect.objectContaining({ id: 'artifact-csv-comparison-context' }))
    expect(registerCapture).toHaveBeenCalledExactlyOnceWith('artifact', expect.any(Function), expect.any(Function), expect.any(Function))

    await feature.dispose()
    slot.update(owner)
    expect(slot.container.querySelector('iframe')).toBeNull()
    expect(unregisterDefinition).toHaveBeenCalledTimes(3)
    expect(unregisterText).toHaveBeenCalledTimes(3)
    expect(unregisterCapture).toHaveBeenCalledOnce()
  })

  it('exports the exact CSV comparison address and uses the active UI locale only for HTML', async () => {
    runtime = await SlotTestRuntime.create()
    const h = runtime
    const bytes = new TextEncoder().encode('<p>Frozen comparison</p>')
    const read = vi.fn(async (_request: ArtifactBranchExportSentCsvComparisonRequest) => ({ ok: true as const, value: bytes }))
    const jsonBytes = new TextEncoder().encode('{"format":"agentrans-csv-comparison","version":1}')
    const readJson = vi.fn(async (_request: ArtifactBranchReviewSentCsvComparisonRequest) => ({ ok: true as const, value: jsonBytes }))
    h.remote.provideNamespaces({ artifactRuntime: { attach: () => runtimeChannel() }, artifacts: { submitAction: vi.fn() },
      artifactExports: { create: vi.fn(), read: vi.fn() },
      artifactBranchResults: { exportSentCsvComparison: read, exportSentCsvComparisonJson: readJson } })
    const save = vi.fn<FileActions['save']>().mockImplementation(async (source) => {
      if (source.read === undefined) throw new Error('Missing authorized comparison reader')
      const blob = await source.read(new AbortController().signal)
      expect(blob.size).toBe(source.mediaType === 'text/html' ? bytes.length : jsonBytes.length)
      expect(blob.type).toBe(source.mediaType)
      return { status: 'requested' }
    })
    h.ctx.provide('fileActions', { save, copyImage: vi.fn(), canSaveAs: false })
    const locale = new LocaleRuntime(h.ctx)
    locale.setLocale('en')
    h.ctx.provide('locale', locale)
    h.slots.installLocale(locale)
    h.ctx.provide('uiConversation', { userText: { register: () => () => {} }, events: { register: () => () => {} },
      binding: () => ({ target: () => ({ getSnapshot: () => undefined }) }) } as never)
    h.ctx.provide('conversation', { registerPromptContext: () => () => {} } as never)
    const sessionId = await h.sessions.add({ id: 'sent-csv-export' })
    h.sessions.retainFor(h.ctx, sessionId)
    await h.declare({ 'conversation.user.text.node': { kind: 'keyed', scope: 'session', inline: true } })
    await h.mount({ inject: [...inject], apply })
    const entry = h.slots.entriesOfSlot('conversation.user.text.node')
      .find(slot => slot.options.key === 'artifact-csv-comparison-context')
    if (entry?.inject === undefined) throw new Error('Missing CSV comparison Slot')
    const download = entry.inject(sessionId as never).downloadSentCsvComparison as CsvComparisonContextInjected['downloadSentCsvComparison']
    expect(read).not.toHaveBeenCalled()
    const target = { eventSeq: 31, messageId: MessageId('sent-csv-message') }
    await expect(download(target, 'html')).resolves.toEqual({ status: 'requested' })
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'csv-comparison-31.html', mediaType: 'text/html' }), 'download')
    expect(read).toHaveBeenCalledExactlyOnceWith({ sessionId, ...target, locale: 'en' })
    expect(readJson).not.toHaveBeenCalled()
    locale.setLocale('zh')
    await expect(download(target, 'html')).resolves.toEqual({ status: 'requested' })
    expect(read.mock.calls.map(([request]) => request)).toEqual([
      { sessionId, ...target, locale: 'en' }, { sessionId, ...target, locale: 'zh' },
    ])
    await expect(download(target, 'json')).resolves.toEqual({ status: 'requested' })
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'csv-comparison-31.json', mediaType: 'application/json' }), 'download')
    expect(read).toHaveBeenCalledTimes(2)
    expect(readJson).toHaveBeenCalledExactlyOnceWith({ sessionId, ...target })
  })

  it('restores an imported comparison on a blank Session and saves a new preview only on confirmation', async () => {
    runtime = await SlotTestRuntime.create()
    const h = runtime
    const sessionId = await h.sessions.add({ id: 'blank-csv-import', snapshot: { blank: true } })
    const record = { groupKey: 'Warm', aggregate: 'sum', value: 35, count: 1, valueColumn: 'LatencyMs' } as const
    const attachment: ArtifactCsvComparisonAttachment = { proof: 'proof', facts: { kind: 'csv-question-comparison',
      sessionId, attribution: 'user-imported', comparison: { original: record, current: record,
        kept: 1, excluded: 0, added: 0, total: 1, offset: 0, rows: [{ record: 5, status: 'kept', value: '35' }] } } }
    const restored: ArtifactCsvComparisonDraft = { receiptId: 'restored-import', facts: attachment.facts }
    const saved: ArtifactCsvComparisonDraft = { receiptId: 'chosen-import', facts: attachment.facts }
    const read = vi.fn(async () => ({ ok: true as const, value: restored }))
    const preview = vi.fn(async (_request: ArtifactBranchImportCsvComparisonRequest) => ({ ok: true as const, value: attachment }))
    const save = vi.fn(async (_request: ArtifactBranchSaveCsvComparisonDraftRequest) => ({ ok: true as const, value: saved }))
    h.remote.provideNamespaces({ artifactRuntime: { attach: () => runtimeChannel() }, artifacts: { submitAction: vi.fn() },
      artifactExports: { create: vi.fn(), read: vi.fn() },
      artifactBranchResults: { readCsvComparisonDraft: read, importCsvComparison: preview, saveCsvComparisonDraft: save } })
    h.ctx.provide('fileActions', { save: vi.fn(), copyImage: vi.fn(), canSaveAs: false })
    h.ctx.provide('locale', new LocaleRuntime(h.ctx))
    h.slots.installLocale(h.ctx.get('locale') as LocaleRuntime)
    h.ctx.provide('uiConversation', { userText: { register: () => () => {} }, events: { register: () => () => {} },
      binding: () => ({ target: () => ({ getSnapshot: () => undefined }) }) } as never)
    const focus = vi.fn(() => true)
    h.ctx.provide('conversation', { registerPromptContext: () => () => {}, input: { for: () => ({ focus }) },
      reconcilePromptContext: () => Promise.resolve('untracked') } as never)
    using main = h.sessions.retainFor(h.ctx, sessionId, { source: 'mainView' })
    await main.ready
    await h.declare({ 'conversation.input.dock': { kind: 'list', scope: 'session' } })
    await h.mount({ inject: [...inject], apply })
    const entry = h.slots.entriesOfSlot('conversation.input.dock').find(slot => slot.options.id === 'artifact-question-context')
    if (entry?.inject === undefined) throw new Error('Missing CSV draft Dock')
    const injected = entry.inject(sessionId as never)
    const { csvComparisonDraft, artifactPromptContext } = injected.hooks as ArtifactPromptContextInjected['hooks']
    await vi.waitFor(() => { expect(csvComparisonDraft.getSnapshot()).toBe('ready') })
    expect(read).toHaveBeenCalledExactlyOnceWith({ sessionId })
    expect(artifactPromptContext.getSnapshot()).toMatchObject({ draft: restored })

    const json = '{"format":"agentrans-csv-comparison","version":1}'
    const load = injected.loadCsvComparisonImport as ArtifactPromptContextInjected['loadCsvComparisonImport']
    const review = await load(json, new AbortController().signal)
    expect(preview).toHaveBeenCalledExactlyOnceWith({ sessionId, json })
    expect(review).toMatchObject({ page: attachment.facts.comparison, replacesContext: true })
    expect(save).not.toHaveBeenCalled()
    expect(artifactPromptContext.getSnapshot()).toMatchObject({ draft: restored })
    await expect(review.confirm()).resolves.toBe(true)
    expect(save).toHaveBeenCalledExactlyOnceWith({ sessionId, attachment, expectedReceiptId: restored.receiptId })
    expect(artifactPromptContext.getSnapshot()).toMatchObject({ draft: saved })
    expect(focus).toHaveBeenCalledOnce()
  })

  it.each(['explanation', 'return cards'] as const)('only replaces the draft with the same imported %s', async (kind) => {
    runtime = await SlotTestRuntime.create()
    const h = runtime
    const sessionId = await h.sessions.add({ id: 'reuse-imported-pair' })
    const mean = { groupKey: 'Warm', aggregate: 'mean', value: 30, count: 2, valueColumn: 'LatencyMs' } as const
    const sum = { ...mean, aggregate: 'sum', value: 60 } as const
    const originalRows = [{ record: 4, status: 'kept', value: '25' }, { record: 5, status: 'kept', value: '35' }] as const
    const first = { original: mean, current: sum, kept: 2, excluded: 0, added: 0, total: 2, offset: 0, rows: originalRows } as const
    const second = { ...first, current: { ...sum, count: 1, value: 35, filter: { column: 'Batch', value: 'B' } }, kept: 1, excluded: 1,
      rows: [{ record: 4, status: 'excluded', value: '25' }, originalRows[1]] } as const
    const explanation = { aggregation: { comparison: first } }
    const target = { eventSeq: 32, messageId: MessageId('sent-imported-pair') }
    const savedCard = { title: 'Warm latency', groupBy: 'Trial' }
    const returnCards = {
      first: { ...savedCard, revision: 1, conclusion: ['Mean 30.'], groups: [{ key: 'Warm', value: 30, count: 2 }] },
      second: { ...savedCard, revision: 2, conclusion: ['Sum 60.'], groups: [{ key: 'Warm', value: 60, count: 2 }] },
    }
    const common = { kind: 'csv-question-comparison', sessionId, attribution: 'user-imported', reusedFrom: target } as const
    const paired = { ...common, comparison: second, explanation }
    const returned = { ...common, comparison: first, returnCards }
    const facts = kind === 'explanation' ? paired : returned
    const imported = { proof: 'signed-pair', facts } satisfies ArtifactCsvComparisonAttachment
    const { comparison } = facts
    const prior: ArtifactCsvComparisonDraft = { receiptId: 'old', facts: { ...facts, comparison: { ...comparison,
      current: { ...comparison.current, value: 39 } } } }
    const saved = { receiptId: 'copied-pair', facts } satisfies ArtifactCsvComparisonDraft
    const wrongContents = { ...imported, facts: kind === 'explanation'
      ? { ...paired, explanation: { aggregation: { comparison: { ...first, current: { ...first.current, value: 61 } } } } }
      : { ...returned, returnCards: { ...returnCards, second: { ...returnCards.second, revision: 3 } } } }
    const wrongPage = { ...imported, facts: { ...facts, comparison: { ...comparison, current: { ...comparison.current, value: 36 } } } }
    const wrongSource = { ...imported, facts: { ...facts, reusedFrom: { ...target, eventSeq: 31 } } }
    const review = vi.fn<(_request: ArtifactBranchReviewSentCsvComparisonRequest) => Promise<{
      ok: true
      value: ArtifactCsvComparisonAttachment
    }>>().mockResolvedValueOnce({ ok: true, value: wrongContents }).mockResolvedValueOnce({ ok: true, value: wrongPage })
      .mockResolvedValueOnce({ ok: true, value: wrongSource })
      .mockResolvedValue({ ok: true, value: imported })
    const read = vi.fn(async () => ({ ok: true as const, value: prior }))
    const save = vi.fn(async (_request: ArtifactBranchSaveCsvComparisonDraftRequest) => ({ ok: true as const, value: saved }))
    h.remote.provideNamespaces({ artifactRuntime: { attach: () => runtimeChannel() }, artifacts: { submitAction: vi.fn() },
      artifactExports: { create: vi.fn(), read: vi.fn() }, artifactBranchResults: {
        reviewSentCsvComparison: review, readCsvComparisonDraft: read, saveCsvComparisonDraft: save,
      } })
    h.ctx.provide('fileActions', { save: vi.fn(), copyImage: vi.fn(), canSaveAs: false })
    h.ctx.provide('locale', new LocaleRuntime(h.ctx))
    h.slots.installLocale(h.ctx.get('locale') as LocaleRuntime)
    h.ctx.provide('uiConversation', { userText: { register: () => () => {} }, events: { register: () => () => {} },
      binding: () => ({ target: () => ({ getSnapshot: () => undefined }) }) } as never)
    const focus = vi.fn(() => true)
    h.ctx.provide('conversation', { registerPromptContext: () => () => {}, input: { for: () => ({ focus }) },
      reconcilePromptContext: () => Promise.resolve('untracked') } as never)
    using main = h.sessions.retainFor(h.ctx, sessionId, { source: 'mainView' })
    await main.ready
    await h.declare({ 'conversation.user.text.node': { kind: 'keyed', scope: 'session', inline: true } })
    await h.mount({ inject: [...inject], apply })
    const entry = h.slots.entriesOfSlot('conversation.user.text.node').find(slot => slot.options.key === 'artifact-csv-comparison-context')
    if (entry?.inject === undefined) throw new Error('Missing CSV comparison Slot')
    const injected = entry.inject(sessionId as never)
    const { csvHistoryDraftPhase } = injected.hooks as CsvComparisonContextInjected['hooks']
    await vi.waitFor(() => { expect(csvHistoryDraftPhase.getSnapshot()).toBe('ready') })
    const reuse = injected.reviewSentCsvComparison as CsvComparisonContextInjected['reviewSentCsvComparison']
    const startReview = () => kind === 'explanation' ? reuse(target, comparison, explanation) : reuse(target, comparison, undefined, returnCards)
    const snapshot = startReview()
    expect(snapshot?.replacesContext).toBe(true)
    expect(review).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    await expect(snapshot?.confirm()).resolves.toBe('unavailable')
    await expect(startReview()?.confirm()).resolves.toBe('unavailable')
    await expect(startReview()?.confirm()).resolves.toBe('unavailable')
    expect(save).not.toHaveBeenCalled()
    await expect(startReview()?.confirm()).resolves.toBe(true)
    expect(review.mock.calls).toEqual(Array.from({ length: 4 }, () => [{ sessionId, ...target }]))
    expect(save).toHaveBeenCalledExactlyOnceWith({ sessionId, attachment: imported, expectedReceiptId: prior.receiptId })
    expect(focus).toHaveBeenCalledOnce()
  })

  it('rejects a Host refusal so the card can retain and retry its pending action', async () => {
    const ctx = { remote: { artifacts: { submitAction: async () => ({ ok: false, error: { message: 'denied' } }) } } }
    await expect(recordArtifactAction(ctx as never, 'session' as never, 'artifact' as ArtifactId, 1, 'publish', null, true, 'stable' as never))
      .rejects.toThrow('denied')
  })

  it.each([
    ['artifact/action-conflict', { requestId: 'stable' }, 'conflict'],
    ['artifact/action-unavailable', { reason: 'SERVICE_UNAVAILABLE' }, 'unavailable'],
    ['artifact/action-unknown', { requestId: 'stable' }, 'unknown'],
    ['artifact/action-rejected', { reason: 'BAD_INPUT' }, 'invalid'],
    ['artifact/action-rejected', { reason: 'CALLER_NOT_LIVE_ROOT' }, 'denied'],
    ['artifact/action-rejected', { reason: 'CALLER_NOT_OWNER' }, 'denied'],
    ['artifact/action-rejected', { reason: 'AGENT_REGISTRY_UNAVAILABLE' }, 'unavailable'],
    ['artifact/action-rejected', { reason: 'ARTIFACT_NOT_FOUND' }, 'source-unavailable'],
    ['artifact/action-rejected', { reason: 'STALE_REVISION', currentRevision: 2 }, 'stale'],
    ['artifact/action-rejected', { reason: 'ACTION_TOO_LARGE' }, 'too-large'],
    ['gateway/service-unavailable', {}, 'unavailable'],
    ['remote-access/denied', {}, 'denied'],
  ] as const)('classifies stable action %s refusals without parsing diagnostic text', async (code, details, failure) => {
    const submitAction = vi.fn().mockResolvedValue({ ok: false, error: { code, details, message: 'diagnostic' } })
    const ctx = { remote: { artifacts: { submitAction } } }
    const operation = recordArtifactAction(ctx as never, 'session' as never, 'artifact' as ArtifactId, 1, 'inspect', null, true, 'stable' as never)
    await expect(operation).rejects.toBeInstanceOf(ArtifactActionRequestError)
    await expect(operation).rejects.toMatchObject({ failure })
    expect(submitAction).toHaveBeenCalledExactlyOnceWith('session', {
      requestId: 'stable', artifactId: 'artifact', revision: 1, action: 'inspect', payload: null, wake: true,
    })
  })

  it('requires capture to provide a stable action identity instead of minting one in the Remote adapter', async () => {
    const submitAction = vi.fn()
    const ctx = { remote: { artifacts: { submitAction } } }
    await expect(recordArtifactAction(ctx as never, 'session' as never, 'artifact' as ArtifactId, 1, 'inspect', null, true))
      .rejects.toMatchObject({ failure: 'invalid' })
    expect(submitAction).not.toHaveBeenCalled()
  })

  it('keeps the node half free of registrations', () => {
    expect(hostApply).toBeTypeOf('function')
    hostApply()
  })

  it('keeps export admission separate from authorized original-byte transfer and preserves platform outcomes', async () => {
    const request: ArtifactHtmlExportRequest = { exportId: 'export-1' as ArtifactExportId, format: 'html',
      source: { kind: 'current', artifactId: 'scene' as ArtifactId, revision: 1 } }
    const record: ArtifactHtmlExportRecord & { status: 'ready' } = { request,
      frozen: { sessionId: 'session' as never, artifact: { artifactId: 'scene' as ArtifactId, revision: 1, title: 'Plot', presentation: 'inline', format: 'scene',
        spec: { kind: 'flowchart', nodes: [], edges: [] } }, exporterVersion: 1, parameters: 'source-defaults' }, status: 'ready',
      file: { attachmentId: 'sha256:abc' as never, name: 'plot.html', bytes: 4 } }
    const create = vi.fn(async () => ({ ok: true as const, value: record }))
    const bytes = new Uint8Array([60, 104, 49, 62])
    const read = vi.fn(async () => ({ ok: true as const, value: bytes }))
    const save = vi.fn<FileActions['save']>(async () => ({ status: 'requested' }))
    const ctx = { remote: { artifactExports: { create, read } }, fileActions: { save } }
    expect(await createArtifactExport(ctx as never, 'session' as never, request)).toBe(record)
    expect(create).toHaveBeenCalledExactlyOnceWith('session', request)
    expect(read).not.toHaveBeenCalled()
    expect(await downloadArtifactExport(ctx as never, 'session' as never, record)).toEqual({ status: 'requested' })
    expect(read).not.toHaveBeenCalled()
    const call = vi.mocked(save).mock.calls[0]!
    expect(call[1]).toBe('download')
    expect(call[0]).toMatchObject({ name: 'plot.html', mediaType: 'text/html' })
    if (call[0].read === undefined) throw new Error('Expected authorized original-byte reader')
    const blob = await call[0].read(new AbortController().signal)
    expect(blob.size).toBe(4)
    expect(blob.type).toBe('text/html')
    expect(read).toHaveBeenCalledExactlyOnceWith('session', 'export-1')
    expect(create).toHaveBeenCalledOnce()
  })

  it.each([
    ['artifact-export/limit', { limit: 3 }, 'limit'],
    ['artifact-export/input-too-large', { limit: 256 }, 'input-too-large'],
    ['artifact-export/source-unavailable', { reason: 'STALE_REVISION' }, 'source-unavailable'],
    ['artifact-export/request-conflict', { exportId: 'export-1' }, 'conflict'],
    ['gateway/service-unavailable', {}, 'service-unavailable'],
    ['gateway/internal', {}, 'unknown'],
    ['remote-access/denied', {}, 'denied'],
    ['gateway/bad-request', {}, 'invalid'],
  ] as const)('classifies export failure %s by code and retains its diagnostic', async (code, details, failure) => {
    const error = { code, details, message: 'unrelated diagnostic' }
    const ctx = { remote: { artifactExports: { create: async () => ({ ok: false, error }) } } }
    const result = createArtifactExport(ctx as never, 'session' as never, { exportId: 'export-1' as ArtifactExportId,
      format: 'html', source: { kind: 'current', artifactId: 'plot' as ArtifactId, revision: 1 } })
    await expect(result).rejects.toBeInstanceOf(ArtifactExportRequestError)
    await expect(result).rejects.toMatchObject({ failure, cause: error })
  })

  it('keeps save and send on separate Session Remote calls', async () => {
    const saved: SavedParticleObservation = {
      observationId: 'saved-a' as ArtifactObservationId, label: 'A',
      artifact: {
        artifactId: 'particles' as ArtifactId, revision: 1, format: 'scene', presentation: 'inline', title: 'Particles',
        spec: { kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 0, vx: 1, vy: 0, mass: 1 }],
          gravity: { x: 0, y: -9.8 }, timeStep: 0.02, trails: false },
      },
      checkpoint: { runtimeVersion: 1, stepCount: 1 },
      values: { time: 0.02, particles: [{ id: 'p', x: 0.02, y: 0, vx: 1, vy: -0.196 }] },
    }
    const saveObservation = vi.fn(async () => ({ ok: true as const, value: saved }))
    const sendObservation = vi.fn(async () => ({ ok: true as const, value: { accepted: true, revision: 1 } }))
    const record = vi.fn()
    const ctx = { remote: { artifacts: { saveObservation, sendObservation, record } } }
    const session = 'saved-session' as never
    expect(await saveArtifactObservation(ctx as never, session, saved.artifact.artifactId,
      1, saved.observationId, 'A', saved.checkpoint)).toBe(saved)
    expect(saveObservation).toHaveBeenCalledExactlyOnceWith(session, 'particles', 1, 'saved-a', 'A', saved.checkpoint)
    expect(record).not.toHaveBeenCalled()
    expect(sendObservation).not.toHaveBeenCalled()
    await sendArtifactObservation(ctx as never, session, saved.artifact.artifactId, saved.observationId, true)
    expect(sendObservation).toHaveBeenCalledExactlyOnceWith(session, 'particles', 'saved-a', true)
  })

  it.each([
    [new RemoteError('artifact/observation-limit', 'Connection diagnostic does not name the limit', {
      artifactId: 'particles' as ArtifactId, limit: 3,
    }), { kind: 'limit', limit: 3 }],
    [new RemoteError('artifact/stale-revision', 'Another diagnostic', {
      artifactId: 'particles' as ArtifactId, expectedRevision: 1, currentRevision: 2,
    }), { kind: 'stale', currentRevision: 2 }],
    [new RemoteError('gateway/internal', 'saved observation limit reached for this Artifact', {}), { kind: 'unknown' }],
  ] as const)('preserves structured save refusal %s without parsing diagnostics', async (failure, expected) => {
    const ctx = { remote: { artifacts: { saveObservation: async () => ({ ok: false as const, error: failure }) } } }
    const saved = saveArtifactObservation(ctx as never, 'session' as never, 'particles' as ArtifactId, 1,
      'saved-a' as ArtifactObservationId, 'A', { runtimeVersion: 1, stepCount: 1 })
    await expect(saved).rejects.toBeInstanceOf(ArtifactObservationSaveError)
    await expect(saved).rejects.toMatchObject({ code: failure.code, cause: failure, failure: expected })
  })

  it('confirms saved comparison references through their Session Remote without sending browser values', async () => {
    const confirmObservationComparison = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const record = vi.fn()
    const sendObservation = vi.fn()
    const ctx = { remote: { artifacts: { confirmObservationComparison, record, sendObservation } } }
    const control = { artifactId: 'control' as ArtifactId, observationId: 'a' as ArtifactObservationId }
    const variant = { artifactId: 'variant' as ArtifactId, observationId: 'b' as ArtifactObservationId }
    await confirmArtifactObservationComparison(ctx as never, 'comparison-session' as never, 'fixed-study', control, variant, true)
    expect(confirmObservationComparison).toHaveBeenCalledExactlyOnceWith('comparison-session', 'fixed-study', control, variant, true)
    expect(record).not.toHaveBeenCalled()
    expect(sendObservation).not.toHaveBeenCalled()
  })

  it('keeps an explicit comparison refusal distinct from an unknown Remote outcome', async () => {
    const refusal = new RemoteError('artifact/comparison-rejected', 'Unrelated diagnostic', { reason: 'OBSERVATION_NOT_FOUND' })
    const unknown = new RemoteError('gateway/internal', 'comparison-rejected', {})
    const confirmObservationComparison = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: refusal })
      .mockResolvedValueOnce({ ok: false, error: unknown })
    const ctx = { remote: { artifacts: { confirmObservationComparison } } }
    const control = { artifactId: 'control' as ArtifactId, observationId: 'a' as ArtifactObservationId }
    const variant = { artifactId: 'variant' as ArtifactId, observationId: 'b' as ArtifactObservationId }
    const first = confirmArtifactObservationComparison(ctx as never, 'session' as never, 'study', control, variant, true)
    await expect(first).rejects.toBeInstanceOf(ArtifactComparisonRequestError)
    await expect(first).rejects.toMatchObject({ reason: 'OBSERVATION_NOT_FOUND', cause: refusal })
    await expect(confirmArtifactObservationComparison(ctx as never, 'session' as never, 'study', control, variant, true)).rejects.toBe(unknown)
  })

  it('installs the evidence action only when its optional Remote namespace is available', async () => {
    runtime = await SlotTestRuntime.create()
    const h = runtime
    h.remote.provideNamespaces({ artifactRuntime: { attach: () => runtimeChannel() },
      artifacts: { submitAction: vi.fn() }, artifactExports: { create: vi.fn(), read: vi.fn() } })
    h.ctx.provide('fileActions', { save: vi.fn(), copyImage: vi.fn(), canSaveAs: false })
    h.ctx.provide('locale', new LocaleRuntime(h.ctx))
    h.slots.installLocale(h.ctx.get('locale') as LocaleRuntime)
    h.ctx.provide('uiConversation', { userText: { register: vi.fn(() => () => {}) }, events: { register: () => () => {} } } as never)
    h.ctx.provide('conversation', { registerPromptContext: vi.fn(() => () => {}) } as never)
    h.ctx.provide('uiWorkspace', { openSession: vi.fn() } as never)
    await h.declare({
      'conversation.chat.assistant.details': { kind: 'list', scope: 'session' },
      'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: CHAT_NODE_INJECT },
    })
    const feature = await h.mount({ inject: [...inject], apply })
    expect(h.slots.entriesOfSlot('conversation.chat.assistant.details')).toEqual([])
    const evidence = h.slots.entriesOfSlot('conversation.chat.node').find(entry => entry.options.key === 'artifact-branch-evidence')
    if (evidence?.inject === undefined) throw new Error('Missing returned evidence renderer')
    const hooks = evidence.inject('test-session' as never).hooks as BranchEvidenceFollowupInjected['hooks']
    expect(hooks.continuationAvailable.getSnapshot()).toBe(false)
    const unavailableExports = { 'function-plot': false, 'particle-system': false, 'bfs-checkpoint': false, 'half-adder-checkpoint': false }
    expect(hooks.returnedExperimentExports.getSnapshot()).toEqual(unavailableExports)
    await act(async () => {
      h.remote.provideNamespaces({ artifactBranchResults: {
        returnResult: vi.fn(), continuePlot: vi.fn(), continueParticle: vi.fn(),
        exportReturnedPlot: vi.fn(), exportReturnedBfs: vi.fn(), exportReturnedHalfAdder: vi.fn(),
      } })
    })
    await vi.waitFor(() => {
      expect(h.slots.entriesOfSlot('conversation.chat.assistant.details').map(entry => entry.options.id)).toEqual(['artifact-branch-result'])
      expect(hooks.continuationAvailable.getSnapshot()).toBe(true)
      expect(hooks.returnedExperimentExports.getSnapshot()).toEqual({
        'function-plot': true, 'particle-system': false, 'bfs-checkpoint': true, 'half-adder-checkpoint': true,
      })
    })
    await feature.dispose()
    expect(h.slots.entriesOfSlot('conversation.chat.assistant.details')).toEqual([])
    expect(hooks.continuationAvailable.getSnapshot()).toBe(false)
    expect(hooks.returnedExperimentExports.getSnapshot()).toEqual(unavailableExports)
  })

  it('forwards a complete branch conclusion/evidence request and returns its parent receipt', async () => {
    const request: ArtifactBranchResultRequest = {
      sessionId: 'parent' as never, branchSessionId: 'child' as never, resultSeq: 6,
      evidence: { kind: 'observation', observation: { artifactId: 'particles' as ArtifactId, observationId: 'A' as ArtifactObservationId } },
    }
    const receipt = { parentSessionId: 'parent', eventSeq: 8, messageId: 'adopted' }
    const returnResult = vi.fn(async () => ({ ok: true as const, value: receipt }))
    const ctx = { remote: { artifactBranchResults: { returnResult } } }
    expect(await returnArtifactBranchResult(ctx as never, request)).toBe(receipt)
    expect(returnResult).toHaveBeenCalledExactlyOnceWith(request)
  })

  it.each([
    [new RemoteError('session/branch-result-conflict', 'diagnostic', {
      parentSessionId: 'parent' as never, branchSessionId: 'child' as never, resultSeq: 6,
    }), { kind: 'conflict' }],
    [new RemoteError('artifact-branch/evidence-unavailable', 'diagnostic', { reason: 'OBSERVATION_NOT_FOUND' }), { kind: 'evidence-unavailable' }],
    [new RemoteError('artifact-branch/result-too-large', 'diagnostic', { limit: 50 }), { kind: 'too-large', limit: 50 }],
    [new RemoteError('session/branch-result-unavailable', 'diagnostic', {
      parentSessionId: 'parent' as never, branchSessionId: 'child' as never, resultSeq: 6, reason: 'inherited-result',
    }), { kind: 'result-unavailable' }],
    [new RemoteError('session/agent-busy', 'diagnostic', { reason: 'parent-maintenance' }), { kind: 'busy' }],
    [new RemoteError('gateway/invocation-unavailable', 'diagnostic', { endpoint: 'artifactBranchResults/returnResult' }), { kind: 'service-unavailable' }],
    [new RemoteError('gateway/service-unavailable', 'diagnostic', { endpoint: 'artifactBranchResults/returnResult' }), { kind: 'service-unavailable' }],
    [new RemoteError('gateway/definition-unavailable', 'diagnostic', { endpoint: 'artifactBranchResults/returnResult' }), { kind: 'service-unavailable' }],
    [new RemoteError('gateway/method-unavailable', 'diagnostic', { endpoint: 'artifactBranchResults/returnResult' }), { kind: 'service-unavailable' }],
    [new RemoteError('gateway/internal', 'branch-result-conflict', {}), { kind: 'unknown' }],
  ] as const)('classifies branch evidence failure %s by its machine code', async (error, failure) => {
    const returnResult = vi.fn(async () => ({ ok: false as const, error }))
    const ctx = { remote: { artifactBranchResults: { returnResult } } }
    const request: ArtifactBranchResultRequest = {
      sessionId: 'parent' as never, branchSessionId: 'child' as never, resultSeq: 6,
      evidence: { kind: 'observation', observation: { artifactId: 'particles' as ArtifactId, observationId: 'A' as ArtifactObservationId } },
    }
    const operation = returnArtifactBranchResult(ctx as never, request)
    await expect(operation).rejects.toBeInstanceOf(ArtifactBranchReturnError)
    await expect(operation).rejects.toMatchObject({ code: error.code, cause: error, failure })
  })
})
