import { chmod, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@agentrans/cordis'
import AgentRegistry, { type Agent } from '@agentrans/agent'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from '@agentrans/session'
import SessionProjectionRegistry from '@agentrans/session-projection'
import LocalAttachmentStore from '@agentrans/attachment-local'
import { AttachmentError } from '@agentrans/attachment'
import ArtifactService from '@agentrans/artifact'
import type { ArtifactId, ArtifactObservationId, ArtifactPlotContinuation, SceneArtifactSnapshot } from '@agentrans/artifact/types'
import type { FunctionPlotSpec, ParticleSystemSpec } from '@agentrans/artifact/scene'
import { analyzeFunctionPlotSelection } from '@agentrans/artifact/scene-renderers'
import ArtifactExports, { type Config } from '../src/index.ts'
import type { ArtifactExportId, ArtifactHtmlExportRequest } from '../src/types.ts'
import { recordSchema } from '../src/schema.ts'

const contexts: Context[] = []
const roots: string[] = []
let sequence = 0
const id = 'particles' as ArtifactId
const source: ParticleSystemSpec = {
  kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 1, vx: 3, vy: 8, mass: 1 }],
  gravity: { x: 0, y: -9.8 }, timeStep: 1 / 30, trails: true,
}
const checkpoint = { runtimeVersion: 1 as const, stepCount: 6 }
function request(value = 'export-a'): ArtifactHtmlExportRequest {
  return { exportId: value as ArtifactExportId, format: 'html', source: { kind: 'current', artifactId: id, revision: 1, checkpoint } }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3 })
  vi.restoreAllMocks()
})

async function setup(config: Config = {}, seed?: readonly SessionEvent[], dshHome?: string, title = 'Saved experiment A') {
  const root = dshHome ?? await mkdtemp(join(tmpdir(), 'dsh-artifact-export-'))
  if (dshHome === undefined) roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  await ctx.plugin(ArtifactService)
  const fiber = ctx.plugin(ArtifactExports, config)
  await fiber
  const sessionId = SessionId(`artifact-export-${String(++sequence).padStart(6, '0')}`)
  const session = ctx.sessions.create(sessionId, seed === undefined ? {} : { seed })
  const steer = vi.fn()
  const inject = vi.fn()
  const agent = {
    id: sessionId, session, ctx,
    steer: (...args: Parameters<Agent['steer']>): void => { steer(...args) },
    inject: (...args: Parameters<Agent['inject']>): void => { inject(...args) },
  } as Agent
  ctx.agents.enter(agent, undefined)
  const flush = vi.fn(() => Promise.resolve())
  ctx.on('session/flush', flush)
  if (seed === undefined) ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
    action: 'create', artifactId: id, title, presentation: 'inline', format: 'scene', spec: source,
  }))
  return { ctx, agent, session, service: ctx.artifactExports, fiber, flush, root, steer, inject }
}

function revise(ctx: Context, agent: Agent) {
  ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
    action: 'update', artifactId: id, title: 'Changed experiment B', presentation: 'inline', format: 'scene', baseRevision: 1,
    spec: { ...source, particles: [{ ...source.particles[0]!, x: 100 }] },
  }))
}

function records(ctx: Context, agent: Agent) {
  return ctx.sessionProjections.snapshot(agent.session).values.artifactExports
}

function continuedPlot(ctx: Context, agent: Agent) {
  const spec: FunctionPlotSpec = {
    kind: 'function-plot',
    functions: [
      { id: 'line', label: 'Reference line', expression: 'x' },
      { id: 'quadratic', label: 'Selected quadratic', expression: 'a*x^2' },
    ],
    parameters: { a: { value: 1, min: 1, max: 3, step: 0.25 } },
    viewport: { x: [-2, 2], y: [-2, 6] }, trace: { x: 0, derivative: true, integral: true },
  }
  const conditions = { functionId: 'quadratic', x: 3, parameters: { a: 1.25 } }
  const values = analyzeFunctionPlotSelection(spec, conditions)
  if (values === undefined) throw new Error('Expected valid locked conditions')
  const baseline = { ...conditions, values }
  const artifact: SceneArtifactSnapshot = {
    artifactId: 'continued-plot' as ArtifactId, revision: 1, title: 'Continued experiment', format: 'scene', presentation: 'inline', spec,
    continuation: {
      source: { sessionId: SessionId('returned-plot'), eventSeq: SessionSeq(3),
        messageId: 'plot-return' as ArtifactPlotContinuation['source']['messageId'], artifactId: 'original-plot' as ArtifactId, revision: 1 },
      baseline,
    },
  }
  ctx.artifacts.commit(agent, artifact)
  return { artifact, baseline, spec }
}

function plotExportOrigin(bytes: Uint8Array): unknown {
  const html = Buffer.from(bytes).toString('utf8')
  const origin = /<script type="application\/json" id="artifact-export-origin-data">([^<]+)<\/script>/u.exec(html)?.[1]
  if (origin === undefined) throw new Error('Expected a frozen source in the export')
  return JSON.parse(origin)
}

describe('fixed-input HTML exports', () => {
  it('stores original saved source and exact replay point, then reads the same file after cold replay', async () => {
    const { ctx, agent, session, service, root, steer, inject } = await setup()
    const observationId = 'a' as ArtifactObservationId
    ctx.artifacts.saveObservation(agent, id, 1, observationId, 'A', checkpoint)
    revise(ctx, agent)
    const savedRequest: ArtifactHtmlExportRequest = {
      exportId: 'saved-a' as ArtifactExportId, format: 'html', source: { kind: 'observation', artifactId: id, observationId },
    }
    const record = await service.create(agent, savedRequest)
    expect(record).toMatchObject({ status: 'ready', request: savedRequest,
      frozen: { artifact: { revision: 1, title: 'Saved experiment A', spec: source }, checkpoint, observationId,
        sessionId: agent.session.id, exporterVersion: 1, parameters: 'particle-checkpoint' } })
    const bytes = await service.read(agent, savedRequest.exportId)
    const html = Buffer.from(bytes).toString('utf8')
    expect(html).toContain('artifact-export-origin-data')
    expect(html).toContain('Saved experiment A')
    expect(html).not.toContain('Changed experiment B')
    expect(html).toContain('"stepCount":6')
    expect(records(ctx, agent)).toEqual({ [savedRequest.exportId]: record })
    expect(ctx.sessionProjections.summaryKeys().has('artifactExports')).toBe(false)
    expect(steer).not.toHaveBeenCalled()
    expect(inject).not.toHaveBeenCalled()
    expect(session.snapshotEvents().filter(event => event.type === 'artifact/export').map(event => event.data.status)).toEqual(['pending', 'ready'])
    const restored = await setup({}, session.snapshotEvents(), root)
    expect(records(restored.ctx, restored.agent)).toEqual(records(ctx, agent))
    await expect(restored.service.read(restored.agent, savedRequest.exportId)).resolves.toEqual(bytes)
    await expect(restored.service.create(restored.agent, savedRequest)).resolves.toEqual(record)
  })

  it('freezes a current source before asynchronous storage and coalesces concurrent identical requests', async () => {
    const { ctx, agent, service, session } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const store = ctx.attachments.saveFile.bind(ctx.attachments)
    const save = vi.spyOn(ctx.attachments, 'saveFile').mockImplementation(async (input) => {
      entered.resolve(undefined)
      await release.promise
      return store(input)
    })
    const first = service.create(agent, request())
    await entered.promise
    expect(records(ctx, agent)?.['export-a']?.status).toBe('pending')
    revise(ctx, agent)
    const second = service.create(agent, request())
    release.resolve(undefined)
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(a.frozen.artifact.revision).toBe(1)
    expect(a.frozen.artifact.spec).toMatchObject(source)
    expect(save).toHaveBeenCalledTimes(1)
    await expect(service.create(agent, request())).resolves.toEqual(a)
    expect(save).toHaveBeenCalledTimes(1)
    expect(session.snapshotEvents().filter(event => event.type === 'artifact/export')).toHaveLength(2)
    await expect(service.create(agent, { ...request(), source: { kind: 'current', artifactId: id, revision: 2, checkpoint } }))
      .rejects.toMatchObject({ code: 'artifact-export/request-conflict' })
    await expect(service.create(agent, request('new-stale'))).rejects.toMatchObject({ code: 'artifact-export/source-unavailable', details: { reason: 'STALE_REVISION' } })
  })

  it('exports an exact earlier revision after cold replay', async () => {
    const { ctx, agent, session, root } = await setup()
    revise(ctx, agent)
    const restored = await setup({}, session.snapshotEvents(), root)
    const selected = {
      exportId: 'original-revision' as ArtifactExportId, format: 'html', source: { kind: 'revision', artifactId: id, revision: 1 },
    } satisfies ArtifactHtmlExportRequest
    const result = await restored.service.create(restored.agent, selected)
    expect(result).toMatchObject({ status: 'ready', request: selected,
      frozen: { artifact: { title: 'Saved experiment A', revision: 1 }, checkpoint: { stepCount: 0 } } })
    expect(Buffer.from(await restored.service.read(restored.agent, selected.exportId)).toString('utf8')).not.toContain('Changed experiment B')
    await expect(restored.service.create(restored.agent, { ...selected, source: { ...selected.source, revision: 2 } }))
      .rejects.toMatchObject({ code: 'artifact-export/request-conflict' })
    await expect(restored.service.create(restored.agent, { ...selected, exportId: 'unknown-revision' as ArtifactExportId,
      source: { ...selected.source, revision: 3 } })).rejects.toMatchObject({ code: 'artifact-export/source-unavailable', details: { reason: 'NOT_FOUND' } })
  })

  it('leaves a failed admission flush pending and only an explicit retry continues the frozen source', async () => {
    const { ctx, agent, service, flush } = await setup()
    const save = vi.spyOn(ctx.attachments, 'saveFile')
    flush.mockRejectedValueOnce(new Error('storage barrier failed'))
    await expect(service.create(agent, request())).rejects.toThrow('storage barrier failed')
    expect(records(ctx, agent)?.['export-a']?.status).toBe('pending')
    expect(save).not.toHaveBeenCalled()
    revise(ctx, agent)
    const restored = await setup({}, agent.session.snapshotEvents())
    expect(records(restored.ctx, restored.agent)?.['export-a']?.status).toBe('pending')
    await expect(service.create(agent, request())).resolves.toMatchObject({ status: 'ready', frozen: { artifact: { revision: 1 } } })
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('restores the locked function and parameters of a pending continuation after its source evolves', async () => {
    const { ctx, agent, service, session, root, flush } = await setup()
    const { artifact, baseline, spec } = continuedPlot(ctx, agent)
    const source = { kind: 'current', artifactId: artifact.artifactId, revision: 1 } as const
    const request: ArtifactHtmlExportRequest = { exportId: 'continued-pending' as ArtifactExportId, format: 'html', source }
    flush.mockRejectedValueOnce(new Error('pending flush failed'))
    await expect(service.create(agent, request)).rejects.toThrow('pending flush failed')
    const pending = records(ctx, agent)?.[request.exportId]
    expect(pending).toMatchObject({ status: 'pending', frozen: { exporterVersion: 2, parameters: 'function-plot-baseline',
      functionPlotBaseline: baseline, artifact: { revision: 1, spec } } })
    ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
      action: 'update', artifactId: artifact.artifactId, title: 'Evolved experiment', presentation: 'inline', format: 'scene', baseRevision: 1,
      spec: { ...spec, parameters: { a: { ...spec.parameters['a']!, value: 2 } } },
    }))
    const restored = await setup({}, session.snapshotEvents(), root)
    expect(records(restored.ctx, restored.agent)?.[request.exportId]).toEqual(pending)
    const ready = await restored.service.create(restored.agent, request)
    expect(ready).toMatchObject({ status: 'ready', frozen: pending?.frozen })
    expect(plotExportOrigin(await restored.service.read(restored.agent, request.exportId))).toMatchObject({
      exportId: request.exportId, sessionId: session.id, artifactId: artifact.artifactId, revision: 1,
      exporterVersion: 2, functionPlotBaseline: baseline,
    })
    const historical: ArtifactHtmlExportRequest = { ...request, exportId: 'continued-historical' as ArtifactExportId,
      source: { ...source, kind: 'revision' } }
    await expect(restored.service.create(restored.agent, historical)).resolves.toMatchObject({
      status: 'ready', frozen: { exporterVersion: 2, artifact: { revision: 1, spec }, functionPlotBaseline: baseline },
    })
    await expect(restored.service.create(restored.agent, { ...request, exportId: 'evolved' as ArtifactExportId,
      source: { ...source, revision: 2 } })).resolves.toMatchObject({
      status: 'ready', frozen: { exporterVersion: 1, parameters: 'source-defaults', artifact: { revision: 2 } },
    })
  })

  it('preserves source defaults when reopening a version 1 continuation export', async () => {
    const { ctx, agent, session, root } = await setup()
    const { artifact } = continuedPlot(ctx, agent)
    const request: ArtifactHtmlExportRequest = { exportId: 'legacy-plot' as ArtifactExportId, format: 'html',
      source: { kind: 'current', artifactId: artifact.artifactId, revision: 1 } }
    session.append('artifact/export', { request, status: 'pending',
      frozen: { sessionId: session.id, artifact, exporterVersion: 1, parameters: 'source-defaults' } })
    const restored = await setup({}, session.snapshotEvents(), root)
    const ready = await restored.service.create(restored.agent, request)
    expect(ready).toMatchObject({ status: 'ready', frozen: { exporterVersion: 1, parameters: 'source-defaults' } })
    const bytes = await restored.service.read(restored.agent, request.exportId)
    const origin = plotExportOrigin(bytes)
    expect(origin).toEqual({ exporterVersion: 1, exportId: request.exportId, sessionId: session.id,
      artifactId: artifact.artifactId, revision: 1 })
  })

  it('rejects incompatible versions and unverified function plot baselines in the stored record', async () => {
    const { ctx, agent, service } = await setup()
    const { artifact, baseline } = continuedPlot(ctx, agent)
    const record = await service.create(agent, { exportId: 'schema-plot' as ArtifactExportId, format: 'html',
      source: { kind: 'current', artifactId: artifact.artifactId, revision: 1 } })
    expect(recordSchema.parse(record)).toEqual(record)
    for (const invalid of [
      { exporterVersion: 1 },
      { parameters: 'source-defaults' },
      { functionPlotBaseline: undefined },
      { functionPlotBaseline: { ...baseline, functionId: 'missing' } },
      { functionPlotBaseline: { ...baseline, values: { ...baseline.values, derivative: 0 } } },
    ]) {
      expect(recordSchema.safeParse({ ...record, frozen: { ...record.frozen, ...invalid } }).success).toBe(false)
    }
  })

  it('recovers a file-ready receipt after its flush response fails without regenerating the file', async () => {
    const { ctx, agent, service, flush } = await setup()
    const save = vi.spyOn(ctx.attachments, 'saveFile')
    flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('ready flush failed'))
    await expect(service.create(agent, request())).rejects.toThrow('ready flush failed')
    expect(records(ctx, agent)?.['export-a']?.status).toBe('ready')
    revise(ctx, agent)
    await expect(service.create(agent, request())).resolves.toMatchObject({ status: 'ready', frozen: { artifact: { revision: 1 } } })
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('retains terminal output and storage failures and refuses extra identities without evicting facts', async () => {
    const small = await setup({ maxOutputBytes: 1, maxExportsPerSession: 1 })
    const saveSmall = vi.spyOn(small.ctx.attachments, 'saveFile')
    const failed = await small.service.create(small.agent, request())
    expect(failed).toMatchObject({ status: 'failed', failure: 'OUTPUT_TOO_LARGE', frozen: { artifact: { revision: 1 } } })
    await expect(small.service.create(small.agent, request())).resolves.toEqual(failed)
    expect(saveSmall).not.toHaveBeenCalled()
    await expect(small.service.create(small.agent, request('extra'))).rejects.toMatchObject({ code: 'artifact-export/limit', details: { limit: 1 } })
    expect(Object.keys(records(small.ctx, small.agent) ?? {})).toEqual(['export-a'])
    const storage = await setup()
    const save = vi.spyOn(storage.ctx.attachments, 'saveFile').mockRejectedValue(new AttachmentError('Disk unavailable', 'ATTACHMENT_WRITE_FAILED'))
    const storedFailure = await storage.service.create(storage.agent, request())
    expect(storedFailure).toMatchObject({ status: 'failed', failure: 'STORAGE_FAILED' })
    await expect(storage.service.create(storage.agent, request())).resolves.toEqual(storedFailure)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('exports other Scenes with explicit source defaults and rejects HTML or missing replay conditions', async () => {
    const { ctx, agent, service } = await setup()
    const plot = 'plot' as ArtifactId
    ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
      action: 'create', artifactId: plot, title: 'Timeline', presentation: 'inline', format: 'scene',
      spec: { kind: 'timeline', events: [{ id: 'start', time: 0, label: 'Start' }] },
    }))
    await expect(service.create(agent, { ...request(), source: { kind: 'current', artifactId: plot, revision: 1 } }))
      .resolves.toMatchObject({ status: 'ready', frozen: { parameters: 'source-defaults' } })
    ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
      action: 'create', artifactId: 'html', title: 'HTML', source: '<p>Custom</p>', presentation: 'inline',
    }))
    await expect(service.create(agent, { ...request('unsupported'), source: { kind: 'current', artifactId: 'html' as ArtifactId, revision: 1 } }))
      .rejects.toMatchObject({ code: 'artifact-export/source-unavailable', details: { reason: 'UNSUPPORTED_SOURCE' } })
    await expect(service.create(agent, { ...request('no-checkpoint'), source: { kind: 'current', artifactId: id, revision: 1 } }))
      .rejects.toMatchObject({ code: 'artifact-export/source-unavailable', details: { reason: 'INVALID_CHECKPOINT' } })
  })

  it('rejects missing or corrupted file reads without rewriting the ready generation record', async () => {
    const { ctx, agent, service } = await setup()
    await expect(service.read(agent, 'missing' as ArtifactExportId)).rejects.toMatchObject({ code: 'artifact-export/not-ready' })
    const record = await service.create(agent, request())
    if (record.status !== 'ready') throw new Error('Expected a ready fixture')
    const path = ctx.attachments.fileHostPath(record.file)
    if (path === undefined) throw new Error('Expected local attachment path')
    await chmod(path, 0o600)
    await writeFile(path, 'corrupt')
    await expect(service.read(agent, request().exportId)).rejects.toMatchObject({ code: 'artifact-export/file-unavailable' })
    expect(records(ctx, agent)?.['export-a']).toEqual(record)
    await unlink(path)
    await expect(service.read(agent, request().exportId)).rejects.toMatchObject({ code: 'artifact-export/file-unavailable' })
  })

  it('authorizes result reads from the addressed Session rather than a supplied or guessed file reference', async () => {
    const { ctx, agent, service } = await setup()
    const record = await service.create(agent, request())
    const session = ctx.sessions.create(SessionId(`foreign-export-${++sequence}`))
    const foreign = { id: session.id, session, ctx } as Agent
    ctx.agents.enter(foreign, undefined)
    await expect(service.read(foreign, request().exportId)).rejects.toMatchObject({ code: 'artifact-export/not-ready' })
    await expect(service.read(agent, request().exportId)).resolves.toHaveLength(record.status === 'ready' ? record.file.bytes : 0)
    expect(records(ctx, foreign)).toEqual({})
  })

  it('accepts valid identities that also name JavaScript prototype members', async () => {
    const { ctx, agent, service } = await setup()
    const artifactId = 'constructor' as ArtifactId
    await expect(service.create(agent, {
      ...request('constructor'), source: { kind: 'observation', artifactId, observationId: 'absent' as ArtifactObservationId },
    })).rejects.toMatchObject({ code: 'artifact-export/source-unavailable', details: { reason: 'NOT_FOUND' } })
    ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
      action: 'create', artifactId, title: 'Constructor experiment', presentation: 'inline', format: 'scene', spec: source,
    }))
    const selected: ArtifactHtmlExportRequest = { ...request('constructor'), source: { kind: 'current', artifactId, revision: 1, checkpoint } }
    const record = await service.create(agent, selected)
    expect(record).toMatchObject({ status: 'ready', frozen: { artifact: { artifactId } } })
    await expect(service.create(agent, selected)).resolves.toEqual(record)
    await expect(service.read(agent, selected.exportId)).resolves.toHaveLength(record.status === 'ready' ? record.file.bytes : 0)
  })

  it('restores a pending checkpoint and its ready suffix without running generation or file reads', async () => {
    const { ctx, agent, service, session } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const store = ctx.attachments.saveFile.bind(ctx.attachments)
    const save = vi.spyOn(ctx.attachments, 'saveFile').mockImplementation(async (input) => {
      entered.resolve(undefined)
      await release.promise
      return store(input)
    })
    const read = vi.spyOn(ctx.attachments, 'readFileStream')
    const operation = service.create(agent, request())
    await entered.promise
    const rows = ctx.sessionProjections.checkpoint(session)
    const offset = session.snapshotEvents().length
    release.resolve(undefined)
    await operation
    const events = session.snapshotEvents()
    const suffix = ctx.sessionProjections.restore(
      rows, events.slice(offset), SessionLogOffset(offset), session.header, session.inheritedEventCount,
    )
    const full = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), session.header, session.inheritedEventCount)
    expect(suffix.snapshot).toEqual(full.snapshot)
    expect(suffix.snapshot.values.artifactExports?.['export-a']?.status).toBe('ready')
    expect(save).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()
  })

  it('checks the complete UTF-8 HTML budget at its exact byte boundary', async () => {
    const reference = await setup()
    const record = await reference.service.create(reference.agent, request())
    if (record.status !== 'ready') throw new Error('Expected a ready reference')
    const exact = await setup({ maxOutputBytes: record.file.bytes })
    await expect(exact.service.create(exact.agent, request())).resolves.toMatchObject({ status: 'ready', file: { bytes: record.file.bytes } })
    const insufficient = await setup({ maxOutputBytes: record.file.bytes - 1 })
    await expect(insufficient.service.create(insufficient.agent, request())).resolves.toMatchObject({ status: 'failed', failure: 'OUTPUT_TOO_LARGE' })
  })

  it('bounds the complete multibyte frozen input before writing any export event or file', async () => {
    const title = '原始实验 😀'
    const reference = await setup({}, undefined, undefined, title)
    const record = await reference.service.create(reference.agent, request())
    const pendingJson = JSON.stringify({ request: record.request, frozen: record.frozen, status: 'pending' })
    const inputBytes = Buffer.byteLength(pendingJson, 'utf8')
    expect(inputBytes).toBeGreaterThan(pendingJson.length)
    const exact = await setup({ maxInputBytes: inputBytes }, undefined, undefined, title)
    await expect(exact.service.create(exact.agent, request())).resolves.toMatchObject({ status: 'ready' })
    const insufficient = await setup({ maxInputBytes: inputBytes - 1 }, undefined, undefined, title)
    const store = vi.spyOn(insufficient.ctx.attachments, 'saveFile')
    await expect(insufficient.service.create(insufficient.agent, request()))
      .rejects.toMatchObject({ code: 'artifact-export/input-too-large', details: { limit: inputBytes - 1 } })
    expect(records(insufficient.ctx, insufficient.agent)).toEqual({})
    expect(insufficient.session.snapshotEvents().some(event => event.type === 'artifact/export')).toBe(false)
    expect(store).not.toHaveBeenCalled()
  })

  it('continues an existing frozen input and returns its receipt after the admission limit is lowered', async () => {
    const { ctx, agent, service, fiber, flush } = await setup()
    flush.mockRejectedValueOnce(new Error('pending flush failed'))
    await expect(service.create(agent, request())).rejects.toThrow('pending flush failed')
    const frozen = records(ctx, agent)?.['export-a']?.frozen
    revise(ctx, agent)
    await fiber.dispose()
    await ctx.plugin(ArtifactExports, { maxInputBytes: 1 })
    const record = await ctx.artifactExports.create(agent, request())
    expect(record).toMatchObject({ status: 'ready', frozen })
    await expect(ctx.artifactExports.create(agent, request())).resolves.toEqual(record)
    await expect(ctx.artifactExports.create(agent, {
      ...request('new-over-limit'), source: { kind: 'current', artifactId: id, revision: 2, checkpoint },
    })).rejects.toMatchObject({ code: 'artifact-export/input-too-large', details: { limit: 1 } })
  })

  it('rejects persisted particle records without their replay checkpoint', async () => {
    const { agent, service } = await setup()
    const record = await service.create(agent, request())
    const invalid = { ...record, frozen: { ...record.frozen, checkpoint: undefined } }
    expect(recordSchema.safeParse(invalid).success).toBe(false)
  })

  it('joins admitted storage work when the export plugin is disposed', async () => {
    const { ctx, agent, service, fiber } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const store = ctx.attachments.saveFile.bind(ctx.attachments)
    vi.spyOn(ctx.attachments, 'saveFile').mockImplementation(async (input) => {
      entered.resolve(undefined)
      await release.promise
      return store(input)
    })
    const operation = service.create(agent, request())
    await entered.promise
    const disposed = vi.fn()
    const dispose = fiber.dispose().then(disposed)
    expect(disposed).not.toHaveBeenCalled()
    release.resolve(undefined)
    await expect(operation).resolves.toMatchObject({ status: 'ready' })
    await dispose
    expect(disposed).toHaveBeenCalledTimes(1)
    await expect(service.create(agent, request('later'))).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(ctx.sessionProjections.snapshot(agent.session).values.artifactExports).toBeUndefined()
  })
})
