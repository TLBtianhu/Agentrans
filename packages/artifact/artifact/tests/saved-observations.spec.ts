import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import ArtifactService, { type Config } from '../src/index.ts'
import type { ParticleCheckpoint } from '../src/particle-runtime.ts'
import type { ParticleSystemSpec } from '../src/scene.ts'
import type { ArtifactId, ArtifactObservationId, SavedParticleObservation } from '../src/types.ts'

const contexts: Context[] = []
let sequence = 0
const id = 'particles' as ArtifactId
const observationId = (value: string) => value as ArtifactObservationId
const checkpoint: ParticleCheckpoint = { runtimeVersion: 1, stepCount: 6 }
const source: ParticleSystemSpec = {
  kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 1, vx: 3, vy: 8, mass: 1 }],
  gravity: { x: 0, y: -9.8 }, timeStep: 1 / 30, trails: true,
}

afterEach(async () => {
  for (const context of contexts.splice(0).reverse()) await context.fiber.dispose()
})

async function setup(config: Config = {}, seed?: readonly SessionEvent[], inherited = false) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const fiber = ctx.plugin(ArtifactService, config)
  await fiber
  const agentId = SessionId(`saved-observation-${++sequence}`)
  const session = ctx.sessions.create(agentId, {
    ...(seed === undefined ? {} : { seed }),
    ...(inherited ? { meta: { isSeeded: true, parentSession: SessionId('observation-parent') },
      inheritedEventCount: SessionLogOffset(seed?.length ?? 0) } : {}),
  })
  // Mirror the Agent inbox's commit point: admission durably splices before returning.
  const admit = (message: UserMessage) => {
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
  }
  const steer = vi.fn(admit)
  const inject = vi.fn(admit)
  const agent = {
    id: agentId, session, ctx,
    steer: (message: UserMessage): void => { steer(message) },
    inject: (message: UserMessage): void => { inject(message) },
  } as Agent
  ctx.agents.enter(agent, undefined)
  return { ctx, agent, session, service: ctx.artifacts, fiber, steer, inject }
}

function create(service: ArtifactService, agent: Agent) {
  const snapshot = service.prepare(agent, {
    action: 'create', artifactId: id, title: 'Experiment', presentation: 'inline', format: 'scene', spec: source,
  })
  service.commit(agent, snapshot)
}

function revise(service: ArtifactService, agent: Agent) {
  service.commit(agent, service.prepare(agent, {
    action: 'update', artifactId: id, title: 'New experiment', presentation: 'inline', format: 'scene',
    baseRevision: 1, spec: { ...source, gravity: { x: 0, y: -4 } },
  }))
}

function savedEvents(session: Session) {
  return session.snapshotEvents().filter(event => event.type === 'artifact/observations')
}

function values(ctx: Context, session: Session) {
  return ctx.sessionProjections.snapshot(session).values.artifactObservations
}

describe('saved particle observations', () => {
  it('saves, sends and resolves a valid Artifact identity that names a prototype member', async () => {
    const { ctx, service, agent, steer, session } = await setup()
    const artifactId = 'constructor' as ArtifactId
    service.commit(agent, service.prepare(agent, {
      action: 'create', artifactId, title: 'Constructor experiment', presentation: 'inline', format: 'scene', spec: source,
    }))
    const saved = service.saveObservation(agent, artifactId, 1, observationId('a'), 'A', checkpoint)
    expect(service.resolveSceneSource(agent, { kind: 'observation', artifactId, observationId: observationId('a') }))
      .toEqual({ artifact: saved.artifact, checkpoint: saved.checkpoint, observationId: saved.observationId })
    expect(service.sendObservation(agent, artifactId, observationId('a'), true)).toEqual({ accepted: true, revision: 1 })
    expect(service.sendObservation(agent, artifactId, observationId('a'), true)).toEqual({ accepted: true, revision: 1 })
    expect(steer).toHaveBeenCalledTimes(1)
    const rows = ctx.sessionProjections.checkpoint(session)
    const restored = ctx.sessionProjections.restore(rows, [], SessionLogOffset(session.snapshotEvents().length), session.header,
      session.inheritedEventCount)
    expect(restored.snapshot.values.artifactObservations?.[artifactId]).toEqual([saved])
  })

  it('stores a complete named source-bound observation without adding Agent input', async () => {
    const { ctx, service, agent, session, steer, inject } = await setup()
    create(service, agent)
    const saved = service.saveObservation(agent, id, 1, observationId('a'), '  A  ', checkpoint)
    expect(saved).toMatchObject({ observationId: 'a', label: 'A', artifact: { artifactId: id, revision: 1 }, checkpoint })
    expect(saved.values.time).toBe(0.2)
    expect(saved.values.particles[0]?.y).toBeCloseTo(2.4366666666666665, 12)
    expect(savedEvents(session).map(event => event.data)).toEqual([{ artifactId: id, observations: [saved] }])
    expect(values(ctx, session)).toEqual({ [id]: [saved] })
    expect(ctx.sessionProjections.summaryKeys().has('artifactObservations')).toBe(false)
    expect(steer).not.toHaveBeenCalled()
    expect(inject).not.toHaveBeenCalled()
    expect(session.snapshotEvents().some(event => event.type === 'user/message' || event.type === 'agent/inbox/spliced')).toBe(false)
  })

  it('retries a saved request after a source update but rejects a reused identity with different intent', async () => {
    const { service, agent, session } = await setup()
    create(service, agent)
    const saved = service.saveObservation(agent, id, 1, observationId('a'), 'A', checkpoint)
    revise(service, agent)
    expect(service.saveObservation(agent, id, 1, observationId('a'), ' A ', checkpoint)).toEqual(saved)
    expect(savedEvents(session)).toHaveLength(1)
    expect(() => service.saveObservation(agent, id, 1, observationId('a'), 'B', checkpoint))
      .toThrow(expect.objectContaining({ code: 'OBSERVATION_CONFLICT' }))
    expect(() => service.saveObservation(agent, id, 1, observationId('a'), 'A', { ...checkpoint, stepCount: 7 }))
      .toThrow(expect.objectContaining({ code: 'OBSERVATION_CONFLICT' }))
    expect(() => service.saveObservation(agent, id, 1, observationId('new'), 'New', checkpoint))
      .toThrow(expect.objectContaining({ code: 'artifact/stale-revision',
        details: { artifactId: id, expectedRevision: 1, currentRevision: 2 },
      }))
    expect(savedEvents(session)).toHaveLength(1)
  })

  it('rejects invalid checkpoints and unsupported sources before any saved event', async () => {
    const { service, agent, session } = await setup()
    create(service, agent)
    expect(() => service.saveObservation(agent, id, 1, observationId('a'), 'A', { runtimeVersion: 1, stepCount: -1 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_CHECKPOINT' }))
    expect(() => service.saveObservation(agent, id, 1, observationId('a'), ' ', checkpoint))
      .toThrow(expect.objectContaining({ code: 'BAD_INPUT' }))
    service.commit(agent, service.prepare(agent, {
      action: 'create', artifactId: 'html', title: 'HTML', source: '<p>Content</p>', presentation: 'inline',
    }))
    expect(() => service.saveObservation(agent, 'html' as ArtifactId, 1, observationId('a'), 'A', checkpoint))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_OBSERVATION' }))
    expect(savedEvents(session)).toEqual([])
  })

  it('bounds retained observations without replacing an earlier saved value', async () => {
    const { ctx, service, agent, session } = await setup({ maxSavedObservationsPerArtifact: 1 })
    create(service, agent)
    const saved = service.saveObservation(agent, id, 1, observationId('a'), 'A', checkpoint)
    expect(() => service.saveObservation(agent, id, 1, observationId('b'), 'B', checkpoint))
      .toThrow(expect.objectContaining({ code: 'artifact/observation-limit', details: { artifactId: id, limit: 1 },
      }))
    expect(values(ctx, session)).toEqual({ [id]: [saved] })
    expect(savedEvents(session)).toHaveLength(1)
  })

  it('keeps a full-list failure in the Gateway RemoteError branch with typed details', async () => {
    const { service, agent, session } = await setup({ maxSavedObservationsPerArtifact: 1 })
    create(service, agent)
    service.saveObservation(agent, id, 1, observationId('a'), 'A', checkpoint)
    let failure: unknown
    try { service.saveObservation(agent, id, 1, observationId('b'), 'B', checkpoint) } catch (error) { failure = error }
    expect(remoteErrorOf(failure)).toMatchObject({
      code: 'artifact/observation-limit', details: { artifactId: id, limit: 1 },
    })
    expect(failure).toHaveProperty('cause.code', 'OBSERVATION_LIMIT')
    expect(savedEvents(session)).toHaveLength(1)
  })

  it('keeps a stale-source failure in the Gateway RemoteError branch with both revisions', async () => {
    const { service, agent, session } = await setup()
    create(service, agent)
    revise(service, agent)
    let failure: unknown
    try { service.saveObservation(agent, id, 1, observationId('a'), 'A', checkpoint) } catch (error) { failure = error }
    expect(remoteErrorOf(failure)).toMatchObject({
      code: 'artifact/stale-revision', details: { artifactId: id, expectedRevision: 1, currentRevision: 2 },
    })
    expect(failure).toHaveProperty('cause.code', 'STALE_REVISION')
    expect(savedEvents(session)).toEqual([])
  })

  it('requires the exact live root for both saving and sending', async () => {
    const { service, agent, session, steer, inject } = await setup()
    create(service, agent)
    service.saveObservation(agent, id, 1, observationId('a'), 'A', checkpoint)
    const unregistered = { ...agent } as Agent
    expect(() => service.saveObservation(unregistered, id, 1, observationId('b'), 'B', checkpoint))
      .toThrow(expect.objectContaining({ code: 'CALLER_NOT_LIVE_ROOT' }))
    expect(() => service.sendObservation(unregistered, id, observationId('a'), true))
      .toThrow(expect.objectContaining({ code: 'CALLER_NOT_LIVE_ROOT' }))
    expect(savedEvents(session)).toHaveLength(1)
    expect(steer).not.toHaveBeenCalled()
    expect(inject).not.toHaveBeenCalled()
  })

  it('recovers complete observations and source revisions in a fresh service lifecycle', async () => {
    const first = await setup()
    create(first.service, first.agent)
    const saved = first.service.saveObservation(first.agent, id, 1, observationId('a'), 'A', checkpoint)
    revise(first.service, first.agent)
    const events = JSON.parse(JSON.stringify(first.session.snapshotEvents())) as SessionEvent[]
    const second = await setup({}, events)
    expect(values(second.ctx, second.session)).toEqual({ [id]: [saved] })
    expect(second.service.sendObservation(second.agent, id, observationId('a'), true)).toEqual({ accepted: true, revision: 1 })
    const message = second.steer.mock.calls[0]?.[0]
    expect(message?.source).toEqual({ kind: 'artifact-action', artifactId: id, revision: 1 })
    const content = message?.content[0]
    if (content?.type !== 'text') throw new Error('Expected one saved observation message')
    expect(JSON.parse(content.text)).toMatchObject({
      action: 'physics.inspected', revision: 1,
      payload: { observationId: 'a', label: 'A', runtimeVersion: 1, stepCount: 6, ...saved.values },
    })
    expect(() => second.service.record(second.agent, id, 1, 'physics.inspected', null, false))
      .toThrow(expect.objectContaining({ code: 'STALE_REVISION' }))
  })

  it('matches full replay when a cached projection is restored and a saved-list suffix is applied', async () => {
    const { ctx, service, agent, session } = await setup()
    create(service, agent)
    service.saveObservation(agent, id, 1, observationId('a'), 'A', checkpoint)
    const rows = ctx.sessionProjections.checkpoint(session)
    const offset = session.snapshotEvents().length
    service.saveObservation(agent, id, 1, observationId('b'), 'B', { ...checkpoint, stepCount: 9 })
    const events = session.snapshotEvents()
    const suffix = ctx.sessionProjections.restore(
      rows, events.slice(offset), SessionLogOffset(offset), session.header, session.inheritedEventCount,
    )
    const full = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), session.header, session.inheritedEventCount)
    expect(suffix.snapshot).toEqual(full.snapshot)
    expect(suffix.snapshot.values.artifactObservations?.[id]).toHaveLength(2)
  })

  it('does not re-enqueue after a durable receipt whose transport outcome was unknown', async () => {
    const first = await setup()
    create(first.service, first.agent)
    first.service.saveObservation(first.agent, id, 1, observationId('a'), 'A', checkpoint)
    first.steer.mockImplementationOnce((message) => {
      first.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
      throw new Error('Response connection was lost after admission')
    })
    expect(() => first.service.sendObservation(first.agent, id, observationId('a'), true)).toThrow('connection was lost')
    expect(first.service.sendObservation(first.agent, id, observationId('a'), true)).toEqual({ accepted: true, revision: 1 })
    expect(first.steer).toHaveBeenCalledOnce()
    const second = await setup({}, first.session.snapshotEvents())
    expect(second.service.sendObservation(second.agent, id, observationId('a'), false)).toEqual({ accepted: true, revision: 1 })
    expect(second.inject).not.toHaveBeenCalled()
    expect(second.steer).not.toHaveBeenCalled()
  })

  it('releases the observation wire contribution with the Artifact service', async () => {
    const { ctx, service, agent, session, fiber } = await setup()
    create(service, agent)
    service.saveObservation(agent, id, 1, observationId('a'), 'A', checkpoint)
    expect(values(ctx, session)?.[id]).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values.artifactObservations).toBeUndefined()
  })

  it('keeps the observation wire value stable when only the current source changes', async () => {
    const { ctx, service, agent, session } = await setup()
    create(service, agent)
    const changed = vi.fn()
    ctx.sessionProjections.onChanged(changed)
    service.saveObservation(agent, id, 1, observationId('a'), 'A', checkpoint)
    expect(changed).toHaveBeenCalledOnce()
    const before = values(ctx, session)
    revise(service, agent)
    expect(changed).toHaveBeenCalledOnce()
    expect(values(ctx, session)).toEqual(before)
  })

  it('inherits observations into a child Session without inheriting the parent receipt', async () => {
    const first = await setup()
    create(first.service, first.agent)
    first.service.saveObservation(first.agent, id, 1, observationId('a'), 'A', checkpoint)
    first.service.sendObservation(first.agent, id, observationId('a'), true)
    const child = await setup({}, first.session.snapshotEvents(), true)
    expect(child.service.sendObservation(child.agent, id, observationId('a'), false)).toEqual({ accepted: true, revision: 1 })
    expect(child.inject).toHaveBeenCalledOnce()
    expect(child.steer).not.toHaveBeenCalled()
  })

  it('recognizes a consumed user-message receipt when no pending inbox splice is retained', async () => {
    const first = await setup()
    create(first.service, first.agent)
    first.service.saveObservation(first.agent, id, 1, observationId('a'), 'A', checkpoint)
    first.steer.mockImplementationOnce((message) => { first.session.append('user/message', message, { surfaceOp: 'append' }) })
    first.service.sendObservation(first.agent, id, observationId('a'), true)
    const second = await setup({}, first.session.snapshotEvents())
    second.service.sendObservation(second.agent, id, observationId('a'), true)
    expect(second.steer).not.toHaveBeenCalled()
  })

  it('refuses saved coordinates that disagree with the source-bound runtime during replay', async () => {
    const { service, agent, session } = await setup()
    create(service, agent)
    const saved = service.saveObservation(agent, id, 1, observationId('a'), 'A', checkpoint)
    const corrupt: SavedParticleObservation = { ...saved, values: { ...saved.values, time: 100 } }
    const events = session.snapshotEvents().map(event => event.type === 'artifact/observations'
      ? { ...event, data: { artifactId: id, observations: [corrupt] } } : event)
    const fresh = await setup({}, events)
    expect(() => values(fresh.ctx, fresh.session)).toThrow('values do not match')
  })
})
