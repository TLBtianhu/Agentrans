// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@agentrans/client-test-runtime'
import type { SceneSpec } from '@agentrans/artifact/scene'
import type { ArtifactId } from '@agentrans/artifact/types'
import { createParticleState } from '@agentrans/artifact/particle-runtime'
import { SceneNodeView } from '../src/client/SceneNodeView.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)
const nodes = [{ id: 'a', label: 'Start', x: 0, y: 0 }, { id: 'b', label: 'End', x: 1, y: 0 }]
const timeline = { duration: 6, fps: 30 }
const scenes: readonly SceneSpec[] = [
  { kind: 'function-plot', functions: [{ id: 'f', label: 'x', expression: 'x' }],
    parameters: {}, viewport: { x: [0, 12], y: [-10, 10] }, trace: { x: 1, derivative: false, integral: false }, timeline },
  { kind: 'flowchart', nodes, edges: [{ from: 'a', to: 'b' }], path: ['a', 'b'], timeline },
  { kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 1, vx: 1, vy: 0, mass: 1 }],
    gravity: { x: 0, y: -1 }, timeStep: 1 / 30, trails: false },
  { kind: 'timeline', events: [{ id: 'a', label: 'Start', time: 0 }, { id: 'b', label: 'End', time: 1 }], playhead: 0, timeline },
  { kind: 'network-graph', nodes, edges: [{ from: 'a', to: 'b' }], timeline },
  { kind: 'map', markers: nodes, path: ['a', 'b'], timeline },
]

beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each(scenes)('keeps $kind local controls available when the Host route cannot record actions', async (spec) => {
  const recordAction = vi.fn().mockResolvedValue(undefined)
  const onStateChange = vi.fn()
  const onCommand = vi.fn()
  render(<SceneNodeView spec={spec} artifactId={'local' as ArtifactId} revision={1} placement="inline"
    recordAction={recordAction} canRecord={false} onStateChange={onStateChange}
    particleRun={spec.kind === 'particle-system' ? { state: createParticleState(spec), playing: false, failed: false } : null}
    onParticleCommand={onCommand} t={t} />)
  expect(screen.queryByRole('button', { name: t('scene.confirm') })).toBeNull()
  const before = onStateChange.mock.calls.length
  const name = spec.kind === 'function-plot' ? t('scene.derivative')
    : spec.kind === 'particle-system' ? t('scene.step') : t('scene.next')
  const control = screen.getByRole('button', { name })
  expect(control.hasAttribute('disabled')).toBe(false)
  fireEvent.click(control)
  if (spec.kind === 'particle-system') expect(onCommand).toHaveBeenCalledWith('step')
  else if (spec.kind === 'function-plot') {
    expect(control.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: t('scene.exportVideo') })).toBeTruthy()
  } else await waitFor(() => { expect(onStateChange.mock.calls.length).toBeGreaterThan(before) })
  expect(recordAction).not.toHaveBeenCalled()
})
