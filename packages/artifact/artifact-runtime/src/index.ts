/** Source-bound live reports with stream-owned lifetime and bounded model inspection. @module @agentrans/artifact-runtime */
import { Buffer } from 'node:buffer'
import { Context } from '@agentrans/cordis'
import z from '@agentrans/schemastery'
import { z as schema } from 'zod'
import type { Agent } from '@agentrans/agent'
import type { ArtifactId } from '@agentrans/artifact/types'
import type {} from '@agentrans/artifact'
import { getArtifactSourceCapabilities } from '@agentrans/artifact/capabilities'
import { Remote, RemoteError, TypertRemoteService, type RemoteStream } from '@agentrans/typert-protocol'
import type { SessionId } from '@agentrans/session'
import type { ArtifactRuntimeIdentity, ArtifactRuntimeInspection, ArtifactRuntimeWaitResult, RuntimeAck, RuntimeReport } from './types.ts'

export type * from './types.ts'

declare module '@agentrans/cordis' {
  interface Context {
    /** Live renderer/program reports; historical tool results never become current execution state. */
    artifactRuntime: ArtifactRuntime
  }
}

/** Active report and diagnostic retention budgets. */
export interface Config {
  /** Maximum concurrently attached views for one Session; default 16. */
  readonly maxViewsPerSession?: number
  /** Maximum concurrently attached views across this Host; default 128. */
  readonly maxViewsTotal?: number
  /** Maximum UTF-8 bytes of one complete JSON diagnostic object; default 2048. */
  readonly maxErrorBytes?: number
  /** Maximum duration of one readiness wait in milliseconds; default 5000. */
  readonly maxWaitMs?: number
  /** Maximum pending readiness waits for one Session; default 4. */
  readonly maxWaitsPerSession?: number
  /** Maximum pending readiness waits across this Host; default 32. */
  readonly maxWaitsTotal?: number
}

interface OwnedView {
  readonly sessionId: SessionId
  readonly identity: ArtifactRuntimeIdentity
  readonly lifetime: AbortController
  report: RuntimeReport
}

interface PendingWait {
  readonly sessionId: SessionId
  readonly artifactId: ArtifactId
  refresh(): void
  reject(error: unknown): void
}

const identitySchema = schema.object({
  artifactId: schema.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  revision: schema.number().int().positive(),
  runtimeId: schema.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  renderer: schema.enum(['native', 'html']),
}).strict()

const reportSchema = schema.discriminatedUnion('status', [
  schema.object({ status: schema.literal('starting') }).strict(),
  schema.object({ status: schema.literal('ready'), capabilities: schema.object({
    state: schema.boolean(),
    commands: schema.array(schema.enum(['play', 'pause', 'step', 'reset'])).max(4)
      .refine(commands => new Set(commands).size === commands.length),
  }).strict() }).strict(),
  schema.object({ status: schema.literal('error'), error: schema.object({
    code: schema.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,95}$/), message: schema.string(),
  }).strict() }).strict(),
])

/** Owns only currently attached report streams; inspection reads authoritative source identity separately. */
export class ArtifactRuntime extends TypertRemoteService {
  static inject = ['artifacts']
  static Config: z<Config, Required<Config>> = z.object({
    maxViewsPerSession: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16),
    maxViewsTotal: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(128),
    maxErrorBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2048),
    maxWaitMs: z.number().step(1).min(1).max(2_147_483_647).default(5000),
    maxWaitsPerSession: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(4),
    maxWaitsTotal: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(32),
  })

  private readonly config: Required<Config>
  private readonly views = new Set<OwnedView>()
  private readonly waits = new Set<PendingWait>()
  private closing = false

  /** @param ctx - Artifact source owner and Remote invocation scope. @param config - Live-view and diagnostic budgets. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'artifactRuntime')
    this.config = ArtifactRuntime.Config(config)
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'artifact/upsert') return
      for (const view of this.views) {
        if (view.sessionId === session.id && view.identity.artifactId === event.data.artifactId
          && view.identity.revision !== event.data.revision) this.release(view)
      }
      this.refreshWaits(session.id, event.data.artifactId)
    })
    ctx.on('session/disposed', (session) => {
      for (const wait of this.waits) if (wait.sessionId === session.id) {
        wait.reject(new RemoteError('artifact-runtime/wait-unavailable', 'Runtime wait Session was disposed', { reason: 'SESSION_DISPOSED' }))
      }
      for (const view of this.views) if (view.sessionId === session.id) this.release(view)
    })
    ctx.effect(() => () => {
      this.closing = true
      for (const wait of this.waits) wait.reject(new RemoteError('artifact-runtime/wait-unavailable', 'Runtime waiting is closing', { reason: 'CLOSED' }))
      for (const view of this.views) this.release(view)
    }, 'Artifact runtime report streams')
  }

  /**
   * Attach one stream-owned runtime report without opening a Session or activating an Agent.
   * Registration records a Client claim, not proof that the named source exists or rendered successfully.
   * @param sessionId - Session resource whose rendered source the Client names.
   * @param identity - Exact source revision and unique mounted runtime identity.
   * @param signal - Carrier generation; cancellation, disconnect and disposal remove its live report.
   * @returns Registration followed by a monotonic acknowledgement for each accepted replacement report.
   * @throws {RemoteError} Invalid, duplicate, over-budget or unavailable streams retain no rejected report.
   */
  @Remote({ mode: 'stream', resources: { session: (sessionId: SessionId) => sessionId } })
  async *attach(sessionId: SessionId, identity: ArtifactRuntimeIdentity, signal: AbortSignal): RemoteStream<RuntimeAck, RuntimeReport> {
    if (this.closing) throw new RemoteError('artifact-runtime/rejected', 'Runtime reporting is closing', { reason: 'CLOSED' })
    const parsed = identitySchema.safeParse(identity)
    if (!parsed.success) throw new RemoteError('artifact-runtime/rejected', 'Invalid runtime identity', { reason: 'INVALID_IDENTITY' })
    if (this.views.size >= this.config.maxViewsTotal) {
      throw new RemoteError('artifact-runtime/rejected', 'Host runtime report capacity reached', { reason: 'CAPACITY', limit: this.config.maxViewsTotal })
    }
    let sessionCount = 0
    for (const active of this.views) {
      if (active.sessionId !== sessionId) continue
      sessionCount += 1
      if (active.identity.runtimeId === identity.runtimeId) {
        throw new RemoteError('artifact-runtime/rejected', 'Mounted runtime identity already has a report stream', { reason: 'DUPLICATE_RUNTIME' })
      }
    }
    if (sessionCount >= this.config.maxViewsPerSession) {
      throw new RemoteError('artifact-runtime/rejected', 'Session runtime report capacity reached', { reason: 'CAPACITY', limit: this.config.maxViewsPerSession })
    }
    const invocation = this.ctx.invocation
    if (invocation === undefined) throw new Error('Artifact runtime attachment requires a Remote invocation')
    signal.throwIfAborted()
    const input = invocation.uplink<RuntimeReport>()[Symbol.asyncIterator]()
    const view: OwnedView = { sessionId, identity: { ...identity }, report: { status: 'starting' }, lifetime: new AbortController() }
    const onAbort = (): void => { this.release(view) }
    signal.addEventListener('abort', onAbort, { once: true })
    let stopped!: () => void
    const stop = new Promise<undefined>((resolve) => { stopped = () => { resolve(undefined) } })
    view.lifetime.signal.addEventListener('abort', stopped, { once: true })
    this.views.add(view)
    this.refreshWaits(sessionId, identity.artifactId)
    try {
      yield { kind: 'attached' }
      let sequence = 0
      for (;;) {
        const reading = input.next()
        const next = await Promise.race([reading, stop])
        if (next === undefined || next.done === true || view.lifetime.signal.aborted) return
        const report = reportSchema.safeParse(next.value)
        if (!report.success) throw new RemoteError('artifact-runtime/rejected', 'Invalid runtime report', { reason: 'INVALID_REPORT' })
        if (report.data.status === 'error' && Buffer.byteLength(JSON.stringify(report.data.error), 'utf8') > this.config.maxErrorBytes) {
          throw new RemoteError('artifact-runtime/rejected', 'Runtime diagnostic exceeds its byte budget', { reason: 'ERROR_TOO_LARGE', limit: this.config.maxErrorBytes })
        }
        if (sequence === Number.MAX_SAFE_INTEGER) throw new RemoteError('artifact-runtime/rejected', 'Runtime report sequence exhausted', { reason: 'INVALID_REPORT' })
        view.report = report.data
        this.refreshWaits(sessionId, identity.artifactId)
        yield { kind: 'accepted', sequence: ++sequence }
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      view.lifetime.signal.removeEventListener('abort', stopped)
      this.release(view)
      await input.return?.()
    }
  }

  /**
   * Inspect one exact current source and its connected matching runtime reports without adding input.
   * @param agent - Agent whose own Session supplies the authoritative current source.
   * @param artifactId - Artifact to inspect in that Session.
   * @param revision - Exact current source revision expected by the caller.
   * @returns Detached source capabilities and active Client reports at this read; no report is a rendering proof.
   * @throws {RemoteError} For absent or changed source revisions.
   */
  inspect(agent: Agent, artifactId: ArtifactId, revision: number): ArtifactRuntimeInspection {
    const snapshot = this.ctx.artifacts.currentSnapshot(agent, artifactId)
    if (snapshot === undefined) throw new RemoteError('artifact-runtime/source-unavailable', 'Artifact source was not found in this Session', { reason: 'NOT_FOUND' })
    if (snapshot.revision !== revision) throw new RemoteError('artifact-runtime/source-unavailable', 'Artifact source revision changed', {
      reason: 'STALE_REVISION', currentRevision: snapshot.revision,
    })
    const renderer = snapshot.format === 'scene' ? 'native' : 'html'
    return {
      artifactId: snapshot.artifactId, revision: snapshot.revision, title: snapshot.title, format: snapshot.format,
      ...snapshot.format === 'scene' ? { sceneKind: snapshot.spec.kind } : {},
      sourceCapabilities: getArtifactSourceCapabilities(snapshot), reportAuthority: 'client-reported',
      runs: [...this.views].filter(view => view.sessionId === agent.session.id
        && view.identity.artifactId === artifactId && view.identity.revision === revision && view.identity.renderer === renderer)
        .map(view => ({ runtimeId: view.identity.runtimeId, renderer, ...structuredClone(view.report) })),
    }
  }

  /**
   * Wait once for any matching current run to report ready or error, including a not-yet-attached view.
   * Reports remain independent Client assertions; this never executes code or wakes an Agent.
   * @param agent - Agent whose own Session supplies the authoritative current source.
   * @param artifactId - Artifact to inspect in that Session.
   * @param revision - Exact current source revision; replacement rejects instead of following the new source.
   * @param waitMs - Positive integer duration within the configured maximum; it is never silently shortened.
   * @param signal - Invocation cancellation; rejection preserves its reason and releases all wait resources.
   * @returns All matching reports at settlement; expiration with starting reports, no reports, and disconnect are distinct.
   * @throws {RemoteError} For unavailable source, invalid or over-capacity waits, and Session/service disposal.
   */
  async wait(
    agent: Agent, artifactId: ArtifactId, revision: number, waitMs: number, signal: AbortSignal,
  ): Promise<ArtifactRuntimeWaitResult> {
    signal.throwIfAborted()
    if (this.closing) throw new RemoteError('artifact-runtime/wait-unavailable', 'Runtime waiting is closing', { reason: 'CLOSED' })
    if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > this.config.maxWaitMs) {
      throw new RemoteError('artifact-runtime/wait-unavailable', 'Runtime wait duration is outside its configured budget', {
        reason: 'INVALID_WAIT', limit: this.config.maxWaitMs,
      })
    }
    const initial = this.inspect(agent, artifactId, revision)
    const result = (inspection: ArtifactRuntimeInspection, outcome: ArtifactRuntimeWaitResult['wait']['outcome']): ArtifactRuntimeWaitResult => ({
      ...inspection, wait: { outcome, limitMs: waitMs },
    })
    if (initial.runs.some(run => run.status !== 'starting')) return result(initial, 'reported')
    if (this.waits.size >= this.config.maxWaitsTotal) {
      throw new RemoteError('artifact-runtime/wait-unavailable', 'Host runtime wait capacity reached', {
        reason: 'CAPACITY', limit: this.config.maxWaitsTotal,
      })
    }
    let sessionCount = 0
    for (const wait of this.waits) if (wait.sessionId === agent.session.id) sessionCount += 1
    if (sessionCount >= this.config.maxWaitsPerSession) {
      throw new RemoteError('artifact-runtime/wait-unavailable', 'Session runtime wait capacity reached', {
        reason: 'CAPACITY', limit: this.config.maxWaitsPerSession,
      })
    }
    return new Promise<ArtifactRuntimeWaitResult>((resolve, reject) => {
      let hadReport = initial.runs.length > 0
      const cleanup = (): boolean => {
        if (!this.waits.delete(operation)) return false
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        return true
      }
      const fail = (error: unknown): void => {
        if (!cleanup()) return
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Cancellation preserves the caller's original reason.
        reject(error)
      }
      const refresh = (expired = false): void => {
        if (!this.waits.has(operation)) return
        let inspection: ArtifactRuntimeInspection
        try { inspection = this.inspect(agent, artifactId, revision) }
        catch (error) { fail(error); return }
        let outcome: ArtifactRuntimeWaitResult['wait']['outcome'] | undefined
        if (inspection.runs.some(run => run.status !== 'starting')) outcome = 'reported'
        else if (inspection.runs.length > 0) {
          hadReport = true
          if (expired) outcome = 'timeout'
        } else if (hadReport) outcome = 'disconnected'
        else if (expired) outcome = 'no-active-report'
        if (outcome !== undefined && cleanup()) resolve(result(inspection, outcome))
      }
      const onAbort = (): void => { fail(signal.reason) }
      const operation: PendingWait = { sessionId: agent.session.id, artifactId, refresh, reject: fail }
      const timer = setTimeout(() => { refresh(true) }, waitMs)
      this.waits.add(operation)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private refreshWaits(sessionId: SessionId, artifactId: ArtifactId): void {
    for (const wait of this.waits) if (wait.sessionId === sessionId && wait.artifactId === artifactId) wait.refresh()
  }

  private release(view: OwnedView): void {
    const retained = this.views.delete(view)
    view.lifetime.abort()
    if (retained) this.refreshWaits(view.sessionId, view.identity.artifactId)
  }
}

export default ArtifactRuntime
