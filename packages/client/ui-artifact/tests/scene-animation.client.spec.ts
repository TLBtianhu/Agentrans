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
    expect(html).toContain('spec = {"kind":"function-plot"')
    expect(html).not.toContain('<script src=')
  })
})
