// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactId, ArtifactSnapshot } from '@agentrans/artifact/types'
import type { ArtifactRuntimeIdentity, ArtifactRuntimeId } from '@agentrans/artifact-runtime/types'
import { ArtifactRuntimePreview } from '../src/client/ArtifactRuntimePreview.tsx'
import { ArtifactRuntimeOwner } from '../src/client/runtime-owner.ts'
import { runtimeChannel } from './runtime-channel.client.ts'

const snapshot: ArtifactSnapshot = { artifactId: 'preview' as ArtifactId, revision: 1, format: 'html',
  source: '<p>Old HTML without readiness callbacks</p>', title: 'Preview', presentation: 'inline' }
const owners: ArtifactRuntimeOwner[] = []
afterEach(() => { cleanup(); for (const owner of owners) owner.dispose(); owners.length = 0; vi.restoreAllMocks() })
function identityOf(frame: HTMLIFrameElement): ArtifactRuntimeIdentity {
  return { artifactId: snapshot.artifactId, revision: 1, renderer: 'html', runtimeId: frame.dataset.artifactRuntimeId as ArtifactRuntimeId }
}
async function settle(): Promise<void> { await act(async () => { for (let tick = 0; tick < 12; tick++) await Promise.resolve() }) }

describe('physical Artifact preview identity', () => {
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
