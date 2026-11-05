import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ArtifactService from '../src/index.ts'
import { normalizeSceneSpec } from '../src/scene.ts'
import type { ArtifactPrepareInput } from '../src/types.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

function makeAgent(ctx: Context): Agent {
  const id = SessionId('scene-agent')
  return { id, session: Session.create(id), ctx } as Agent
}

import type { FunctionPlotSpec } from '../src/scene.ts'

const spec: FunctionPlotSpec = {
  kind: 'function-plot',
  functions: [
    { id: 'sine', label: 'sin(x)', expression: 'sin(x)' },
    { id: 'quadratic', label: 'a*x^2/4', expression: 'a*x^2/4' },
  ],
  parameters: { a: { value: 1, min: -2, max: 2, step: 0.1 } },
  viewport: { x: [-6, 6], y: [-2, 2] },
  trace: { x: 1, derivative: true, integral: false },
  timeline: { duration: 6, fps: 30 },
}

function input(overrides: Partial<ArtifactPrepareInput> = {}): ArtifactPrepareInput {
  return {
    action: 'create', artifactId: 'scene-demo', title: 'Scene demo', presentation: 'inline', format: 'scene', spec,
    ...overrides,
  }
}

describe('SceneSpec validation and persistence', () => {
  it('normalizes a valid function-plot spec and commits it as format scene', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ArtifactService)
    const agent = makeAgent(ctx)
    const snapshot = ctx.artifacts.prepare(agent, input())
    expect(snapshot.format).toBe('scene')
    if (snapshot.format === 'scene') expect(snapshot.spec.kind).toBe('function-plot')
    if (snapshot.format === 'scene' && snapshot.spec.kind === 'function-plot') expect(snapshot.spec.functions.map(fn => fn.label)).toEqual(['sin(x)', 'a*x^2/4'])
    ctx.artifacts.commit(agent, snapshot)
    const events = agent.session.snapshotEvents().filter(event => event.type === 'artifact/upsert')
    expect(events).toHaveLength(1)
    expect(events[0]?.data.format).toBe('scene')
  })

  it('rejects unsupported scene kinds, unsafe expressions, and invalid parameters', async () => {
    expect(() => normalizeSceneSpec({ ...spec, kind: 'unknown' })).toThrow('unsupported scene kind')
    expect(() => normalizeSceneSpec({ ...spec, functions: [{ id: 'bad', label: 'bad', expression: 'alert(1)' }] })).toThrow('Unknown function')
    expect(() => normalizeSceneSpec({ ...spec, parameters: { a: { value: 3, min: -2, max: 2, step: 0.1 } } })).toThrow('within [min,max]')
    expect(() => normalizeSceneSpec({ ...spec, trace: { x: 20, derivative: true, integral: false } })).toThrow('within viewport.x')
  })

  it('does not commit an invalid SceneSpec', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ArtifactService)
    const agent = makeAgent(ctx)
    expect(() => ctx.artifacts.prepare(agent, input({ spec: { ...spec, functions: [{ id: 'bad', label: 'bad', expression: 'alert(1)' }] } })))
      .toThrow(expect.objectContaining({ code: 'BAD_SCENE_SPEC' }))
    expect(agent.session.snapshotEvents().filter(event => event.type === 'artifact/upsert')).toHaveLength(0)
  })

  it('preserves comparison metadata on a SceneSpec snapshot', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ArtifactService)
    const agent = makeAgent(ctx)
    const snapshot = ctx.artifacts.prepare(agent, input({ comparison: { group: 'damping-study', role: 'control' } }))
    expect(snapshot.comparison).toEqual({ group: 'damping-study', role: 'control' })
  })

  it('normalizes a flowchart spec and rejects dangling references', async () => {
    const { normalizeSceneSpec } = await import('../src/scene.ts')
    const flowchart = {
      kind: 'flowchart',
      nodes: [
        { id: 'a', label: 'Collect', x: 0, y: 0 },
        { id: 'b', label: 'Analyze', x: 1, y: 0 },
      ],
      edges: [{ from: 'a', to: 'b', label: 'data' }],
      path: ['a', 'b'],
      style: 'transit-map',
    }
    const normalized = normalizeSceneSpec(flowchart)
    if (normalized.kind !== 'flowchart') throw new Error('expected a flowchart spec')
    expect(normalized.nodes.map(node => node.id)).toEqual(['a', 'b'])
    expect(normalized.path).toEqual(['a', 'b'])
    expect(normalized.style).toBe('transit-map')
    expect(() => normalizeSceneSpec({ ...flowchart, style: 'unknown-style' })).toThrow('must be editorial, transit-map, blueprint, math-proof-lecture, or particles')
    expect(() => normalizeSceneSpec({ ...flowchart, edges: [{ from: 'a', to: 'missing' }] })).toThrow('must reference an existing node')
    expect(() => normalizeSceneSpec({ ...flowchart, path: ['a', 'missing'] })).toThrow('must reference an existing node')
  })

  it('normalizes a particle-system spec and rejects invalid masses', async () => {
    const { normalizeSceneSpec } = await import('../src/scene.ts')
    const system = {
      kind: 'particle-system',
      particles: [{ id: 'p1', x: 0, y: 10, vx: 1, vy: 0, mass: 2 }],
      gravity: { x: 0, y: -9.8 },
      timeStep: 0.02,
      trails: true,
      style: 'particles',
    }
    const normalized = normalizeSceneSpec(system)
    if (normalized.kind !== 'particle-system') throw new Error('expected a particle-system spec')
    expect(normalized.particles.map(particle => particle.id)).toEqual(['p1'])
    expect(normalized.gravity).toEqual({ x: 0, y: -9.8 })
    expect(normalized.trails).toBe(true)
    expect(normalized.style).toBe('particles')
    expect(() => normalizeSceneSpec({ ...system, particles: [{ ...system.particles[0], mass: 0 }] })).toThrow('must be > 0')
    expect(() => normalizeSceneSpec({ ...system, style: 'unknown-style' })).toThrow('must be editorial, transit-map, blueprint, math-proof-lecture, or particles')
  })

  it('normalizes a timeline spec and rejects out-of-range playheads', async () => {
    const { normalizeSceneSpec } = await import('../src/scene.ts')
    const timeline = {
      kind: 'timeline',
      events: [
        { id: 'start', label: 'Start', time: 0 },
        { id: 'middle', label: 'Middle', time: 5 },
        { id: 'end', label: 'End', time: 10 },
      ],
      playhead: 5,
    }
    const normalized = normalizeSceneSpec(timeline)
    if (normalized.kind !== 'timeline') throw new Error('expected a timeline spec')
    expect(normalized.events.map(event => event.id)).toEqual(['start', 'middle', 'end'])
    expect(normalized.playhead).toBe(5)
    expect(() => normalizeSceneSpec({ ...timeline, playhead: 100 })).toThrow('must be within the event time range')
  })
})
