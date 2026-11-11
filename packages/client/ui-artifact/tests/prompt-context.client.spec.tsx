// @vitest-environment jsdom
import type { SessionId } from '@agentrans/session/types'
import { sessionSnapshot } from '@agentrans/client-test-runtime'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { bindSnapshotSelector, makeTranslate } from '@agentrans/client-test-runtime'
import { createSnapshotStore } from '@agentrans/client-store'
import type { ArtifactId, ArtifactObservationId, ArtifactSnapshot, SavedParticleObservation, SceneArtifactSnapshot } from '@agentrans/artifact/types'
import { restoreParticleCheckpoint, observeParticleState } from '@agentrans/artifact/particle-runtime'
import { ArtifactInteractionOwner, particleRuntimeKey } from '../src/client/particle-runtime-owner.ts'
import { ArtifactPromptContext } from '../src/client/ArtifactPromptContext.tsx'
import { ArtifactCard } from './runtime-harness.tsx'
import { ArtifactCard as ArtifactCardView } from '../src/client/ArtifactNodeView.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)
const artifact: SceneArtifactSnapshot = {
  artifactId: 'experiment' as ArtifactId, revision: 1, format: 'scene', title: 'Experiment A', presentation: 'inline',
  spec: { kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 1, vx: 3, vy: 8, mass: 1 }],
    gravity: { x: 0, y: -9.8 }, timeStep: 1 / 30, trails: true },
}
const key = particleRuntimeKey('artifact:experiment', artifact.artifactId)

function bench() {
  const source = createSnapshotStore<ArtifactSnapshot | undefined>(artifact)
  const owner = new ArtifactInteractionOwner(() => source)
  const runtime = owner.runtime(key)
  const release = runtime.subscribe(() => {})
  return { source, owner, runtime, release }
}

function observation(label: string, source = artifact): SavedParticleObservation {
  if (source.spec.kind !== 'particle-system') throw new Error('Particle source required')
  const checkpoint = { runtimeVersion: 1 as const, stepCount: 6 }
  return { observationId: label as ArtifactObservationId, label, artifact: source, checkpoint,
    values: observeParticleState(restoreParticleCheckpoint(source.spec, checkpoint)) }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('captures the latest sole runtime at send time without automatically selecting generated content', () => {
  const { owner, runtime, release } = bench()
  expect(owner.capture('Unavailable')).toBeUndefined()
  owner.command(key, 'step')
  owner.chooseCurrent(key, artifact)
  for (let step = 1; step < 6; step++) owner.command(key, 'step')
  const sent = owner.capture('Unavailable')
  expect(sent).toEqual({ kind: 'current-particle', artifactId: 'experiment', revision: 1, checkpoint: { runtimeVersion: 1, stepCount: 6 } })
  owner.command(key, 'step')
  expect(runtime.getSnapshot()?.run.state.stepCount).toBe(7)
  expect(sent).toMatchObject({ checkpoint: { stepCount: 6 } })
  release()
  owner.dispose()
})

it('shares one runtime across subscribers and invalidates an old choice after last-unmount and same-revision remount', () => {
  const { owner, runtime, release } = bench()
  const secondRelease = runtime.subscribe(() => {})
  owner.command(key, 'step')
  owner.chooseCurrent(key, artifact)
  release()
  expect(owner.capture('Unavailable')).toMatchObject({ checkpoint: { stepCount: 1 } })
  secondRelease()
  expect(() => owner.capture('Unavailable')).toThrow('Unavailable')
  const remountRelease = runtime.subscribe(() => {})
  expect(runtime.getSnapshot()?.run.state.stepCount).toBe(0)
  expect(() => owner.capture('Unavailable')).toThrow('Unavailable')
  owner.chooseCurrent(key, artifact)
  expect(owner.capture('Unavailable')).toMatchObject({ checkpoint: { stepCount: 0 } })
  remountRelease()
  owner.dispose()
})

it('rejects a selected old revision and resets the calculation when the existing node changes source', () => {
  const { owner, runtime, source, release } = bench()
  owner.command(key, 'step')
  owner.chooseCurrent(key, artifact)
  source.set({ ...artifact, revision: 2, title: 'Experiment B' })
  expect(runtime.getSnapshot()).toMatchObject({ revision: 2, run: { state: { stepCount: 0 } } })
  expect(owner.selection.getSnapshot()).toMatchObject({ revision: 1, available: false })
  expect(() => owner.capture('Choose again')).toThrow('Choose again')
  release()
  owner.dispose()
})

it('keeps saved observations and comparison references fixed without copying their sources into selection state', () => {
  const { owner, source, release } = bench()
  const control = observation('A')
  const variant = observation('B', { ...artifact, artifactId: 'variant' as ArtifactId })
  owner.chooseObservation(control)
  source.set({ ...artifact, revision: 2 })
  expect(owner.capture('Unavailable')).toEqual({ kind: 'observation', ref: { artifactId: 'experiment', observationId: 'A' } })
  expect(JSON.stringify(owner.selection.getSnapshot())).not.toContain('gravity')
  owner.chooseComparison('study', control, variant)
  expect(owner.capture('Unavailable')).toEqual({ kind: 'comparison', group: 'study',
    control: { artifactId: 'experiment', observationId: 'A' }, variant: { artifactId: 'variant', observationId: 'B' } })
  release()
  owner.dispose()
})

it('does not inherit selection into a different Session owner and clears without changing the visible experiment', () => {
  const { owner, runtime, release } = bench()
  owner.command(key, 'step')
  owner.chooseCurrent(key, artifact)
  const other = new ArtifactInteractionOwner(() => createSnapshotStore(artifact))
  expect(other.capture('Unavailable')).toBeUndefined()
  const props = { useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot('test-session' as SessionId))), useArtifactPromptContext: bindSnapshotSelector(owner.selection),
    clearArtifactPromptContext: () => { owner.clear() }, t } as ComponentProps<typeof ArtifactPromptContext>
  render(<ArtifactPromptContext {...props} />)
  expect(screen.getByRole('region', { name: 'Question context' }).getAttribute('data-artifact-prompt-context')).toBe('current-particle')
  fireEvent.click(screen.getByRole('button', { name: 'Remove question context' }))
  expect(screen.queryByRole('region', { name: 'Question context' })).toBeNull()
  expect(runtime.getSnapshot()?.run.state.stepCount).toBe(1)
  release()
  owner.dispose()
  other.dispose()
})

it('requires an explicit card action and identifies unsupported runtime conditions', () => {
  const chooseCurrent = vi.fn()
  const chooseObservation = vi.fn()
  const props = { snapshot: artifact, origin: { kind: 'current' as const }, placement: 'inline' as const,
    recordAction: vi.fn(), t, promptContext: { chooseCurrent, chooseObservation } }
  const view = render(<ArtifactCard {...props} />)
  expect(chooseCurrent).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Use for next question' }))
  expect(chooseCurrent).toHaveBeenCalledOnce()
  view.rerender(<ArtifactCard {...props} snapshot={{ ...artifact, revision: 2, spec: { kind: 'flowchart', nodes: [], edges: [] } }} />)
  expect(screen.queryByRole('button', { name: 'Use for next question' })).toBeNull()
  expect(screen.getByText(en['promptContext.unsupported'])).toBeTruthy()
})

it('keeps the unavailable choice visible instead of silently substituting a new source', () => {
  const { owner, source, release } = bench()
  owner.chooseCurrent(key, artifact)
  const props = { useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot('test-session' as SessionId))), useArtifactPromptContext: bindSnapshotSelector(owner.selection),
    clearArtifactPromptContext: () => { owner.clear() }, t } as ComponentProps<typeof ArtifactPromptContext>
  render(<ArtifactPromptContext {...props} />)
  act(() => { source.set({ ...artifact, revision: 2 }) })
  expect(screen.getByRole('alert').textContent).toBe(en['promptContext.unavailable'])
  release()
  owner.dispose()
})

it('does not export or attach a particle source before its sole runtime is available', () => {
  const create = vi.fn()
  const chooseCurrent = vi.fn()
  render(<ArtifactCardView snapshot={artifact} origin={{ kind: 'current' }} placement="inline" recordAction={vi.fn()} t={t}
    particleRuntime={{ current: undefined, command: vi.fn() }}
    promptContext={{ chooseCurrent, chooseObservation: vi.fn() }}
    exportControls={{ ready: true, records: [], create, download: vi.fn() }} />)
  expect(screen.getByText('Preparing particle experiment…')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Use for next question' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Export animation' }))
  expect(create).not.toHaveBeenCalled()
  expect(chooseCurrent).not.toHaveBeenCalled()
})

it('retains an existing choice with removal and a route explanation when the chat becomes a subagent continuation', () => {
  const { owner, release } = bench()
  owner.chooseCurrent(key, artifact)
  const lifecycle = sessionSnapshot('test-session' as SessionId)
  const session = createSnapshotStore(lifecycle)
  const props = { useSession: bindSnapshotSelector(session), useArtifactPromptContext: bindSnapshotSelector(owner.selection),
    clearArtifactPromptContext: () => { owner.clear() }, t } as ComponentProps<typeof ArtifactPromptContext>
  render(<ArtifactPromptContext {...props} />)
  act(() => { session.set({ ...lifecycle, subagent: {
    address: { parentSessionId: 'parent' as SessionId, childSessionId: lifecycle.sessionId, mode: 'continuable' }, parentAvailable: true,
  } }) })
  expect(screen.getByRole('alert').textContent).toBe(en['promptContext.subagentUnsupported'])
  expect(owner.selection.getSnapshot()).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en['promptContext.clear'] }))
  expect(screen.queryByRole('region', { name: en['promptContext.label'] })).toBeNull()
  release()
  owner.dispose()
})
