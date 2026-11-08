import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import GatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import ArtifactService from '@deepseek-ai/dsh-artifact'
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { PeerId, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import RuntimeService, { type Config } from '../src/index.ts'
import type { ArtifactRuntimeId, ArtifactRuntimeIdentity, RuntimeAck, RuntimeReport } from '../src/types.ts'

const contexts: Context[] = []
const streams: { readonly controller: AbortController; readonly iterator: AsyncIterator<RuntimeAck> }[] = []
const artifactId = 'demo' as ArtifactId
let nextSession = 1

afterEach(async () => {
  vi.useRealTimers()
  for (const stream of streams.splice(0)) { stream.controller.abort(); await stream.iterator.return?.() }
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

describe('bounded exact-revision runtime waiting', () => {
  it('waits for a not-yet-attached view and settles from its first terminal report without adding input', async () => {
    const h = await setup()
    vi.useFakeTimers()
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const events = h.session.snapshotEvents()
    const pending = h.ctx.artifactRuntime.wait(h.agent, artifactId, 1, 100, controller.signal)
    expect(vi.getTimerCount()).toBe(1)
    const stream = open(h.ctx, h.session.id)
    await stream.iterator.next()
    expect(vi.getTimerCount()).toBe(1)
    stream.input.send(ready)
    await stream.iterator.next()
    expect(await pending).toMatchObject({
      artifactId, revision: 1, reportAuthority: 'client-reported', wait: { outcome: 'reported', limitMs: 100 },
      runs: [{ status: 'ready', renderer: 'native' }],
    })
    expect(h.session.snapshotEvents()).toEqual(events)
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1])
    controller.abort()
    expect(h.ctx.artifactRuntime.inspect(h.agent, artifactId, 1).runs).toHaveLength(1)
  })

  it('returns all existing independent runs immediately when ready and error reports disagree', async () => {
    const h = await setup({ maxWaitsPerSession: 1 })
    const first = open(h.ctx, h.session.id)
    const second = open(h.ctx, h.session.id)
    const third = open(h.ctx, h.session.id)
    for (const stream of [first, second, third]) await stream.iterator.next()
    first.input.send(ready)
    await first.iterator.next()
    second.input.send({ status: 'error', error: { code: 'BROKEN_VIEW', message: 'A different view failed' } })
    await second.iterator.next()
    vi.useFakeTimers()
    const result = await h.ctx.artifactRuntime.wait(h.agent, artifactId, 1, 100, new AbortController().signal)
    expect(result.wait).toEqual({ outcome: 'reported', limitMs: 100 })
    expect(result.runs.map(run => run.status)).toEqual(['ready', 'error', 'starting'])
    expect(result).not.toHaveProperty('ready')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['no-active-report', 'timeout'] as const)('expires once with %s without promoting a missing or starting report', async (outcome) => {
    const h = await setup()
    if (outcome === 'timeout') await open(h.ctx, h.session.id).iterator.next()
    vi.useFakeTimers()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = h.ctx.artifactRuntime.wait(h.agent, artifactId, 1, 100, controller.signal)
    await vi.advanceTimersByTimeAsync(99)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending
    expect(result.wait).toEqual({ outcome, limitMs: 100 })
    expect(result.runs).toHaveLength(outcome === 'timeout' ? 1 : 0)
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('finishes immediately when all matching reports disconnect instead of waiting for another mount', async () => {
    const h = await setup()
    const first = open(h.ctx, h.session.id)
    const second = open(h.ctx, h.session.id)
    await first.iterator.next()
    await second.iterator.next()
    vi.useFakeTimers()
    const pending = h.ctx.artifactRuntime.wait(h.agent, artifactId, 1, 100, new AbortController().signal)
    first.controller.abort()
    expect(vi.getTimerCount()).toBe(1)
    second.controller.abort()
    expect(await pending).toMatchObject({ runs: [], wait: { outcome: 'disconnected', limitMs: 100 } })
    expect(vi.getTimerCount()).toBe(0)
    const later = open(h.ctx, h.session.id)
    await later.iterator.next()
    later.input.send(ready)
    await later.iterator.next()
    expect((await pending).runs).toEqual([])
  })

  it('also reports disconnection after an initially absent view attached while waiting', async () => {
    const h = await setup()
    vi.useFakeTimers()
    const pending = h.ctx.artifactRuntime.wait(h.agent, artifactId, 1, 100, new AbortController().signal)
    const stream = open(h.ctx, h.session.id)
    await stream.iterator.next()
    stream.controller.abort()
    expect(await pending).toMatchObject({ runs: [], wait: { outcome: 'disconnected' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('rejects source replacement before classifying report loss (initial report: %s)', async (attached) => {
    const h = await setup()
    if (attached) await open(h.ctx, h.session.id).iterator.next()
    vi.useFakeTimers()
    const pending = h.ctx.artifactRuntime.wait(h.agent, artifactId, 1, 100, new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'artifact-runtime/source-unavailable', details: { reason: 'STALE_REVISION', currentRevision: 2 },
    })
    h.revise(1)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores unrelated Session, revision and renderer reports, including inherited parent reports', async () => {
    const h = await setup()
    const seed = h.session.snapshotEvents()
    const child = h.ctx.sessions.create(SessionId('runtime-wait-child'), {
      seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { parentSession: h.session.id, isSeeded: true },
    })
    const childAgent = { id: child.id, session: child, ctx: h.ctx } as Agent
    const parent = open(h.ctx, h.session.id)
    const wrongRevision = open(h.ctx, child.id, { revision: 2 })
    const wrongRenderer = open(h.ctx, child.id, { renderer: 'html' })
    for (const stream of [parent, wrongRevision, wrongRenderer]) {
      await stream.iterator.next()
      stream.input.send(ready)
      await stream.iterator.next()
    }
    vi.useFakeTimers()
    const pending = h.ctx.artifactRuntime.wait(childAgent, artifactId, 1, 100, new AbortController().signal)
    h.revise(1)
    expect(vi.getTimerCount()).toBe(1)
    const own = open(h.ctx, child.id)
    await own.iterator.next()
    own.input.send({ status: 'error', error: { code: 'CHILD_FAILURE', message: 'The child view failed' } })
    await own.iterator.next()
    expect(await pending).toMatchObject({ wait: { outcome: 'reported' }, runs: [{ status: 'error', error: { code: 'CHILD_FAILURE' } }] })
    expect((await pending).runs).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves invocation cancellation and releases its timer, listener and pending capacity', async () => {
    const h = await setup({ maxWaitsPerSession: 1 })
    vi.useFakeTimers()
    const controller = new AbortController()
    const reason = 'user stopped the current turn'
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = h.ctx.artifactRuntime.wait(h.agent, artifactId, 1, 100, controller.signal)
    const rejected = expect(pending).rejects.toBe(reason)
    controller.abort(reason)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledOnce()
    const next = h.ctx.artifactRuntime.wait(h.agent, artifactId, 1, 100, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(100)
    expect(await next).toMatchObject({ wait: { outcome: 'no-active-report' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not allocate or read source for an already cancelled wait', async () => {
    const h = await setup()
    vi.useFakeTimers()
    const controller = new AbortController()
    const reason = new Error('cancelled before admission')
    controller.abort(reason)
    const read = vi.spyOn(h.ctx.artifacts, 'currentSnapshot')
    await expect(h.ctx.artifactRuntime.wait(h.agent, artifactId, 1, 100, controller.signal)).rejects.toBe(reason)
    expect(read).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects pending waits before Session disposal can turn them into disconnected reports', async () => {
    const h = await setup()
    const session = h.ctx.sessions.prepare(SessionId('runtime-wait-dispose'), { seed: h.session.snapshotEvents() })
    const detach = h.ctx.sessions.enter(session)
    h.ctx.sessions.announce(session)
    const agent = { id: session.id, session, ctx: h.ctx } as Agent
    const stream = open(h.ctx, session.id)
    await stream.iterator.next()
    vi.useFakeTimers()
    const pending = h.ctx.artifactRuntime.wait(agent, artifactId, 1, 100, new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'artifact-runtime/wait-unavailable', details: { reason: 'SESSION_DISPOSED' } })
    detach()
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects pending and later waits when the service closes without touching disposed source readers', async () => {
    const h = await setup()
    await open(h.ctx, h.session.id).iterator.next()
    const service = h.ctx.artifactRuntime
    vi.useFakeTimers()
    const pending = service.wait(h.agent, artifactId, 1, 100, new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'artifact-runtime/wait-unavailable', details: { reason: 'CLOSED' } })
    await h.fiber.dispose()
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    const read = vi.spyOn(h.ctx.artifacts, 'currentSnapshot')
    await expect(service.wait(h.agent, artifactId, 1, 100, new AbortController().signal)).rejects.toMatchObject({ details: { reason: 'CLOSED' } })
    expect(read).not.toHaveBeenCalled()
  })

  it('bounds pending Session and Host waits and returns capacity when an earlier wait settles', async () => {
    const h = await setup({ maxWaitsPerSession: 1, maxWaitsTotal: 2 })
    const other = h.ctx.sessions.create(SessionId('runtime-wait-capacity'), { seed: h.session.snapshotEvents() })
    const otherAgent = { id: other.id, session: other, ctx: h.ctx } as Agent
    vi.useFakeTimers()
    const controller = new AbortController()
    const reason = new Error('release pending wait capacity')
    const first = h.ctx.artifactRuntime.wait(h.agent, artifactId, 1, 100, controller.signal)
    const cancelled = expect(first).rejects.toBe(reason)
    await expect(h.ctx.artifactRuntime.wait(h.agent, artifactId, 1, 100, new AbortController().signal)).rejects.toMatchObject({
      details: { reason: 'CAPACITY', limit: 1 },
    })
    const second = h.ctx.artifactRuntime.wait(otherAgent, artifactId, 1, 100, new AbortController().signal)
    await expect(h.ctx.artifactRuntime.wait(h.agent, artifactId, 1, 100, new AbortController().signal)).rejects.toMatchObject({
      details: { reason: 'CAPACITY', limit: 2 },
    })
    expect(vi.getTimerCount()).toBe(2)
    controller.abort(reason)
    await cancelled
    const replacement = h.ctx.artifactRuntime.wait(h.agent, artifactId, 1, 100, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(100)
    expect((await second).wait.outcome).toBe('no-active-report')
    expect((await replacement).wait.outcome).toBe('no-active-report')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 101])('rejects invalid or over-budget duration %s without a timer', async (waitMs) => {
    const h = await setup({ maxWaitMs: 100 })
    vi.useFakeTimers()
    await expect(h.ctx.artifactRuntime.wait(h.agent, artifactId, 1, waitMs, new AbortController().signal)).rejects.toMatchObject({
      code: 'artifact-runtime/wait-unavailable', details: { reason: 'INVALID_WAIT', limit: 100 },
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads prepared source without scanning history or activating a cold Session during waiting', async () => {
    const h = await setup()
    h.ctx.artifacts.currentSnapshot(h.agent, artifactId)
    vi.spyOn(h.session, 'snapshotEvents').mockImplementation(() => { throw new Error('history must not be read') })
    vi.useFakeTimers()
    const pending = h.ctx.artifactRuntime.wait(h.agent, artifactId, 1, 100, new AbortController().signal)
    const cold = open(h.ctx, SessionId('cold-runtime-wait'))
    await cold.iterator.next()
    cold.input.send(ready)
    await cold.iterator.next()
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toMatchObject({ runs: [], wait: { outcome: 'no-active-report' } })
    expect(h.ctx.sessions.get(SessionId('cold-runtime-wait'))).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})

async function setup(config: Config = {}, gateway = false) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  if (gateway) {
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(RemoteAccessService)
    await ctx.plugin(GatewayService, {})
  }
  await ctx.plugin(ArtifactService)
  const fiber = ctx.plugin(RuntimeService, config)
  await fiber
  const id = SessionId(`runtime-${nextSession++}`)
  const session = ctx.sessions.create(id)
  const agent = { id, session, ctx } as Agent
  const revise = (baseRevision?: number): void => {
    ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
      action: baseRevision === undefined ? 'create' : 'update', artifactId, title: 'Demo', format: 'scene',
      presentation: 'inline', spec: { kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 0, vx: 1, vy: 0, mass: 1 }],
        gravity: { x: 0, y: -1 }, timeStep: 1 / 30, trails: false },
      ...baseRevision === undefined ? {} : { baseRevision },
    }))
  }
  revise()
  return { ctx, session, agent, fiber, revise }
}

function channel<T>() {
  const queue: T[] = []
  let ended = false
  let pending: ((result: IteratorResult<T>) => void) | undefined
  const source: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          if (queue.length > 0) return { value: queue.shift()!, done: false }
          if (ended) return { value: undefined, done: true }
          return new Promise<IteratorResult<T>>((resolve) => { pending = resolve })
        },
        return: async () => {
          ended = true; pending?.({ value: undefined, done: true }); pending = undefined
          return { value: undefined, done: true }
        },
      }
    },
  }
  return {
    source,
    send(value: T): void {
      if (pending === undefined) queue.push(value)
      else { const resolve = pending; pending = undefined; resolve({ value, done: false }) }
    },
    end(): void { ended = true; pending?.({ value: undefined, done: true }); pending = undefined },
  }
}

function open(ctx: Context, sessionId: SessionId, identity: Partial<ArtifactRuntimeIdentity> = {}) {
  const input = channel<unknown>()
  const controller = new AbortController()
  const invocation: RemoteInvocation = {
    request: { namespace: 'artifactRuntime', method: 'attach', args: {} }, service: 'artifactRuntime', signal: controller.signal,
    peer: { id: 'test-peer' as PeerId, ctx, principal: { kind: 'owner' }, interactions: 'answer', signal: controller.signal, dispose: async () => {} },
    uplink: <In>() => input.source as AsyncIterable<In>,
  }
  const iterator = ctx.extend({ invocation }).artifactRuntime.attach(sessionId, {
    artifactId, revision: 1, runtimeId: `runtime-${streams.length}` as ArtifactRuntimeId, renderer: 'native', ...identity,
  }, controller.signal)[Symbol.asyncIterator]()
  streams.push({ iterator, controller })
  return { iterator, controller, input }
}

const ready: RuntimeReport = { status: 'ready', capabilities: { state: true, commands: ['step', 'reset'] } }

describe('live Artifact runtime reports', () => {
  it('separates stored source semantics from active starting, ready and error reports without appending input', async () => {
    const h = await setup()
    const initial = h.session.snapshotEvents()
    const inspect = () => h.ctx.artifactRuntime.inspect(h.agent, artifactId, 1)
    expect(inspect()).toMatchObject({ reportAuthority: 'client-reported', runs: [], sourceCapabilities: { observe: 'particle' } })
    const stream = open(h.ctx, h.session.id)
    expect(await stream.iterator.next()).toEqual({ value: { kind: 'attached' }, done: false })
    expect(inspect().runs).toMatchObject([{ status: 'starting', renderer: 'native' }])
    stream.input.send(ready)
    expect(await stream.iterator.next()).toEqual({ value: { kind: 'accepted', sequence: 1 }, done: false })
    expect(inspect().runs[0]).toMatchObject(ready)
    stream.input.send({ status: 'error', error: { code: 'PARTICLE_NUMERICS', message: 'Non-finite position' } })
    expect(await stream.iterator.next()).toMatchObject({ value: { kind: 'accepted', sequence: 2 } })
    expect(inspect().runs[0]).toMatchObject({ status: 'error', error: { code: 'PARTICLE_NUMERICS' } })
    expect(h.session.snapshotEvents()).toEqual(initial)
    stream.input.end()
    expect(await stream.iterator.next()).toEqual({ value: undefined, done: true })
    expect(inspect().runs).toEqual([])
  })

  it('removes a report on carrier loss and source revision replacement, including a blocked uplink read', async () => {
    const h = await setup()
    const first = open(h.ctx, h.session.id)
    await first.iterator.next()
    first.input.send(ready)
    await first.iterator.next()
    const blocked = first.iterator.next()
    first.controller.abort()
    await expect(blocked).resolves.toEqual({ value: undefined, done: true })
    expect(h.ctx.artifactRuntime.inspect(h.agent, artifactId, 1).runs).toEqual([])
    const second = open(h.ctx, h.session.id)
    await second.iterator.next()
    second.input.send(ready)
    await second.iterator.next()
    const old = second.iterator.next()
    h.revise(1)
    await expect(old).resolves.toEqual({ value: undefined, done: true })
    expect(h.ctx.artifactRuntime.inspect(h.agent, artifactId, 2).runs).toEqual([])
    expect(() => h.ctx.artifactRuntime.inspect(h.agent, artifactId, 1)).toThrow(expect.objectContaining({
      code: 'artifact-runtime/source-unavailable', details: { reason: 'STALE_REVISION', currentRevision: 2 },
    }))
  })

  it.each(['source replacement', 'service disposal'] as const)(
    'ends a real Gateway stream during %s while its raw uplink generator cannot return yet', async (reason) => {
      const h = await setup({}, true)
      const held = Promise.withResolvers<undefined>()
      async function* rawUplink(): AsyncIterable<RuntimeReport> {
        yield ready
        await held.promise
      }
      const peer = new Peer(h.ctx, { principal: { kind: 'owner' } })
      const source = await h.ctx.typertGateway.stream({
        peer, namespace: 'artifactRuntime', method: 'attach',
        args: { sessionId: h.session.id, identity: {
          artifactId, revision: 1, runtimeId: 'gateway-view', renderer: 'native',
        } },
        uplink: rawUplink(),
      })
      const iterator = source[Symbol.asyncIterator]()
      try {
        expect(await iterator.next()).toMatchObject({ value: { kind: 'attached' } })
        expect(await iterator.next()).toMatchObject({ value: { kind: 'accepted', sequence: 1 } })
        const pending = iterator.next()
        // The Gateway must have started the blocked read before invalidation.
        await Promise.resolve()
        if (reason === 'source replacement') h.revise(1)
        else await h.fiber.dispose()
        await expect(pending).resolves.toEqual({ value: undefined, done: true })
      } finally {
        held.resolve(undefined)
        await iterator.return?.()
        await peer.dispose()
      }
    },
  )

  it('keeps physical runs independent and filters Session, source revision and renderer claims', async () => {
    const h = await setup()
    const first = open(h.ctx, h.session.id)
    const second = open(h.ctx, h.session.id)
    const wrongSession = open(h.ctx, SessionId('other-session'))
    const wrongRevision = open(h.ctx, h.session.id, { revision: 9 })
    const wrongRenderer = open(h.ctx, h.session.id, { renderer: 'html' })
    for (const stream of [first, second, wrongSession, wrongRevision, wrongRenderer]) {
      await stream.iterator.next(); stream.input.send(ready); await stream.iterator.next()
    }
    const runs = h.ctx.artifactRuntime.inspect(h.agent, artifactId, 1).runs
    expect(runs).toHaveLength(2)
    expect(new Set(runs.map(run => run.runtimeId)).size).toBe(2)
    first.controller.abort()
    expect(h.ctx.artifactRuntime.inspect(h.agent, artifactId, 1).runs).toHaveLength(1)
  })

  it('keeps inherited source support while isolating parent and child live reports', async () => {
    const h = await setup()
    const seed = h.session.snapshotEvents()
    const child = h.ctx.sessions.create(SessionId('runtime-child'), {
      seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { parentSession: h.session.id, isSeeded: true },
    })
    const childAgent = { id: child.id, session: child, ctx: h.ctx } as Agent
    const parent = open(h.ctx, h.session.id)
    await parent.iterator.next(); parent.input.send(ready); await parent.iterator.next()
    expect(h.ctx.artifactRuntime.inspect(childAgent, artifactId, 1).runs).toEqual([])
    const own = open(h.ctx, child.id)
    await own.iterator.next(); own.input.send({ status: 'error', error: { code: 'CHILD_ERROR', message: 'Child renderer failed' } }); await own.iterator.next()
    expect(h.ctx.artifactRuntime.inspect(childAgent, artifactId, 1).runs).toMatchObject([{ status: 'error', error: { code: 'CHILD_ERROR' } }])
    h.revise(1)
    expect(h.ctx.artifactRuntime.inspect(childAgent, artifactId, 1).runs).toHaveLength(1)
    expect(h.ctx.artifactRuntime.inspect(h.agent, artifactId, 2).runs).toEqual([])
  })

  it('does not turn HTML program declarations into Host-supported observation or export semantics', async () => {
    const h = await setup()
    h.ctx.artifacts.commit(h.agent, h.ctx.artifacts.prepare(h.agent, {
      action: 'update', artifactId, baseRevision: 1, title: 'HTML program', format: 'html', source: '<p>Authored program</p>', presentation: 'inline',
    }))
    const stream = open(h.ctx, h.session.id, { revision: 2, renderer: 'html' })
    await stream.iterator.next(); stream.input.send(ready); await stream.iterator.next()
    expect(h.ctx.artifactRuntime.inspect(h.agent, artifactId, 2)).toMatchObject({
      format: 'html', sourceCapabilities: { observe: 'unsupported', save: 'unsupported', restore: 'unsupported', compare: 'unsupported',
        questionContext: 'program-reported', exportHtml: 'unsupported' },
      runs: [{ renderer: 'html', status: 'ready', capabilities: { state: true, commands: ['step', 'reset'] } }],
    })
  })

  it('rejects unknown sources during inspection and never reads a Session log while registering or inspecting', async () => {
    const h = await setup()
    h.ctx.artifacts.currentSnapshot(h.agent, artifactId)
    vi.spyOn(h.session, 'snapshotEvents').mockImplementation(() => { throw new Error('history must not be read') })
    const stream = open(h.ctx, SessionId('cold-unpublished-session'))
    await stream.iterator.next()
    stream.input.send(ready)
    await stream.iterator.next()
    expect(h.ctx.sessions.get(SessionId('cold-unpublished-session'))).toBeUndefined()
    expect(h.ctx.artifactRuntime.inspect(h.agent, artifactId, 1).runs).toEqual([])
    expect(() => h.ctx.artifactRuntime.inspect(h.agent, 'missing' as ArtifactId, 1)).toThrow(expect.objectContaining({
      code: 'artifact-runtime/source-unavailable', details: { reason: 'NOT_FOUND' },
    }))
  })

  it('enforces global and per-Session capacity and does not let duplicate runtime ids replace a stream', async () => {
    const h = await setup({ maxViewsPerSession: 1, maxViewsTotal: 2 })
    const first = open(h.ctx, h.session.id, { runtimeId: 'same' as ArtifactRuntimeId })
    await first.iterator.next()
    await expect(open(h.ctx, h.session.id, { runtimeId: 'same' as ArtifactRuntimeId }).iterator.next()).rejects.toMatchObject({ details: { reason: 'DUPLICATE_RUNTIME' } })
    await expect(open(h.ctx, h.session.id).iterator.next()).rejects.toMatchObject({ details: { reason: 'CAPACITY', limit: 1 } })
    const second = open(h.ctx, SessionId('other'))
    await second.iterator.next()
    await expect(open(h.ctx, SessionId('third')).iterator.next()).rejects.toMatchObject({ details: { reason: 'CAPACITY', limit: 2 } })
    first.controller.abort()
    const replacement = open(h.ctx, h.session.id, { runtimeId: 'same' as ArtifactRuntimeId })
    expect(await replacement.iterator.next()).toMatchObject({ value: { kind: 'attached' } })
    await first.iterator.return?.()
    expect(h.ctx.artifactRuntime.inspect(h.agent, artifactId, 1).runs).toHaveLength(1)
  })

  it.each([
    { status: 'ready', capabilities: { state: true, commands: ['step', 'step'] } },
    { status: 'ready', capabilities: { state: true, commands: ['write-files'] } },
    { status: 'error', error: { code: 'bad code', message: 'failure' } },
    { status: 'error', error: { code: 'ERROR', message: '多'.repeat(40) } },
  ])('drops a stream instead of retaining malformed or over-budget reports: $status', async (report) => {
    const h = await setup({ maxErrorBytes: 64 })
    const stream = open(h.ctx, h.session.id)
    await stream.iterator.next()
    stream.input.send(report)
    await expect(stream.iterator.next()).rejects.toMatchObject({ code: 'artifact-runtime/rejected' })
    expect(h.ctx.artifactRuntime.inspect(h.agent, artifactId, 1).runs).toEqual([])
  })

  it('returns detached reports and clears live state when the service is disposed', async () => {
    const h = await setup()
    const stream = open(h.ctx, h.session.id)
    await stream.iterator.next(); stream.input.send(ready); await stream.iterator.next()
    const inspected = h.ctx.artifactRuntime.inspect(h.agent, artifactId, 1)
    const run = inspected.runs[0]
    if (run?.status !== 'ready') throw new Error('missing ready report')
    Object.assign(run.capabilities, { state: false })
    expect(h.ctx.artifactRuntime.inspect(h.agent, artifactId, 1).runs[0]).toMatchObject(ready)
    const service = h.ctx.artifactRuntime
    const pending = stream.iterator.next()
    await h.fiber.dispose()
    await expect(pending).resolves.toEqual({ value: undefined, done: true })
    await expect(service.attach(h.session.id, { artifactId, revision: 1, runtimeId: 'later' as ArtifactRuntimeId, renderer: 'native' }, new AbortController().signal)
      [Symbol.asyncIterator]().next()).rejects.toMatchObject({ details: { reason: 'CLOSED' } })
  })

  it('declares an explicit Session resource and has no Agent/Session lookup in its report parameters', async () => {
    const h = await setup()
    const descriptor = remoteMethods(h.ctx.artifactRuntime).find(marker => marker.method === 'attach')
    expect(descriptor).toMatchObject({ mode: 'stream' })
    expect(descriptor?.resources?.session?.(SessionId('cold'), { artifactId, revision: 1, runtimeId: 'r' as ArtifactRuntimeId, renderer: 'native' }, new AbortController().signal))
      .toBe('cold')
  })
})
