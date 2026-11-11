// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@agentrans/client-test-runtime'
import { ArtifactCard } from './runtime-harness.tsx'
import { createParticleRun, updateParticleRun } from '../src/client/particle-run.ts'
import { en } from '../src/client/locales.ts'
import type { ParticleSystemSpec } from '@agentrans/artifact/scene'
import type { SceneArtifactSnapshot } from '@agentrans/artifact/types'
import * as particleRuntime from '@agentrans/artifact/particle-runtime'
import type { ArtifactId, ArtifactPlacement, ArtifactExportCommands, RecordArtifactAction } from '../src/client/protocol.ts'

const t = makeTranslate(en)

const spec: ParticleSystemSpec = {
  kind: 'particle-system',
  particles: [{ id: 'p1', x: 0, y: 10, vx: 1, vy: 0, mass: 2 }],
  gravity: { x: 0, y: -9.8 },
  timeStep: 0.02,
  trails: true,
  timeline: { duration: 6, fps: 30 },
}

function surface(options: {
  readonly revision?: number
  readonly source?: ParticleSystemSpec
  readonly placement?: ArtifactPlacement
  readonly activeDockId?: ArtifactId | null
  readonly recordAction?: RecordArtifactAction
  readonly exportCommands?: ArtifactExportCommands
} = {}) {
  const snapshot: SceneArtifactSnapshot = {
    artifactId: 'particles' as ArtifactId, revision: options.revision ?? 1,
    format: 'scene', title: 'Particle experiment', presentation: 'inline', spec: options.source ?? spec,
  }
  return <ArtifactCard snapshot={snapshot} origin={{ kind: 'current' }} placement={options.placement ?? 'inline'}
    {...options.activeDockId === undefined ? {} : { activeDockId: options.activeDockId }}
    recordAction={options.recordAction ?? vi.fn()} t={t}
    exportControls={options.exportCommands === undefined ? undefined : { ...options.exportCommands, ready: true, records: [] }} />
}

function stepCount(): number {
  const workspace = screen.getByRole('img', { name: en['scene.particleSystem'] }).closest<HTMLElement>('[data-particle-step]')
  if (workspace === null) throw new Error('Particle workspace is missing')
  return Number(workspace.dataset.particleStep)
}

beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('revision-owned particle runtime', () => {
  it('renders the initial time and confirms the same fixed-step values shown by the preview', () => {
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    render(surface({ recordAction }))
    const readout = screen.getAllByRole('status')[0]!
    expect(readout.textContent).toContain('0.00')
    expect(readout.textContent).toContain('-9.80')
    fireEvent.click(screen.getByRole('button', { name: 'Step' }))
    expect(stepCount()).toBe(1)
    expect(readout.textContent).toContain('0.02')
    expect(recordAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm analysis' }))
    expect(recordAction).toHaveBeenCalledWith('particles', 1, 'physics.inspected', {
      time: 0.02, particles: [{ id: 'p1', x: 0.02, y: 10, vx: 1, vy: -0.196 }],
    }, true, expect.any(String))
  })

  it('pauses while viewing source and restores the same state without silently resuming', () => {
    vi.useFakeTimers()
    const recordAction = vi.fn<RecordArtifactAction>()
    render(surface({ recordAction }))
    fireEvent.click(screen.getByRole('button', { name: 'Play sweep' }))
    act(() => { vi.advanceTimersByTime(60) })
    expect(stepCount()).toBe(3)
    fireEvent.click(screen.getByRole('button', { name: 'View source' }))
    expect(screen.queryByRole('img', { name: en['scene.particleSystem'] })).toBeNull()
    act(() => { vi.advanceTimersByTime(200) })
    fireEvent.click(screen.getByRole('button', { name: 'Show preview' }))
    expect(stepCount()).toBe(3)
    expect(screen.getByRole('button', { name: 'Play sweep' }).getAttribute('aria-pressed')).toBe('false')
    act(() => { vi.advanceTimersByTime(200) })
    expect(stepCount()).toBe(3)
    expect(recordAction).not.toHaveBeenCalled()
  })

  it('retains the current run when the preview moves between flow and portal surfaces', () => {
    const view = render(surface())
    fireEvent.click(screen.getByRole('button', { name: 'Step' }))
    fireEvent.click(screen.getByRole('button', { name: 'Step' }))
    for (const placement of ['focus', 'pip', 'inline'] as const) {
      view.rerender(surface({ placement }))
      expect(stepCount()).toBe(2)
      expect(screen.getByLabelText('Artifact: Particle experiment').getAttribute('data-placement')).toBe(placement)
    }
  })

  it('pauses a background dock and keeps its state when selected again', () => {
    vi.useFakeTimers()
    const view = render(surface({ placement: 'beside', activeDockId: 'particles' as ArtifactId }))
    fireEvent.click(screen.getByRole('button', { name: 'Play sweep' }))
    act(() => { vi.advanceTimersByTime(40) })
    expect(stepCount()).toBe(2)
    view.rerender(surface({ placement: 'beside', activeDockId: 'another' as ArtifactId }))
    act(() => { vi.advanceTimersByTime(200) })
    view.rerender(surface({ placement: 'beside', activeDockId: 'particles' as ArtifactId }))
    expect(stepCount()).toBe(2)
    expect(screen.getByRole('button', { name: 'Play sweep' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('starts a fresh paused run for a new source revision', () => {
    const recordAction = vi.fn<RecordArtifactAction>()
    const view = render(surface({ recordAction }))
    fireEvent.click(screen.getByRole('button', { name: 'Step' }))
    view.rerender(surface({ revision: 2, recordAction, source: {
      ...spec, particles: [{ ...spec.particles[0]!, x: 5 }],
    } }))
    expect(stepCount()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm analysis' }))
    expect(recordAction).toHaveBeenCalledWith('particles', 2, 'physics.inspected', {
      time: 0, particles: [{ id: 'p1', x: 5, y: 10, vx: 1, vy: 0 }],
    }, true, expect.any(String))
  })

  it('releases playback timers when the card is removed and does not retain a run across removals', () => {
    vi.useFakeTimers()
    const before = vi.getTimerCount()
    const view = render(surface())
    fireEvent.click(screen.getByRole('button', { name: 'Play sweep' }))
    act(() => { vi.advanceTimersByTime(40) })
    expect(stepCount()).toBe(2)
    view.unmount()
    expect(vi.getTimerCount()).toBe(before)
    render(surface())
    expect(stepCount()).toBe(0)
    expect(screen.getByRole('button', { name: 'Play sweep' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('exports the current fixed step rather than restarting from source defaults', async () => {
    const create = vi.fn<ArtifactExportCommands['create']>(async request => ({
      request, frozen: { sessionId: 'particle-session' as never,
        artifact: { artifactId: 'particles' as ArtifactId, revision: 1, format: 'scene', title: 'Particle experiment',
          presentation: 'inline', spec }, checkpoint: { runtimeVersion: 1, stepCount: 2 },
        exporterVersion: 1, parameters: 'particle-checkpoint' },
      status: 'ready', file: { attachmentId: 'sha256:abc' as never, name: 'particles.html', bytes: 32 },
    }))
    const download = vi.fn<ArtifactExportCommands['download']>().mockResolvedValue({ status: 'requested' })
    render(surface({ exportCommands: { create, download } }))
    fireEvent.click(screen.getByRole('button', { name: 'Step' }))
    fireEvent.click(screen.getByRole('button', { name: 'Step' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export animation' }))
    await waitFor(() => { expect(download).toHaveBeenCalledOnce() })
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]?.[0].source).toEqual({ kind: 'current', artifactId: 'particles', revision: 1,
      checkpoint: { runtimeVersion: 1, stepCount: 2 } })
  })

  it('retains the last finite state on numeric failure and recovers through Reset', () => {
    vi.useFakeTimers()
    const source = { ...spec, timeStep: 2, particles: [{ ...spec.particles[0]!, vx: 1e308 }] }
    render(surface({ source }))
    fireEvent.click(screen.getByRole('button', { name: 'Play sweep' }))
    act(() => { vi.advanceTimersByTime(2000) })
    expect(stepCount()).toBe(0)
    expect(screen.getByRole('alert').textContent).toBe(en['scene.particleFailed'])
    expect(screen.getByRole('button', { name: 'Step' }).hasAttribute('disabled')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Step' }).hasAttribute('disabled')).toBe(false)
    expect(stepCount()).toBe(0)
  })

  it('does not turn unexpected programming errors into numeric failures', () => {
    const error = new Error('Unexpected computation defect')
    vi.spyOn(particleRuntime, 'stepParticleState').mockImplementation(() => { throw error })
    expect(() => updateParticleRun(spec, createParticleRun(spec), 'step')).toThrow(error)
  })
})
