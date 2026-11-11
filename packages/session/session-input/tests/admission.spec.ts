import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@agentrans/cordis'
import AgentRegistry, { type Agent } from '@agentrans/agent'
import { freezeMessage, MessageId, type UserMessage } from '@agentrans/llm'
import SessionStore, { SessionId, SessionLogOffset } from '@agentrans/session'
import SessionProjectionRegistry from '@agentrans/session-projection'
import SessionInputAdmission from '../src/index.ts'
import type { SessionInputRequestId } from '../src/types.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const fiber = ctx.plugin(SessionInputAdmission)
  await fiber
  const session = ctx.sessions.create(SessionId('input-admission'))
  const deliver = (target: 'next-turn' | 'next-step', message: UserMessage): void => {
    session.append('agent/inbox/spliced', { target, start: 0, inserted: [message] })
  }
  const steer = vi.fn((message: UserMessage) => { deliver('next-step', message) })
  const followup = vi.fn((message: UserMessage) => { deliver('next-turn', message) })
  const inject = vi.fn((message: UserMessage) => { deliver('next-turn', message) })
  const unsupported = (): never => { throw new Error('This admission test Agent does not support this capability') }
  const agent: Agent = {
    id: session.id, session, ctx, steer, followup, inject, options: {}, status: 'idle',
    model: { current: unsupported, select: unsupported },
    inbox: { nextTurn: [], nextStep: [], clear: unsupported, append: unsupported,
      prepend: unsupported, replace: unsupported, remove: unsupported, splice: unsupported },
    cancel: unsupported, whenIdle: unsupported, runMaintenance: unsupported, send: unsupported,
  }
  ctx.agents.enter(agent, undefined)
  return { ctx, session, agent, fiber, steer, followup, inject }
}

const message = (id = 'chosen-action', text = 'Original input'): UserMessage => freezeMessage({
  id: MessageId(id), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
})

describe('Session input admission', () => {
  it.each(['steer', 'queue', 'inject'] as const)('dispatches %s once and returns an old receipt before source validation or a new delivery choice', async (mode) => {
    const h = await harness()
    const validate = vi.fn()
    const original = message()
    expect(await h.ctx.sessionInputs.admitMessage(h.agent, original, mode, validate)).toEqual({ accepted: true })
    const changedSource = vi.fn(() => { throw new Error('Current source no longer exists') })
    expect(await h.ctx.sessionInputs.admitMessage(h.agent, original, mode === 'steer' ? 'queue' : 'steer', changedSource))
      .toEqual({ accepted: true })
    expect(validate).toHaveBeenCalledOnce()
    expect(changedSource).not.toHaveBeenCalled()
    expect(h.steer).toHaveBeenCalledTimes(mode === 'steer' ? 1 : 0)
    expect(h.followup).toHaveBeenCalledTimes(mode === 'queue' ? 1 : 0)
    expect(h.inject).toHaveBeenCalledTimes(mode === 'inject' ? 1 : 0)
    expect(h.session.snapshotEvents()).toHaveLength(1)
  })

  it('reserves before preparation, freezes the input and joins equal concurrent work', async () => {
    const h = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const identity = { kind: 'rpc' as const, requestId: 'same-rpc' as SessionInputRequestId }
    const request = { content: ['Before'], mode: 'queue' }
    const job = vi.fn(async (input: typeof request): Promise<{ accepted: true }> => {
      entered.resolve(undefined)
      await release.promise
      expect(input).toEqual({ content: ['Before'], mode: 'queue' })
      expect(Object.isFrozen(input.content)).toBe(true)
      return { accepted: true }
    })
    const first = h.ctx.sessionInputs.run(h.session.id, identity, request, job)
    request.content[0] = 'Later'
    await entered.promise
    const second = h.ctx.sessionInputs.run(h.session.id, identity, { content: ['Before'], mode: 'queue' }, job)
    await expect(h.ctx.sessionInputs.run(h.session.id, identity, request, job)).rejects.toMatchObject({ code: 'CONFLICT' })
    release.resolve(undefined)
    expect(await first).toEqual({ accepted: true })
    expect(await second).toEqual({ accepted: true })
    expect(job).toHaveBeenCalledOnce()
  })

  it('keeps RPC and message identities with the same string independent', async () => {
    const h = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const pending = h.ctx.sessionInputs.run(h.session.id, { kind: 'rpc', requestId: 'same' as SessionInputRequestId }, {}, async () => {
      entered.resolve(undefined)
      await release.promise
      return { accepted: true }
    })
    await entered.promise
    expect(await h.ctx.sessionInputs.admitMessage(h.agent, message('same'), 'queue')).toEqual({ accepted: true })
    release.resolve(undefined)
    await pending
    expect(h.followup).toHaveBeenCalledOnce()
  })

  it('refuses different accepted content without dispatching or validating it', async () => {
    const h = await harness()
    await h.ctx.sessionInputs.admitMessage(h.agent, message(), 'queue')
    const validate = vi.fn()
    await expect(h.ctx.sessionInputs.admitMessage(h.agent, message('chosen-action', 'Changed input'), 'queue', validate))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(validate).not.toHaveBeenCalled()
    expect(h.followup).toHaveBeenCalledOnce()
  })

  it('keeps original acceptance after queue edit, cancellation and a later committed edited message', async () => {
    const h = await harness()
    const original = message()
    await h.ctx.sessionInputs.admitMessage(h.agent, original, 'queue')
    const edited = message(original.id, 'User edited the queued input')
    h.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [edited] })
    h.session.append('user/message', edited, { surfaceOp: 'append' })
    h.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
    await h.ctx.sessionInputs.admitMessage(h.agent, original, 'steer')
    await expect(h.ctx.sessionInputs.admitMessage(h.agent, edited, 'queue')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(h.followup).toHaveBeenCalledOnce()
    expect(h.steer).not.toHaveBeenCalled()
  })

  it('preserves a validation refusal and releases its in-flight reservation', async () => {
    const h = await harness()
    const refusal = new Error('Invalid current source')
    await expect(h.ctx.sessionInputs.admitMessage(h.agent, message(), 'queue', () => { throw refusal })).rejects.toBe(refusal)
    expect(h.followup).not.toHaveBeenCalled()
    expect(await h.ctx.sessionInputs.admitMessage(h.agent, message(), 'queue')).toEqual({ accepted: true })
  })

  it('labels post-dispatch failure unknown and finds its acceptance without executing again', async () => {
    const h = await harness()
    const failure = new Error('Observer failed after append')
    vi.mocked(h.followup).mockImplementationOnce((value) => {
      h.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [value] })
      throw failure
    })
    await expect(h.ctx.sessionInputs.admitMessage(h.agent, message(), 'queue')).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME', cause: failure })
    expect(await h.ctx.sessionInputs.admitMessage(h.agent, message(), 'queue')).toEqual({ accepted: true })
    expect(h.followup).toHaveBeenCalledOnce()
  })

  it('rejects a non-live Agent before reading source or appending input', async () => {
    const h = await harness()
    const validate = vi.fn()
    const forged: Agent = { ...h.agent }
    await expect(h.ctx.sessionInputs.admitMessage(forged, message(), 'queue', validate)).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' })
    expect(validate).not.toHaveBeenCalled()
    expect(h.session.snapshotEvents()).toEqual([])
  })

  it('retains receipt reads for blocked preparation after unregistering during real service disposal', async () => {
    const h = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const service = h.ctx.sessionInputs
    const original = freezeMessage({ ...message('original'), source: { kind: 'user', rpcId: 'original-rpc' } })
    h.session.append('user/message', original, { surfaceOp: 'append' })
    const operation = service.run(h.session.id, { kind: 'rpc', requestId: 'waiting' as SessionInputRequestId }, {}, async () => {
      entered.resolve(undefined)
      await release.promise
      expect(service.hasPromptReceipt(h.agent, 'original-rpc' as SessionInputRequestId)).toBe(true)
      expect(service.hasPromptReceipt(h.agent, 'during-shutdown' as SessionInputRequestId)).toBe(true)
      return { accepted: true }
    })
    await entered.promise
    let disposed = false
    const disposing = h.fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => {
      expect(Object.hasOwn(h.ctx.sessionProjections.checkpoint(h.session), 'session/promptReceipts')).toBe(false)
    })
    expect(disposed).toBe(false)
    h.session.append('user/message', freezeMessage({ ...message('later'), source: { kind: 'user', rpcId: 'during-shutdown' } }), { surfaceOp: 'append' })
    release.resolve(undefined)
    await expect(operation).resolves.toEqual({ accepted: true })
    await disposing
    await expect(service.run(h.session.id, { kind: 'rpc', requestId: 'later' as SessionInputRequestId }, {}, async () => ({ accepted: true })))
      .rejects.toMatchObject({ code: 'CLOSED' })
  })

  it('admits the same identity independently in a child after excluding its inherited prefix', async () => {
    const h = await harness()
    const original = message()
    await h.ctx.sessionInputs.admitMessage(h.agent, original, 'queue')
    const seed = h.session.snapshotEvents()
    const childSession = h.ctx.sessions.create(SessionId('child'), {
      seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { isSeeded: true },
    })
    const childFollowup = vi.fn((value: UserMessage) => {
      childSession.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [value] })
    })
    const child: Agent = { ...h.agent, id: childSession.id, session: childSession, followup: childFollowup }
    h.ctx.agents.enter(child, h.agent)
    await h.ctx.sessionInputs.admitMessage(child, message(original.id, 'Independent child input'), 'queue')
    expect(childFollowup).toHaveBeenCalledOnce()
    expect(h.followup).toHaveBeenCalledOnce()
  })

  it('rejects non-JSON pending requests before invoking the operation', async () => {
    const h = await harness()
    const job = vi.fn(async (): Promise<{ accepted: true }> => ({ accepted: true }))
    await expect(h.ctx.sessionInputs.run(h.session.id, { kind: 'rpc', requestId: 'bad' as SessionInputRequestId }, { value: undefined }, job))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(job).not.toHaveBeenCalled()
  })

  it('preserves caller cancellation during preparation and releases the unused identity', async () => {
    const h = await harness()
    const controller = new AbortController()
    const reason = new Error('Caller canceled before admission')
    controller.abort(reason)
    const identity = { kind: 'rpc' as const, requestId: 'cancelable' as SessionInputRequestId }
    await expect(h.ctx.sessionInputs.run(h.session.id, identity, {}, () => {
      controller.signal.throwIfAborted()
      return { accepted: true }
    })).rejects.toBe(reason)
    expect(await h.ctx.sessionInputs.run(h.session.id, identity, {}, () => ({ accepted: true }))).toEqual({ accepted: true })
    expect(h.session.snapshotEvents()).toEqual([])
  })
})
