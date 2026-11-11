// @vitest-environment jsdom
import { sessionSnapshot } from '@agentrans/client-test-runtime'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@agentrans/client-test-runtime'
import { createSnapshotStore } from '@agentrans/client-store'
import { SessionId } from '@agentrans/session/types'
import type { ArtifactId, HtmlArtifactSnapshot } from '@agentrans/artifact/types'
import type { ArtifactRuntimeId, ArtifactRuntimeIdentity } from '@agentrans/artifact-runtime/types'
import { ArtifactRuntimeOwner, type ArtifactRuntimeSnapshot } from '../src/client/runtime-owner.ts'
import { ArtifactInteractionOwner, particleRuntimeKey } from '../src/client/particle-runtime-owner.ts'
import { ArtifactPromptContext } from '../src/client/ArtifactPromptContext.tsx'
import { ArtifactCard } from '../src/client/ArtifactNodeView.tsx'
import { en } from '../src/client/locales.ts'
import { runtimeChannel } from './runtime-channel.client.ts'
import type { ComponentProps } from 'react'

const t = makeTranslate(en)
const sessionId = SessionId('program-context')
const artifact: HtmlArtifactSnapshot = { artifactId: 'program' as ArtifactId, revision: 1, format: 'html',
  title: 'Program A', source: '<p>Authored program</p>', presentation: 'inline' }
const key = particleRuntimeKey('artifact:program', artifact.artifactId)
const identity = (runtimeId = 'run-a'): ArtifactRuntimeIdentity => ({ artifactId: artifact.artifactId, revision: 1,
  runtimeId: runtimeId as ArtifactRuntimeId, renderer: 'html' })
const owners: Array<{ dispose(): void }> = []
afterEach(() => { cleanup(); for (const owner of owners) owner.dispose(); owners.length = 0; vi.restoreAllMocks() })
async function settle(): Promise<void> { for (let tick = 0; tick < 12; tick++) await Promise.resolve() }

function bench() {
  const source = createSnapshotStore<typeof artifact | undefined>(artifact)
  const channel = runtimeChannel()
  const open = vi.fn(() => runtimeChannel()).mockReturnValueOnce(channel)
  const runtimes = new ArtifactRuntimeOwner(open, 1000)
  const owner = new ArtifactInteractionOwner(() => source, { sessionId, runtimeFor: value => runtimes.source(value) })
  const run = identity()
  const release = runtimes.actions.mount(key, run)
  owners.push(owner, runtimes)
  return { source, channel, open, runtimes, owner, run, release }
}

function receiveState(b: ReturnType<typeof bench>, state: import('@agentrans/util-values').JsonValue): void {
  b.runtimes.actions.report(key, b.run, { status: 'ready', capabilities: { state: true, commands: [] } })
  b.runtimes.actions.state(key, b.run, state)
}

describe('explicit program report question selection', () => {
  it('binds the physical instance but freezes the latest received state at send, independently of later changes or release', () => {
    const b = bench()
    receiveState(b, { counter: 1 })
    expect(b.owner.capture('Unavailable')).toBeUndefined()
    b.owner.chooseHtmlRuntime(key, artifact, b.run)
    const live = { counter: 2, nested: { label: 'second' } }
    receiveState(b, live)
    const captured = b.owner.capture('Unavailable')
    expect(captured).toEqual({ kind: 'html-runtime', capturedSessionId: sessionId, artifactId: artifact.artifactId,
      revision: 1, runtimeId: b.run.runtimeId, capture: { status: 'ready', state: live } })
    expect(b.runtimes.source(key).getSnapshot()?.host).toBe('connecting')
    live.nested.label = 'changed after capture'
    receiveState(b, { counter: 3 })
    b.release()
    expect(captured).toMatchObject({ capture: { state: { counter: 2, nested: { label: 'second' } } } })
    expect(b.owner.selection.getSnapshot()).toMatchObject({ availability: 'stale' })
    expect(() => b.owner.capture('Unavailable')).toThrow('Unavailable')
    expect(b.open).toHaveBeenCalledOnce()
  })

  it.each([null, false, 0, ''])('captures the own received state value %j without treating it as absent', (state) => {
    const b = bench()
    receiveState(b, state)
    b.owner.chooseHtmlRuntime(key, artifact, b.run)
    expect(b.owner.capture('Unavailable')).toMatchObject({ capture: { status: 'ready', state } })
  })

  it('captures a current error without requiring state and does not copy state or diagnostics into the user choice', () => {
    const b = bench()
    receiveState(b, { secretPayload: 1 })
    b.owner.chooseHtmlRuntime(key, artifact, b.run)
    b.runtimes.actions.report(key, b.run, { status: 'error', error: { code: 'PROGRAM_ERROR', message: 'Needs correction' } })
    expect(b.owner.capture('Unavailable')).toMatchObject({ capture: { status: 'error', error: { code: 'PROGRAM_ERROR', message: 'Needs correction' } } })
    expect(b.owner.selection.getSnapshot()).toMatchObject({ availability: 'error' })
    expect(JSON.stringify(b.owner.selection.getSnapshot())).not.toContain('Needs correction')
    expect(JSON.stringify(b.owner.selection.getSnapshot())).not.toContain('secretPayload')
    b.owner.clear()
    b.owner.chooseHtmlRuntime(key, artifact, b.run)
    expect(b.owner.capture('Unavailable')).toMatchObject({ capture: { status: 'error' } })
  })

  it('explains missing or withdrawn state and allows a fresh same-instance report to become capturable again', () => {
    const b = bench()
    b.owner.chooseHtmlRuntime(key, artifact, b.run)
    expect(b.owner.selection.getSnapshot()).toMatchObject({ availability: 'waiting' })
    expect(() => b.owner.capture('Unavailable')).toThrow('Unavailable')
    b.runtimes.actions.report(key, b.run, { status: 'ready', capabilities: { state: false, commands: [] } })
    expect(b.owner.selection.getSnapshot()).toMatchObject({ availability: 'unsupported' })
    b.runtimes.actions.report(key, b.run, { status: 'ready', capabilities: { state: true, commands: [] } })
    expect(b.owner.selection.getSnapshot()).toMatchObject({ availability: 'missing-state' })
    expect(() => b.owner.capture('Unavailable')).toThrow('Unavailable')
    b.runtimes.actions.state(key, b.run, { fresh: true })
    expect(b.owner.capture('Unavailable')).toMatchObject({ capture: { state: { fresh: true } } })
  })

  it.each(['source', 'remount', 'disconnect'] as const)('latches %s invalidation until the user explicitly selects again', async (cause) => {
    const b = bench()
    receiveState(b, { value: 1 })
    b.owner.chooseHtmlRuntime(key, artifact, b.run)
    if (cause === 'source') {
      b.source.set({ ...artifact, revision: 2 })
      b.source.set(artifact)
    } else if (cause === 'remount') {
      b.release()
      b.runtimes.actions.mount(key, b.run)
    } else {
      b.channel.dispose()
      await settle()
      b.runtimes.actions.mount(key, b.run)
    }
    receiveState(b, { value: 2 })
    expect(b.owner.selection.getSnapshot()).toMatchObject({ availability: 'stale' })
    expect(() => b.owner.capture('Choose again')).toThrow('Choose again')
    b.owner.chooseHtmlRuntime(key, artifact, b.run)
    expect(b.owner.capture('Choose again')).toMatchObject({ capture: { state: { value: 2 } } })
  })

  it('keeps the composer on the same chosen instance and updates its explanation without mirroring payloads', () => {
    const b = bench()
    receiveState(b, { value: 1 })
    b.owner.chooseHtmlRuntime(key, artifact, b.run)
    const props = { useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot('test-session' as SessionId))), useArtifactPromptContext: bindSnapshotSelector(b.owner.selection),
      clearArtifactPromptContext: () => { b.owner.clear() }, t } as ComponentProps<typeof ArtifactPromptContext>
    render(<ArtifactPromptContext {...props} />)
    expect(screen.getByRole('region', { name: 'Question context' }).getAttribute('data-artifact-prompt-context')).toBe('html-runtime')
    expect(screen.getByText(en['promptContext.program.state'])).toBeTruthy()
    act(() => { b.runtimes.actions.report(key, b.run, { status: 'error', error: { code: 'PROGRAM_ERROR', message: 'Broken' } }) })
    expect(screen.getByText(en['promptContext.program.error'])).toBeTruthy()
    act(() => { b.release() })
    expect(screen.getByRole('alert').textContent).toBe(en['promptContext.program.stale'])
    fireEvent.click(screen.getByRole('button', { name: 'Remove question context' }))
    expect(screen.queryByRole('region', { name: 'Question context' })).toBeNull()
  })

  it.each(['runtime-first', 'selection-first'] as const)('releases real owners in %s order without locating new sources during teardown', (order) => {
    const source = createSnapshotStore<typeof artifact | undefined>(artifact)
    const runtimes = new ArtifactRuntimeOwner(() => runtimeChannel(), 1000)
    let locatingAllowed = true
    const sourceFor = vi.fn(() => {
      if (!locatingAllowed) throw new Error('Source lookup after binding teardown began')
      return source
    })
    const runtimeFor = vi.fn((value: string) => {
      if (!locatingAllowed) throw new Error('Runtime lookup after binding teardown began')
      return runtimes.source(value)
    })
    const owner = new ArtifactInteractionOwner(sourceFor, { sessionId, runtimeFor })
    owners.push(owner, runtimes)
    const run = identity()
    runtimes.actions.mount(key, run)
    runtimes.actions.report(key, run, { status: 'ready', capabilities: { state: true, commands: [] } })
    runtimes.actions.state(key, run, { value: 1 })
    owner.chooseHtmlRuntime(key, artifact, run)
    const sourceReads = sourceFor.mock.calls.length
    const runtimeReads = runtimeFor.mock.calls.length
    locatingAllowed = false
    if (order === 'runtime-first') {
      expect(() => { runtimes.dispose() }).not.toThrow()
      expect(owner.selection.getSnapshot()).toMatchObject({ availability: 'stale' })
      expect(() => owner.capture('Unavailable')).toThrow('Unavailable')
      owner.dispose()
    } else {
      owner.dispose()
      expect(() => { runtimes.dispose() }).not.toThrow()
    }
    expect(sourceFor).toHaveBeenCalledTimes(sourceReads)
    expect(runtimeFor).toHaveBeenCalledTimes(runtimeReads)
    expect(owner.selection.getSnapshot()).toBeNull()
  })

  it('unsubscribes both prepared readers when selection is replaced or cleared', () => {
    const b = bench()
    receiveState(b, { value: 1 })
    const runtime = b.runtimes.source(key)
    const sourceReleases: Array<() => void> = []
    const runtimeReleases: Array<() => void> = []
    const owner = new ArtifactInteractionOwner(() => ({
      getSnapshot: () => b.source.getSnapshot(),
      subscribe: (listener) => {
        const unsubscribe = b.source.subscribe(listener)
        const release = vi.fn(() => { unsubscribe() })
        sourceReleases.push(release)
        return release
      },
    }), { sessionId, runtimeFor: () => ({
      getSnapshot: () => runtime.getSnapshot(),
      subscribe: (listener) => {
        const unsubscribe = runtime.subscribe(listener)
        const release = vi.fn(() => { unsubscribe() })
        runtimeReleases.push(release)
        return release
      },
    }) })
    owners.push(owner)
    owner.chooseHtmlRuntime(key, artifact, b.run)
    owner.chooseHtmlRuntime(key, artifact, b.run)
    expect(sourceReleases[0]).toHaveBeenCalledOnce()
    expect(runtimeReleases[0]).toHaveBeenCalledOnce()
    owner.clear()
    expect(sourceReleases[1]).toHaveBeenCalledOnce()
    expect(runtimeReleases[1]).toHaveBeenCalledOnce()
    b.release()
    b.source.set(undefined)
    expect(owner.selection.getSnapshot()).toBeNull()
  })

  it('shows distinct unsupported and missing-state guidance and can choose an error report without state', () => {
    const b = bench()
    const choose = vi.fn()
    const props: ComponentProps<typeof ArtifactCard> = { snapshot: artifact, origin: { kind: 'current' }, placement: 'inline',
      recordAction: vi.fn().mockResolvedValue(undefined), t,
      promptContext: { chooseCurrent: vi.fn(), chooseObservation: vi.fn(), chooseRuntime: choose },
      runtimeControls: { key, actions: { ...b.runtimes.actions, mount: () => () => {} }, snapshot: undefined } }
    const view = render(<ArtifactCard {...props} />)
    expect(screen.getByText(en['promptContext.program.waiting'])).toBeTruthy()
    expect(screen.getByRole('button', { name: en['promptContext.programAttach'] }).hasAttribute('disabled')).toBe(true)
    const current: ArtifactRuntimeSnapshot = { identity: b.run, host: 'pending', command: 'idle',
      report: { status: 'ready', capabilities: { state: false, commands: [] } } }
    view.rerender(<ArtifactCard {...props} runtimeControls={{ ...props.runtimeControls!, snapshot: current }} />)
    expect(screen.getByText(en['promptContext.program.unsupported'])).toBeTruthy()
    view.rerender(<ArtifactCard {...props} runtimeControls={{ ...props.runtimeControls!, snapshot: {
      ...current, report: { status: 'ready', capabilities: { state: true, commands: [] } },
    } }} />)
    expect(screen.getByText(en['promptContext.program.missing-state'])).toBeTruthy()
    view.rerender(<ArtifactCard {...props} runtimeControls={{ ...props.runtimeControls!, snapshot: {
      ...current, report: { status: 'error', error: { code: 'PROGRAM_ERROR', message: 'Broken' } },
    } }} />)
    const button = screen.getByRole('button', { name: en['promptContext.programAttach'] })
    expect(button.getAttribute('data-artifact-prompt-attach')).toBe('html-runtime')
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    expect(choose).toHaveBeenCalledExactlyOnceWith(b.run)
    expect(props.recordAction).not.toHaveBeenCalled()
  })
})
