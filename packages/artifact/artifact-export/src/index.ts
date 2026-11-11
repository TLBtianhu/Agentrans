/** Fixed-input HTML generation with Session-owned result records and immutable file storage. @module @agentrans/artifact-export */
import { Buffer } from 'node:buffer'
import { Context, Service } from '@agentrans/cordis'
import z from '@agentrans/schemastery'
import type { Agent } from '@agentrans/agent'
import type { Session } from '@agentrans/session'
import { ArtifactError, type ArtifactService } from '@agentrans/artifact'
import { ParticleRuntimeError } from '@agentrans/artifact/particle-runtime'
import { buildSceneAnimationHtml, SCENE_EXPORTER_VERSION } from '@agentrans/artifact/scene-export'
import { isAttachmentError } from '@agentrans/attachment'
import type { ProjectionDefinition, ProjectionHandle } from '@agentrans/session-projection'
import { Remote, RemoteError, TypertRemoteService } from '@agentrans/typert-protocol'
import { exportIdSchema, exportsSchema, recordSchema, requestSchema } from './schema.ts'
import type { ArtifactExportId, ArtifactHtmlExportFailure, ArtifactHtmlExportInput, ArtifactHtmlExportRecord, ArtifactHtmlExportRequest, ArtifactHtmlExports } from './types.ts'

export type * from './types.ts'

declare module '@agentrans/cordis' {
  interface Context {
    /** Fixed-input Scene HTML export requests, files, and their Session-visible history. */
    artifactExports: ArtifactExports
  }
}

/** Retained-result and complete-output budgets for one Session. */
export interface Config {
  /** Maximum retained export identities per Session; default 32, with no automatic eviction. */
  readonly maxExportsPerSession?: number
  /** Maximum UTF-8 bytes of the complete pending record, including original source; default 262144. */
  readonly maxInputBytes?: number
  /** Maximum UTF-8 bytes of the complete generated HTML; default 2097152. */
  readonly maxOutputBytes?: number
}

const projection = {
  key: 'artifactExports', stateVersion: 1, stateSchema: exportsSchema,
  init: (): ArtifactHtmlExports => ({}),
  apply: (state, event) => {
    if (event.type !== 'artifact/export') return state
    const record = recordSchema.parse(event.data)
    const previous = recordOf(state, record.request.exportId)
    if (previous !== undefined) {
      if (!sameRequest(previous.request, record.request) || JSON.stringify(previous.frozen) !== JSON.stringify(record.frozen)
        || (previous.status !== 'pending' && JSON.stringify(previous) !== JSON.stringify(record))) {
        throw new Error('Artifact export event changes an immutable request or settled result')
      }
    }
    return { ...state, [record.request.exportId]: record }
  },
  wire: { viewSchema: exportsSchema, view: state => state, summary: false },
} satisfies ProjectionDefinition<'artifactExports', ArtifactHtmlExports>

function sameRequest(left: ArtifactHtmlExportRequest, right: ArtifactHtmlExportRequest): boolean {
  if (left.exportId !== right.exportId || left.source.kind !== right.source.kind
    || left.source.artifactId !== right.source.artifactId) return false
  if (left.source.kind === 'observation') return right.source.kind === 'observation' && left.source.observationId === right.source.observationId
  return right.source.kind === 'current' && left.source.revision === right.source.revision
    && left.source.checkpoint?.runtimeVersion === right.source.checkpoint?.runtimeVersion
    && left.source.checkpoint?.stepCount === right.source.checkpoint?.stepCount
}

function recordOf(records: ArtifactHtmlExports, id: ArtifactExportId): ArtifactHtmlExportRecord | undefined {
  return Object.hasOwn(records, id) ? records[id] : undefined
}

/** Owns fixed HTML export inputs, explicit continuation, and verified result reads. */
export class ArtifactExports extends TypertRemoteService {
  static inject = ['agents', 'artifacts', 'attachments', 'sessions', 'sessionProjections']
  static Config: z<Config, Required<Config>> = z.object({
    maxExportsPerSession: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(32),
    maxInputBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(262_144),
    maxOutputBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2_097_152),
  })

  private readonly config: Required<Config>
  private projection!: ProjectionHandle<ArtifactHtmlExports>
  private readonly inFlight = new Map<Session, Map<ArtifactExportId, Promise<ArtifactHtmlExportRecord>>>()
  private closing = false

  /**
   * @param ctx - Session, Artifact, and attachment owners.
   * @param config - Explicit retained-result and complete-output budgets.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'artifactExports')
    this.config = ArtifactExports.Config(config)
    ctx.effect(() => async () => {
      this.closing = true
      await Promise.allSettled([...this.inFlight.values()].flatMap(entries => [...entries.values()]))
    }, 'artifact export settlement')
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(projection)
  }

  private assertLiveRoot(agent: Agent): void {
    if (this.closing || this.ctx.agents.get(agent.id) !== agent || !this.ctx.agents.roots().includes(agent)) {
      throw new RemoteError('gateway/bad-request', 'Artifact export requires an active root Session', {})
    }
  }

  private resolve(agent: Agent, request: ArtifactHtmlExportRequest): ArtifactHtmlExportInput {
    let source: ReturnType<ArtifactService['resolveSceneSource']>
    try { source = this.ctx.artifacts.resolveSceneSource(agent, request.source) } catch (error) {
      if (error instanceof ParticleRuntimeError) throw new RemoteError('artifact-export/source-unavailable', 'Particle replay conditions are unavailable', { reason: 'INVALID_CHECKPOINT' }, { cause: error })
      if (!(error instanceof ArtifactError)) throw error
      const reason = error.code === 'ARTIFACT_NOT_FOUND' ? 'NOT_FOUND'
        : error.code === 'STALE_REVISION' ? 'STALE_REVISION' : 'UNSUPPORTED_SOURCE'
      throw new RemoteError('artifact-export/source-unavailable', 'Selected source is unavailable for export', { reason }, { cause: error })
    }
    return { ...source, sessionId: agent.session.id, exporterVersion: SCENE_EXPORTER_VERSION,
      parameters: source.checkpoint === undefined ? 'source-defaults' : 'particle-checkpoint' }
  }

  /**
   * Capture and generate one Scene HTML export without adding model input.
   * @param agent - Exact live root owning the result record.
   * @param input - Stable request identity and current-revision or saved-observation reference.
   * @returns The settled record after flush; generation failures return a durable failed record.
   * @throws {RemoteError} Before admission for invalid, conflicting, missing, stale, or over-limit requests.
   * Append or flush failures retain an unknown outcome; retry the identical request to recover or explicitly continue it.
   */
  @Remote
  async create(agent: Agent, input: ArtifactHtmlExportRequest): Promise<ArtifactHtmlExportRecord> {
    this.assertLiveRoot(agent)
    const parsed = requestSchema.safeParse(input)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'Invalid Artifact HTML export request', {}, { cause: parsed.error })
    const request = parsed.data
    const records = this.projection.stateOf(agent.session)
    const existing = recordOf(records, request.exportId)
    if (existing !== undefined && !sameRequest(existing.request, request)) {
      throw new RemoteError('artifact-export/request-conflict', 'Export identity already belongs to a different request', { exportId: request.exportId })
    }
    const active = this.inFlight.get(agent.session)?.get(request.exportId)
    if (active !== undefined) return active
    if (existing === undefined && Object.keys(records).length >= this.config.maxExportsPerSession) {
      throw new RemoteError('artifact-export/limit', 'Session export retention limit reached', { limit: this.config.maxExportsPerSession })
    }
    const record: ArtifactHtmlExportRecord = existing ?? { request, frozen: this.resolve(agent, request), status: 'pending' }
    if (existing === undefined && Buffer.byteLength(JSON.stringify(record), 'utf8') > this.config.maxInputBytes) {
      throw new RemoteError('artifact-export/input-too-large', 'Complete export input exceeds the retained byte budget', {
        limit: this.config.maxInputBytes,
      })
    }
    const operation = this.generate(agent, record, existing === undefined)
    const entries = this.inFlight.get(agent.session) ?? new Map<ArtifactExportId, Promise<ArtifactHtmlExportRecord>>()
    this.inFlight.set(agent.session, entries)
    entries.set(request.exportId, operation)
    try { return await operation } finally {
      entries.delete(request.exportId)
      if (entries.size === 0) this.inFlight.delete(agent.session)
    }
  }

  private async generate(agent: Agent, record: ArtifactHtmlExportRecord, isNew: boolean): Promise<ArtifactHtmlExportRecord> {
    if (isNew) agent.session.append('artifact/export', record)
    await this.ctx.sessions.flush(agent.session)
    if (record.status !== 'pending') return record
    const { frozen, request } = record
    let bytes: Buffer
    try {
      bytes = Buffer.from(buildSceneAnimationHtml(frozen.artifact.spec, frozen.artifact.title, frozen.checkpoint, {
        exporterVersion: frozen.exporterVersion, exportId: request.exportId, artifactId: frozen.artifact.artifactId,
        sessionId: frozen.sessionId, revision: frozen.artifact.revision,
        ...(frozen.observationId === undefined ? {} : { observationId: frozen.observationId }),
        ...(frozen.checkpoint === undefined ? {} : { checkpoint: frozen.checkpoint }),
      }), 'utf8')
    } catch (error) {
      this.ctx.logger.warn('Artifact HTML rendering failed; the fixed input is retained', error)
      return this.fail(agent, record, 'RENDER_FAILED')
    }
    if (bytes.length > this.config.maxOutputBytes) return this.fail(agent, record, 'OUTPUT_TOO_LARGE')
    let file
    try {
      file = await this.ctx.attachments.saveFile({ data: bytes, name: `${frozen.artifact.artifactId}-r${String(frozen.artifact.revision)}-${request.exportId}.html` })
    } catch (error) {
      this.ctx.logger.warn('Artifact export file storage failed; the fixed input is retained', error)
      return this.fail(agent, record, 'STORAGE_FAILED')
    }
    const ready: ArtifactHtmlExportRecord = { request, frozen, status: 'ready', file }
    agent.session.append('artifact/export', ready)
    await this.ctx.sessions.flush(agent.session)
    return ready
  }

  private async fail(
    agent: Agent, record: ArtifactHtmlExportRecord, failure: ArtifactHtmlExportFailure,
  ): Promise<ArtifactHtmlExportRecord> {
    const failed: ArtifactHtmlExportRecord = { request: record.request, frozen: record.frozen, status: 'failed', failure }
    agent.session.append('artifact/export', failed)
    await this.ctx.sessions.flush(agent.session)
    return failed
  }

  /**
   * Read the exact stored file after the attachment provider verifies all bytes.
   * @param agent - Exact live root whose result records authorize the read.
   * @param exportId - Ready export identity, never an arbitrary file reference or path.
   * @returns Complete verified HTML bytes; a partial read never reaches the caller.
   * @throws {RemoteError} When the export is not ready or its stored bytes are missing or corrupt.
   */
  @Remote
  async read(agent: Agent, exportId: ArtifactExportId): Promise<Uint8Array> {
    this.assertLiveRoot(agent)
    const parsed = exportIdSchema.safeParse(exportId)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'Invalid Artifact export identity', {}, { cause: parsed.error })
    const record = recordOf(this.projection.stateOf(agent.session), parsed.data)
    if (record?.status !== 'ready') throw new RemoteError('artifact-export/not-ready', 'Artifact export has no ready file', { exportId: parsed.data })
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for await (const chunk of this.ctx.attachments.readFileStream(record.file)) {
        length += chunk.length
        if (length > record.file.bytes) throw new RemoteError('artifact-export/file-unavailable', 'Stored export byte length changed', { exportId: parsed.data })
        chunks.push(chunk)
      }
      if (length !== record.file.bytes) throw new RemoteError('artifact-export/file-unavailable', 'Stored export byte length changed', { exportId: parsed.data })
    } catch (error) {
      if (!isAttachmentError(error)) throw error
      throw new RemoteError('artifact-export/file-unavailable', 'Stored export bytes are unavailable; the generation record is retained', { exportId: parsed.data }, { cause: error })
    }
    return Buffer.concat(chunks, length)
  }
}

export default ArtifactExports
