// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@agentrans/client-test-runtime'
import type { ArtifactId, SceneArtifactSnapshot } from '@agentrans/artifact/types'
import type { ParticleSystemSpec } from '@agentrans/artifact/scene'
import { restoreParticleCheckpoint, observeParticleState } from '@agentrans/artifact/particle-runtime'
import { SCENE_PALETTE_TOKENS } from '@agentrans/artifact/scene-renderers'
import { ArtifactQuestionReplay } from '../src/client/ArtifactQuestionReplay.tsx'
import * as plotRenderer from '../src/client/renderers/function-plot.ts'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)

function replaySnapshot(spec: SceneArtifactSnapshot['spec']): SceneArtifactSnapshot {
  return { artifactId: 'experiment' as ArtifactId, title: 'Experiment', revision: 3, format: 'scene', presentation: 'inline', spec }
}

function useCanvasStub(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const style = document.createElement('style')
  style.setAttribute('data-test-scene-palette', '')
  style.textContent = `canvas { ${Object.values(SCENE_PALETTE_TOKENS).map(token => `${token}: #fff`).join(';')} }`
  document.head.append(style)
}

afterEach(() => {
  cleanup()
  document.querySelector('[data-test-scene-palette]')?.remove()
  vi.restoreAllMocks()
})

it('draws the second function at the recorded parameter and trace, with the stored readings', () => {
  useCanvasStub()
  const draw = vi.spyOn(plotRenderer, 'renderFunctionPlot')
  const snapshot = replaySnapshot({
    kind: 'function-plot',
    functions: [{ id: 'linear', label: 'Linear', expression: 'x' }, { id: 'quadratic', label: 'Quadratic', expression: 'a*x^2' }],
    parameters: { a: { min: 0, max: 4, step: 0.125, value: 1 } },
    trace: { x: 1, derivative: true, integral: true }, viewport: { x: [-2, 2], y: [-1, 30] },
  })
  const x = 3.25
  const a = 2.125
  const values = { value: 22.4453125, derivative: 13.81250000001, integral: 24.31575520833 }
  const view = render(<ArtifactQuestionReplay snapshot={snapshot} t={t}
    replay={{ kind: 'function-plot', functionId: 'quadratic', x, parameters: { a }, values }} />)

  const canvas = screen.getByRole('img', { name: en['scene.historyCanvas'] })
  expect(draw).toHaveBeenLastCalledWith(snapshot.spec, canvas, Number(canvas.getAttribute('width')), Number(canvas.getAttribute('height')),
    expect.objectContaining({ traceX: x, pan: x, parameters: { a }, currentFunctionId: 'quadratic' }), expect.any(Object))
  expect(screen.getByText('Quadratic').getAttribute('aria-current')).toBe('true')
  expect(screen.getByText('Linear').hasAttribute('aria-current')).toBe(false)
  expect(view.container.querySelector('[data-function-source-parameter="a"]')?.textContent).toBe(String(a))
  for (const [key, value] of Object.entries({ x, ...values })) {
    expect(view.container.querySelector(`[data-function-source-value="${key}"]`)?.textContent).toBe(String(value))
  }
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('slider')).toBeNull()
})

it('restores a paused checkpoint only when the restored particle readings match the recorded readings', () => {
  useCanvasStub()
  const spec: ParticleSystemSpec = {
    kind: 'particle-system', particles: [{ id: 'p1', x: 1, y: 3, vx: 2, vy: 0, mass: 1 }],
    gravity: { x: 0, y: -1 }, timeStep: 0.125, trails: true,
  }
  const snapshot = replaySnapshot(spec)
  const checkpoint = { runtimeVersion: 1, stepCount: 3 } as const
  const values = observeParticleState(restoreParticleCheckpoint(spec, checkpoint))
  const view = render(<ArtifactQuestionReplay snapshot={snapshot} t={t} replay={{ kind: 'particle-system', checkpoint, values }} />)

  const canvas = screen.getByRole('img', { name: en['scene.particleSystem'] })
  expect(canvas.getAttribute('width')).toBe('900')
  expect(canvas.getAttribute('height')).toBe('420')
  expect(canvas.closest('[data-particle-step]')?.getAttribute('data-particle-step')).toBe('3')
  expect(view.container.querySelector('[data-particle-source-time]')?.textContent).toBe('0.375')
  expect(view.container.querySelector('[data-particle-live-coordinate="x"]')?.textContent).toBe('1.75')
  expect(screen.queryByRole('button')).toBeNull()

  view.rerender(<ArtifactQuestionReplay snapshot={snapshot} t={t}
    replay={{ kind: 'particle-system', checkpoint, values: { ...values, time: 0.5 } }} />)
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.getByRole('alert').textContent).toBe(en['runtime.failed'])
})
