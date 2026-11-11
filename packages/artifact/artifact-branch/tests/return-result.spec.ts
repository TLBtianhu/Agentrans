import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@agentrans/cordis'
import AgentRegistry, { type Agent } from '@agentrans/agent'
import type { SessionController } from '@agentrans/api-session-controller'
import ArtifactService from '@agentrans/artifact'
import type { ArtifactId, ArtifactObservationId, SavedParticleObservationRef } from '@agentrans/artifact/types'
import type { ParticleSystemSpec } from '@agentrans/artifact/scene'
import { createAssistantMessage, createUserMessage, type UserMessage } from '@agentrans/llm'
import SessionStore, { SessionId, SessionLogOffset, type Session } from '@agentrans/session'
import { selectBranchResult } from '@agentrans/session-branch'
import { admitBranchResult } from '@agentrans/session-branch/admission'
import SessionProjectionRegistry from '@agentrans/session-projection'
import SessionQueryEngine, { type SessionEventSearchRequest } from '@agentrans/session-query'
import { remoteErrorOf } from '@agentrans/typert-protocol'
import ArtifactBranchResults, { type Config } from '../src/index.ts'
import type { ArtifactBranchResultRequest } from '../src/types.ts'

const contexts: Context[] = []
let sequence = 0
const control: SavedParticleObservationRef = { artifactId: 'control' as ArtifactId, observationId: 'six' as ArtifactObservationId }
const variant: SavedParticleObservationRef = { artifactId: 'variant' as ArtifactId, observationId: 'six' as ArtifactObservationId }
const spec: ParticleSystemSpec = {
  kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 1, vx: 3, vy: 8, mass: 1 }],
  gravity: { x: 0, y: -9.8 }, timeStep: 1 / 30, trails: true,
}

class TestQuery extends SessionQueryEngine {
  override searchSessions() { return Promise.resolve({ items: [] }) }
  override async searchEvents(request: SessionEventSearchRequest) {
    return { session: (await this.readSurface(request.sessionId)).session, items: [] }
  }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

function makeAgent(ctx: Context, session: Session) {
  let maintenance = false
  let busy = false
  const steer = vi.fn<(message: UserMessage) => void>()
  const inject = vi.fn<(message: UserMessage) => void>()
  const runMaintenance: Agent['runMaintenance'] = <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (maintenance || busy) throw new Error('Agent is busy')
    maintenance = true
    return task(new AbortController().signal).finally(() => { maintenance = false })
  }
  const agent = {
    id: session.id, session, ctx, runMaintenance,
    steer: (message: UserMessage): void => { steer(message) },
    inject: (message: UserMessage): void => { inject(message) },
  } as Agent
  ctx.agents.enter(agent, undefined)
  return { agent, steer, inject, setBusy: (value: boolean): void => { busy = value } }
}

async function setup(config: Config = {}, restored?: { parent: Session; child: Session }) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TestQuery)
  await ctx.plugin(ArtifactService)
  const parentSession = restored === undefined ? ctx.sessions.create(SessionId(`parent-${++sequence}`))
    : ctx.sessions.create(restored.parent.id, { seed: restored.parent.snapshotEvents(), meta: restored.parent.header,
      inheritedEventCount: restored.parent.inheritedEventCount })
  if (restored === undefined) parentSession.append('user/message', createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'Original parent question' }],
  }), { surfaceOp: 'append' })
  const parent = makeAgent(ctx, parentSession)
  const childSession = restored === undefined ? ctx.sessions.create(SessionId(`child-${sequence}`), {
    seed: parentSession.snapshotEvents(), meta: { isSeeded: true, parentSession: parentSession.id },
    inheritedEventCount: SessionLogOffset(parentSession.seq),
  }) : ctx.sessions.create(restored.child.id, { seed: restored.child.snapshotEvents(), meta: restored.child.header,
    inheritedEventCount: restored.child.inheritedEventCount })
  const child = makeAgent(ctx, childSession)
  const resolveAgent = vi.fn<SessionController['resolveAgent']>(async (id) => {
    if (id !== parentSession.id) throw new Error('Only the parent may be activated')
    return { agent: parent.agent }
  })
  ctx.provide('sessionController', {
    resolveAgent: (id: Parameters<SessionController['resolveAgent']>[0]) => resolveAgent(id),
  } as SessionController)
  const fiber = ctx.plugin(ArtifactBranchResults, config)
  await fiber
  return { ctx, parent, child, parentSession, childSession, resolveAgent, service: ctx.artifactBranchResults, fiber }
}

function savePair(fixture: Awaited<ReturnType<typeof setup>>, variantSpec = spec) {
  const { ctx, child } = fixture
  for (const [role, ref, source] of [['control', control, spec], ['variant', variant, variantSpec]] as const) {
    ctx.artifacts.commit(child.agent, ctx.artifacts.prepare(child.agent, {
      action: 'create', artifactId: ref.artifactId, title: role, presentation: 'inline', format: 'scene', spec: source,
      comparison: { group: 'gravity', role },
    }))
    ctx.artifacts.saveObservation(child.agent, ref.artifactId, 1, ref.observationId, role, { runtimeVersion: 1, stepCount: 6 })
  }
}

function conclusion(session: Session, text = 'The variant falls less over the same time.') {
  session.append('turn/start', { turn: 1 })
  const event = session.append('assistant/message', {
    turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'reasoning', text: 'Private reasoning must stay in the child' }, { type: 'text', text }],
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return event.seq
}

function request(fixture: Awaited<ReturnType<typeof setup>>, resultSeq: number): ArtifactBranchResultRequest {
  return { sessionId: fixture.parentSession.id, branchSessionId: fixture.childSession.id, resultSeq,
    evidence: { kind: 'comparison', group: 'gravity', control, variant } }
}

async function returnPlain(fixture: Awaited<ReturnType<typeof setup>>, resultSeq: number) {
  using child = await fixture.ctx.sessionQuery.observeSession(fixture.childSession.id, { projectionMode: 'none' })
  const selected = selectBranchResult(child, fixture.parentSession.id, resultSeq as ReturnType<typeof conclusion>)
  if (!selected.ok) throw new Error('Expected a child-owned conclusion')
  return await admitBranchResult(fixture.parent.agent, selected.value, {
    observeParent: signal => fixture.ctx.sessionQuery.observeSession(fixture.parentSession.id, { projectionMode: 'none', signal }),
    flushParent: () => fixture.ctx.sessions.flush(fixture.parentSession),
  })
}

describe('Artifact branch-result evidence', () => {
  it('returns a fixed old pair with complete sources without changing parent Artifacts or waking either Agent', async () => {
    const fixture = await setup()
    const resultSeq = conclusion(fixture.childSession)
    savePair(fixture, { ...spec, gravity: { x: 0, y: -4 } })
    for (const ref of [control, variant]) {
      fixture.ctx.artifacts.commit(fixture.child.agent, fixture.ctx.artifacts.prepare(fixture.child.agent, {
        action: 'update', artifactId: ref.artifactId, baseRevision: 1, title: 'Current HTML', presentation: 'inline',
        source: '<p>Current source is unrelated</p>', format: 'html',
      }))
    }
    fixture.ctx.artifacts.commit(fixture.parent.agent, fixture.ctx.artifacts.prepare(fixture.parent.agent, {
      action: 'create', artifactId: control.artifactId, title: 'Independent parent experiment', presentation: 'inline',
      format: 'scene', spec: { ...spec, particles: [{ ...spec.particles[0]!, x: 100 }] },
    }))
    const parentBefore = fixture.parentSession.snapshotEvents()
    const childBefore = fixture.childSession.snapshotEvents()
    const response = await fixture.service.returnResult(request(fixture, resultSeq))
    expect(response).toMatchObject({ parentSessionId: fixture.parentSession.id })
    expect(fixture.parentSession.snapshotEvents().slice(0, -1)).toEqual(parentBefore)
    expect(fixture.childSession.snapshotEvents()).toEqual(childBefore)
    const returned = fixture.parentSession.snapshotEvents().at(-1)
    expect(returned).toMatchObject({ type: 'user/message', data: {
      id: response.messageId, source: { kind: 'branch-result', branchSessionId: fixture.childSession.id, resultSeq, form: 'notice' },
    } })
    if (returned?.type !== 'user/message') throw new Error('Expected returned parent input')
    expect(returned.data.content).toHaveLength(2)
    const evidence = returned.data.content[1]
    if (evidence?.type !== 'text') throw new Error('Expected evidence text')
    expect(evidence.text).toContain('This does not state that the assistant used it')
    expect(JSON.parse(evidence.text.slice(evidence.text.indexOf('\n') + 1))).toMatchObject({
      kind: 'branch-result-artifact-evidence', branchSessionId: fixture.childSession.id, evidence: {
        kind: 'comparison', group: 'gravity', conditions: { runtimeVersion: 1, stepCount: 6, timeStep: 1 / 30, time: 0.2 },
        control: { artifact: { artifactId: control.artifactId, revision: 1, spec }, checkpoint: { stepCount: 6 }, values: { time: 0.2 } },
        variant: { artifact: { artifactId: variant.artifactId, revision: 1, spec: { gravity: { y: -4 } } } },
      },
    })
    expect(evidence.text).not.toContain('Independent parent experiment')
    expect(JSON.stringify(returned)).not.toContain('Private reasoning')
    expect(returned.sourceEventSeqs).toBeUndefined()
    for (const agent of [fixture.parent, fixture.child]) {
      expect(agent.steer).not.toHaveBeenCalled()
      expect(agent.inject).not.toHaveBeenCalled()
    }
    expect(fixture.resolveAgent).toHaveBeenCalledExactlyOnceWith(fixture.parentSession.id)
  })

  it('returns one saved observation and keeps identical retries stable after child progress and service recreation', async () => {
    const first = await setup()
    savePair(first)
    const resultSeq = conclusion(first.childSession)
    const selected: ArtifactBranchResultRequest = { ...request(first, resultSeq), evidence: { kind: 'observation', observation: control } }
    const initial = await first.service.returnResult(selected)
    first.childSession.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Later work must not affect the frozen return' }] }), { surfaceOp: 'append' })
    expect(await first.service.returnResult(selected)).toEqual(initial)
    const second = await setup({}, { parent: first.parentSession, child: first.childSession })
    expect(await second.service.returnResult(selected)).toEqual(initial)
    expect(second.parentSession.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'branch-result'))
      .toHaveLength(1)
  })

  it('rejects adding evidence to a conclusion already returned through plain admission', async () => {
    const fixture = await setup()
    savePair(fixture)
    const resultSeq = conclusion(fixture.childSession)
    await returnPlain(fixture, resultSeq)
    await expect(fixture.service.returnResult(request(fixture, resultSeq))).rejects.toMatchObject({ code: 'session/branch-result-conflict' })
    expect(fixture.parentSession.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'branch-result'))
      .toHaveLength(1)
  })

  it('rejects replacing evidence and allows retrying the original request', async () => {
    const fixture = await setup()
    savePair(fixture)
    const resultSeq = conclusion(fixture.childSession)
    const selected = request(fixture, resultSeq)
    const initial = await fixture.service.returnResult(selected)
    await expect(fixture.service.returnResult({ ...selected, evidence: { kind: 'observation', observation: control } }))
      .rejects.toMatchObject({ code: 'session/branch-result-conflict' })
    await expect(returnPlain(fixture, resultSeq)).rejects.toThrow('different content')
    expect(await fixture.service.returnResult(selected)).toEqual(initial)
  })

  it('preserves an unknown flush outcome after append and recovers the original receipt', async () => {
    const fixture = await setup()
    savePair(fixture)
    const selected = request(fixture, conclusion(fixture.childSession))
    const failure = new Error('Acknowledgement lost after append')
    const flush = vi.spyOn(fixture.ctx.sessions, 'flush').mockRejectedValueOnce(failure)
    await expect(fixture.service.returnResult(selected)).rejects.toBe(failure)
    const returned = fixture.parentSession.snapshotEvents().at(-1)
    const response = await fixture.service.returnResult(selected)
    expect(response.eventSeq).toBe(returned?.seq)
    expect(flush).toHaveBeenCalledTimes(2)
    expect(fixture.parentSession.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'branch-result'))
      .toHaveLength(1)
  })

  it('reports busy before starting a parent transaction', async () => {
    const fixture = await setup()
    savePair(fixture)
    const selected = request(fixture, conclusion(fixture.childSession))
    fixture.parent.setBusy(true)
    await expect(fixture.service.returnResult(selected)).rejects.toMatchObject({ code: 'session/agent-busy' })
    expect(fixture.parentSession.snapshotEvents()).toHaveLength(1)
  })

  it('rejects evidence available only in the parent after the fork and incompatible fixed conditions', async () => {
    const fixture = await setup()
    savePair(fixture, { ...spec, timeStep: 1 / 60 })
    const selected = request(fixture, conclusion(fixture.childSession))
    await expect(fixture.service.returnResult(selected)).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable',
      details: { reason: 'TIME_STEP_MISMATCH' } })
    fixture.ctx.artifacts.commit(fixture.parent.agent, fixture.ctx.artifacts.prepare(fixture.parent.agent, {
      action: 'create', artifactId: control.artifactId, title: 'Parent-only observation', presentation: 'inline', format: 'scene', spec,
    }))
    fixture.ctx.artifacts.saveObservation(fixture.parent.agent, control.artifactId, 1,
      'parent-only' as ArtifactObservationId, 'Saved after the fork', { runtimeVersion: 1, stepCount: 6 })
    await expect(fixture.service.returnResult({ ...selected,
      evidence: { kind: 'observation', observation: { ...control, observationId: 'parent-only' as ArtifactObservationId } },
    })).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable', details: { reason: 'OBSERVATION_NOT_FOUND' } })
    expect(fixture.resolveAgent).not.toHaveBeenCalled()
  })

  it('accepts saved evidence inherited in the selected branch prefix', async () => {
    const fixture = await setup()
    fixture.ctx.artifacts.commit(fixture.parent.agent, fixture.ctx.artifacts.prepare(fixture.parent.agent, {
      action: 'create', artifactId: control.artifactId, title: 'Inherited experiment', presentation: 'inline', format: 'scene', spec,
    }))
    fixture.ctx.artifacts.saveObservation(fixture.parent.agent, control.artifactId, 1, control.observationId,
      'Saved before the fork', { runtimeVersion: 1, stepCount: 6 })
    const inherited = fixture.ctx.sessions.create(SessionId('inheriting-child'), {
      seed: fixture.parentSession.snapshotEvents(),
      meta: { isSeeded: true, parentSession: fixture.parentSession.id },
      inheritedEventCount: SessionLogOffset(fixture.parentSession.seq),
    })
    const response = await fixture.service.returnResult({ ...request(fixture, conclusion(inherited)), branchSessionId: inherited.id,
      evidence: { kind: 'observation', observation: control } })
    expect(response.parentSessionId).toBe(fixture.parentSession.id)
    expect(JSON.stringify(fixture.parentSession.snapshotEvents().at(-1))).toContain('Saved before the fork')
  })

  it('rejects the wrong parent, inherited conclusions and missing child Sessions before activation', async () => {
    const fixture = await setup()
    savePair(fixture)
    const selected = request(fixture, conclusion(fixture.childSession))
    await expect(fixture.service.returnResult({ ...selected, sessionId: SessionId('other-parent') }))
      .rejects.toMatchObject({ code: 'session/branch-result-unavailable', details: { reason: 'wrong-parent' } })
    await expect(fixture.service.returnResult({ ...selected, resultSeq: 0 }))
      .rejects.toMatchObject({ code: 'session/branch-result-unavailable', details: { reason: 'inherited-result' } })
    await expect(fixture.service.returnResult({ ...selected, branchSessionId: SessionId('missing') }))
      .rejects.toMatchObject({ code: 'session/not-found' })
    expect(fixture.resolveAgent).not.toHaveBeenCalled()
  })

  it('bounds the complete parent message before append with a typed terminal error', async () => {
    const fixture = await setup({ maxActionBytes: 1 })
    savePair(fixture)
    let failure: unknown
    try { await fixture.service.returnResult(request(fixture, conclusion(fixture.childSession))) } catch (error) { failure = error }
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'artifact-branch/result-too-large', details: { limit: 1 } })
    expect(fixture.parentSession.snapshotEvents()).toHaveLength(1)
  })

  it('withdraws the optional Host capability when its plugin is disposed', async () => {
    const fixture = await setup()
    expect(fixture.ctx.get('artifactBranchResults')).toBeDefined()
    await fixture.fiber.dispose()
    expect(fixture.ctx.get('artifactBranchResults')).toBeUndefined()
    expect(fixture.ctx.get('artifacts')).toBeDefined()
  })
})
