// @vitest-environment jsdom
import { act, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { en } from '../src/client/locales.ts'
import type { SessionId } from '@agentrans/session/types'
import type { JsonValue } from '@agentrans/util-values'
import { createParticleState, observeParticleState } from '@agentrans/artifact/particle-runtime'
import type { ArtifactActionRequest, ArtifactObservationId, SavedParticleObservation } from '@agentrans/artifact/types'
import type { ArtifactBranchResultRequest } from '@agentrans/artifact-branch/types'
import type { ArtifactHtmlExportRequest, ArtifactHtmlExportRecord, ArtifactExportId } from '@agentrans/artifact-export/types'
import type { FileActions } from '@agentrans/client-ui-file-actions/client'

let runtime: SlotTestRuntime | undefined
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
})

describe('Artifact plugin registration', () => {
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
      chooseCurrent('unused', saved.artifact)
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
        location: { kind: 'session' }, visibility: 'visible', data,
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
    expect(register).toHaveBeenCalledTimes(2)
    expect(registerText).toHaveBeenCalledTimes(2)
    expect(registerCapture).toHaveBeenCalledExactlyOnceWith('artifact', expect.any(Function))

    await feature.dispose()
    slot.update(owner)
    expect(slot.container.querySelector('iframe')).toBeNull()
    expect(unregisterDefinition).toHaveBeenCalledTimes(2)
    expect(unregisterText).toHaveBeenCalledTimes(2)
    expect(unregisterCapture).toHaveBeenCalledOnce()
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
    await h.declare({ 'conversation.chat.assistant.details': { kind: 'list', scope: 'session' } })
    const feature = await h.mount({ inject: [...inject], apply })
    expect(h.slots.entriesOfSlot('conversation.chat.assistant.details')).toEqual([])
    await act(async () => {
      h.remote.provideNamespaces({ artifactBranchResults: { returnResult: vi.fn() } })
    })
    await vi.waitFor(() => {
      expect(h.slots.entriesOfSlot('conversation.chat.assistant.details').map(entry => entry.options.id)).toEqual(['artifact-branch-result'])
    })
    await feature.dispose()
    expect(h.slots.entriesOfSlot('conversation.chat.assistant.details')).toEqual([])
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
