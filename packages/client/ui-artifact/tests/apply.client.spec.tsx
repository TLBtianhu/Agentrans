// @vitest-environment jsdom
import { act, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { apply as hostApply } from '../src/index.ts'
import { CHAT_NODE_INJECT } from '../../ui-chat/src/client/apply.ts'
import { apply, inject } from '../src/client/index.ts'
import { recordArtifactAction } from '../src/client/protocol.ts'
import type { ArtifactId } from '../src/client/protocol.ts'

let runtime: SlotTestRuntime | undefined
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
})

describe('Artifact plugin registration', () => {
  it('binds Session Remote arguments through Slot inject and removes registrations on disposal', async () => {
    runtime = await SlotTestRuntime.create()
    const h = runtime
    const record = vi.fn(async () => ({ ok: true as const, value: undefined }))
    h.remote.provideNamespaces({ artifacts: { record } })
    h.ctx.provide('locale', new LocaleRuntime(h.ctx))
    h.slots.installLocale(h.ctx.get('locale') as LocaleRuntime)
    const unregisterDefinition = vi.fn()
    const register = vi.fn(() => unregisterDefinition)
    h.ctx.provide('uiConversation', { events: { register } } as never)
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
    expect(record).toHaveBeenCalledExactlyOnceWith(sessionId, 'integrated', 3, 'publish', { path: 'index.html' }, true)
    expect(register).toHaveBeenCalledOnce()

    await feature.dispose()
    slot.update(owner)
    expect(slot.container.querySelector('iframe')).toBeNull()
    expect(unregisterDefinition).toHaveBeenCalledOnce()
  })

  it('rejects a Host refusal so the card can retain and retry its pending action', async () => {
    const ctx = { remote: { artifacts: { record: async () => ({ ok: false, error: { message: 'denied' } }) } } }
    await expect(recordArtifactAction(ctx as never, 'session' as never, 'artifact' as ArtifactId, 1, 'publish', null, true))
      .rejects.toThrow('denied')
  })

  it('keeps the node half free of registrations', () => {
    expect(hostApply).toBeTypeOf('function')
    hostApply()
  })
})
