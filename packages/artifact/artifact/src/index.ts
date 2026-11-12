/**
 * Event-sourced HTML artifacts with compare-and-set updates and user-reviewed
 * action messages. Artifact actions carry text intent only; they never grant
 * filesystem, network, or approval authority.
 * @module @agentrans/artifact
 */

import { Context, Service } from '@agentrans/cordis'
import z from '@agentrans/schemastery'
import { z as zod, type ZodType } from 'zod'
import type { Agent } from '@agentrans/agent'
import { brandString } from '@agentrans/brand'
import { createUserMessage, freezeMessage, HarnessError, type UserMessage } from '@agentrans/llm'
import { Remote, RemoteError, TypertRemoteService, principalOf } from '@agentrans/typert-protocol'
import { assertNever, snapshotJsonValue } from '@agentrans/util-values'
import { SessionInputAdmissionError } from '@agentrans/session-input'
import type { ProjectionDefinition, ProjectionHandle } from '@agentrans/session-projection'
import type {
  ArtifactId, ArtifactComparison, ArtifactPrepareInput, ArtifactRecordResult, ArtifactSnapshot, ArtifactSnapshotBase,
  ArtifactObservationId, ArtifactObservations, SavedParticleObservation,
  ArtifactObservationComparisonResult, ParticleObservationComparison, SavedParticleObservationRef,
  ArtifactExportSource, ArtifactExportSourceSelection, ArtifactActionRequest,
} from './types.ts'
import { normalizeSceneSpec } from './scene.ts'
import {
  createParticleCheckpoint, observeParticleState, restoreParticleCheckpoint, ParticleRuntimeError, type ParticleCheckpoint,
  type ParticleObservation,
} from './particle-runtime.ts'
import { buildParticleObservationComparison, ParticleObservationComparisonError } from './observation-comparison.ts'

export type * from './types.ts'

declare module '@agentrans/cordis' {
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
  /** Maximum saved observations retained for one Artifact; default 32. */
  readonly maxSavedObservationsPerArtifact?: number
}

const ARTIFACT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const ACTION_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/
const OBSERVATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

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
  const presentation = value.presentation
  const common: Omit<ArtifactSnapshotBase, 'format'> = {
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

interface ArtifactState {
  readonly current: Readonly<Record<string, ArtifactSnapshot>>
  readonly observations: ArtifactObservations
  readonly sent: Readonly<Record<string, readonly ArtifactObservationId[]>>
  readonly sentComparisons: Readonly<Record<string, true>>
  readonly inheritedEventCount: number
}

function observationIdOf(value: unknown): ArtifactObservationId {
  if (typeof value !== 'string' || !OBSERVATION_ID_PATTERN.test(value)) {
    return badInput('observationId must contain 1-128 letters, digits, dots, underscores, or hyphens and start with a letter or digit')
  }
  return brandString<ArtifactObservationId>(value)
}

function observationLabelOf(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 80) {
    return badInput('observation label must contain 1-80 characters after trimming')
  }
  return value.trim()
}

function particleSource(value: unknown) {
  const artifact = snapshotOf(value)
  if (artifact.format !== 'scene' || artifact.spec.kind !== 'particle-system') {
    throw new ArtifactError('saved observations require a particle-system SceneSpec', 'UNSUPPORTED_OBSERVATION')
  }
  return { artifact, spec: artifact.spec }
}

function savedObservationOf(value: unknown): SavedParticleObservation {
  if (!isRecord(value)) return badInput('saved observation must be an object')
  const { artifact, spec } = particleSource(value.artifact)
  const state = restoreParticleCheckpoint(spec, value.checkpoint)
  const values = observeParticleState(state)
  if (!observationValuesMatch(value.values, values)) return badInput('saved observation values do not match their checkpoint')
  return {
    observationId: observationIdOf(value.observationId), label: observationLabelOf(value.label), artifact,
    checkpoint: createParticleCheckpoint(state), values,
  }
}

function observationsOf(value: unknown, artifactId: string): readonly SavedParticleObservation[] {
  if (!Array.isArray(value)) return badInput('saved observations must be an array')
  const observations = value.map(savedObservationOf)
  const ids = new Set<string>()
  for (const observation of observations) {
    if (observation.artifact.artifactId !== artifactId) return badInput('saved observation belongs to another Artifact')
    if (ids.has(observation.observationId)) return badInput('saved observation ids must be unique within an Artifact')
    ids.add(observation.observationId)
  }
  return observations
}

function observationMapOf(value: unknown): ArtifactObservations {
  if (!isRecord(value)) return badInput('saved observation projection must be an object')
  return Object.fromEntries(Object.entries(value).map(([id, observations]) => [artifactIdOf(id), observationsOf(observations, id)]))
}

function observationValuesMatch(value: unknown, expected: ParticleObservation): boolean {
  if (!isRecord(value) || value.time !== expected.time || !Array.isArray(value.particles)
    || value.particles.length !== expected.particles.length) return false
  const particles = value.particles
  return expected.particles.every((particle, index) => {
    const input: unknown = particles[index]
    return isRecord(input) && input.id === particle.id && input.x === particle.x && input.y === particle.y
      && input.vx === particle.vx && input.vy === particle.vy
  })
}

function actionPayloadOf(message: UserMessage, action: string): Record<string, unknown> | undefined {
  if (message.source.kind !== 'artifact-action' || message.content.length !== 1 || message.content[0]?.type !== 'text') return
  let data: unknown
  try { data = JSON.parse(message.content[0].text) } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return
  }
  if (!isRecord(data) || data.kind !== 'artifact_action' || data.action !== action
    || data.artifactId !== message.source.artifactId || data.revision !== message.source.revision || !isRecord(data.payload)) return
  return data.payload
}

function receiptOf(message: UserMessage, observations: ArtifactObservations): SavedParticleObservation | undefined {
  if (message.source.kind !== 'artifact-action') return
  const payload = actionPayloadOf(message, 'physics.inspected')
  if (payload === undefined) return
  const saved = observationListOf(observations, message.source.artifactId)
    .find(observation => observation.observationId === payload.observationId)
  if (saved === undefined || saved.artifact.revision !== message.source.revision || payload.label !== saved.label
    || payload.runtimeVersion !== saved.checkpoint.runtimeVersion || payload.stepCount !== saved.checkpoint.stepCount
    || !observationValuesMatch(payload, saved.values)) return
  return saved
}

function observationRefOf(value: unknown): SavedParticleObservationRef {
  if (!isRecord(value)) return badInput('saved observation reference must be an object')
  return { artifactId: artifactIdOf(value.artifactId), observationId: observationIdOf(value.observationId) }
}

function resolveObservation(observations: ArtifactObservations, ref: SavedParticleObservationRef): SavedParticleObservation | undefined {
  return observationListOf(observations, ref.artifactId).find(saved => saved.observationId === ref.observationId)
}

function observationListOf(observations: ArtifactObservations, id: string): readonly SavedParticleObservation[] {
  return Object.hasOwn(observations, id) ? observations[id] ?? [] : []
}

function comparisonKey(group: string, control: SavedParticleObservationRef, variant: SavedParticleObservationRef): string {
  return JSON.stringify([group, control.artifactId, control.observationId, variant.artifactId, variant.observationId])
}

function comparisonSideMatches(value: unknown, expected: ParticleObservationComparison['control']): boolean {
  return isRecord(value) && isRecord(value.ref) && value.ref.artifactId === expected.ref.artifactId
    && value.ref.observationId === expected.ref.observationId && value.label === expected.label
    && value.revision === expected.revision && observationValuesMatch(value.values, expected.values)
}

function comparisonReceiptOf(message: UserMessage, observations: ArtifactObservations): string | undefined {
  if (message.source.kind !== 'artifact-action') return
  const payload = actionPayloadOf(message, 'comparison.completed')
  if (payload === undefined || payload.kind !== 'saved-particle-observation-comparison' || typeof payload.group !== 'string'
    || !isRecord(payload.control) || !isRecord(payload.variant) || !isRecord(payload.conditions)) return
  let controlRef: SavedParticleObservationRef
  let variantRef: SavedParticleObservationRef
  try {
    controlRef = observationRefOf(payload.control.ref)
    variantRef = observationRefOf(payload.variant.ref)
  } catch (error) {
    if (!(error instanceof ArtifactError)) throw error
    return
  }
  const control = resolveObservation(observations, controlRef)
  const variant = resolveObservation(observations, variantRef)
  if (control === undefined || variant === undefined || message.source.artifactId !== controlRef.artifactId
    || message.source.revision !== control.artifact.revision) return
  let expected: ParticleObservationComparison
  try { expected = buildParticleObservationComparison(payload.group, control, variant) } catch (error) {
    if (!(error instanceof ParticleObservationComparisonError) && !(error instanceof ParticleRuntimeError)) throw error
    return
  }
  const conditions = payload.conditions
  if (conditions.runtimeVersion !== expected.conditions.runtimeVersion || conditions.stepCount !== expected.conditions.stepCount
    || conditions.timeStep !== expected.conditions.timeStep || conditions.time !== expected.conditions.time
    || !comparisonSideMatches(payload.control, expected.control) || !comparisonSideMatches(payload.variant, expected.variant)) return
  return comparisonKey(expected.group, expected.control.ref, expected.variant.ref)
}

function comparisonReceiptsOf(value: unknown, observations: ArtifactObservations): Readonly<Record<string, true>> {
  if (!isRecord(value)) return badInput('comparison receipts must be an object')
  return Object.fromEntries(Object.entries(value).map(([key, admitted]) => {
    let tuple: unknown
    try { tuple = JSON.parse(key) } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return badInput('comparison receipt key must be an ordered observation pair')
    }
    if (admitted !== true || !Array.isArray(tuple) || tuple.length !== 5 || typeof tuple[0] !== 'string') {
      return badInput('comparison receipt key must be an ordered observation pair')
    }
    const group = tuple[0]
    const entries: readonly unknown[] = tuple
    const controlRef = observationRefOf({ artifactId: entries[1], observationId: entries[2] })
    const variantRef = observationRefOf({ artifactId: entries[3], observationId: entries[4] })
    const control = resolveObservation(observations, controlRef)
    const variant = resolveObservation(observations, variantRef)
    if (control === undefined || variant === undefined || comparisonKey(group, controlRef, variantRef) !== key) {
      return badInput('comparison receipt must identify existing saved observations')
    }
    buildParticleObservationComparison(group, control, variant)
    return [key, true]
  }))
}

function projectionSchema<T>(parse: (value: unknown) => T): ZodType<T> {
  return zod.unknown().transform((value, context) => {
    try { return parse(value) } catch (error) {
      if (!(error instanceof ArtifactError) && !(error instanceof ParticleRuntimeError)
        && !(error instanceof ParticleObservationComparisonError)) throw error
      context.addIssue({ code: 'custom', message: error.message })
      return zod.NEVER
    }
  })
}

const artifactProjection = {
  key: 'artifactObservations',
  stateVersion: 3,
  stateSchema: projectionSchema<ArtifactState>((value) => {
    if (!isRecord(value) || !isRecord(value.current)) return badInput('Artifact projection requires current snapshots')
    const current = Object.fromEntries(Object.entries(value.current).map(([id, snapshot]) => {
      const parsed = snapshotOf(snapshot)
      if (parsed.artifactId !== artifactIdOf(id)) return badInput('Artifact projection snapshot key does not match its identity')
      return [id, parsed]
    }))
    const observations = observationMapOf(value.observations)
    if (!isRecord(value.sent) || !Number.isSafeInteger(value.inheritedEventCount)
      || typeof value.inheritedEventCount !== 'number' || value.inheritedEventCount < 0) return badInput('invalid Artifact receipt checkpoint')
    const sent = Object.fromEntries(Object.entries(value.sent).map(([id, ids]) => {
      if (!Array.isArray(ids)) return badInput('Artifact receipt ids must be an array')
      const parsed = ids.map(observationIdOf)
      if (new Set(parsed).size !== parsed.length
        || parsed.some(savedId => !observationListOf(observations, id).some(item => item.observationId === savedId))) {
        return badInput('Artifact receipt ids must identify unique saved observations')
      }
      return [artifactIdOf(id), parsed]
    }))
    const sentComparisons = comparisonReceiptsOf(value.sentComparisons, observations)
    return { current, observations, sent, sentComparisons, inheritedEventCount: value.inheritedEventCount }
  }),
  init: (_header, inheritedEventCount): ArtifactState => ({
    current: {}, observations: {}, sent: {}, sentComparisons: {}, inheritedEventCount,
  }),
  apply: (state, event) => {
    if (event.type === 'artifact/upsert') {
      const snapshot = snapshotOf(event.data)
      return { ...state, current: { ...state.current, [snapshot.artifactId]: snapshot } }
    }
    if (event.type === 'artifact/observations') {
      const id = artifactIdOf(event.data.artifactId)
      const observations = observationsOf(event.data.observations, id)
      return { ...state, observations: { ...state.observations, [id]: observations } }
    }
    if (event.seq < state.inheritedEventCount) return state
    const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted
      : event.type === 'user/message' ? [event.data] : []
    let sent = state.sent
    let sentComparisons = state.sentComparisons
    for (const message of messages) {
      const comparison = comparisonReceiptOf(message, state.observations)
      if (comparison !== undefined && sentComparisons[comparison] !== true) sentComparisons = { ...sentComparisons, [comparison]: true }
      const receipt = receiptOf(message, state.observations)
      if (receipt === undefined) continue
      const id = receipt.artifact.artifactId
      const sentIds = Object.hasOwn(sent, id) ? sent[id] ?? [] : []
      if (sentIds.includes(receipt.observationId)) continue
      sent = { ...sent, [id]: [...sentIds, receipt.observationId] }
    }
    if (sent !== state.sent || sentComparisons !== state.sentComparisons) return { ...state, sent, sentComparisons }
    return state
  },
  wire: { viewSchema: projectionSchema(observationMapOf), view: state => state.observations, summary: false },
} satisfies ProjectionDefinition<'artifactObservations', ArtifactState>

/** `ctx.artifacts`: validated artifact snapshots and user-action routing. */
export class ArtifactService extends TypertRemoteService {
  static inject = ['sessionProjections']

  static Config: z<Config> = z.object({
    maxSourceBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(262_144),
    maxActionBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
    maxSavedObservationsPerArtifact: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(32),
  })

  private readonly maxSourceBytes: number
  private readonly maxActionBytes: number
  private readonly maxSavedObservationsPerArtifact: number
  /** Artifacts with a prepared snapshot that has not been committed or discarded yet, per Session. */
  private readonly writers = new WeakMap<Agent['session'], Map<ArtifactId, symbol>>()
  private projection!: ProjectionHandle<ArtifactState>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'artifacts')
    this.maxSourceBytes = positiveLimit(config.maxSourceBytes ?? 262_144, 'maxSourceBytes')
    this.maxActionBytes = positiveLimit(config.maxActionBytes ?? 16_384, 'maxActionBytes')
    this.maxSavedObservationsPerArtifact = positiveLimit(config.maxSavedObservationsPerArtifact ?? 32, 'maxSavedObservationsPerArtifact')
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(artifactProjection)
  }

  private current(agent: Agent, artifactId: ArtifactId): ArtifactSnapshot | undefined {
    const current = this.projection.stateOf(agent.session).current
    return Object.hasOwn(current, artifactId) ? current[artifactId] : undefined
  }

  /**
   * Read one source revision visible in an already prepared Session.
   * @param agent - Agent whose Session defines the visible source prefix.
   * @param artifactId - Artifact identity within that Session.
   * @returns An independent snapshot, or undefined when the source is not visible; no activation or I/O occurs.
   */
  currentSnapshot(agent: Agent, artifactId: ArtifactId): ArtifactSnapshot | undefined {
    const current = this.current(agent, artifactId)
    return current === undefined ? undefined : structuredClone(current)
  }

  /**
   * Read an original saved observation visible in one prepared Session.
   * @param agent - Agent whose Session owns the visible source prefix.
   * @param ref - Artifact and saved-observation identity in that Session.
   * @returns Independent saved source, checkpoint and recomputed particle values.
   * @throws {ArtifactError} When the saved observation is not visible.
   */
  resolveSavedObservation(agent: Agent, ref: SavedParticleObservationRef): SavedParticleObservation {
    const observation = resolveObservation(this.projection.stateOf(agent.session).observations, {
      artifactId: artifactIdOf(ref.artifactId), observationId: observationIdOf(ref.observationId),
    })
    if (observation === undefined) throw new ArtifactError('Saved observation is unavailable', 'ARTIFACT_NOT_FOUND')
    return savedObservationOf(observation)
  }

  /**
   * Resolve a Scene selection to a complete original source and validated replay point.
   * @param agent - Agent whose prepared Session owns the source and saved observations.
   * @param selection - Current source revision or a previously saved observation reference.
   * @returns Independent complete source values; particle coordinates are recomputed.
   * @throws {ArtifactError} For missing, stale, or unsupported sources.
   * @throws {ParticleRuntimeError} For invalid replay conditions.
   */
  resolveSceneSource(agent: Agent, selection: ArtifactExportSourceSelection): ArtifactExportSource {
    const id = artifactIdOf(selection.artifactId)
    if (selection.kind === 'observation') {
      const saved = this.resolveSavedObservation(agent, { artifactId: id, observationId: selection.observationId })
      return { artifact: saved.artifact, checkpoint: saved.checkpoint, observationId: saved.observationId }
    }
    const expectedRevision = revisionOf(selection.revision)
    const current = this.current(agent, id)
    if (current === undefined) throw new ArtifactError('Artifact source is unavailable', 'ARTIFACT_NOT_FOUND')
    if (current.revision !== expectedRevision) throw new ArtifactError('Artifact source revision changed', 'STALE_REVISION')
    const artifact = snapshotOf(current)
    if (artifact.format !== 'scene') throw new ArtifactError('HTML export requires a Scene source', 'UNSUPPORTED_EXPORT_SOURCE')
    if (artifact.spec.kind === 'particle-system') {
      return { artifact, checkpoint: createParticleCheckpoint(restoreParticleCheckpoint(artifact.spec, selection.checkpoint)) }
    }
    if (selection.checkpoint !== undefined) throw new ArtifactError('This Scene does not support a particle checkpoint', 'UNSUPPORTED_EXPORT_SOURCE')
    return { artifact }
  }

  /**
   * Validate and normalize one complete create or update without committing it.
   * @param agent - Agent whose Session supplies the current artifact revision.
   * @param input - Complete new values and, for update, the observed base revision.
   * @returns The snapshot to commit after the enclosing operation succeeds.
   * @throws {ArtifactError} `ARTIFACT_BUSY`, `ARTIFACT_EXISTS`, `ARTIFACT_NOT_FOUND`, `STALE_REVISION`,
   * `BAD_SOURCE`, or `BAD_INPUT`; no Session event is appended.
   */
  prepare(agent: Agent, input: ArtifactPrepareInput): ArtifactSnapshot {
    if (!isRecord(input)) return badInput('artifact input must be an object')
    const action: unknown = input.action
    if (action !== 'create' && action !== 'update') {
      return badInput('action must be create or update')
    }
    const artifactId = artifactIdOf(input.artifactId)
    const writers = this.writersOf(agent)
    if (writers.has(artifactId)) {
      throw new ArtifactError(
        `artifact "${artifactId}" already has a prepared snapshot awaiting commit`,
        'ARTIFACT_BUSY',
      )
    }
    writers.set(artifactId, Symbol(artifactId))
    try {
      const current = this.current(agent, artifactId)
      let revision: number
      if (action === 'create') {
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
    } catch (error) {
      writers.delete(artifactId)
      throw error
    }
  }

  /**
   * Append one validated complete snapshot only when it still follows the committed revision.
   * @param agent - Agent owning the Session log.
   * @param snapshot - Prepared complete artifact value.
   * @throws {ArtifactError} `STALE_REVISION` when the log moved past the prepared base, or when the
   * snapshot violates the same persistent validation as `prepare`; no Session event is appended.
   */
  commit(agent: Agent, snapshot: ArtifactSnapshot): void {
    const writers = this.writersOf(agent)
    const current = this.current(agent, snapshot.artifactId)
    if (current === undefined ? snapshot.revision !== 1 : snapshot.revision !== current.revision + 1) {
      writers.delete(snapshot.artifactId)
      throw new ArtifactError(
        current === undefined
          ? `artifact "${snapshot.artifactId}" has no committed revision to follow ${snapshot.revision}`
          : `artifact "${snapshot.artifactId}" is at revision ${current.revision}; ${snapshot.revision} cannot follow it`,
        'STALE_REVISION',
      )
    }
    writers.delete(snapshot.artifactId)
    agent.session.append('artifact/upsert', snapshotOf(snapshot, this.maxSourceBytes))
  }

  /**
   * Release one prepared snapshot without writing it, so a failed or aborted operation does not block later updates.
   * @param agent - Agent whose Session owns the artifact.
   * @param artifactId - Artifact identity of the discarded preparation.
   */
  discard(agent: Agent, artifactId: ArtifactId): void {
    this.writersOf(agent).delete(artifactId)
  }

  private writersOf(agent: Agent): Map<ArtifactId, symbol> {
    const existing = this.writers.get(agent.session)
    if (existing !== undefined) return existing
    const created = new Map<ArtifactId, symbol>()
    this.writers.set(agent.session, created)
    return created
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
   * Save a named particle observation without adding input or waking the Agent.
   * @param agent - Exact live root Agent owning the Session.
   * @param artifactId - Particle Artifact to inspect.
   * @param revision - Current source revision that produced the checkpoint.
   * @param observationId - Client-generated retry identity, stable until the request succeeds.
   * @param label - User label containing 1-80 characters after trimming.
   * @param checkpoint - Runtime version and step count; coordinates are recomputed by the Host.
   * @returns The immutable saved value; an identical retry returns the existing observation.
   * @throws {RemoteError} `artifact/stale-revision` or `artifact/observation-limit`; no observation is appended.
   * @throws {ArtifactError} For conflicting retry identities, unsupported sources, or invalid caller input.
   * @throws {ParticleRuntimeError} For an invalid checkpoint or non-finite derived state; no event is appended.
   */
  @Remote
  saveObservation(
    agent: Agent,
    artifactId: ArtifactId,
    revision: number,
    observationId: ArtifactObservationId,
    label: string,
    checkpoint: ParticleCheckpoint,
  ): SavedParticleObservation {
    this.assertLiveRoot(agent)
    const id = artifactIdOf(artifactId)
    const expectedRevision = revisionOf(revision)
    const savedId = observationIdOf(observationId)
    const savedLabel = observationLabelOf(label)
    const observations = observationListOf(this.projection.stateOf(agent.session).observations, id)
    const existing = observations.find(observation => observation.observationId === savedId)
    if (existing !== undefined) {
      const retryCheckpoint = createParticleCheckpoint(restoreParticleCheckpoint(particleSource(existing.artifact).spec, checkpoint))
      if (existing.artifact.revision !== expectedRevision || existing.label !== savedLabel
        || existing.checkpoint.stepCount !== retryCheckpoint.stepCount) {
        throw new ArtifactError('observationId already identifies a different saved observation', 'OBSERVATION_CONFLICT')
      }
      return savedObservationOf(existing)
    }
    const current = this.current(agent, id)
    if (current === undefined) throw new ArtifactError(`artifact "${id}" does not exist`, 'ARTIFACT_NOT_FOUND')
    if (current.revision !== expectedRevision) {
      const cause = new ArtifactError(`artifact "${id}" is at revision ${current.revision}, not ${expectedRevision}`, 'STALE_REVISION')
      throw new RemoteError('artifact/stale-revision', cause.message,
        { artifactId: id, expectedRevision, currentRevision: current.revision }, { cause })
    }
    const { artifact, spec } = particleSource(current)
    const state = restoreParticleCheckpoint(spec, checkpoint)
    if (observations.length >= this.maxSavedObservationsPerArtifact) {
      const cause = new ArtifactError('saved observation limit reached for this Artifact', 'OBSERVATION_LIMIT')
      throw new RemoteError('artifact/observation-limit', cause.message,
        { artifactId: id, limit: this.maxSavedObservationsPerArtifact }, { cause })
    }
    const saved: SavedParticleObservation = {
      observationId: savedId, label: savedLabel, artifact, checkpoint: createParticleCheckpoint(state), values: observeParticleState(state),
    }
    agent.session.append('artifact/observations', { artifactId: id, observations: [...observations, saved] })
    return saved
  }

  /**
   * Send an explicitly selected saved observation, including one from an older source revision.
   * @param agent - Exact live root Agent owning the saved observation.
   * @param artifactId - Artifact under which the observation was saved.
   * @param observationId - Durable observation identity; caller-supplied values are never used.
   * @param wake - Whether to steer the Agent or inject without waking.
   * @returns Inbox admission and the saved source revision; retries do not enqueue a second message.
   * @throws {ArtifactError} For an unknown observation, invalid caller or oversized action; no source revision is changed.
   */
  @Remote
  sendObservation(agent: Agent, artifactId: ArtifactId, observationId: ArtifactObservationId, wake: boolean): ArtifactRecordResult {
    this.assertLiveRoot(agent)
    const id = artifactIdOf(artifactId)
    const savedId = observationIdOf(observationId)
    const saved = resolveObservation(this.projection.stateOf(agent.session).observations, { artifactId: id, observationId: savedId })
    if (saved === undefined) throw new ArtifactError('saved observation does not exist for this Artifact', 'OBSERVATION_NOT_FOUND')
    if (typeof wake !== 'boolean') return badInput('wake must be a boolean')
    const sent = this.projection.stateOf(agent.session).sent
    if (Object.hasOwn(sent, id) && sent[id]?.includes(savedId)) return { accepted: true, revision: saved.artifact.revision }
    return this.admitAction(agent, id, saved.artifact.revision, 'physics.inspected', {
      observationId: saved.observationId, label: saved.label,
      runtimeVersion: saved.checkpoint.runtimeVersion, stepCount: saved.checkpoint.stepCount, ...saved.values,
    }, wake)
  }

  /**
   * Confirm one fixed control/variant observation pair as ordinary user input.
   * @param agent - Exact live root Agent whose Session resolves both saved references.
   * @param group - Comparison group on the saved source revisions, independent of current revisions.
   * @param controlRef - Saved control observation; Client coordinates are never accepted.
   * @param variantRef - Saved variant observation with equal runtime, time step and step count.
   * @param wake - Whether to steer the Agent or inject without waking.
   * @returns The recomputed comparison; the same ordered pair is admitted at most once per Session.
   * @throws {RemoteError} `artifact/comparison-rejected` for incompatible, missing or oversized observations; no input is added.
   * @throws {ArtifactError} For invalid references, group or caller. An admission failure may have committed input; retry the same pair.
   */
  @Remote
  confirmObservationComparison(
    agent: Agent, group: string, controlRef: SavedParticleObservationRef, variantRef: SavedParticleObservationRef, wake: boolean,
  ): ArtifactObservationComparisonResult {
    this.assertLiveRoot(agent)
    const savedGroup = comparisonOf({ group, role: 'control' }).group
    const controlIdentity = observationRefOf(controlRef)
    const variantIdentity = observationRefOf(variantRef)
    if (typeof wake !== 'boolean') return badInput('wake must be a boolean')
    const state = this.projection.stateOf(agent.session)
    const control = resolveObservation(state.observations, controlIdentity)
    const variant = resolveObservation(state.observations, variantIdentity)
    if (control === undefined || variant === undefined) {
      throw new RemoteError('artifact/comparison-rejected', 'Both saved observations must exist in this Session', { reason: 'OBSERVATION_NOT_FOUND' })
    }
    let comparison: ParticleObservationComparison
    try { comparison = buildParticleObservationComparison(savedGroup, control, variant) } catch (error) {
      if (!(error instanceof ParticleObservationComparisonError)) throw error
      throw new RemoteError('artifact/comparison-rejected', error.message, { reason: error.code }, { cause: error })
    }
    const key = comparisonKey(savedGroup, controlIdentity, variantIdentity)
    if (state.sentComparisons[key] === true) return { accepted: true, comparison }
    try { this.admitAction(agent, controlIdentity.artifactId, control.artifact.revision, 'comparison.completed', comparison, wake) } catch (error) {
      if (!(error instanceof ArtifactError) || error.code !== 'ACTION_TOO_LARGE') throw error
      throw new RemoteError('artifact/comparison-rejected', error.message, { reason: 'ACTION_TOO_LARGE' }, { cause: error })
    }
    return { accepted: true, comparison }
  }

  /**
   * Admit one identified user action, or acknowledge the exact message accepted earlier in this Session.
   * @param agent - Exact live root Agent owning the action and receipt.
   * @param request - Original request identity, reviewed source, action, payload and first-admission delivery policy.
   * @returns Acceptance of that original message; retries do not dispatch or wake again.
   * @throws {RemoteError} A known refusal, conflicting identity, unavailable admission service, or unknown dispatch outcome.
   */
  @Remote
  async submitAction(agent: Agent, request: ArtifactActionRequest): Promise<ArtifactRecordResult> {
    try {
      if (principalOf(this.ctx.invocation) !== undefined) {
        throw new RemoteError('artifact/action-rejected', 'Only the owner can submit Artifact actions', { reason: 'CALLER_NOT_OWNER' })
      }
      const admissions = this.ctx.get('sessionInputs')
      if (admissions === undefined) {
        throw new RemoteError('artifact/action-unavailable', 'Artifact action admission is not available', { reason: 'SERVICE_UNAVAILABLE' })
      }
      if (typeof request.requestId !== 'string' || request.requestId.length < 1 || request.requestId.length > 128) {
        return badInput('action requestId must contain 1 to 128 characters')
      }
      const id = artifactIdOf(request.artifactId)
      const revision = revisionOf(request.revision)
      const text = this.actionText(id, revision, request.action, request.payload, request.wake)
      const message = freezeMessage({
        role: 'user', id: request.requestId, source: { kind: 'artifact-action', artifactId: id, revision },
        content: [{ type: 'text', text }],
      } satisfies UserMessage)
      try {
        await admissions.admitMessage(agent, message, request.wake ? 'steer' : 'inject', () => {
          this.assertLiveRoot(agent)
          const current = this.current(agent, id)
          if (current === undefined) throw new ArtifactError(`artifact "${id}" does not exist`, 'ARTIFACT_NOT_FOUND')
          if (current.revision !== revision) {
            throw new RemoteError('artifact/action-rejected', 'Artifact source revision changed', {
              reason: 'STALE_REVISION', currentRevision: current.revision,
            })
          }
          this.validateActionBytes(text)
        })
      } catch (error) {
        if (!(error instanceof SessionInputAdmissionError)) throw error
        switch (error.code) {
          case 'CONFLICT': throw new RemoteError('artifact/action-conflict', 'Action identity belongs to different input', {
            requestId: request.requestId,
          }, { cause: error })
          case 'CLOSED': case 'AGENT_UNAVAILABLE': throw new RemoteError('artifact/action-unavailable', 'Artifact action admission is unavailable', {
            reason: error.code,
          }, { cause: error })
          case 'INVALID_INPUT': throw new RemoteError('artifact/action-rejected', 'Artifact action input is invalid', {
            reason: 'BAD_INPUT',
          }, { cause: error })
          case 'UNKNOWN_OUTCOME': throw new RemoteError('artifact/action-unknown', 'Unable to confirm Artifact action admission', {
            requestId: request.requestId,
          }, { cause: error })
          default: return assertNever(error.code, 'SessionInputAdmissionError')
        }
      }
      return { accepted: true, revision }
    } catch (error) {
      if (!(error instanceof ArtifactError)) throw error
      switch (error.code) {
        case 'BAD_INPUT': case 'CALLER_NOT_LIVE_ROOT': case 'AGENT_REGISTRY_UNAVAILABLE':
        case 'ARTIFACT_NOT_FOUND': case 'ACTION_TOO_LARGE':
          throw new RemoteError('artifact/action-rejected', error.message, { reason: error.code }, { cause: error })
        default: throw error
      }
    }
  }

  private admitAction(
    agent: Agent, id: ArtifactId, revision: number, action: string, payload: unknown, wake: boolean,
  ): ArtifactRecordResult {
    const text = this.actionText(id, revision, action, payload, wake)
    this.validateActionBytes(text)
    const message = createUserMessage({
      source: { kind: 'artifact-action', artifactId: id, revision },
      content: [{ type: 'text', text }],
    })
    if (wake) agent.steer(message)
    else agent.inject(message)
    return { accepted: true, revision }
  }

  private actionText(id: ArtifactId, revision: number, action: string, payload: unknown, wake: boolean): string {
    if (typeof action !== 'string') return badInput('action must be a string')
    const normalizedAction = action.trim()
    if (normalizedAction.length < 1 || normalizedAction.length > 64 || !ACTION_PATTERN.test(normalizedAction)) {
      return badInput('action must be a trimmed 1-64 character name matching [A-Za-z][A-Za-z0-9._-]*')
    }
    if (typeof wake !== 'boolean') return badInput('wake must be a boolean')
    const detachedPayload = snapshotJsonValue(payload)
    if (detachedPayload === undefined) return badInput('payload must be a lossless JSON value')
    return JSON.stringify({
      kind: 'artifact_action',
      artifactId: id,
      revision,
      action: normalizedAction,
      payload: detachedPayload,
    })
  }

  private validateActionBytes(text: string): void {
    if (Buffer.byteLength(text, 'utf8') > this.maxActionBytes) {
      throw new ArtifactError(`artifact action exceeds the ${this.maxActionBytes}-byte limit`, 'ACTION_TOO_LARGE')
    }
  }
}

export default ArtifactService
