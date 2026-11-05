// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ParticleSystemView } from '../src/client/ParticleSystemView.tsx'
import { en } from '../src/client/locales.ts'
import type { ParticleSystemSpec } from '@deepseek-ai/dsh-artifact/scene'
import type { ArtifactId, RecordArtifactAction } from '../src/client/protocol.ts'

const t = makeTranslate(en)

const spec: ParticleSystemSpec = {
  kind: 'particle-system',
  particles: [{ id: 'p1', x: 0, y: 10, vx: 1, vy: 0, mass: 2 }],
  gravity: { x: 0, y: -9.8 },
  timeStep: 0.02,
  trails: true,
  timeline: { duration: 6, fps: 30 },
}

describe('ParticleSystemView', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('renders the initial time and particle count', () => {
    render(<ParticleSystemView spec={spec} artifactId={'a' as ArtifactId} revision={1} placement="inline" recordAction={vi.fn()} t={t} />)
    const readout = screen.getAllByRole('status')[0]!
    expect(readout.textContent).toContain('0.00')
    expect(readout.textContent).toContain('1')
    expect(readout.textContent).toContain('-9.80')
  })

  it('advances the simulation by one step and confirms the inspected state', async () => {
    const recordAction = vi.fn<RecordArtifactAction>().mockResolvedValue(undefined)
    render(<ParticleSystemView spec={spec} artifactId={'a' as ArtifactId} revision={1} placement="inline" recordAction={recordAction} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Step' }))
    expect(screen.getAllByRole('status')[0]!.textContent).toContain('0.02')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm analysis' }))
    await waitFor(() => {
      expect(recordAction).toHaveBeenCalledWith('a', 1, 'physics.inspected', expect.objectContaining({ time: 0.02 }), true)
    })
  })
})
