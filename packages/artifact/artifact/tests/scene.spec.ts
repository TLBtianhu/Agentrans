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
    if (snapshot.format === 'scene') expect(snapshot.spec.functions.map(fn => fn.label)).toEqual(['sin(x)', 'a*x^2/4'])
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
})
