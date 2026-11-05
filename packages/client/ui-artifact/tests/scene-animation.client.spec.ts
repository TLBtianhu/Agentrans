// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildSceneAnimationHtml } from '../src/client/scene-animation.ts'
import type { FunctionPlotSpec } from '@deepseek-ai/dsh-artifact/scene'

const spec: FunctionPlotSpec = {
  kind: 'function-plot',
  functions: [{ id: 'sine', label: 'sin(x)', expression: 'sin(x)' }],
  parameters: { a: { value: 1, min: -2, max: 2, step: 0.1 } },
  viewport: { x: [-6, 6], y: [-2, 2] },
  trace: { x: 1, derivative: true, integral: false },
  timeline: { duration: 6, fps: 30 },
}

describe('scene animation export', () => {
  it('embeds the SceneSpec, the safe parser, and a timeline player', () => {
    const html = buildSceneAnimationHtml(spec, 'Damped oscillator')
    expect(html).toContain('SceneExpr.parseExpression')
    expect(html).toContain('Damped oscillator')
    expect(html).toContain('id="play"')
    expect(html).toContain('id="scrub"')
    expect(html).toContain('id="record"')
    expect(html).toContain('MediaRecorder')
    expect(html).toContain('spec = {"kind":"function-plot"')
    expect(html).not.toContain('<script src=')
  })

  it('exports a flowchart replay with path advancement', () => {
    const flowchart = {
      kind: 'flowchart' as const,
      nodes: [
        { id: 'a', label: 'Collect', x: 0, y: 0 },
        { id: 'b', label: 'Analyze', x: 1, y: 0 },
        { id: 'c', label: 'Decide', x: 2, y: 0 },
      ],
      edges: [{ from: 'a', to: 'b', label: 'data' }, { from: 'b', to: 'c', label: 'insight' }],
      path: ['a', 'b', 'c'],
    }
    const html = buildSceneAnimationHtml(flowchart, 'Inquiry flow')
    expect(html).toContain('"kind":"flowchart"')
    expect(html).toContain('scenePrimitives')
    expect(html).toContain('pathIndex')
    expect(html).toContain('id="record"')
  })

  it('exports a particle-system replay with deterministic physics', () => {
    const system = {
      kind: 'particle-system' as const,
      particles: [{ id: 'p1', x: 0, y: 10, vx: 1, vy: 0, mass: 2 }],
      gravity: { x: 0, y: -9.8 },
      timeStep: 0.02,
      trails: true,
    }
    const html = buildSceneAnimationHtml(system, 'Gravity lab')
    expect(html).toContain('"kind":"particle-system"')
    expect(html).toContain('scenePrimitives')
    expect(html).toContain('spec.timeStep')
    expect(html).toContain('isFlowchart || isParticleSystem ? [] : spec.functions.map')
    expect(html).toContain('id="record"')
  })
})
