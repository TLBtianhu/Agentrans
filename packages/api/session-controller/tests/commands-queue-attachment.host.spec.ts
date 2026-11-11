import TypertRegistry from '@agentrans/typert-registry'
import SessionProjectionRegistry from '@agentrans/session-projection'
import SessionInputAdmission from '@agentrans/session-input'
import { RemoteError } from '@agentrans/typert-protocol'
import { Context } from '@agentrans/cordis'
import AgentRegistry from '@agentrans/agent'
import type { Agent, Inbox } from '@agentrans/agent'
import { AttachmentError, AttachmentId } from '@agentrans/attachment'
import type { ImageAttachmentRef } from '@agentrans/attachment'
import { createUserMessage, MessageId } from '@agentrans/llm'
import type { ContextFormed } from '@agentrans/llm'
import SessionStore, {
  Session, SessionId, SessionLogOffset,
} from '@agentrans/session'
import type { UserMessage } from '@agentrans/session'
import { snapshotSubagentDescriptor, SUBAGENT_DESCRIPTOR_VERSION } from '@agentrans/subagent'
import { subagentIdentityProjectionDefinition } from '@agentrans/subagent/src/projection.ts'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { unsupportedModel, createInboxStub } from '@agentrans/agent-loop-testkit'
import { installSessionReadTestServices, createSessionTestController } from './test-remote.ts'

declare module '@agentrans/llm' {
  interface MessageSourceMap {
    'test': { kind: 'test' } & ContextFormed
  }
}

async function commandHarness(
  childMode?: 'continuable' | 'seeded-continuable' | 'seed-only' | 'one-shot' | 'unknown' | 'corrupt',
): Promise<{
  ctx: Context
  controller: SessionCommandController
  agent: Agent
  inbox: Inbox
  steer: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  resolveAgent: MockInstance<ApiSessionAgentController['resolveAgent']>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionInputAdmission)
  await ctx.plugin(TypertRegistry)
  installSessionReadTestServices(ctx)
  await ctx.sessionProjections.register(subagentIdentityProjectionDefinition)
  const sessionId = SessionId('commands-session')
  const ancestor = Session.create(SessionId('ancestor'))
  ancestor.append('subagent/descriptor', snapshotSubagentDescriptor({
    mode: 'continuable', provider: 'test', label: 'ancestor',
  }))
  // A seeded child inherits exactly the ancestor prefix; its own descriptor
  // is appended after creation, as the continuation manager does. `seed-only`
  // never appends one: the identity folds as continuable, but from the
  // inherited prefix rather than this Session's own suffix.
  const lineage = childMode === 'seeded-continuable' || childMode === 'seed-only'
    ? ancestor.snapshotEvents()
    : undefined
  const session = ctx.sessions.create(sessionId, {
    ...lineage === undefined ? {} : { seed: lineage, inheritedEventCount: SessionLogOffset(lineage.length) },
    meta: {
      cwd: '/workspace',
      ...(childMode === undefined ? {} : {
        origin: 'subagent' as const,
        parentSession: SessionId('offline-parent'),
      }),
      ...lineage === undefined ? {} : { isSeeded: true },
    },
  })
  if (childMode === 'continuable' || childMode === 'seeded-continuable') {
    session.append('subagent/descriptor', snapshotSubagentDescriptor({
      mode: 'continuable', provider: 'test', label: 'child',
    }))
  } else if (childMode === 'one-shot') {
    session.append('subagent/descriptor', {
      version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'one-shot', provider: 'test', label: 'child',
    })
  } else if (childMode === 'corrupt') {
    session.append('subagent/descriptor', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 1,
    } as never)
  }
  const inbox = createInboxStub()
  const steer = vi.fn((message: UserMessage) => { inbox.append('next-step', message) })
  const cancel = vi.fn()
  const agent = {
    id: session.id,
    options: { provider: 'fixture', model: 'fixture-model' },
    whenIdle: vi.fn(() => Promise.resolve()),
    runMaintenance: async () => { throw new Error('unexpected maintenance') },
    send: vi.fn(),
    inject: vi.fn(),
    session,
    model: unsupportedModel(),
    inbox,
    status: 'running',
    ctx,
    steer,
    followup: vi.fn(),
    cancel,
  } satisfies Agent
  await ctx.agents.register(agent)
  ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  const agents = new ApiSessionAgentController(ctx)
  const resolveAgent = vi.spyOn(agents, 'resolveAgent').mockImplementation(id => Promise.resolve(id === agent.id
    ? { agent }
    : { error: new RemoteError('session/not-found', 'missing', { sessionId: id }) }))
  vi.spyOn(agents, 'composeAgent').mockResolvedValue({ setup: () => {} })
  return {
    ctx,
    controller: new SessionCommandController(ctx, agents, '/workspace'),
    agent,
    inbox,
    steer,
    cancel,
    resolveAgent,
  }
}

async function expectFailure(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code })
}

describe('Session queue commands', () => {
  it('edits a blockquote into ordinary text without changing prompt correlation', async () => {
    const { ctx, controller, agent, inbox } = await commandHarness()
    try {
      const message = createUserMessage({ content: [{ type: 'text', text: '> selected' }],
        source: { kind: 'user', rpcId: 'quote-edit' as import('../src/types.ts').SessionRequestId } })
      inbox.append('next-turn', message)
      await controller.updateQueue({ sessionId: agent.id, itemId: message.id,
        action: { kind: 'edit', content: [{ type: 'text', text: 'plain replacement' }] } })
      expect(inbox.nextTurn[0]?.content).toEqual([{ type: 'text', text: 'plain replacement' }])
      expect(inbox.nextTurn[0]?.source).toEqual(message.source)
    } finally { await ctx.fiber.dispose() }
  })

  it('preserves the cold Agent resolver rejection', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    const error = new RemoteError('session/agent-busy', 'owned by a child', { reason: 'subagent-owned' })
    const controller = new SessionCommandController(ctx, {
      resolveAgent: () => Promise.resolve({ error }),
    } as unknown as ApiSessionAgentController, '/workspace')
    try {
      await expect(controller.updateQueue({
        sessionId: SessionId('cold-child'), itemId: MessageId('pending'), action: { kind: 'remove' },
      })).rejects.toBe(error)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('edits, removes, steers, and rejects stale queue occurrences', async () => {
    const { ctx, controller, agent, inbox, steer, cancel } = await commandHarness()
    const queued = createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } })
    const nextStep = createUserMessage({ content: [{ type: 'text', text: 'step' }], source: { kind: 'user' } })
    inbox.append('next-turn', queued)
    inbox.append('next-step', nextStep)

    await expectFailure(Promise.resolve().then(() => controller.updateQueue({
      sessionId: agent.id,
      itemId: queued.id,
      action: {
        kind: 'edit',
        content: [{
          // @ts-expect-error -- remote edit payloads can carry unsupported image blocks.
          type: 'image',
          attachment: {
            attachmentId: AttachmentId('att-edit'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
          },
        }],
      },
    })), 'session/attachment-invalid')
    for (const content of [[], [{ type: 'text' as const, text: ' \t\n' }]]) {
      await expectFailure(Promise.resolve().then(() => controller.updateQueue({
        sessionId: agent.id,
        itemId: queued.id,
        action: { kind: 'edit', content },
      })), 'gateway/bad-request')
    }
    expect(inbox.nextTurn[0]?.content).toEqual([{ type: 'text', text: 'queued' }])
    await expectFailure(Promise.resolve().then(() => controller.updateQueue({
      sessionId: SessionId('missing'), itemId: queued.id, action: { kind: 'remove' },
    })), 'session/queue-item-not-found')
    await expectFailure(Promise.resolve().then(() => controller.updateQueue({
      sessionId: agent.id, itemId: MessageId('missing'), action: { kind: 'remove' },
    })), 'session/queue-item-not-found')
    await expectFailure(Promise.resolve().then(() => controller.updateQueue({
      sessionId: agent.id, itemId: nextStep.id, action: { kind: 'steer' },
    })), 'session/steer-unavailable')

    Object.assign(agent, { status: 'idle' })
    await expectFailure(Promise.resolve().then(() => controller.updateQueue({
      sessionId: agent.id, itemId: queued.id, action: { kind: 'steer' },
    })), 'session/steer-unavailable')
    expect(await controller.updateQueue({
      sessionId: agent.id,
      itemId: queued.id,
      action: { kind: 'edit', content: [{ type: 'text', text: 'edited' }] },
    })).toEqual({ accepted: true })
    expect(inbox.nextTurn[0]?.content).toEqual([{ type: 'text', text: 'edited' }])
    // An edit rewrites content in place, so the occurrence a client addressed
    // by id stays addressable.
    expect(inbox.nextTurn[0]?.id).toBe(queued.id)
    expect(await controller.updateQueue({
      sessionId: agent.id, itemId: nextStep.id, action: { kind: 'remove' },
    })).toEqual({ accepted: true })

    Object.assign(agent, { status: 'running' })
    const steered = inbox.nextTurn[0]
    if (steered === undefined) throw new Error('missing edited queue item')
    expect(await controller.updateQueue({
      sessionId: agent.id, itemId: steered.id, action: { kind: 'steer' },
    })).toEqual({ accepted: true })
    expect(steer).toHaveBeenCalledWith(steered)

    const queuedFile = createUserMessage({
      content: [{
        type: 'file',
        attachment: { attachmentId: AttachmentId('file-queued'), name: 'queued.txt', bytes: 6 },
      }],
      source: { kind: 'user', rpcId: 'file-rpc' as never },
    })
    inbox.append('next-turn', queuedFile)
    expect(await controller.updateQueue({
      sessionId: agent.id, itemId: queuedFile.id, action: { kind: 'steer' },
    })).toEqual({ accepted: true })
    expect(steer).toHaveBeenLastCalledWith(queuedFile)
    expect(queuedFile).toMatchObject({
      source: { kind: 'user', rpcId: 'file-rpc' },
      content: [{ type: 'file', attachment: { name: 'queued.txt', bytes: 6 } }],
    })

    await expectFailure(Promise.resolve().then(() => controller.cancel({
      sessionId: SessionId('missing'),
    })), 'session/not-found')
    expect(controller.cancel({ sessionId: agent.id })).toEqual({ accepted: true })
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    await ctx.fiber.dispose()
  })

  it.each(['continuable', 'seeded-continuable'] as const)(
    'mutates both inbox destinations of a live %s child while its parent is offline',
    async (childMode) => {
      const { ctx, controller, agent, inbox, steer } = await commandHarness(childMode)
      const queued = createUserMessage({
        content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' },
      })
      const context = createUserMessage({
        content: [{ type: 'text', text: 'context' }], source: { kind: 'test' },
      })
      inbox.append('next-turn', queued)
      inbox.append('next-step', context)

      expect(await controller.updateQueue({
        sessionId: agent.id,
        itemId: context.id,
        action: { kind: 'edit', content: [{ type: 'text', text: 'edited context' }] },
      })).toEqual({ accepted: true })
      const editedContext = inbox.nextStep[0]
      expect(editedContext).toMatchObject({
        content: [{ type: 'text', text: 'edited context' }],
        source: context.source,
      })
      expect(editedContext?.id).toBe(context.id)
      if (editedContext === undefined) throw new Error('missing edited context')
      expect(await controller.updateQueue({
        sessionId: agent.id, itemId: editedContext.id, action: { kind: 'remove' },
      })).toEqual({ accepted: true })
      expect(await controller.updateQueue({
        sessionId: agent.id, itemId: queued.id, action: { kind: 'steer' },
      })).toEqual({ accepted: true })
      expect(steer).toHaveBeenCalledWith(queued)
      await ctx.fiber.dispose()
    },
  )

  it('removes the selected message before handing it to Agent steering', async () => {
    const { ctx, controller, agent, inbox, steer } = await commandHarness('continuable')
    const first = createUserMessage({
      content: [{ type: 'text', text: 'first' }], source: { kind: 'user' },
    })
    const second = createUserMessage({
      content: [{ type: 'text', text: 'second' }], source: { kind: 'user' },
    })
    inbox.append('next-turn', first)
    inbox.append('next-turn', second)
    // Stand in for the Agent's cancellation-convergence destination; the
    // command must accept whichever boundary `Agent.steer()` selects.
    steer.mockImplementation((message: UserMessage) => { inbox.append('next-turn', message) })

    expect(await controller.updateQueue({
      sessionId: agent.id, itemId: first.id, action: { kind: 'steer' },
    })).toEqual({ accepted: true })
    expect(steer).toHaveBeenCalledWith(first)
    // Ordering proves the removal happened before delivery rather than after.
    expect(inbox.nextTurn).toEqual([second, first])
    expect(inbox.nextStep).toEqual([])
    await ctx.fiber.dispose()
  })

  it('keeps one-shot, seed-only, missing, and malformed child descriptors behind the ownership fence', async () => {
    for (const mode of ['one-shot', 'seed-only', 'unknown', 'corrupt'] as const) {
      const { ctx, controller, agent, inbox } = await commandHarness(mode)
      const queued = createUserMessage({
        content: [{ type: 'text', text: mode }], source: { kind: 'user' },
      })
      inbox.append('next-turn', queued)
      await expectFailure(Promise.resolve().then(() => controller.updateQueue({
        sessionId: agent.id, itemId: queued.id, action: { kind: 'remove' },
      })), 'session/agent-busy')
      expect(inbox.nextTurn).toEqual([queued])
      await ctx.fiber.dispose()
    }
  })
})

describe('Session attachment reads', () => {
  it.each(['commands-session', 'other-session', 'missing-session'])('reads a supplied reference without looking up history for %s', async (id) => {
    const { ctx, controller, agent, resolveAgent } = await commandHarness()
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`),
      mediaType: 'image/png', bytes: 2, width: 1, height: 1,
    }
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'image', attachment: ref }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const readImage = vi.fn(() => Promise.resolve({ ref, data: Uint8Array.of(1, 2) }))
    ctx.provide('attachments', { readImage } as never)
    const failHistory = (): never => { throw new Error('image reads must not access Session history') }
    const get = vi.spyOn(ctx.sessions, 'get').mockImplementation(failHistory)
    const snapshot = vi.spyOn(agent.session, 'snapshotEvents').mockImplementation(failHistory)
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(failHistory)
    try {
      await expect(controller.attachment({ sessionId: SessionId(id), attachment: ref }))
        .resolves.toEqual({ attachment: ref, data: 'AQI=' })
      expect(readImage).toHaveBeenCalledExactlyOnceWith(ref)
      expect(get).not.toHaveBeenCalled()
      expect(snapshot).not.toHaveBeenCalled()
      expect(observe).not.toHaveBeenCalled()
      expect(resolveAgent).not.toHaveBeenCalled()
    } finally {
      get.mockRestore()
      snapshot.mockRestore()
      observe.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it.each([
    'INVALID_ATTACHMENT_REF', 'ATTACHMENT_NOT_FOUND', 'ATTACHMENT_CORRUPT', 'ATTACHMENT_READ_FAILED',
  ] as const)('returns %s as an explicit attachment failure', async (reason) => {
    const ctx = new Context()
    const readImage = vi.fn(() => Promise.reject(new AttachmentError('Stored image is unavailable.', reason)))
    ctx.provide('attachments', { readImage } as never)
    const controller = new SessionCommandController(ctx, new ApiSessionAgentController(ctx), '/workspace')
    try {
      await expect(controller.attachment({
        sessionId: SessionId('unopened'),
        attachment: { attachmentId: AttachmentId('requested'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      }))
        .rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('contains unexpected backend failures without exposing internal details', async () => {
    const ctx = new Context()
    ctx.provide('attachments', { readImage: () => Promise.reject(new Error('/private/storage failed')) } as never)
    const controller = new SessionCommandController(ctx, new ApiSessionAgentController(ctx), '/workspace')
    try {
      await expect(controller.attachment({
        sessionId: SessionId('unopened'),
        attachment: { attachmentId: AttachmentId('requested'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      }))
        .rejects.toMatchObject({ code: 'gateway/internal', message: 'Unable to read image attachment.', details: {} })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})


async function contextPromptHarness(config: { maxPromptContexts?: number; maxPromptContextBytes?: number } = {}) {
  const b = await commandHarness()
  // This fixture has no running driver, so model the driver's durable queue writes.
  const append = b.inbox.append.bind(b.inbox)
  vi.spyOn(b.inbox, 'append').mockImplementation((target, message) => {
    const start = target === 'next-turn' ? b.inbox.nextTurn.length : b.inbox.nextStep.length
    b.agent.session.append('agent/inbox/spliced', { target, start, inserted: [message] })
    append(target, message)
  })
  const remove = b.inbox.remove.bind(b.inbox)
  vi.spyOn(b.inbox, 'remove').mockImplementation((id) => {
    for (const target of ['next-turn', 'next-step'] as const) {
      const queue = target === 'next-turn' ? b.inbox.nextTurn : b.inbox.nextStep
      const start = queue.findIndex(message => message.id === id)
      if (start < 0) continue
      b.agent.session.append('agent/inbox/spliced', { target, start, removedCount: 1, inserted: [], outcome: 'canceled' })
      return remove(id)
    }
    return false
  })
  const service = await createSessionTestController(b.ctx, {
    cwd: '/workspace', defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }), ...config,
  })
  return { ...b, service }
}

describe('registered prompt context admission', () => {
  it('settles reserved Agent resolution during disposal without looking up withdrawn admission services', async () => {
    const b = await commandHarness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<{ agent: Agent }>()
    b.resolveAgent.mockImplementationOnce(() => { entered.resolve(undefined); return release.promise })
    const request = { requestId: 'during-close' as import('../src/types.ts').SessionRequestId, sessionId: b.agent.id,
      mode: 'queue' as const, content: [{ type: 'text' as const, text: 'Accepted during shutdown' }] }
    const operation = b.controller.prompt(request, { kind: 'user', rpcId: request.requestId })
    await entered.promise
    const disposing = b.ctx.fiber.dispose()
    release.resolve({ agent: b.agent })
    await expect(operation).rejects.toMatchObject({ code: 'session/not-found' })
    await disposing
  })

  it('acknowledges a canceled accepted request without resolving or re-enqueueing it', async () => {
    const b = await contextPromptHarness()
    try {
      const resolve = vi.fn(() => [{ type: 'text' as const, text: 'fixed evidence' }])
      const withdraw = b.service.registerPromptContext('experiment', resolve)
      const followup = vi.spyOn(b.agent, 'followup').mockImplementation((message) => { b.inbox.append('next-turn', message) })
      const request = { requestId: 'canceled-accepted' as import('../src/types.ts').SessionRequestId, sessionId: b.agent.id,
        mode: 'queue' as const, content: [{ type: 'text' as const, text: 'Explain' }], contexts: [{ kind: 'experiment', value: 1 }] }
      const signal = new AbortController().signal
      await expect(b.service.prompt(request, signal)).resolves.toEqual({ accepted: true })
      const queued = b.inbox.nextTurn[0]
      if (queued === undefined) throw new Error('Expected one queued prompt')
      await b.service.updateQueue({ sessionId: b.agent.id, itemId: queued.id, action: { kind: 'remove' } })
      expect(b.inbox.nextTurn).toEqual([])
      withdraw()
      const legacyRead = vi.spyOn(b.agent.session, 'snapshotEvents')
        .mockImplementation(() => { throw new Error('Prompt retries must use their prepared receipt state') })
      await expect(b.service.prompt(request, signal)).resolves.toEqual({ accepted: true })
      expect(legacyRead).not.toHaveBeenCalled()
      legacyRead.mockRestore()
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(followup).toHaveBeenCalledTimes(1)
      expect(b.inbox.nextTurn).toEqual([])
    } finally { await b.ctx.fiber.dispose() }
  })

  it('admits a child request independently of the inherited parent receipt', async () => {
    const b = await contextPromptHarness()
    try {
      const requestId = 'parent-and-child' as import('../src/types.ts').SessionRequestId
      b.agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Parent input' }], source: { kind: 'user', rpcId: requestId },
      }), { surfaceOp: 'append' })
      const inherited = b.agent.session.snapshotEvents()
      const child = b.ctx.sessions.create(SessionId('independent-child'), {
        seed: inherited, inheritedEventCount: SessionLogOffset(inherited.length), meta: { isSeeded: true },
      })
      const inbox = createInboxStub()
      const followup = vi.fn((message: UserMessage) => {
        child.append('agent/inbox/spliced', { target: 'next-turn', start: inbox.nextTurn.length, inserted: [message] })
        inbox.append('next-turn', message)
      })
      await b.ctx.agents.register({ ...b.agent, id: child.id, session: child, inbox, followup })
      const resolve = vi.fn(() => [{ type: 'text' as const, text: 'Child evidence' }])
      b.service.registerPromptContext('experiment', resolve)
      await expect(b.service.prompt({ requestId, sessionId: child.id, mode: 'queue',
        content: [{ type: 'text', text: 'Child input' }], contexts: [{ kind: 'experiment', value: null }] },
      new AbortController().signal)).resolves.toEqual({ accepted: true })
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(followup).toHaveBeenCalledTimes(1)
      expect(inbox.nextTurn).toHaveLength(1)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('freezes one resolved context before attachment work and joins identical concurrent requests', async () => {
    const b = await contextPromptHarness()
    try {
      let step = 6
      const resolve = vi.fn(() => [{ type: 'text' as const, text: JSON.stringify({ step }) }])
      const agents = new ApiSessionAgentController(b.ctx)
      vi.spyOn(agents, 'resolveAgent').mockResolvedValue({ agent: b.agent })
      const controller = new SessionCommandController(b.ctx, agents, '/workspace', resolve)
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      vi.spyOn(b.ctx.attachments, 'admitPromptContent').mockImplementation(async () => {
        entered.resolve(undefined)
        await release.promise
        return [{ type: 'text', text: 'Explain A' }]
      })
      const followup = vi.spyOn(b.agent, 'followup').mockImplementation((message) => { b.inbox.append('next-turn', message) })
      const request = { requestId: 'context-a' as import('../src/types.ts').SessionRequestId, sessionId: b.agent.id,
        mode: 'queue' as const, content: [{ type: 'text' as const, text: 'Explain A' }],
        contexts: [{ kind: 'experiment', value: { step: 6 } }] }
      const source = { kind: 'user' as const, rpcId: request.requestId }
      const first = controller.prompt(request, source)
      await entered.promise
      step = 12
      const second = controller.prompt(request, source)
      await expect(controller.prompt({ ...request, content: [{ type: 'text', text: 'Different' }] }, source))
        .rejects.toMatchObject({ code: 'session/prompt-request-conflict' })
      release.resolve(undefined)
      await Promise.all([first, second])
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(followup).toHaveBeenCalledTimes(1)
      expect(b.inbox.nextTurn[0]?.content).toEqual([{ type: 'text', text: 'Explain A' }, { type: 'text', text: '{"step":6}' }])
      await controller.prompt(request, source)
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(followup).toHaveBeenCalledTimes(1)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('preserves a post-dispatch unknown outcome and finds its original receipt on retry', async () => {
    const b = await contextPromptHarness()
    try {
      const agents = new ApiSessionAgentController(b.ctx)
      vi.spyOn(agents, 'resolveAgent').mockResolvedValue({ agent: b.agent })
      const resolve = vi.fn(() => [{ type: 'text' as const, text: 'fixed evidence' }])
      const controller = new SessionCommandController(b.ctx, agents, '/workspace', resolve)
      const followup = vi.spyOn(b.agent, 'followup').mockImplementation((message) => {
        b.inbox.append('next-turn', message)
        throw new Error('post-append observer failure')
      })
      const request = { requestId: 'context-unknown' as import('../src/types.ts').SessionRequestId, sessionId: b.agent.id,
        mode: 'queue' as const, content: [{ type: 'text' as const, text: 'Explain' }], contexts: [{ kind: 'experiment', value: 1 }] }
      const source = { kind: 'user' as const, rpcId: request.requestId }
      await expect(controller.prompt(request, source)).rejects.toMatchObject({ code: 'gateway/internal' })
      expect(b.inbox.nextTurn).toHaveLength(1)
      await expect(controller.prompt(request, source)).resolves.toEqual({ accepted: true })
      expect(followup).toHaveBeenCalledTimes(1)
      expect(resolve).toHaveBeenCalledTimes(1)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('rejects an unmounted context owner before attachments or inbox writes', async () => {
    const b = await contextPromptHarness()
    try {
      const admit = vi.spyOn(b.ctx.attachments, 'admitPromptContent')
      const request = { requestId: 'missing-owner' as import('../src/types.ts').SessionRequestId, sessionId: b.agent.id,
        mode: 'queue' as const, content: [{ type: 'text' as const, text: 'Explain' }], contexts: [{ kind: 'missing', value: null }] }
      await expect(b.controller.prompt(request, { kind: 'user', rpcId: request.requestId }))
        .rejects.toMatchObject({ code: 'session/prompt-context-unavailable' })
      expect(admit).not.toHaveBeenCalled()
      expect(b.inbox.nextTurn).toEqual([])
    } finally { await b.ctx.fiber.dispose() }
  })
})


describe('prompt context owner registration', () => {
  it('does not apply a tiny context budget to ordinary prompts without selections', async () => {
    const b = await contextPromptHarness({ maxPromptContextBytes: 1 })
    try {
      const followup = vi.spyOn(b.agent, 'followup').mockImplementation((message) => { b.inbox.append('next-turn', message) })
      const request = { requestId: 'no-context' as import('../src/types.ts').SessionRequestId, sessionId: b.agent.id,
        mode: 'queue' as const, content: [{ type: 'text' as const, text: 'Ordinary prompt' }] }
      const signal = new AbortController().signal
      await expect(b.service.prompt(request, signal)).resolves.toEqual({ accepted: true })
      await expect(b.service.prompt({ ...request, requestId: 'empty-context' as import('../src/types.ts').SessionRequestId,
        contexts: [] }, signal)).resolves.toEqual({ accepted: true })
      expect(followup).toHaveBeenCalledTimes(2)
      b.service.registerPromptContext('experiment', () => [])
      await expect(b.service.prompt({ ...request, requestId: 'selected-context' as import('../src/types.ts').SessionRequestId,
        contexts: [{ kind: 'experiment', value: null }] }, signal))
        .rejects.toMatchObject({ code: 'session/prompt-context-invalid', details: { reason: 'BYTE_LIMIT' } })
      expect(followup).toHaveBeenCalledTimes(2)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('withdraws providers and wraps only known provider refusals before effects', async () => {
    const b = await contextPromptHarness()
    try {
      const request = { requestId: 'provider-failure' as import('../src/types.ts').SessionRequestId, sessionId: b.agent.id,
        mode: 'queue' as const, content: [{ type: 'text' as const, text: 'Explain' }], contexts: [{ kind: 'experiment', value: null }] }
      const signal = new AbortController().signal
      const refusal = new RemoteError('gateway/bad-request', 'unsupported experiment', {})
      const dispose = b.service.registerPromptContext('experiment', () => { throw refusal })
      const admit = vi.spyOn(b.ctx.attachments, 'admitPromptContent')
      await expect(b.service.prompt(request, signal)).rejects.toMatchObject({
        code: 'session/prompt-context-rejected', details: { kind: 'experiment', code: 'gateway/bad-request', details: {} }, cause: refusal,
      })
      expect(admit).not.toHaveBeenCalled()
      dispose()
      await expect(b.service.prompt(request, signal)).rejects.toMatchObject({ code: 'session/prompt-context-unavailable' })
      const unexpected = new Error('provider defect')
      b.service.registerPromptContext('experiment', () => { throw unexpected })
      await expect(b.service.prompt(request, signal)).rejects.toBe(unexpected)
      expect(b.inbox.nextTurn).toEqual([])
    } finally { await b.ctx.fiber.dispose() }
  })

  it('bounds the complete encoded UTF-8 blocks at exact bytes and limits selection count', async () => {
    const blocks = [{ type: 'text' as const, text: '中文😀' }]
    const bytes = Buffer.byteLength(JSON.stringify(blocks), 'utf8')
    const b = await contextPromptHarness({ maxPromptContextBytes: bytes, maxPromptContexts: 1 })
    try {
      const followup = vi.spyOn(b.agent, 'followup').mockImplementation((message) => { b.inbox.append('next-turn', message) })
      let output = blocks
      b.service.registerPromptContext('experiment', () => output)
      const request = { requestId: 'exact-bytes' as import('../src/types.ts').SessionRequestId, sessionId: b.agent.id,
        mode: 'queue' as const, content: [{ type: 'text' as const, text: 'Explain' }], contexts: [{ kind: 'experiment', value: null }] }
      const signal = new AbortController().signal
      await expect(b.service.prompt(request, signal)).resolves.toEqual({ accepted: true })
      expect(followup).toHaveBeenCalledTimes(1)
      output = [{ type: 'text', text: '中文😀!' }]
      await expect(b.service.prompt({ ...request, requestId: 'too-large' as import('../src/types.ts').SessionRequestId }, signal))
        .rejects.toMatchObject({ code: 'session/prompt-context-invalid', details: { reason: 'BYTE_LIMIT' } })
      await expect(b.service.prompt({ ...request, requestId: 'too-many' as import('../src/types.ts').SessionRequestId,
        contexts: [...request.contexts, ...request.contexts] }, signal))
        .rejects.toMatchObject({ code: 'session/prompt-context-invalid', details: { reason: 'COUNT_LIMIT' } })
      expect(followup).toHaveBeenCalledTimes(1)
    } finally { await b.ctx.fiber.dispose() }
  })
})
