// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import {
  advanceParticleState, createParticleCheckpoint, createParticleState, observeParticleState,
} from '@deepseek-ai/dsh-artifact/particle-runtime'
import type { ArtifactId, ArtifactObservationId, SceneArtifactSnapshot, SavedParticleObservation } from '@deepseek-ai/dsh-artifact/types'
import { ArtifactCard } from './runtime-harness.tsx'
import { en } from '../src/client/locales.ts'
import { ArtifactObservationSaveError, type ArtifactExportCommands, type SaveArtifactObservation, type SendArtifactObservation } from '../src/client/protocol.ts'

const t = makeTranslate(en)
const snapshot: SceneArtifactSnapshot = {
  artifactId: 'saved-particles' as ArtifactId, revision: 1, format: 'scene', presentation: 'inline', title: 'Particle observations',
  spec: {
    kind: 'particle-system', particles: [{ id: 'alpha', x: 0, y: 1, vx: 3, vy: 8, mass: 1 }],
    gravity: { x: 0, y: -9.8 }, timeStep: 1 / 30, trails: true,
  },
}

function saved(label = 'A', steps = 6, source = snapshot): SavedParticleObservation {
  if (source.spec.kind !== 'particle-system') throw new Error('Expected particle source')
  const state = advanceParticleState(source.spec, createParticleState(source.spec), steps)
  return {
    observationId: `observation-${label}` as ArtifactObservationId, label, artifact: source,
    checkpoint: createParticleCheckpoint(state), values: observeParticleState(state),
  }
}

type CardProps = ComponentProps<typeof ArtifactCard>
function props(overrides: Partial<CardProps> = {}): CardProps {
  return {
    snapshot, origin: { kind: 'current' }, placement: 'inline', recordAction: vi.fn().mockResolvedValue(undefined), t,
    observationControls: {
      ready: true, observations: [], save: vi.fn<SaveArtifactObservation>().mockResolvedValue(saved()),
      send: vi.fn<SendArtifactObservation>().mockResolvedValue(undefined),
    },
    ...overrides,
  }
}

function currentStep(): string | null {
  return document.querySelector('[data-particle-step]')?.getAttribute('data-particle-step') ?? null
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('keeps projection readiness distinct from an empty saved list', () => {
  const p = props()
  const controls = p.observationControls!
  const view = render(<ArtifactCard {...p} observationControls={{ ...controls, ready: false }} />)
  expect(screen.getByText('Loading saved observations…')).toBeTruthy()
  expect(screen.queryByText('No saved observations yet.')).toBeNull()
  expect(screen.getByRole('button', { name: 'Save observation' }).hasAttribute('disabled')).toBe(true)
  view.rerender(<ArtifactCard {...p} />)
  expect(screen.getByText('No saved observations yet.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Save observation' }).hasAttribute('disabled')).toBe(false)
})

it('saves a captured checkpoint and waits for projected facts rather than copying the response into a list', async () => {
  const p = props()
  const controls = p.observationControls!
  const view = render(<ArtifactCard {...p} />)
  for (let index = 0; index < 6; index++) fireEvent.click(screen.getByRole('button', { name: 'Step' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Observation name' }), { target: { value: ' A ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save observation' }))
  await screen.findByText('Observation saved without sending it to the Agent.')
  expect(controls.save).toHaveBeenCalledExactlyOnceWith('saved-particles', 1, expect.any(String), 'A', {
    runtimeVersion: 1, stepCount: 6,
  })
  expect(p.recordAction).not.toHaveBeenCalled()
  expect(controls.send).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull()
  view.rerender(<ArtifactCard {...p} observationControls={{ ...controls, observations: [saved()] }} />)
  expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy()
})

it('retains the same request and checkpoint after a failed save while the live experiment advances', async () => {
  const save = vi.fn<SaveArtifactObservation>().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce(saved())
  const p = props()
  const controls = p.observationControls!
  render(<ArtifactCard {...p} observationControls={{ ...controls, save }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Step' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Observation name' }), { target: { value: 'A' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save observation' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('textbox', { name: 'Observation name' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Step' }))
  expect(currentStep()).toBe('2')
  fireEvent.click(screen.getByRole('button', { name: 'Retry save' }))
  await screen.findByText('Observation saved without sending it to the Agent.')
  expect(save).toHaveBeenCalledTimes(2)
  expect(save.mock.calls[1]).toEqual(save.mock.calls[0])
  expect(save.mock.calls[1]![4]).toEqual({ runtimeVersion: 1, stepCount: 1 })
  expect(p.recordAction).not.toHaveBeenCalled()
})

it('does not allocate a second save during one pending submission', async () => {
  let resolveSave!: (value: SavedParticleObservation) => void
  const save = vi.fn<SaveArtifactObservation>(() => new Promise((resolve) => { resolveSave = resolve }))
  const p = props()
  render(<ArtifactCard {...p} observationControls={{ ...p.observationControls!, save }} />)
  const button = screen.getByRole('button', { name: 'Save observation' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(save).toHaveBeenCalledOnce()
  expect(save.mock.calls[0]![3]).toBe('Observation 1')
  await act(async () => { resolveSave(saved()) })
})

it('reports the configured save limit without offering retry and keeps existing observations usable', async () => {
  const p = props()
  const save = vi.fn<SaveArtifactObservation>().mockRejectedValue(new ArtifactObservationSaveError(
    'artifact/observation-limit', { kind: 'limit', limit: 1 }, new Error('Different diagnostic text'),
  ))
  render(<ArtifactCard {...p} observationControls={{ ...p.observationControls!, observations: [saved()], save }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Save observation' }))
  expect((await screen.findByRole('alert')).textContent).toContain('limit of 1 saved observations')
  expect(screen.queryByRole('button', { name: 'Retry save' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Save observation' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'Restore' }).hasAttribute('disabled')).toBe(false)
  expect(screen.getByRole('button', { name: 'Send to Agent' }).hasAttribute('disabled')).toBe(false)
  expect(p.recordAction).not.toHaveBeenCalled()
})

it('ends a refused stale request and starts a new identity only after the latest revision is available', async () => {
  const p = props()
  const save = vi.fn<SaveArtifactObservation>().mockRejectedValueOnce(new ArtifactObservationSaveError(
    'artifact/stale-revision', { kind: 'stale', currentRevision: 2 }, new Error('Source changed'),
  )).mockResolvedValueOnce(saved())
  const controls = { ...p.observationControls!, save }
  const view = render(<ArtifactCard {...p} observationControls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: 'Step' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save observation' }))
  await screen.findByRole('alert')
  expect(screen.queryByRole('button', { name: 'Retry save' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Save observation' }).hasAttribute('disabled')).toBe(true)
  view.rerender(<ArtifactCard {...p} snapshot={{ ...snapshot, revision: 2 }} observationControls={controls} />)
  expect(screen.getByRole('button', { name: 'Save observation' }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Save observation' }))
  await screen.findByText('Observation saved without sending it to the Agent.')
  expect(save.mock.calls).toHaveLength(2)
  expect(save.mock.calls[1]![2]).not.toBe(save.mock.calls[0]![2])
  expect(save.mock.calls[1]![1]).toBe(2)
  expect(save.mock.calls[1]![4]).toEqual({ runtimeVersion: 1, stepCount: 0 })
})

it('does not overwrite a newer live run when an older in-flight save is explicitly refused', async () => {
  let rejectSave!: (error: Error) => void
  const save = vi.fn<SaveArtifactObservation>()
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject }))
    .mockResolvedValueOnce(saved())
  const p = props()
  const controls = { ...p.observationControls!, save }
  const view = render(<ArtifactCard {...p} observationControls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: 'Step' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save observation' }))
  view.rerender(<ArtifactCard {...p} snapshot={{ ...snapshot, revision: 2 }} observationControls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: 'Step' }))
  fireEvent.click(screen.getByRole('button', { name: 'Step' }))
  await act(async () => { rejectSave(new ArtifactObservationSaveError(
    'artifact/stale-revision', { kind: 'stale', currentRevision: 2 }, new Error('Source changed'),
  )) })
  expect(currentStep()).toBe('2')
  fireEvent.click(screen.getByRole('button', { name: 'Save observation' }))
  await screen.findByText('Observation saved without sending it to the Agent.')
  expect(save.mock.calls[1]![1]).toBe(2)
  expect(save.mock.calls[1]![4]).toEqual({ runtimeVersion: 1, stepCount: 2 })
  expect(save.mock.calls[1]![2]).not.toBe(save.mock.calls[0]![2])
})

it('keeps an in-flight save identity through source, portal, and source-revision changes', async () => {
  let rejectSave!: (error: Error) => void
  const save = vi.fn<SaveArtifactObservation>()
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject }))
    .mockResolvedValueOnce(saved())
  const p = props()
  const controls = { ...p.observationControls!, save }
  const view = render(<ArtifactCard {...p} observationControls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: 'Step' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Observation name' }), { target: { value: 'A' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save observation' }))
  const captured = save.mock.calls[0]
  fireEvent.click(screen.getByRole('button', { name: 'View source' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show preview' }))
  view.rerender(<ArtifactCard {...p} placement="focus" observationControls={controls} />)
  expect(screen.getByRole('button', { name: 'Saving…' }).hasAttribute('disabled')).toBe(true)
  view.rerender(<ArtifactCard {...p} snapshot={{
    artifactId: snapshot.artifactId, revision: 2, title: 'New source', format: 'html',
    source: '<p>Changed while saving</p>', presentation: 'inline',
  }} observationControls={controls} />)
  await act(async () => { rejectSave(new Error('response lost after save')) })
  fireEvent.click(screen.getByRole('button', { name: 'Retry save' }))
  await screen.findByText('Observation saved without sending it to the Agent.')
  expect(save.mock.calls).toHaveLength(2)
  expect(save.mock.calls[1]).toEqual(captured)
  expect(p.recordAction).not.toHaveBeenCalled()
})

it('restores saved source independently, exports its reference, and returns to the paused latest run', async () => {
  const old = saved()
  const latest: SceneArtifactSnapshot = {
    ...snapshot, revision: 2,
    spec: { ...snapshot.spec, kind: 'particle-system', particles: [{ id: 'alpha', x: 20, y: 1, vx: 3, vy: 8, mass: 1 }],
      gravity: { x: 0, y: -9.8 }, timeStep: 1 / 30, trails: true },
  }
  const create = vi.fn<ArtifactExportCommands['create']>(async request => ({ request, frozen: { sessionId: 'export-session' as never, artifact: old.artifact, checkpoint: old.checkpoint,
    observationId: old.observationId, exporterVersion: 1, parameters: 'particle-checkpoint' }, status: 'ready',
  file: { attachmentId: 'sha256:abc' as never, bytes: 8, name: 'saved.html' } }))
  const download = vi.fn().mockResolvedValue({ status: 'requested' })
  const p = props({ snapshot: latest })
  render(<ArtifactCard {...p} observationControls={{ ...p.observationControls!, observations: [old] }}
    exportControls={{ ready: true, records: [], create, download }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Step' }))
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
  expect(currentStep()).toBe('6')
  expect(screen.getByText('Saved observation A · revision 1')).toBeTruthy()
  expect(document.querySelector('[data-artifact-revision]')?.getAttribute('data-artifact-revision')).toBe('1')
  expect(screen.queryByRole('button', { name: 'Step' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Confirm analysis' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Save observation' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Export animation' }))
  await waitFor(() => { expect(download).toHaveBeenCalledOnce() })
  expect(create).toHaveBeenCalledOnce()
  expect(create.mock.calls[0]?.[0]).toEqual({ exportId: create.mock.calls[0]?.[0].exportId, format: 'html',
    source: { kind: 'observation', artifactId: old.artifact.artifactId, observationId: old.observationId } })
  expect(p.recordAction).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Return to latest' }))
  expect(currentStep()).toBe('1')
  expect(document.querySelector('[data-artifact-revision]')?.getAttribute('data-artifact-revision')).toBe('2')
  fireEvent.click(screen.getByRole('button', { name: 'Confirm analysis' }))
  expect(p.recordAction).toHaveBeenCalledWith('saved-particles', 2, 'physics.inspected', expect.objectContaining({
    particles: [expect.objectContaining({ x: 20.1 })],
  }), true, expect.any(String))
})

it('reads a saved observation after card remount and only sends it through the explicit saved command', async () => {
  const a = saved()
  const b = saved('B', 9)
  const p = props()
  const controls = { ...p.observationControls!, observations: [a, b] }
  const view = render(<ArtifactCard {...p} observationControls={controls} />)
  fireEvent.click(within(screen.getAllByRole('listitem')[0]!).getByRole('button', { name: 'Restore' }))
  expect(currentStep()).toBe('6')
  view.unmount()
  render(<ArtifactCard {...p} observationControls={controls} />)
  expect(currentStep()).toBe('0')
  const first = within(screen.getAllByRole('listitem')[0]!)
  fireEvent.click(first.getByRole('button', { name: 'Restore' }))
  expect(currentStep()).toBe('6')
  expect(controls.send).not.toHaveBeenCalled()
  fireEvent.click(first.getByRole('button', { name: 'Send to Agent' }))
  await waitFor(() => { expect(controls.send).toHaveBeenCalledExactlyOnceWith('saved-particles', a.observationId, true) })
  await first.findByRole('button', { name: 'Sent' })
  expect(p.recordAction).not.toHaveBeenCalled()
})

it('keeps saved facts available but drops the selected historical view when a new revision arrives', () => {
  const p = props()
  const controls = { ...p.observationControls!, observations: [saved()] }
  const view = render(<ArtifactCard {...p} observationControls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
  expect(currentStep()).toBe('6')
  view.rerender(<ArtifactCard {...p} snapshot={{ ...snapshot, revision: 2 }} observationControls={controls} />)
  expect(currentStep()).toBe('0')
  expect(screen.queryByRole('button', { name: 'Return to latest' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy()
})

it('restores an old particle observation after the latest revision becomes HTML', () => {
  const p = props()
  const controls = { ...p.observationControls!, observations: [saved()] }
  render(<ArtifactCard {...p} snapshot={{
    artifactId: snapshot.artifactId, revision: 2, title: 'Updated explanation', format: 'html',
    source: '<p>New explanation</p>', presentation: 'inline',
  }} observationControls={controls} />)
  expect(screen.queryByRole('button', { name: 'Save observation' })).toBeNull()
  expect(document.querySelector('iframe')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
  expect(currentStep()).toBe('6')
  expect(document.querySelector('iframe')).toBeNull()
  expect(screen.getByText('Saved observation A · revision 1')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Return to latest' }))
  expect(document.querySelector('iframe')).toBeTruthy()
  expect(document.querySelector('[data-artifact-revision]')?.getAttribute('data-artifact-revision')).toBe('2')
  expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy()
  expect(p.recordAction).not.toHaveBeenCalled()
})

it('keeps local particle controls and saved restoration without root-only save or send actions', () => {
  const p = props({ hostOperationsAvailable: false })
  const controls = { ...p.observationControls!, observations: [saved()] }
  render(<ArtifactCard {...p} observationControls={controls} />)
  expect(screen.getByText(en['route.subagentLocalOnly'])).toBeTruthy()
  expect(screen.queryByRole('button', { name: en['observation.save'] })).toBeNull()
  expect(screen.queryByRole('textbox', { name: en['observation.name'] })).toBeNull()
  expect(screen.queryByRole('button', { name: en['send.action'] })).toBeNull()
  expect(screen.queryByRole('button', { name: en['scene.confirm'] })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en['scene.step'] }))
  expect(currentStep()).toBe('1')
  fireEvent.click(screen.getByRole('button', { name: en['observation.restore'] }))
  expect(currentStep()).toBe('6')
  fireEvent.click(screen.getByRole('button', { name: en['observation.returnLatest'] }))
  expect(currentStep()).toBe('1')
  expect(controls.save).not.toHaveBeenCalled()
  expect(controls.send).not.toHaveBeenCalled()
  expect(p.recordAction).not.toHaveBeenCalled()
})
