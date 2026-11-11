import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@agentrans/cordis'
import AgentRegistry, { type Agent } from '@agentrans/agent'
import { MessageId, type UserMessage } from '@agentrans/llm'
import { Session, SessionId, SessionLogOffset, type SessionEvent } from '@agentrans/session'
import SessionInputAdmission from '@agentrans/session-input'
import SessionProjectionRegistry from '@agentrans/session-projection'
import type { PeerId, RemoteInvocation } from '@agentrans/typert-protocol'
import { remoteMethods } from '@agentrans/typert-protocol'
import ArtifactService, { type Config } from '../src/index.ts'
import type { ArtifactActionRequest, ArtifactId } from '../src/types.ts'

declare module '@agentrans/typert-protocol' {
  interface PrincipalMap {
    /** Non-owner identity exercised by this domain's owner-only Remote. */
    'artifact-test-caller': { readonly kind: 'artifact-test-caller' }
  }
}

const contexts: Context[] = []
let sequence = 0
const id = 'demo' as ArtifactId

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

interface RoutedAgent extends Agent {
  readonly inject: ReturnType<typeof vi.fn<(message: UserMessage) => void>>
  readonly steer: ReturnType<typeof vi.fn<(message: UserMessage) => void>>
}

function makeAgent(ctx: Context, seed?: readonly SessionEvent[], inheritedEventCount?: SessionLogOffset): RoutedAgent {
  const agentId = SessionId(`action-admission-${++sequence}`)
  const header = inheritedEventCount === undefined ? undefined : { ...Session.create(agentId).header, isSeeded: true }
  const session = Session.create(agentId, seed, header, inheritedEventCount)
  const append = (message: UserMessage): void => {
    session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message] })
  }
  return { id: agentId, session, ctx, steer: vi.fn(append), inject: vi.fn(append) } as RoutedAgent
}

async function setup(config: Config = {}, withInputs = true) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const artifactFiber = ctx.plugin(ArtifactService, config)
  await artifactFiber
  const inputFiber = withInputs ? ctx.plugin(SessionInputAdmission) : undefined
  await inputFiber
  const agent = makeAgent(ctx)
  ctx.agents.enter(agent, undefined)
  const service = ctx.artifacts
  service.commit(agent, service.prepare(agent, {
    action: 'create', artifactId: id, title: 'Demo', source: '<p>Original</p>', presentation: 'inline',
  }))
  return { ctx, agent, service, inputFiber, artifactFiber }
}

function request(overrides: Partial<ArtifactActionRequest> = {}): ArtifactActionRequest {
  return { requestId: MessageId('user-selected-action'), artifactId: id, revision: 1, action: 'inspect',
    payload: { count: 2 }, wake: true, ...overrides }
}

function text(input: ArtifactActionRequest): string {
  return JSON.stringify({ kind: 'artifact_action', artifactId: input.artifactId, revision: input.revision,
    action: input.action, payload: input.payload })
}

describe('identified Artifact action admission', () => {
  it.each([true, false])('keeps the exact original action text, source and stable message id (wake %s)', async (wake) => {
    const { agent, service } = await setup()
    const input = request({ wake, action: '  inspect  ', payload: { note: 'é', count: 2 } })
    expect(await service.submitAction(agent, input)).toEqual({ accepted: true, revision: 1 })
    const message = (wake ? agent.steer : agent.inject).mock.calls[0]?.[0]
    expect(message).toEqual({ role: 'user', id: input.requestId,
      source: { kind: 'artifact-action', artifactId: id, revision: 1 },
      content: [{ type: 'text', text: text({ ...input, action: 'inspect' }) }],
    })
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message?.content)).toBe(true)
    expect(wake ? agent.inject : agent.steer).not.toHaveBeenCalled()
    expect(agent.session.snapshotEvents().map(event => event.type)).toEqual(['artifact/upsert', 'agent/inbox/spliced'])
  })

  it('acknowledges original acceptance before source replacement or a stricter current byte limit', async () => {
    const { ctx, agent, service, artifactFiber } = await setup()
    const input = request()
    await service.submitAction(agent, input)
    service.commit(agent, service.prepare(agent, {
      action: 'update', artifactId: id, baseRevision: 1, title: 'Changed', source: '<p>New</p>', presentation: 'inline',
    }))
    await artifactFiber.update({ maxActionBytes: 1 })
    await expect(ctx.artifacts.submitAction(agent, input)).resolves.toEqual({ accepted: true, revision: 1 })
    expect(agent.steer).toHaveBeenCalledOnce()
  })

  it('keeps the identity reserved after queue cancellation, content editing and cold recovery', async () => {
    const h = await setup()
    const input = request()
    await h.service.submitAction(h.agent, input)
    const original = h.agent.steer.mock.calls[0]![0]
    h.agent.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1,
      inserted: [{ ...original, content: [{ type: 'text', text: 'Edited queued content' }] }] })
    h.agent.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
    const cold = makeAgent(h.ctx, h.agent.session.snapshotEvents())
    h.ctx.agents.enter(cold, undefined)
    await expect(h.service.submitAction(cold, input)).resolves.toEqual({ accepted: true, revision: 1 })
    expect(cold.steer).not.toHaveBeenCalled()
    expect(cold.inject).not.toHaveBeenCalled()
  })

  it('does not inherit parent receipts into an ordinary manual branch', async () => {
    const h = await setup()
    const input = request()
    await h.service.submitAction(h.agent, input)
    const seed = h.agent.session.snapshotEvents()
    const child = makeAgent(h.ctx, seed, SessionLogOffset(seed.length))
    h.ctx.agents.enter(child, undefined)
    await h.service.submitAction(child, input)
    expect(child.steer).toHaveBeenCalledOnce()
    expect(h.agent.steer).toHaveBeenCalledOnce()
  })

  it('rejects different content with the same identity while preserving the first input', async () => {
    const h = await setup()
    const input = request()
    await h.service.submitAction(h.agent, input)
    for (const changed of [request({ payload: { count: 3 } }), request({ artifactId: 'other' as ArtifactId }), request({ revision: 2 })]) {
      await expect(h.service.submitAction(h.agent, changed)).rejects.toMatchObject({
        code: 'artifact/action-conflict', details: { requestId: input.requestId },
      })
    }
    expect(h.agent.steer).toHaveBeenCalledOnce()
    expect(h.agent.steer.mock.calls[0]?.[0].content).toEqual([{ type: 'text', text: text(input) }])
  })

  it('coalesces identical concurrent calls and rejects a conflicting in-flight request', async () => {
    const h = await setup()
    const input = request()
    const first = h.service.submitAction(h.agent, input)
    const duplicate = h.service.submitAction(h.agent, input)
    const conflict = h.service.submitAction(h.agent, request({ payload: { count: 4 } }))
    await expect(conflict).rejects.toMatchObject({ code: 'artifact/action-conflict' })
    expect(await first).toEqual({ accepted: true, revision: 1 })
    expect(await duplicate).toEqual({ accepted: true, revision: 1 })
    expect(h.agent.steer).toHaveBeenCalledOnce()
  })

  it('keeps a post-dispatch exception unknown and safely acknowledges the original retry', async () => {
    const h = await setup()
    const input = request()
    h.agent.steer.mockImplementationOnce((message) => {
      h.agent.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message] })
      throw new Error('Wake notification was lost')
    })
    await expect(h.service.submitAction(h.agent, input)).rejects.toMatchObject({ code: 'artifact/action-unknown' })
    await expect(h.service.submitAction(h.agent, input)).resolves.toEqual({ accepted: true, revision: 1 })
    expect(h.agent.steer).toHaveBeenCalledOnce()
  })

  it('never reads history while submitting or finding an accepted retry', async () => {
    const h = await setup()
    h.ctx.sessionProjections.snapshot(h.agent.session)
    vi.spyOn(h.agent.session, 'snapshotEvents').mockImplementation(() => { throw new Error('Unexpected history read') })
    await h.service.submitAction(h.agent, request())
    await h.service.submitAction(h.agent, request())
    expect(h.agent.steer).toHaveBeenCalledOnce()
  })

  it('checks source revision at first admission rather than before its asynchronous reservation', async () => {
    const h = await setup()
    const pending = h.service.submitAction(h.agent, request())
    h.service.commit(h.agent, h.service.prepare(h.agent, {
      action: 'update', artifactId: id, baseRevision: 1, title: 'Updated', source: '<p>Replacement</p>', presentation: 'inline',
    }))
    await expect(pending).rejects.toMatchObject({
      code: 'artifact/action-rejected', details: { reason: 'STALE_REVISION', currentRevision: 2 },
    })
    expect(h.agent.steer).not.toHaveBeenCalled()
  })

  it('does not re-wake an accepted injected action when a later retry changes only delivery policy', async () => {
    const h = await setup()
    await h.service.submitAction(h.agent, request({ wake: false }))
    await h.service.submitAction(h.agent, request({ wake: true }))
    expect(h.agent.inject).toHaveBeenCalledOnce()
    expect(h.agent.steer).not.toHaveBeenCalled()
  })

  it('rejects a missing or stale first source without accepting an input', async () => {
    const h = await setup()
    for (const input of [request({ artifactId: 'missing' as ArtifactId }), request({ revision: 2 })]) {
      await expect(h.service.submitAction(h.agent, input)).rejects.toMatchObject({ code: 'artifact/action-rejected' })
    }
    expect(h.agent.steer).not.toHaveBeenCalled()
  })

  it('enforces the complete UTF-8 action byte limit only on first admission', async () => {
    const input = request({ payload: { note: 'é' } })
    const h = await setup({ maxActionBytes: Buffer.byteLength(text(input), 'utf8') })
    await h.service.submitAction(h.agent, input)
    await expect(h.service.submitAction(h.agent, request({ requestId: MessageId('larger'), payload: { note: 'éé' } })))
      .rejects.toMatchObject({ code: 'artifact/action-rejected', details: { reason: 'ACTION_TOO_LARGE' } })
    expect(h.agent.steer).toHaveBeenCalledOnce()
  })

  it.each(['', 'x'.repeat(129)])('rejects an invalid wire message identity', async (requestId) => {
    const h = await setup()
    await expect(h.service.submitAction(h.agent, request({ requestId: MessageId(requestId) })))
      .rejects.toMatchObject({ code: 'artifact/action-rejected', details: { reason: 'BAD_INPUT' } })
    expect(h.agent.steer).not.toHaveBeenCalled()
  })

  it.each(['__proto__', 'constructor', 'toString'])('keeps opaque identity %s independent of Object properties', async (requestId) => {
    const h = await setup()
    const input = request({ requestId: MessageId(requestId) })
    await h.service.submitAction(h.agent, input)
    await h.service.submitAction(h.agent, input)
    expect(h.agent.steer).toHaveBeenCalledOnce()
  })

  it.each([
    { action: 4 }, { wake: 'yes' }, { payload: { dropped: undefined } },
  ])('rejects malformed action fields before dispatch: %j', async (changed) => {
    const h = await setup()
    await expect(h.service.submitAction(h.agent, { ...request(), ...changed } as never)).rejects.toMatchObject({
      code: 'artifact/action-rejected', details: { reason: 'BAD_INPUT' },
    })
    expect(h.agent.steer).not.toHaveBeenCalled()
  })

  it('requires an exact live root for first admission and does not activate a missing Agent', async () => {
    const h = await setup()
    const detached = makeAgent(h.ctx)
    await expect(h.service.submitAction(detached, request())).rejects.toMatchObject({ code: 'artifact/action-unavailable' })
    expect(h.ctx.agents.get(detached.id)).toBeUndefined()
    const child = makeAgent(h.ctx, h.agent.session.snapshotEvents())
    h.ctx.agents.enter(child, h.agent)
    await expect(h.service.submitAction(child, request())).rejects.toMatchObject({
      code: 'artifact/action-rejected', details: { reason: 'CALLER_NOT_LIVE_ROOT' },
    })
    expect(child.steer).not.toHaveBeenCalled()
  })

  it('keeps legacy source and record operations available without the new admission service', async () => {
    const h = await setup({}, false)
    await expect(h.service.submitAction(h.agent, request())).rejects.toMatchObject({
      code: 'artifact/action-unavailable', details: { reason: 'SERVICE_UNAVAILABLE' },
    })
    expect(h.service.record(h.agent, id, 1, 'inspect', { count: 2 }, false)).toEqual({ accepted: true, revision: 1 })
    expect(h.agent.inject).toHaveBeenCalledOnce()
    expect(h.service.currentSnapshot(h.agent, id)?.revision).toBe(1)
  })

  it('rejects a non-owner principal without adding a durable caller field', async () => {
    const h = await setup()
    const controller = new AbortController()
    const invocation: RemoteInvocation = {
      request: { namespace: 'artifacts', method: 'submitAction', args: {} }, service: 'artifacts', signal: controller.signal,
      peer: { id: 'artifact-test-peer' as PeerId, ctx: h.ctx, principal: { kind: 'artifact-test-caller' },
        interactions: 'answer', signal: controller.signal, dispose: async () => {} },
      uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
    }
    await expect(h.ctx.extend({ invocation }).artifacts.submitAction(h.agent, request())).rejects.toMatchObject({
      code: 'artifact/action-rejected', details: { reason: 'CALLER_NOT_OWNER' },
    })
    expect(h.agent.steer).not.toHaveBeenCalled()
    expect(remoteMethods(h.service).some(method => method.method === 'submitAction')).toBe(true)
  })
})
