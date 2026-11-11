import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactId } from '@agentrans/artifact/types'
import type { ArtifactRuntimeCommand, ArtifactRuntimeIdentity, ArtifactRuntimeId, RuntimeReport } from '@agentrans/artifact-runtime/types'
import { ArtifactRuntimeOwner } from '../src/client/runtime-owner.ts'
import { runtimeChannel } from './runtime-channel.client.ts'

const identity = (runtimeId = 'run-a', revision = 1): ArtifactRuntimeIdentity => ({ artifactId: 'demo' as ArtifactId,
  revision, runtimeId: runtimeId as ArtifactRuntimeId, renderer: 'html' })
const ready: RuntimeReport = { status: 'ready', capabilities: { state: true, commands: ['step'] } }
async function settle(): Promise<void> { for (let tick = 0; tick < 12; tick++) await Promise.resolve() }
afterEach(() => { vi.useRealTimers() })

describe('ArtifactRuntimeOwner', () => {
  it('keeps local readiness separate from actual Host acceptance and retains state only after declared readiness', async () => {
    const channel = runtimeChannel()
    const owner = new ArtifactRuntimeOwner(() => channel, 1000)
    const source = owner.source('node')
    const run = identity()
    const release = owner.actions.mount('node', run)
    owner.actions.state('node', run, { x: 1 })
    expect(source.getSnapshot()?.state).toBeUndefined()
    owner.actions.report('node', run, ready)
    expect(source.getSnapshot()).toMatchObject({ host: 'connecting', report: ready })
    await settle()
    expect(source.getSnapshot()).toMatchObject({ host: 'accepted', report: ready })
    owner.actions.state('node', run, { x: 2 })
    expect(source.getSnapshot()?.state).toEqual({ x: 2 })
    owner.actions.report('node', run, { status: 'error', error: { code: 'BROKEN', message: 'Needs correction' } })
    expect(source.getSnapshot()?.state).toBeUndefined()
    release()
    expect(source.getSnapshot()).toBeUndefined()
  })

  it('ignores replaced source reports and late cleanup without releasing the newer same-revision mount', async () => {
    const channels = [runtimeChannel(), runtimeChannel()]
    const owner = new ArtifactRuntimeOwner(() => channels.shift()!, 1000)
    const first = identity()
    const second = identity('run-b')
    const closeFirst = owner.actions.mount('node', first)
    const closeSecond = owner.actions.mount('node', second)
    closeFirst()
    owner.actions.report('node', first, ready)
    await settle()
    expect(owner.source('node').getSnapshot()).toMatchObject({ identity: second, report: { status: 'starting' } })
    owner.actions.report('node', second, ready)
    await settle()
    expect(owner.source('node').getSnapshot()?.report).toEqual(ready)
    closeSecond()
    owner.dispose()
  })

  it('requires a matching actual command acknowledgement and keeps failures visible', async () => {
    const owner = new ArtifactRuntimeOwner(() => runtimeChannel(), 1000)
    const dispatch = vi.fn<(requestId: string, command: ArtifactRuntimeCommand) => void>()
    const run = identity()
    owner.actions.mount('node', run, dispatch)
    await expect(owner.actions.command('node', 'step')).rejects.toThrow('unavailable')
    owner.actions.report('node', run, ready)
    await settle()
    const completion = owner.actions.command('node', 'step')
    expect(owner.source('node').getSnapshot()?.command).toBe('pending')
    const requestId = dispatch.mock.calls[0]?.[0]
    if (requestId === undefined) throw new Error('Expected the first dispatched command')
    owner.actions.message('node', run, { kind: 'artifact-runtime-command-result', identity: run,
      requestId: 'unrelated', result: { ok: true } })
    expect(owner.source('node').getSnapshot()?.command).toBe('pending')
    owner.actions.message('node', run, { kind: 'artifact-runtime-command-result', identity: run, requestId, result: { ok: true } })
    await completion
    expect(owner.source('node').getSnapshot()?.command).toBe('idle')
    const failed = owner.actions.command('node', 'step')
    const failedId = dispatch.mock.calls[1]?.[0]
    if (failedId === undefined) throw new Error('Expected the second dispatched command')
    owner.actions.message('node', run, { kind: 'artifact-runtime-command-result', identity: run, requestId: failedId,
      result: { ok: false, error: { code: 'COMMAND_FAILED', message: 'Handler failed' } } })
    await expect(failed).rejects.toThrow('Handler failed')
    expect(owner.source('node').getSnapshot()?.command).toBe('failed')
    owner.dispose()
  })

  it('bounds a missing acknowledgement and stops retaining ready after a carrier ends', async () => {
    vi.useFakeTimers()
    const channel = runtimeChannel()
    const owner = new ArtifactRuntimeOwner(() => channel, 50)
    const run = identity()
    owner.actions.mount('node', run, vi.fn())
    owner.actions.report('node', run, ready)
    await settle()
    const missing = owner.actions.command('node', 'step')
    const rejected = expect(missing).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    expect(owner.source('node').getSnapshot()?.command).toBe('failed')
    const inFlight = owner.actions.command('node', 'step')
    const disconnected = expect(inFlight).rejects.toThrow('released')
    channel.dispose()
    await settle()
    await disconnected
    expect(owner.source('node').getSnapshot()).toMatchObject({ host: 'unavailable', report: { status: 'starting' }, command: 'failed' })
    owner.actions.report('node', run, ready)
    expect(owner.source('node').getSnapshot()?.report.status).toBe('starting')
    owner.dispose()
  })

  it('does not reopen streams from callbacks retained after its Session binding was disposed', async () => {
    const open = vi.fn(() => runtimeChannel())
    const owner = new ArtifactRuntimeOwner(open, 50)
    owner.actions.mount('node', identity())
    owner.dispose()
    owner.actions.mount('node', identity('late'))
    owner.actions.report('node', identity('late'), ready)
    expect(open).toHaveBeenCalledOnce()
    expect(owner.source('node').getSnapshot()).toBeUndefined()
    await expect(owner.actions.command('node', 'step')).rejects.toThrow('released')
  })

  it('reports denied registration without pretending that the Host accepted a ready report', () => {
    const owner = new ArtifactRuntimeOwner(() => { throw Object.assign(new Error('Denied'), { code: 'remote-access/denied' }) }, 50)
    const run = identity()
    owner.actions.mount('node', run)
    owner.actions.report('node', run, ready)
    expect(owner.source('node').getSnapshot()).toMatchObject({ host: 'denied', report: { status: 'starting' } })
    owner.dispose()
  })
})
