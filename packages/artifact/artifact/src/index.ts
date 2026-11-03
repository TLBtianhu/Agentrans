/**
 * Event-sourced HTML artifacts with compare-and-set updates and user-reviewed
 * action messages. Artifact actions carry text intent only; they never grant
 * filesystem, network, or approval authority.
 * @module @deepseek-ai/dsh-artifact
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  ArtifactId, ArtifactComparison, ArtifactPrepareInput, ArtifactRecordResult, ArtifactSnapshot,
} from './types.ts'
import { normalizeSceneSpec } from './scene.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    artifacts: ArtifactService
  }
}

/** Structured failure produced by artifact validation and revision checks. */
export class ArtifactError extends HarnessError {}

/** Deployment limits for durable source and user-action messages. */
export interface Config {
  /** Maximum UTF-8 bytes of one HTML source; default 262144. */
  readonly maxSourceBytes?: number
  /** Maximum UTF-8 bytes of the complete encoded action message; default 16384. */
  readonly maxActionBytes?: number
}

const ARTIFACT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const ACTION_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function badInput(message: string): never {
  throw new ArtifactError(message, 'BAD_INPUT')
}

function artifactIdOf(value: unknown): ArtifactId {
  if (typeof value !== 'string' || !ARTIFACT_ID_PATTERN.test(value)) {
    return badInput('artifactId must match [a-z][a-z0-9-]{0,63}')
  }
  return brandString<ArtifactId>(value)
}

function revisionOf(value: unknown, field = 'revision'): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 1) {
    return badInput(`${field} must be a positive safe integer`)
  }
  return value
}

function titleOf(value: unknown): string {
  if (typeof value !== 'string') return badInput('title must be a string')
  const title = value.trim()
  if (title.length < 1 || title.length > 120) {
    return badInput('title must contain 1 to 120 characters after trimming')
  }
  return title
}

function sourceOf(value: unknown, maxSourceBytes: number | undefined): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ArtifactError('source must be a non-empty HTML string', 'BAD_SOURCE')
  }
  if (maxSourceBytes !== undefined && Buffer.byteLength(value, 'utf8') > maxSourceBytes) {
    throw new ArtifactError(`source exceeds the ${maxSourceBytes}-byte limit`, 'BAD_SOURCE')
  }
  return value
}

function comparisonOf(value: unknown): ArtifactComparison {
  if (!isRecord(value)) return badInput('comparison must be an object')
  if (typeof value.group !== 'string' || !ARTIFACT_ID_PATTERN.test(value.group)) {
    return badInput('comparison.group must match [a-z][a-z0-9-]{0,63}')
  }
  if (value.role !== 'control' && value.role !== 'variant') {
    return badInput('comparison.role must be control or variant')
  }
  return { group: value.group, role: value.role }
}

function snapshotOf(value: unknown, maxSourceBytes?: number): ArtifactSnapshot {
  if (!isRecord(value)) return badInput('artifact snapshot must be an object')
  if (value.format !== 'html' && value.format !== 'scene') return badInput('artifact format must be html or scene')
  if (value.presentation !== 'inline' && value.presentation !== 'focus') {
    return badInput('presentation must be inline or focus')
  }
  const presentation = value.presentation as 'inline' | 'focus'
  const common = {
    artifactId: artifactIdOf(value.artifactId),
    revision: revisionOf(value.revision),
    title: titleOf(value.title),
    presentation,
    ...value.comparison === undefined ? {} : { comparison: comparisonOf(value.comparison) },
  }
  if (value.format === 'scene') {
    try {
      return { ...common, format: 'scene', spec: normalizeSceneSpec(value.spec) }
    } catch (error) {
      throw new ArtifactError(error instanceof Error ? error.message : 'invalid SceneSpec', 'BAD_SCENE_SPEC')
    }
  }
  return { ...common, format: 'html', source: sourceOf(value.source, maxSourceBytes) }
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`artifact ${name} must be a positive safe integer`)
  }
  return value
}

/** `ctx.artifacts`: validated artifact snapshots and user-action routing. */
export class ArtifactService extends TypertRemoteService {
  static Config: z<Config> = z.object({
    maxSourceBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(262_144),
    maxActionBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
  })

  private readonly maxSourceBytes: number
  private readonly maxActionBytes: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'artifacts')
    this.maxSourceBytes = positiveLimit(config.maxSourceBytes ?? 262_144, 'maxSourceBytes')
    this.maxActionBytes = positiveLimit(config.maxActionBytes ?? 16_384, 'maxActionBytes')
  }

  private current(agent: Agent, artifactId: ArtifactId): ArtifactSnapshot | undefined {
    let latest: ArtifactSnapshot | undefined
    for (const event of agent.session.snapshotEvents()) {
      if (event.type !== 'artifact/upsert') continue
      const data: unknown = event.data
      if (!isRecord(data) || data.artifactId !== artifactId) continue
      latest = snapshotOf(data)
    }
    return latest
  }

  /**
   * Validate and normalize one complete create or update without committing it.
   * @param agent - Agent whose Session supplies the current artifact revision.
   * @param input - Complete new values and, for update, the observed base revision.
   * @returns The snapshot to commit after the enclosing operation succeeds.
   * @throws {ArtifactError} `ARTIFACT_EXISTS`, `ARTIFACT_NOT_FOUND`, `STALE_REVISION`,
   * `BAD_SOURCE`, or `BAD_INPUT`; no Session event is appended.
   */
  prepare(agent: Agent, input: ArtifactPrepareInput): ArtifactSnapshot {
    if (!isRecord(input)) return badInput('artifact input must be an object')
    if (input.action !== 'create' && input.action !== 'update') {
      return badInput('action must be create or update')
    }
    const artifactId = artifactIdOf(input.artifactId)
    const current = this.current(agent, artifactId)
    let revision: number
    if (input.action === 'create') {
      if (input.baseRevision !== undefined) return badInput('create does not accept baseRevision')
      if (current !== undefined) {
        throw new ArtifactError(`artifact "${artifactId}" already exists`, 'ARTIFACT_EXISTS')
      }
      revision = 1
    } else {
      if (current === undefined) {
        throw new ArtifactError(`artifact "${artifactId}" does not exist`, 'ARTIFACT_NOT_FOUND')
      }
      const baseRevision = revisionOf(input.baseRevision, 'baseRevision')
      if (baseRevision !== current.revision) {
        throw new ArtifactError(
          `artifact "${artifactId}" is at revision ${current.revision}, not ${baseRevision}`,
          'STALE_REVISION',
        )
      }
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        return badInput('artifact revision cannot exceed the maximum safe integer')
      }
      revision = current.revision + 1
    }
    return snapshotOf({
      artifactId,
      revision,
      format: input.format ?? 'html',
      title: input.title,
      source: input.source,
      spec: input.spec,
      presentation: input.presentation,
      comparison: input.comparison,
    }, this.maxSourceBytes)
  }

  /**
   * Append one validated complete snapshot and perform no other operation.
   * @param agent - Agent owning the Session log.
   * @param snapshot - Prepared complete artifact value.
   * @throws {ArtifactError} when the snapshot violates the same persistent validation as `prepare`.
   */
  commit(agent: Agent, snapshot: ArtifactSnapshot): void {
    agent.session.append('artifact/upsert', snapshotOf(snapshot, this.maxSourceBytes))
  }

  private assertLiveRoot(agent: Agent): void {
    const agents = this.ctx.get('agents')
    if (agents === undefined) {
      throw new ArtifactError('artifact actions require an Agent registry', 'AGENT_REGISTRY_UNAVAILABLE')
    }
    if (agents.get(agent.id) !== agent || !agents.roots().includes(agent)) {
      throw new ArtifactError('artifact actions require the exact live root agent', 'CALLER_NOT_LIVE_ROOT')
    }
  }

  /**
   * Encode one user-reviewed artifact intent as a single-text-block UserMessage.
   * The message is input, never an authorization to perform the named action.
   * @param agent - Exact live root Agent owning the artifact Session.
   * @param artifactId - Existing artifact identity.
   * @param revision - Current artifact revision reviewed by the user.
   * @param action - Trimmed 1-64 character action name matching `[A-Za-z][A-Za-z0-9._-]*`.
   * @param payload - Lossless JSON payload included in the bounded text message.
   * @param wake - `false` injects without waking; `true` steers the Agent.
   * @returns Acceptance and the revision carried by the message.
   * @throws {ArtifactError} for a non-root caller, unknown or stale artifact,
   * invalid action/payload, or an oversized complete message; no message is routed on validation failure.
   */
  @Remote
  record(
    agent: Agent,
    artifactId: ArtifactId,
    revision: number,
    action: string,
    payload: JsonValue,
    wake: boolean,
  ): ArtifactRecordResult {
    this.assertLiveRoot(agent)
    const id = artifactIdOf(artifactId)
    const expectedRevision = revisionOf(revision)
    const current = this.current(agent, id)
    if (current === undefined) {
      throw new ArtifactError(`artifact "${id}" does not exist`, 'ARTIFACT_NOT_FOUND')
    }
    if (current.revision !== expectedRevision) {
      throw new ArtifactError(
        `artifact "${id}" is at revision ${current.revision}, not ${expectedRevision}`,
        'STALE_REVISION',
      )
    }
    if (typeof action !== 'string') return badInput('action must be a string')
    const normalizedAction = action.trim()
    if (normalizedAction.length < 1 || normalizedAction.length > 64 || !ACTION_PATTERN.test(normalizedAction)) {
      return badInput('action must be a trimmed 1-64 character name matching [A-Za-z][A-Za-z0-9._-]*')
    }
    if (typeof wake !== 'boolean') return badInput('wake must be a boolean')
    const detachedPayload = snapshotJsonValue(payload)
    if (detachedPayload === undefined) return badInput('payload must be a lossless JSON value')
    const text = JSON.stringify({
      kind: 'artifact_action',
      artifactId: id,
      revision: expectedRevision,
      action: normalizedAction,
      payload: detachedPayload,
    })
    if (Buffer.byteLength(text, 'utf8') > this.maxActionBytes) {
      throw new ArtifactError(`artifact action exceeds the ${this.maxActionBytes}-byte limit`, 'ACTION_TOO_LARGE')
    }
    const message = createUserMessage({
      source: { kind: 'artifact-action', artifactId: id, revision: expectedRevision },
      content: [{ type: 'text', text }],
    })
    if (wake) agent.steer(message)
    else agent.inject(message)
    return { accepted: true, revision: expectedRevision }
  }
}

export default ArtifactService
