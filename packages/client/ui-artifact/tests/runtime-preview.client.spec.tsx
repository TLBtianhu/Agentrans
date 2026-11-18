// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactId, ArtifactSnapshot } from '@agentrans/artifact/types'
import type { ArtifactRuntimeIdentity, ArtifactRuntimeId } from '@agentrans/artifact-runtime/types'
import type { ArtifactBfsCheckpoint, ArtifactHalfAdderCheckpoint } from '@agentrans/artifact/runtime-values'
import { ArtifactRuntimePreview } from '../src/client/ArtifactRuntimePreview.tsx'
import { ArtifactRuntimeOwner } from '../src/client/runtime-owner.ts'
import { runtimeChannel } from './runtime-channel.client.ts'

const snapshot: ArtifactSnapshot = { artifactId: 'preview' as ArtifactId, revision: 1, format: 'html',
  source: '<p>Old HTML without readiness callbacks</p>', title: 'Preview', presentation: 'inline' }
const checkpoint: ArtifactBfsCheckpoint = { kind: 'bfs-checkpoint', current: 'B', queue: ['C', 'D'], visited: ['A', 'B'] }
const restoration = { state: checkpoint, pendingText: 'Restoring', restoredText: 'Restored' }
const owners: ArtifactRuntimeOwner[] = []
afterEach(() => { cleanup(); for (const owner of owners) owner.dispose(); owners.length = 0; vi.restoreAllMocks(); vi.useRealTimers() })
function identityOf(frame: HTMLIFrameElement): ArtifactRuntimeIdentity {
  return { artifactId: snapshot.artifactId, revision: 1, renderer: 'html', runtimeId: frame.dataset.artifactRuntimeId as ArtifactRuntimeId }
}
async function settle(): Promise<void> { await act(async () => { for (let tick = 0; tick < 12; tick++) await Promise.resolve() }) }

describe('physical Artifact preview identity', () => {
  it('isolates the historical frame and waits for an exact same-instance restore acknowledgement', () => {
    const channel = vi.fn(() => runtimeChannel())
    const owner = new ArtifactRuntimeOwner(channel, 1000)
    owners.push(owner)
    const onFrame = vi.fn()
    render(<ArtifactRuntimePreview snapshot={snapshot} title="Preview" failedText="Failed" restoration={restoration}
      onFrame={onFrame} runtime={{ key: 'node', actions: owner.actions }} />)
    const frame = screen.getByTitle<HTMLIFrameElement>('Preview')
    const identity = identityOf(frame)
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    const acknowledgement = { kind: 'artifact-runtime-restored', identity, state: checkpoint }
    const send = (data: unknown, source: Window | null = frame.contentWindow): void => {
      act(() => { window.dispatchEvent(new MessageEvent('message', { source, data, origin: 'null' })) })
    }
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.hidden).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('Restoring')
    send(acknowledgement)
    expect(frame.hidden).toBe(true)
    fireEvent.load(frame)
    expect(post).toHaveBeenCalledExactlyOnceWith({ kind: 'artifact-runtime-restore', identity }, '*')
    send(acknowledgement, window)
    send({ ...acknowledgement, identity: { ...identity, runtimeId: 'old' } })
    send({ kind: 'artifact-runtime-state', identity, state: checkpoint })
    expect(frame.hidden).toBe(true)
    send(acknowledgement)
    expect(frame.hidden).toBe(false)
    expect(screen.getByRole('status').textContent).toBe('Restored')
    expect(owner.source('node').getSnapshot()).toBeUndefined()
    expect(channel).not.toHaveBeenCalled()
    expect(onFrame).not.toHaveBeenCalled()
    fireEvent.load(frame)
    expect(screen.getByRole('alert').textContent).toBe('Failed')
    expect(screen.queryByTitle('Preview')).toBeNull()
  })

  it('reports only verified same-frame replay checkpoints to the opt-in owner and clears them when the frame closes', () => {
    const onCheckpoint = vi.fn()
    const props = { snapshot, title: 'Preview', failedText: 'Failed', restoration: { ...restoration, onCheckpoint } }
    const first = render(<ArtifactRuntimePreview {...props} />)
    const frame = screen.getByTitle<HTMLIFrameElement>('Preview')
    const frameWindow = frame.contentWindow
    const identity = identityOf(frame)
    const next: ArtifactBfsCheckpoint = { kind: 'bfs-checkpoint', current: 'C', queue: ['D'], visited: ['A', 'B', 'C'] }
    const report = { kind: 'artifact-runtime-replay-state', identity, state: next }
    const send = (data: unknown, source: Window | null = frameWindow, origin = 'null'): void => {
      act(() => { window.dispatchEvent(new MessageEvent('message', { source, data, origin })) })
    }
    fireEvent.load(frame)
    send(report)
    expect(onCheckpoint).not.toHaveBeenCalled()
    send({ kind: 'artifact-runtime-restored', identity, state: checkpoint })
    expect(onCheckpoint).toHaveBeenCalledExactlyOnceWith(checkpoint)
    send(report, window)
    send(report, frameWindow, 'https://another-origin.test')
    send({ ...report, identity: { ...identity, runtimeId: 'stale' } })
    send({ ...report, kind: 'artifact-runtime-state' })
    send({ ...report, state: { ...next, queue: ['D', 'D'] } })
    expect(onCheckpoint).toHaveBeenCalledTimes(1)
    send(report)
    send(report)
    expect(onCheckpoint.mock.calls).toEqual([[checkpoint], [next]])
    expect(checkpoint).toEqual({ kind: 'bfs-checkpoint', current: 'B', queue: ['C', 'D'], visited: ['A', 'B'] })
    first.unmount()
    expect(onCheckpoint.mock.calls).toEqual([[checkpoint], [next], [null]])
    send(report)
    expect(onCheckpoint).toHaveBeenCalledTimes(3)
  })

  it('invalidates an opted-in checkpoint on runtime failure', () => {
    const onCheckpoint = vi.fn()
    render(<ArtifactRuntimePreview snapshot={snapshot} title="Preview" failedText="Failed"
      restoration={{ ...restoration, onCheckpoint }} />)
    const frame = screen.getByTitle<HTMLIFrameElement>('Preview')
    const identity = identityOf(frame)
    const send = (data: unknown): void => {
      act(() => { window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data, origin: 'null' })) })
    }
    fireEvent.load(frame)
    send({ kind: 'artifact-runtime-restored', identity, state: checkpoint })
    send({ kind: 'artifact-runtime-report', identity, report: { status: 'error', error: { code: 'INVALID_STATE', message: 'Invalid sample' } } })
    expect(onCheckpoint.mock.calls).toEqual([[checkpoint], [null]])
    expect(screen.getByRole('alert').textContent).toBe('Failed')
  })

  it('binds restored half-adder readings to the original kind', () => {
    const onCheckpoint = vi.fn()
    const state: ArtifactHalfAdderCheckpoint = { kind: 'half-adder-checkpoint', a: 1, b: 1, sum: 0, carry: 1 }
    render(<ArtifactRuntimePreview snapshot={snapshot} title="Preview" failedText="Failed"
      restoration={{ ...restoration, state, onCheckpoint }} />)
    const frame = screen.getByTitle<HTMLIFrameElement>('Preview')
    const identity = identityOf(frame)
    const send = (kind: string, reading: unknown): void => {
      const data = { kind, identity, state: reading }
      act(() => { window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data, origin: 'null' })) })
    }
    fireEvent.load(frame)
    send('artifact-runtime-restored', state)
    send('artifact-runtime-replay-state', checkpoint)
    send('artifact-runtime-replay-state', { ...state, carry: 0 })
    expect(onCheckpoint).toHaveBeenCalledExactlyOnceWith(state)
    const next = { ...state, b: 0, sum: 1, carry: 0 }
    send('artifact-runtime-replay-state', next)
    expect(onCheckpoint.mock.calls).toEqual([[state], [next]])
  })

  it('unmounts a historical frame after a different checkpoint or missing response', () => {
    vi.useFakeTimers()
    const props = { snapshot, title: 'Preview', failedText: 'Failed', restoration: { ...restoration, timeoutMs: 50 } }
    const first = render(<ArtifactRuntimePreview {...props} />)
    const frame = screen.getByTitle<HTMLIFrameElement>('Preview')
    fireEvent.load(frame)
    act(() => { window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin: 'null', data: {
      kind: 'artifact-runtime-restored', identity: identityOf(frame), state: { ...checkpoint, queue: ['D', 'C'] },
    } })) })
    expect(screen.getByRole('alert').textContent).toBe('Failed')
    expect(screen.queryByTitle('Preview')).toBeNull()
    first.unmount()
    render(<ArtifactRuntimePreview {...props} />)
    expect(screen.getByRole('status').textContent).toBe('Restoring')
    act(() => { vi.advanceTimersByTime(50) })
    expect(screen.getByRole('alert').textContent).toBe('Failed')
    expect(screen.queryByTitle('Preview')).toBeNull()
  })

  it('does not turn an iframe load into readiness and rejects another frame or runtime token', async () => {
    const owner = new ArtifactRuntimeOwner(() => runtimeChannel(), 1000)
    owners.push(owner)
    render(<ArtifactRuntimePreview snapshot={snapshot} title="Preview" failedText="Failed"
      runtime={{ key: 'node', actions: owner.actions }} />)
    const frame = screen.getByTitle<HTMLIFrameElement>('Preview')
    const identity = identityOf(frame)
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    fireEvent.load(frame)
    expect(post).toHaveBeenCalledWith({ kind: 'artifact-runtime-request-status', identity }, '*')
    await settle()
    expect(owner.source('node').getSnapshot()?.report.status).toBe('starting')
    const report = { kind: 'artifact-runtime-report', identity, report: { status: 'ready', capabilities: { state: false, commands: [] } } }
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { source: window, data: report }))
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow,
        data: { ...report, identity: { ...identity, runtimeId: 'old-token' } } }))
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { kind: 'artifact-state', state: { x: 1 } } }))
    })
    expect(owner.source('node').getSnapshot()?.report.status).toBe('starting')
    act(() => { window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: report })) })
    await settle()
    expect(owner.source('node').getSnapshot()).toMatchObject({ host: 'accepted', report: { status: 'ready' } })
  })

  it('releases a removed preview and uses a new identity when the same source is opened again', async () => {
    const firstChannel = runtimeChannel()
    const dispose = vi.spyOn(firstChannel, 'dispose')
    const owner = new ArtifactRuntimeOwner(() => firstChannel, 1000)
    owners.push(owner)
    const props = { snapshot, title: 'Preview', failedText: 'Failed', runtime: { key: 'node', actions: owner.actions } }
    const first = render(<ArtifactRuntimePreview {...props} />)
    const oldFrame = screen.getByTitle<HTMLIFrameElement>('Preview')
    const oldIdentity = identityOf(oldFrame)
    const oldWindow = oldFrame.contentWindow
    first.unmount()
    expect(dispose).toHaveBeenCalledOnce()
    expect(owner.source('node').getSnapshot()).toBeUndefined()
    render(<ArtifactRuntimePreview {...props} />)
    const current = screen.getByTitle<HTMLIFrameElement>('Preview')
    expect(identityOf(current).runtimeId).not.toBe(oldIdentity.runtimeId)
    act(() => { window.dispatchEvent(new MessageEvent('message', { source: oldWindow,
      data: { kind: 'artifact-runtime-report', identity: oldIdentity, report: { status: 'ready', capabilities: { state: false, commands: [] } } } })) })
    expect(owner.source('node').getSnapshot()?.report.status).toBe('starting')
    await settle()
  })
})
