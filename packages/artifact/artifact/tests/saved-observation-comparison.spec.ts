import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import ArtifactService, { type Config } from '../src/index.ts'
import type { ParticleSystemSpec } from '../src/scene.ts'
import type { ArtifactId, ArtifactObservationId, SavedParticleObservationRef } from '../src/types.ts'

const contexts: Context[] = []
let sequence = 0
const group = 'gravity'
const controlRef: SavedParticleObservationRef = { artifactId: 'control' as ArtifactId, observationId: 'six' as ArtifactObservationId }
const variantRef: SavedParticleObservationRef = { artifactId: 'variant' as ArtifactId, observationId: 'six' as ArtifactObservationId }
const spec: ParticleSystemSpec = {
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
  await ctx.plugin(ArtifactService, config)
  const id = SessionId(`observation-comparison-${++sequence}`)
  const session = ctx.sessions.create(id, {
    ...(seed === undefined ? {} : { seed }),
    ...(inherited ? { meta: { isSeeded: true, parentSession: SessionId('comparison-parent') },
      inheritedEventCount: SessionLogOffset(seed?.length ?? 0) } : {}),
  })
  // Actual inbox admission commits this durable splice before its caller receives an acknowledgement.
  const admit = (message: UserMessage): void => {
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
  }
  const steer = vi.fn(admit)
  const inject = vi.fn(admit)
  const agent = {
    id, session, ctx, steer: (message: UserMessage): void => { steer(message) },
    inject: (message: UserMessage): void => { inject(message) },
  } as Agent
  ctx.agents.enter(agent, undefined)
  return { ctx, agent, session, service: ctx.artifacts, steer, inject }
}

function savePair(fixture: Awaited<ReturnType<typeof setup>>, variantSpec = spec, variantStep = 6, variantGroup = group) {
  const { service, agent } = fixture
  for (const [role, ref, source, savedGroup] of [
    ['control', controlRef, spec, group], ['variant', variantRef, variantSpec, variantGroup],
  ] as const) {
    service.commit(agent, service.prepare(agent, {
      action: 'create', artifactId: ref.artifactId, title: role, presentation: 'inline', format: 'scene', spec: source,
      comparison: { group: savedGroup, role },
    }))
    service.saveObservation(agent, ref.artifactId, 1, ref.observationId, role, {
      runtimeVersion: 1, stepCount: role === 'control' ? 6 : variantStep,
    })
  }
}

function confirm(fixture: Awaited<ReturnType<typeof setup>>, wake = true) {
  return fixture.service.confirmObservationComparison(fixture.agent, group, controlRef, variantRef, wake)
}

describe('saved observation comparison admission', () => {
  it('keeps saves silent and confirms fixed older revisions using only saved references', async () => {
    const fixture = await setup()
    const changed = vi.fn()
    fixture.ctx.sessionProjections.onChanged(changed)
    savePair(fixture, { ...spec, gravity: { x: 0, y: -4 } })
    expect(fixture.steer).not.toHaveBeenCalled()
    expect(fixture.inject).not.toHaveBeenCalled()
    for (const ref of [controlRef, variantRef]) {
      fixture.service.commit(fixture.agent, fixture.service.prepare(fixture.agent, {
        action: 'update', artifactId: ref.artifactId, baseRevision: 1, title: 'New unrelated source', presentation: 'inline',
        format: 'html', source: '<p>Changed source and group</p>', comparison: { group: 'new-group', role: 'variant' },
      }))
    }
    const before = fixture.ctx.sessionProjections.snapshot(fixture.session).values.artifactObservations
    changed.mockClear()
    const result = confirm(fixture, false)
    expect(result).toMatchObject({ accepted: true, comparison: {
      group, conditions: { runtimeVersion: 1, stepCount: 6, timeStep: 1 / 30, time: 0.2 },
      control: { ref: controlRef, revision: 1 }, variant: { ref: variantRef, revision: 1 },
    } })
    expect(fixture.inject).toHaveBeenCalledOnce()
    expect(fixture.steer).not.toHaveBeenCalled()
    const message = fixture.inject.mock.calls[0]?.[0]
    expect(message?.source).toEqual({ kind: 'artifact-action', artifactId: controlRef.artifactId, revision: 1 })
    const text = message?.content[0]
    if (text?.type !== 'text') throw new Error('Expected comparison input')
    expect(JSON.parse(text.text)).toEqual({ kind: 'artifact_action', artifactId: controlRef.artifactId, revision: 1,
      action: 'comparison.completed', payload: result.comparison })
    expect(fixture.ctx.sessionProjections.snapshot(fixture.session).values.artifactObservations).toEqual(before)
    expect(changed).not.toHaveBeenCalled()
    expect(fixture.session.snapshotEvents().filter(event => event.type === 'artifact/observations')).toHaveLength(2)
  })

  it.each([
    ['TIME_STEP_MISMATCH', { ...spec, timeStep: 1 / 60 }, 6, group],
    ['STEP_COUNT_MISMATCH', spec, 7, group],
    ['GROUP_MISMATCH', spec, 6, 'other-group'],
  ] as const)('rejects incompatible observations with a structured %s reason', async (reason, source, step, savedGroup) => {
    const fixture = await setup()
    savePair(fixture, source, step, savedGroup)
    let failure: unknown
    try { confirm(fixture) } catch (error) { failure = error }
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'artifact/comparison-rejected', details: { reason } })
    expect(fixture.steer).not.toHaveBeenCalled()
    expect(fixture.inject).not.toHaveBeenCalled()
  })

  it('rejects an unknown reference and a swapped role without routing input', async () => {
    const fixture = await setup()
    savePair(fixture)
    expect(() => fixture.service.confirmObservationComparison(fixture.agent, group, controlRef,
      { ...variantRef, observationId: 'missing' as ArtifactObservationId }, true))
      .toThrow(expect.objectContaining({ code: 'artifact/comparison-rejected', details: { reason: 'OBSERVATION_NOT_FOUND' } }))
    expect(() => fixture.service.confirmObservationComparison(fixture.agent, group, variantRef, controlRef, true))
      .toThrow(expect.objectContaining({ code: 'artifact/comparison-rejected', details: { reason: 'ROLE_MISMATCH' } }))
    expect(fixture.steer).not.toHaveBeenCalled()
  })

  it('deduplicates queued admission after a lost response and a fresh service lifecycle', async () => {
    const first = await setup()
    savePair(first)
    first.steer.mockImplementationOnce((message) => {
      first.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
      throw new Error('Response lost after admission')
    })
    expect(() => confirm(first)).toThrow('Response lost')
    const expected = confirm(first)
    expect(first.steer).toHaveBeenCalledOnce()
    const second = await setup({}, JSON.parse(JSON.stringify(first.session.snapshotEvents())) as SessionEvent[])
    expect(confirm(second, false)).toEqual(expected)
    expect(second.steer).not.toHaveBeenCalled()
    expect(second.inject).not.toHaveBeenCalled()
  })

  it('recognizes consumed input with reordered fields and JSON-equivalent signed zero', async () => {
    const first = await setup()
    savePair(first)
    first.steer.mockImplementationOnce((message) => {
      const content = message.content[0]
      if (content?.type !== 'text') throw new Error('Expected comparison text')
      const reverse = (value: unknown): unknown => {
        if (typeof value === 'number' && value === 0) return -0
        if (Array.isArray(value)) return value.map(reverse)
        if (value !== null && typeof value === 'object') {
          return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)]))
        }
        return value
      }
      const reordered = {
        ...message, content: [{ type: 'text' as const, text: JSON.stringify(reverse(JSON.parse(content.text))) }],
      }
      first.session.append('user/message', reordered, { surfaceOp: 'append' })
    })
    confirm(first)
    const second = await setup({}, first.session.snapshotEvents())
    confirm(second)
    expect(second.steer).not.toHaveBeenCalled()
  })

  it.each(['conditions', 'variant-values', 'source-revision'] as const)(
    'does not treat a mismatched %s as a comparison receipt', async (part) => {
      const first = await setup()
      savePair(first)
      const { comparison } = confirm(first)
      const original = first.steer.mock.calls[0]?.[0]
      if (original === undefined) throw new Error('Expected comparison admission')
      const payload = part === 'conditions'
        ? { ...comparison, conditions: { ...comparison.conditions, time: 99 } }
        : part === 'variant-values' ? { ...comparison, variant: {
          ...comparison.variant, values: { ...comparison.variant.values, particles: [] },
        } } : comparison
      const message: UserMessage = {
        ...original,
        source: { kind: 'artifact-action', artifactId: controlRef.artifactId, revision: part === 'source-revision' ? 2 : 1 },
        content: [{ type: 'text', text: JSON.stringify({ kind: 'artifact_action', artifactId: controlRef.artifactId,
          revision: part === 'source-revision' ? 2 : 1, action: 'comparison.completed', payload }) }],
      }
      const events = first.session.snapshotEvents().map(event => event.type === 'agent/inbox/spliced'
        ? { ...event, data: { ...event.data, inserted: [message] } } : event)
      const second = await setup({}, events)
      confirm(second)
      expect(second.steer).toHaveBeenCalledOnce()
    },
  )

  it('admits a different fixed pair in the same group independently', async () => {
    const fixture = await setup()
    savePair(fixture)
    confirm(fixture)
    const otherRef = { ...variantRef, observationId: 'other-six' as ArtifactObservationId }
    fixture.service.saveObservation(fixture.agent, otherRef.artifactId, 1, otherRef.observationId,
      'Another fixed observation', { runtimeVersion: 1, stepCount: 6 })
    fixture.service.confirmObservationComparison(fixture.agent, group, controlRef, otherRef, true)
    confirm(fixture)
    expect(fixture.steer).toHaveBeenCalledTimes(2)
  })

  it('does not inherit a parent confirmation and isolates unrelated Sessions', async () => {
    const parent = await setup()
    savePair(parent)
    confirm(parent)
    const child = await setup({}, parent.session.snapshotEvents(), true)
    confirm(child, false)
    confirm(child, false)
    expect(child.inject).toHaveBeenCalledOnce()
    const unrelated = await setup()
    expect(() => confirm(unrelated)).toThrow(expect.objectContaining({ details: { reason: 'OBSERVATION_NOT_FOUND' } }))
  })

  it('matches cached suffix recovery with full replay and rebuilds an older state version', async () => {
    const fixture = await setup()
    savePair(fixture)
    const rows = fixture.ctx.sessionProjections.checkpoint(fixture.session)
    const offset = fixture.session.snapshotEvents().length
    confirm(fixture)
    const events = fixture.session.snapshotEvents()
    const suffix = fixture.ctx.sessionProjections.restore(rows, events.slice(offset), SessionLogOffset(offset),
      fixture.session.header, fixture.session.inheritedEventCount)
    const full = fixture.ctx.sessionProjections.restore({}, events, SessionLogOffset(0),
      fixture.session.header, fixture.session.inheritedEventCount)
    expect(suffix.checkpoint).toEqual(full.checkpoint)
    expect(suffix.snapshot).toEqual(full.snapshot)
    const committedRows = fixture.ctx.sessionProjections.checkpoint(fixture.session)
    const restored = fixture.ctx.sessionProjections.restore(committedRows, [], SessionLogOffset(events.length),
      fixture.session.header, fixture.session.inheritedEventCount)
    expect(restored.checkpoint).toEqual(full.checkpoint)
    const oldRows = Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, { ...row, ver: 1 }]))
    const invalid = fixture.ctx.sessionProjections.restore(oldRows, events, SessionLogOffset(0),
      fixture.session.header, fixture.session.inheritedEventCount)
    expect(invalid.snapshot).toEqual(full.snapshot)
  })

  it('rejects the complete oversized comparison and requires the exact live root', async () => {
    const fixture = await setup({ maxActionBytes: 1 })
    savePair(fixture)
    expect(() => confirm(fixture)).toThrow(expect.objectContaining({ code: 'artifact/comparison-rejected', details: { reason: 'ACTION_TOO_LARGE' } }))
    const unregistered = { ...fixture.agent } as Agent
    expect(() => fixture.service.confirmObservationComparison(unregistered, group, controlRef, variantRef, true))
      .toThrow(expect.objectContaining({ code: 'CALLER_NOT_LIVE_ROOT' }))
    expect(fixture.steer).not.toHaveBeenCalled()
    expect(fixture.inject).not.toHaveBeenCalled()
  })

})
