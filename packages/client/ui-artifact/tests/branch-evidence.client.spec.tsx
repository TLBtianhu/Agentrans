// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@agentrans/client-test-runtime'
import { createSnapshotStore } from '@agentrans/client-store'
import type { SessionListState } from '@agentrans/api-session-controller/client'
import { SessionId, SessionSeq } from '@agentrans/session/types'
import type { ArtifactId, ArtifactObservationId, ArtifactObservations, SavedParticleObservation } from '@agentrans/artifact/types'
import { advanceParticleState, createParticleState, observeParticleState } from '@agentrans/artifact/particle-runtime'
import { ArtifactBranchResultAction } from '../src/client/ArtifactBranchResultAction.tsx'
import { ArtifactBranchReturnError, type ReturnArtifactBranchResult } from '../src/client/protocol.ts'
import { en } from '../src/client/locales.ts'

type Props = ComponentProps<typeof ArtifactBranchResultAction>
const parent = SessionId('parent')
const child = SessionId('child')
const t = makeTranslate(en)

function saved(role: 'control' | 'variant', label: string, stepCount = 6): SavedParticleObservation {
  const spec = {
    kind: 'particle-system' as const, particles: [{ id: 'p', x: 1, y: 2, vx: 3, vy: 4, mass: 1 }],
    gravity: { x: 0, y: role === 'control' ? -9.8 : -4 }, timeStep: 1 / 30, trails: true,
  }
  return {
    observationId: label as ArtifactObservationId, label,
    artifact: { artifactId: role as ArtifactId, revision: 1, format: 'scene', presentation: 'inline',
      title: role, comparison: { group: 'gravity', role }, spec },
    checkpoint: { runtimeVersion: 1, stepCount },
    values: observeParticleState(advanceParticleState(spec, createParticleState(spec), stepCount)),
  }
}
const A = saved('control', 'A')
const A2 = saved('control', 'A2')
const A7 = saved('control', 'A7', 7)
const B = saved('variant', 'B')
const observations: ArtifactObservations = { control: [A, A2, A7], variant: [B] }
const receipt: Awaited<ReturnType<ReturnArtifactBranchResult>> = {
  parentSessionId: parent, eventSeq: SessionSeq(8),
  messageId: 'adopted' as Awaited<ReturnType<ReturnArtifactBranchResult>>['messageId'],
}

function fixture(options: { childAllowed?: boolean; parentAllowed?: boolean; parentId?: SessionId | undefined; origin?: 'subagent' } = {}) {
  const sessions = createSnapshotStore<SessionListState>({
    ids: [parent, child], phase: 'ready', projectionsBySession: {},
    byId: {
      [parent]: { id: parent, displayTitle: 'Parent', running: false, retainedBy: {}, blank: false, updatedAt: 1 },
      [child]: { id: child, displayTitle: 'Child', running: false, retainedBy: {}, blank: false, updatedAt: 1,
        ...('parentId' in options ? options.parentId === undefined ? {} : { parentId: options.parentId } : { parentId: parent }),
        ...options.origin === undefined ? {} : { origin: options.origin } },
    },
  })
  let projection: ArtifactObservations | undefined = observations
  const useProjection = vi.fn(() => projection)
  const returnResult = vi.fn<ReturnArtifactBranchResult>().mockResolvedValue(receipt)
  const openSession = vi.fn()
  const useSessionAccess = vi.fn<Props['useSessionAccess']>().mockReturnValue(options.parentAllowed ?? true)
  const props = {
    sessionId: child, seq: 6, text: 'Child conclusion', useSessions: bindSnapshotSelector(sessions),
    useAccess: () => options.childAllowed ?? true, useSessionAccess, useProjection,
    returnResult, openSession, t,
  } as Props
  return { props, returnResult, openSession, useSessionAccess, useProjection,
    project: (value: ArtifactObservations | undefined) => { projection = value } }
}

function open(): void { fireEvent.click(screen.getByRole('button', { name: 'Return with evidence' })) }
function choose(name: string, value: SavedParticleObservation): void {
  fireEvent.change(screen.getByRole('combobox', { name }), {
    target: { value: JSON.stringify([value.artifact.artifactId, value.observationId]) },
  })
}
function pair(control = A): void {
  fireEvent.click(screen.getByRole('radio', { name: 'Saved comparison' }))
  choose('Control observation', control)
  choose('Variant observation', B)
}
const confirm = () => screen.getByRole('button', { name: 'Confirm return with evidence' })

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('branch conclusion with saved evidence', () => {
  it('loads projected evidence only for an open preview and cancels without any request', () => {
    const h = fixture()
    render(<ArtifactBranchResultAction {...h.props} />)
    expect(h.useProjection).not.toHaveBeenCalled()
    open()
    expect(h.useProjection).toHaveBeenCalledWith('artifactObservations')
    expect(screen.getByText('Child conclusion')).toBeTruthy()
    choose('Saved observation', A)
    expect(screen.getByLabelText('Observed values: A').textContent).toContain('"x": 1.6')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(h.returnResult).not.toHaveBeenCalled()
    expect(h.openSession).not.toHaveBeenCalled()
  })

  it('keeps unloaded evidence distinct from an empty list', () => {
    const h = fixture()
    h.project(undefined)
    const view = render(<ArtifactBranchResultAction {...h.props} />)
    open()
    expect(screen.getByText('Loading saved observations…')).toBeTruthy()
    expect(confirm().hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText('Save observations in this branch before returning evidence.')).toBeNull()
    h.project({})
    view.rerender(<ArtifactBranchResultAction {...h.props} />)
    expect(screen.queryByText('Loading saved observations…')).toBeNull()
    expect(screen.getByText('Save observations in this branch before returning evidence.')).toBeTruthy()
    expect(confirm().hasAttribute('disabled')).toBe(true)
  })

  it('returns only one immutable observation reference with the exact conclusion sequence', async () => {
    const h = fixture()
    render(<ArtifactBranchResultAction {...h.props} />)
    open()
    choose('Saved observation', A)
    fireEvent.click(confirm())
    await waitFor(() => { expect(h.openSession).toHaveBeenCalledWith(parent) })
    expect(h.returnResult).toHaveBeenCalledExactlyOnceWith({
      sessionId: parent, branchSessionId: child, resultSeq: 6,
      evidence: { kind: 'observation', observation: { artifactId: 'control', observationId: 'A' } },
    })
  })

  it('requires a compatible saved pair and performs no admission during selection', async () => {
    const h = fixture()
    render(<ArtifactBranchResultAction {...h.props} />)
    open()
    pair(A7)
    expect(confirm().hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/Select a supported observation/)).toBeTruthy()
    choose('Control observation', A)
    expect(confirm().hasAttribute('disabled')).toBe(false)
    expect(h.returnResult).not.toHaveBeenCalled()
    fireEvent.click(confirm())
    await waitFor(() => { expect(h.openSession).toHaveBeenCalledWith(parent) })
    expect(h.returnResult).toHaveBeenCalledExactlyOnceWith({
      sessionId: parent, branchSessionId: child, resultSeq: 6, evidence: { kind: 'comparison', group: 'gravity',
        control: { artifactId: 'control', observationId: 'A' }, variant: { artifactId: 'variant', observationId: 'B' } },
    })
  })

  it('freezes the complete request and reviewed values after an unknown result while projection facts change', async () => {
    const h = fixture()
    const deferred = Promise.withResolvers<Awaited<ReturnType<ReturnArtifactBranchResult>>>()
    h.returnResult.mockReturnValueOnce(deferred.promise)
    const view = render(<ArtifactBranchResultAction {...h.props} />)
    open()
    pair()
    const button = confirm()
    fireEvent.click(button)
    fireEvent.click(button)
    expect(h.returnResult).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true)
    await act(async () => { deferred.reject(new Error('response lost')) })
    expect(screen.getByRole('alert').textContent).toContain('Retry the same conclusion and evidence')
    const values = screen.getByLabelText('Observed values: A').textContent
    h.project({ control: [A2], variant: [] })
    view.rerender(<ArtifactBranchResultAction {...h.props} />)
    expect(screen.getByLabelText('Observed values: A').textContent).toBe(values)
    expect(screen.getByRole('combobox', { name: 'Control observation' }).hasAttribute('disabled')).toBe(true)
    choose('Control observation', A2)
    fireEvent.click(screen.getByRole('button', { name: 'Retry return with evidence' }))
    await waitFor(() => { expect(h.openSession).toHaveBeenCalledWith(parent) })
    expect(h.returnResult).toHaveBeenCalledTimes(2)
    expect(h.returnResult.mock.calls[1]?.[0]).toBe(h.returnResult.mock.calls[0]?.[0])
  })

  it('ends a conflicting adoption and directs the user to the parent without retrying', async () => {
    const h = fixture()
    h.returnResult.mockRejectedValueOnce(new ArtifactBranchReturnError('session/branch-result-conflict', { kind: 'conflict' }, new Error('diagnostic')))
    render(<ArtifactBranchResultAction {...h.props} />)
    open()
    choose('Saved observation', A)
    fireEvent.click(confirm())
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain('already returned with different evidence, or without evidence')
    expect(screen.queryByRole('button', { name: 'Retry return with evidence' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Confirm return with evidence' })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Saved observation' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Open parent conversation' }))
    expect(h.openSession).toHaveBeenCalledExactlyOnceWith(parent)
    expect(h.returnResult).toHaveBeenCalledOnce()
  })

  it('reports temporary service unavailability without retaining a futile retry', async () => {
    const h = fixture()
    h.returnResult.mockRejectedValueOnce(new ArtifactBranchReturnError(
      'gateway/invocation-unavailable', { kind: 'service-unavailable' }, new Error('diagnostic'),
    ))
    render(<ArtifactBranchResultAction {...h.props} />)
    open()
    choose('Saved observation', A)
    fireEvent.click(confirm())
    expect((await screen.findByRole('alert')).textContent).toContain('Reopen this preview when the service is available')
    expect(screen.queryByRole('button', { name: 'Retry return with evidence' })).toBeNull()
    expect(confirm().hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('combobox', { name: 'Saved observation' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    open()
    choose('Saved observation', A)
    expect(confirm().hasAttribute('disabled')).toBe(false)
    expect(h.returnResult).toHaveBeenCalledOnce()
  })

  it.each([
    [new ArtifactBranchReturnError('artifact-branch/result-too-large', { kind: 'too-large', limit: 50 }, new Error('diagnostic')),
      'exceed the 50-byte input limit'],
    [new ArtifactBranchReturnError('artifact-branch/evidence-unavailable', { kind: 'evidence-unavailable' }, new Error('diagnostic')),
      'evidence is unavailable or incompatible'],
  ])('ends the known refusal %s and requires a new selection', async (error, message) => {
    const h = fixture()
    h.returnResult.mockRejectedValueOnce(error)
    render(<ArtifactBranchResultAction {...h.props} />)
    open()
    choose('Saved observation', A)
    fireEvent.click(confirm())
    expect((await screen.findByRole('alert')).textContent).toContain(message)
    expect(confirm().hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Retry return with evidence' })).toBeNull()
    choose('Saved observation', A)
    expect(confirm().hasAttribute('disabled')).toBe(true)
    choose('Saved observation', A2)
    expect(confirm().hasAttribute('disabled')).toBe(false)
    expect(h.returnResult).toHaveBeenCalledOnce()
  })

  it.each([
    ['child permission', { childAllowed: false }], ['parent permission', { parentAllowed: false }],
    ['root session', { parentId: undefined }], ['subagent', { origin: 'subagent' as const }],
  ])('hides the entry for %s', (_reason, options) => {
    const h = fixture(options)
    render(<ArtifactBranchResultAction {...h.props} />)
    expect(screen.queryByRole('button', { name: 'Return with evidence' })).toBeNull()
    expect(h.useProjection).not.toHaveBeenCalled()
    expect(h.returnResult).not.toHaveBeenCalled()
    if (!('parentId' in options) && !('origin' in options)) {
      expect(h.useSessionAccess).toHaveBeenCalledWith(parent, 'artifactBranchResults/returnResult')
    }
  })

  it('withdraws an old draft when the assistant conclusion changes and ignores its late result', async () => {
    const h = fixture()
    const deferred = Promise.withResolvers<Awaited<ReturnType<ReturnArtifactBranchResult>>>()
    h.returnResult.mockReturnValueOnce(deferred.promise)
    const view = render(<ArtifactBranchResultAction {...h.props} />)
    open()
    choose('Saved observation', A)
    fireEvent.click(confirm())
    view.rerender(<ArtifactBranchResultAction {...h.props} seq={7} text="Another conclusion" />)
    open()
    expect(screen.getByText('Another conclusion')).toBeTruthy()
    expect(confirm().hasAttribute('disabled')).toBe(true)
    await act(async () => { deferred.resolve(receipt) })
    expect(h.openSession).not.toHaveBeenCalled()
  })
})
