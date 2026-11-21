/** Particle calculation and explicit question choices over canonical particle and program-report sources. */
import { createSnapshotStore, type ObservableSnapshot } from '@agentrans/client-store'
import type { ArtifactId, ArtifactSnapshot, SavedParticleObservation, SavedParticleObservationRef, SceneArtifactSnapshot } from '@agentrans/artifact/types'
import type { CsvBarChartSpec, ParticleSystemSpec } from '@agentrans/artifact/scene'
import { deepEqualJson, deepFreeze, snapshotJsonValue } from '@agentrans/util-values'
import { analyzeFunctionPlotSelection } from '@agentrans/artifact/scene-renderers'
import type { ArtifactRuntimeIdentity } from '@agentrans/artifact-runtime/types'
import type { SessionId } from '@agentrans/session/types'
import type { ArtifactRuntimeSnapshot } from './runtime-owner.ts'
import { runtimeHtmlCheckpoint, runtimeQuestionAvailability, type RuntimeQuestionAvailability } from './runtime-question.ts'
import type { ArtifactHtmlCheckpoint } from '@agentrans/artifact/runtime-values'
import type {
  ArtifactCsvComparisonAttachment, ArtifactCsvComparisonDraft, ArtifactProgramQuestionCapture, ArtifactPromptContextSelection,
  FunctionPlotQuestionConditions,
} from '@agentrans/artifact-followup/types'
import {
  CsvComparisonDraftOwner, isCsvReturnedSourceOrigin, sameCsvSentQuestion, type CsvComparisonDraftCommands, type CsvComparisonSourceTrail,
  type CsvComparisonSourceVisit,
} from './csv-comparison-draft.ts'
import { csvComparisonSourceKind, csvDraftSource,
  type CsvComparisonSourceRecovery, type VerifiedCsvComparisonSourceTrail } from './csv-comparison-source-chain.ts'
import { CsvExplanationSelectionOwner } from './csv-comparison-explanation.ts'
import type { FunctionPlotDraft } from './function-plot-draft.ts'
import {
  createParticleCheckpoint, observeParticleState, particleSpecAtGravity, ParticleRuntimeError, restoreParticleCheckpoint,
  type ParticleCheckpoint, type ParticleObservation,
} from '@agentrans/artifact/particle-runtime'
import { createParticleRun, updateParticleRun, type ParticleRun, type ParticleRunCommand } from './particle-run.ts'
import type { ArtifactQuestionReplay } from './question-context-text.ts'

/** Current source and its sole live calculation. */
export interface ArtifactParticleRuntime {
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly run: ParticleRun
  readonly generation: number
  readonly gravityY?: number
}

/** Readings and restore point from the same displayed step. */
export interface ParticleQuestionReadings {
  readonly generation: number
  readonly checkpoint: ParticleCheckpoint
  readonly values: ParticleObservation
  readonly gravityY?: number
}

/**
 * Capture the checkpoint and readings from the same displayed step.
 * @param runtime - Displayed particle run.
 * @returns The run generation, checkpoint and readings for review.
 */
export function particleQuestionReadings(runtime: ArtifactParticleRuntime): ParticleQuestionReadings {
  const { generation, run: { state }, gravityY } = runtime
  return { generation, checkpoint: createParticleCheckpoint(state), values: observeParticleState(state),
    ...(gravityY === undefined ? {} : { gravityY }) }
}

/** Display metadata and immutable saved identity, without copying source or computed values. */
export interface ArtifactPromptObservation {
  readonly ref: SavedParticleObservationRef
  readonly title: string
  readonly label: string
  readonly revision: number
  readonly stepCount: number
}

function observationChoice(saved: SavedParticleObservation): ArtifactPromptObservation {
  return { ref: { artifactId: saved.artifact.artifactId, observationId: saved.observationId }, title: saved.artifact.title,
    label: saved.label, revision: saved.artifact.revision, stepCount: saved.checkpoint.stepCount }
}

type FunctionPlotSelection = Extract<ArtifactPromptContextSelection, { kind: 'current-function-plot' }>
type CsvGroupSelection = Extract<ArtifactPromptContextSelection, { kind: 'current-csv-bar-chart' }>
type BranchEvidenceSelection = Extract<ArtifactPromptContextSelection, { kind: 'branch-evidence' }>
type BranchHtmlSelection = Extract<ArtifactPromptContextSelection, { kind: 'branch-bfs-checkpoint' | 'branch-half-adder-checkpoint' }>
type HtmlSelection = Extract<ArtifactPromptContextSelection, { kind: 'html-runtime' }>

/** Stable identity of a returned evidence message in the current Session. */
export type BranchEvidenceReference = Pick<BranchEvidenceSelection, 'eventSeq' | 'messageId'>

/** Explicit user choice carried by the composer. */
export type ArtifactPromptBinding =
  | {
    readonly kind: 'current-particle'
    readonly key: string
    readonly artifactId: ArtifactId
    readonly revision: number
    readonly title: string
    readonly readings: ParticleQuestionReadings
    readonly available: boolean
  }
  | {
    readonly kind: 'html-runtime'
    readonly key: string
    readonly identity: ArtifactRuntimeIdentity
    readonly title: string
    readonly availability: RuntimeQuestionAvailability | 'stale'
  }
  | (({ readonly kind: 'html-bfs' } | { readonly kind: 'html-half-adder' }) & {
    readonly title: string
    readonly request: HtmlSelection
    readonly checkpoint: ArtifactHtmlCheckpoint
    readonly available: boolean
  })
  | {
    readonly kind: 'current-function-plot'
    readonly title: string
    readonly request: FunctionPlotSelection
    readonly available: boolean
    readonly draft?: FunctionPlotDraft
    readonly restoration?: 'reading' | 'retry'
  }
  | {
    readonly kind: 'current-csv-bar-chart'
    readonly title: string
    readonly request: CsvGroupSelection
    readonly recipe: Pick<CsvBarChartSpec, 'valueColumn' | 'aggregate' | 'filter'>
    readonly group: CsvBarChartSpec['groups'][number]
    readonly available: boolean
  }
  | {
    readonly kind: 'branch-evidence'
    readonly title: string
    readonly request: BranchEvidenceSelection
    readonly replay: ArtifactQuestionReplay
  }
  | { readonly kind: 'csv-question-comparison'; readonly draft: ArtifactCsvComparisonDraft }
  | (({ readonly kind: 'branch-bfs-checkpoint' } | { readonly kind: 'branch-half-adder-checkpoint' }) & {
    readonly title: string
    readonly revision: number
    readonly request: BranchHtmlSelection
  })
  | { readonly kind: 'observation'; readonly observation: ArtifactPromptObservation }
  | {
    readonly kind: 'comparison'
    readonly group: string
    readonly control: ArtifactPromptObservation
    readonly variant: ArtifactPromptObservation
  }


/**
 * Source identity for a keyed particle observer.
 * @param nodeKey - Chat Node key.
 * @param artifactId - Artifact within the Node.
 * @returns Stable compound key.
 */
export function particleRuntimeKey(nodeKey: string, artifactId: ArtifactId): string {
  return JSON.stringify([nodeKey, artifactId])
}

/**
 * Read the identities of a source selected by a keyed hook.
 * @param key - Package-created compound key.
 * @returns Node and Artifact identity.
 */
export function particleRuntimeIdentity(key: string): readonly [string, string] {
  const value: unknown = JSON.parse(key)
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'string') {
    throw new Error('Invalid Artifact runtime key')
  }
  return [value[0], value[1]]
}

/** Bare source whose subscription lifetime owns one current simulation. */
export class ArtifactParticleSource implements ObservableSnapshot<ArtifactParticleRuntime | undefined> {
  private value: ArtifactParticleRuntime | undefined
  private generation = 0
  private disposed = false
  private spec: ParticleSystemSpec | undefined
  private baselineCheckpoint: ParticleCheckpoint | undefined
  private readonly listeners = new Set<() => void>()
  private releaseSource: (() => void) | undefined

  /** @param source - Current node-owned Artifact revision. @param changed - Notify the selection owner when availability changes. */
  constructor(private readonly source: ObservableSnapshot<ArtifactSnapshot | undefined>, private readonly changed: () => void = () => {}) {
    this.refresh()
  }

  /** @returns The current calculation; no state is copied into a second owner. */
  readonly getSnapshot = (): ArtifactParticleRuntime | undefined => this.value

  /** @param listener - Renderer-owned subscriber. @returns Release, discarding unsaved state when the last renderer leaves. */
  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    if (this.releaseSource === undefined) {
      this.releaseSource = this.source.subscribe(this.refresh)
      this.refresh()
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size !== 0) return
      this.releaseSource?.()
      this.releaseSource = undefined
      this.value = undefined
      this.spec = undefined
      this.baselineCheckpoint = undefined
      this.changed()
    }
  }

  /**
   * Apply user intent or clock advancement to the sole live calculation.
   * @param command - Semantic user or clock command.
   */
  command(command: ParticleRunCommand): void {
    if (this.value === undefined || this.spec === undefined || this.releaseSource === undefined) return
    if (this.baselineCheckpoint !== undefined) {
      if (command === 'reset') this.setGravityY(this.spec.gravity.y)
      else if (typeof command !== 'string') this.setGravityY(command.value)
      return
    }
    if (typeof command !== 'string') return
    const run = updateParticleRun(this.spec, this.value.run, command)
    if (run === this.value.run) return
    this.value = { ...this.value, run }
    this.publish()
  }

  private setGravityY(gravityY: number): void {
    const { spec, value, baselineCheckpoint } = this
    if (spec === undefined || value === undefined || baselineCheckpoint === undefined
      || gravityY === value.gravityY && !value.run.failed) return
    const variant = particleSpecAtGravity(spec, baselineCheckpoint, gravityY, baselineCheckpoint)
    if (variant === undefined) return
    try {
      const state = restoreParticleCheckpoint(variant, baselineCheckpoint)
      this.value = { ...value, gravityY, run: { state, playing: false, failed: false } }
    } catch (error) {
      if (!(error instanceof ParticleRuntimeError)) throw error
      this.value = { ...value, run: { ...value.run, failed: true, failure: { code: error.code, message: error.message } } }
    }
    this.publish()
  }

  /**
   * Read conditions only while a renderer owns this runtime.
   * @returns A mounted current-source runtime, or absence after teardown.
   */
  capture(): ArtifactParticleRuntime | undefined {
    if (this.releaseSource === undefined) return undefined
    this.refresh()
    return this.value
  }

  /** End source reads and release the calculation with its Session binding. */
  dispose(): void {
    this.disposed = true
    this.releaseSource?.()
    this.releaseSource = undefined
    this.value = undefined
    this.spec = undefined
    this.baselineCheckpoint = undefined
    this.publish()
    this.listeners.clear()
  }

  private readonly refresh = (): void => {
    const artifact = this.source.getSnapshot()
    if (artifact?.format !== 'scene' || artifact.spec.kind !== 'particle-system') {
      if (this.value === undefined) return
      this.value = undefined
      this.spec = undefined
      this.baselineCheckpoint = undefined
      this.publish()
      return
    }
    if (this.value?.artifactId === artifact.artifactId && this.value.revision === artifact.revision) return
    this.spec = artifact.spec
    const checkpoint = this.baselineCheckpoint = artifact.particleContinuation?.baseline.checkpoint
    this.value = { artifactId: artifact.artifactId, revision: artifact.revision, generation: ++this.generation,
      ...(checkpoint === undefined ? { run: createParticleRun(artifact.spec) } : {
        gravityY: artifact.spec.gravity.y,
        run: { state: restoreParticleCheckpoint(artifact.spec, checkpoint), playing: false, failed: false },
      }) }
    this.publish()
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
    this.changed()
  }
}

interface HtmlQuestionLease {
  readonly source: ObservableSnapshot<ArtifactSnapshot | undefined>
  readonly runtime: ObservableSnapshot<ArtifactRuntimeSnapshot | undefined>
  readonly release: () => void
}

/** Session-scoped runtime ownership and explicit follow-up selection. */
export class ArtifactInteractionOwner {
  /** Transient explicit choice for an ordinary question; source and calculation remain separately owned. */
  readonly selection = createSnapshotStore<ArtifactPromptBinding | null>(null)
  /** Host-synchronized CSV comparison draft, absent when the Session offers no draft commands. */
  readonly csvDraft: CsvComparisonDraftOwner | undefined
  /** Pair of sent comparisons selected for a two-step explanation review. */
  readonly csvExplanation = new CsvExplanationSelectionOwner()
  /** Active return route displayed only on its current source. */
  readonly csvComparisonSourceTrail = createSnapshotStore<CsvComparisonSourceTrail | undefined>(undefined)
  /** Saved route awaiting verification against the restored Session. */
  readonly pendingCsvComparisonSourceTrail = createSnapshotStore<CsvComparisonSourceTrail | undefined>(undefined)
  /** Status of a saved route that could not be restored completely. */
  readonly csvComparisonSourceRecovery = createSnapshotStore<CsvComparisonSourceRecovery | undefined>(undefined)
  private requestedCsvSourceTrail: CsvComparisonSourceTrail | undefined
  private writeCsvSourceTrail: ((trail?: CsvComparisonSourceTrail) => void) | undefined
  private csvSourceVisitGesture = 0
  private csvDraftNavigation: number | undefined
  private readonly sources = new Map<string, ArtifactParticleSource>()
  private htmlSelectionLease: HtmlQuestionLease | undefined
  private releaseSourceSelection: (() => void) | undefined
  private disposed = false

  /**
   * @param sourceFor - Resolve the existing Chat Node source without another log fold.
   * @param html - Explicit program-report readers and Session identity, omitted by particle-only consumers.
   * @param csvDraft - Authorized access to this Session's comparison draft.
   */
  constructor(private readonly sourceFor: (key: string) => ObservableSnapshot<ArtifactSnapshot | undefined>,
    private readonly html?: {
      readonly sessionId: SessionId
      readonly runtimeFor: (key: string) => ObservableSnapshot<ArtifactRuntimeSnapshot | undefined>
    }, csvDraft?: CsvComparisonDraftCommands) {
    if (html === undefined || csvDraft === undefined) return
    this.csvDraft = new CsvComparisonDraftOwner(html.sessionId, csvDraft, (draft, explicit) => {
      const selected = this.selection.getSnapshot()
      if (draft === null) {
        if (selected?.kind === 'csv-question-comparison') this.selection.set(null)
      } else if (explicit || selected === null || selected.kind === 'csv-question-comparison') {
        this.releaseSelectionLease()
        this.selection.set({ kind: 'csv-question-comparison', draft })
      }
    })
  }

  /**
   * Follow a source from the top of the current route or start a new route.
   * @param visit - Exact source and return location.
   * @returns Whether the visit is still available.
   */
  visitCsvComparisonSource(visit: CsvComparisonSourceVisit): boolean {
    return this.openCsvComparisonSourceTrail([visit])
  }

  /**
   * Open a directly selected source with its verified intermediate stops.
   * @param trail - Verified route to the selected question.
   * @returns Whether the route was activated from a still-available origin.
   */
  openCsvComparisonSourceTrail(trail: CsvComparisonSourceTrail): boolean {
    const [first] = trail
    if (this.disposed || !this.isCsvComparisonSourceAvailable(first)) return false
    if (trail.slice(0, -1).some(visit => isCsvReturnedSourceOrigin(visit.origin))) return false
    const current = this.csvComparisonSourceTrail.getSnapshot()
    const tip = current?.at(-1)
    const extendsCurrent = current !== undefined && (first.origin.kind === 'comparison' || first.origin.kind === 'returned-comparison')
      && tip?.sourceKind === first.sourceKind
      && sameCsvSentQuestion(tip?.source, first.origin.message)
    if (extendsCurrent && (tip !== undefined && isCsvReturnedSourceOrigin(tip.origin)
      || !this.isActiveCsvComparisonSourceAvailable())) return false
    this.activateCsvSourceTrail(extendsCurrent ? [...current, ...trail] : trail)
    return true
  }

  /**
   * Apply verification for the current reload or explicit retry.
   * @param requested - The exact saved route that was verified.
   * @param verified - Verified prefix and any interruption.
   * @param retry - The active retry token when retrying a restore.
   * @returns Whether this result still belongs to the current navigation.
   */
  restoreCsvComparisonSourceTrail(requested: CsvComparisonSourceTrail,
    verified: VerifiedCsvComparisonSourceTrail = { trail: requested }, retry?: CsvComparisonSourceRecovery): boolean {
    const expected = retry === undefined ? this.pendingCsvComparisonSourceTrail.getSnapshot()
      : this.csvComparisonSourceRecovery.getSnapshot() === retry ? this.requestedCsvSourceTrail : undefined
    if (this.disposed || expected !== requested || !this.isCsvComparisonSourceAvailable(requested[0])) return false
    if (verified.interruption === undefined) {
      this.activateCsvSourceTrail(requested)
      return true
    }
    this.beginCsvSourceVisitGesture()
    // Preserve the requested destination across reloads until explicit navigation replaces it.
    this.requestedCsvSourceTrail = requested
    this.pendingCsvComparisonSourceTrail.set(undefined)
    this.csvComparisonSourceTrail.set(verified.trail)
    const source = verified.trail?.at(-1)?.source
    this.csvComparisonSourceRecovery.set({ ...verified.interruption, ...(source === undefined ? {} : { source }) })
    return true
  }

  /**
   * Mark this exact recovery as retrying and keep its verified route active.
   * @param recovery - The interruption rendered by the current view.
   * @returns The original route and token, or nothing for a stale or duplicate retry.
   */
  beginCsvSourceRecovery(recovery: CsvComparisonSourceRecovery): {
    readonly requested: CsvComparisonSourceTrail
    readonly retry: CsvComparisonSourceRecovery
  } | undefined {
    const requested = this.requestedCsvSourceTrail
    if (this.disposed || this.csvDraftNavigation !== undefined || requested === undefined
      || this.csvComparisonSourceRecovery.getSnapshot() !== recovery
      || recovery.status !== 'unavailable' || recovery.pending === true || !this.isCsvComparisonSourceAvailable(requested[0])) return undefined
    const retry = { ...recovery, pending: true } as const
    this.csvComparisonSourceRecovery.set(retry)
    return { requested, retry }
  }

  /**
   * Restore the retry control when an attempt loses its active view.
   * @param retry - The token for the attempt being ended.
   * @param recovery - The interruption before retry began.
   */
  finishCsvSourceRecovery(retry: CsvComparisonSourceRecovery, recovery: CsvComparisonSourceRecovery): void {
    if (this.csvComparisonSourceRecovery.getSnapshot() === retry) this.csvComparisonSourceRecovery.set(recovery)
  }

  private activateCsvSourceTrail(trail: CsvComparisonSourceTrail): void {
    const previous = this.csvDraft?.returnToDraftTarget.getSnapshot()
    if (previous !== undefined) this.csvDraft?.clearReturnToDraft(previous)
    this.updateCsvSourceTrail(trail)
  }

  private updateCsvSourceTrail(trail: CsvComparisonSourceTrail | undefined): void {
    this.beginCsvSourceVisitGesture()
    this.csvDraftNavigation = undefined
    this.requestedCsvSourceTrail = undefined
    this.csvComparisonSourceRecovery.set(undefined)
    this.pendingCsvComparisonSourceTrail.set(undefined)
    this.writeCsvSourceTrail?.(trail)
    this.csvComparisonSourceTrail.set(trail)
  }

  /**
   * Supersede any unfinished source navigation.
   * @returns The token for the newest navigation.
   */
  beginCsvSourceVisitGesture(): number {
    return ++this.csvSourceVisitGesture
  }

  /**
   * Check whether asynchronous navigation has been superseded.
   * @param gesture - Token captured when navigation began.
   * @returns Whether this owner can still apply that navigation.
   */
  isCurrentCsvSourceVisitGesture(gesture: number): boolean {
    return !this.disposed && this.csvSourceVisitGesture === gesture
  }

  /**
   * Expose the stored visit only while the current route has owner access.
   * @param read - Read the current tab's saved route.
   * @param write - Save a route or clear it when called without a value.
   * @returns The callback that releases access while preserving the saved route.
   */
  bindCsvSourceVisitStorage(read: () => CsvComparisonSourceTrail | undefined,
    write: (trail?: CsvComparisonSourceTrail) => void): () => void {
    this.writeCsvSourceTrail = write
    if (this.csvComparisonSourceTrail.getSnapshot() === undefined) this.pendingCsvComparisonSourceTrail.set(read())
    return () => {
      if (this.writeCsvSourceTrail !== write) return
      this.writeCsvSourceTrail = undefined
      this.updateCsvSourceTrail(undefined)
    }
  }

  /**
   * Check whether an open source visit can still return to the place that opened it.
   * @param visit - Source and return location to verify.
   * @returns Whether the source precedes the origin or the same draft attachment is still present.
   */
  isCsvComparisonSourceAvailable(visit: CsvComparisonSourceVisit): boolean {
    const { origin, source } = visit
    if (isCsvReturnedSourceOrigin(origin) && visit.sourceKind !== undefined) return false
    if (origin.kind !== 'draft') return source.eventSeq < origin.message.eventSeq && source.messageId !== origin.message.messageId
    const selected = this.selection.getSnapshot()
    if (selected?.kind !== 'csv-question-comparison' || selected.draft.receiptId !== origin.receiptId) return false
    const { facts } = selected.draft
    const target = origin.returnSide === undefined ? csvDraftSource(facts, origin.step) : facts.returns?.[origin.returnSide]
    const sourceKind = csvComparisonSourceKind(facts)
    // Tabs opened before imported return comparisons got a source kind stored this route without one.
    return (sourceKind === visit.sourceKind || (sourceKind === 'imported-return-comparison' && visit.sourceKind === undefined))
      && sameCsvSentQuestion(target, source)
  }

  /**
   * Check the departure even while a deeper source is open.
   * @returns Whether the active route still has a valid departure point.
   */
  isActiveCsvComparisonSourceAvailable(): boolean {
    const departure = (this.csvComparisonSourceTrail.getSnapshot() ?? this.requestedCsvSourceTrail)?.[0]
    return departure === undefined || this.isCsvComparisonSourceAvailable(departure)
  }

  /**
   * Confirm that the current source can still return to this exact stop.
   * @param current - The currently displayed visit.
   * @param target - The visit whose origin is the return destination.
   * @returns Whether both visits still belong to the active route.
   */
  canReturnToCsvComparisonSourceStop(current: CsvComparisonSourceVisit, target: CsvComparisonSourceVisit): boolean {
    const trail = this.csvComparisonSourceTrail.getSnapshot()
    return !this.disposed && trail?.at(-1) === current && trail.includes(target) && this.isActiveCsvComparisonSourceAvailable()
  }

  /**
   * Give a draft return priority over any history retry before awaiting the editor.
   * @param current - The currently displayed visit.
   * @param target - The visit with the captured draft selection.
   * @returns The return gesture, or undefined if the route changed or a return is already in progress.
   */
  beginCsvSourceDraftReturn(current: CsvComparisonSourceVisit, target: CsvComparisonSourceVisit): number | undefined {
    if (this.csvDraftNavigation !== undefined || target.origin.kind !== 'draft'
      || !this.canReturnToCsvComparisonSourceStop(current, target)) return undefined
    return this.beginCsvDraftNavigation()
  }

  /**
   * Give an explicit draft navigation priority over history retry while the editor captures or restores focus.
   * @returns The gesture that may complete the navigation.
   */
  beginCsvDraftNavigation(): number {
    const gesture = this.beginCsvSourceVisitGesture()
    this.csvDraftNavigation = gesture
    const recovery = this.csvComparisonSourceRecovery.getSnapshot()
    if (recovery?.status === 'unavailable' && recovery.pending === true) {
      const { source } = recovery
      this.csvComparisonSourceRecovery.set({ status: 'unavailable', ...(source === undefined ? {} : { source }) })
    }
    return gesture
  }

  /**
   * Release a draft navigation so a still-visible interruption can be retried.
   * @param gesture - The navigation that finished.
   */
  finishCsvDraftNavigation(gesture: number): void {
    if (this.csvDraftNavigation === gesture) this.csvDraftNavigation = undefined
  }

  /**
   * Remove the visits at and after the chosen return destination.
   * @param current - The currently displayed visit.
   * @param target - The visit whose origin will receive focus.
   * @returns Whether the shortened route was saved.
   */
  returnToCsvComparisonSourceStop(current: CsvComparisonSourceVisit, target: CsvComparisonSourceVisit): boolean {
    const trail = this.csvComparisonSourceTrail.getSnapshot()
    if (trail === undefined || !this.canReturnToCsvComparisonSourceStop(current, target)) return false
    const [first, ...rest] = trail
    const index = trail.indexOf(target)
    this.updateCsvSourceTrail(index === 0 ? undefined : [first, ...rest.slice(0, index - 1)])
    return true
  }

  /**
   * Close the route, including any earlier hops, without affecting a newer visit.
   * @param visit - Exact current visit when invoked by a comparison's close action.
   */
  clearCsvComparisonSourceVisit(visit?: CsvComparisonSourceVisit): void {
    const trail = this.csvComparisonSourceTrail.getSnapshot()
    if (visit !== undefined && trail?.at(-1) !== visit) return
    if (trail === undefined && this.requestedCsvSourceTrail === undefined
      && this.pendingCsvComparisonSourceTrail.getSnapshot() === undefined) return
    this.updateCsvSourceTrail(undefined)
  }

  /**
   * Resolve the canonical observable for one source identity.
   * @param key - Stable Node/Artifact source key.
   * @returns Identity-stable renderer source.
   */
  runtime(key: string): ArtifactParticleSource {
    let source = this.sources.get(key)
    if (source === undefined) {
      source = new ArtifactParticleSource(this.sourceFor(key), () => { this.refreshSelection() })
      this.sources.set(key, source)
    }
    return source
  }

  /**
   * Apply one command without creating a second calculation.
   * @param key - Current source.
   * @param command - Semantic command, including timer advancement.
   */
  command(key: string, command: ParticleRunCommand): void { this.sources.get(key)?.command(command) }

  /**
   * Attach reviewed readings from the current particle source to the next ordinary question.
   * @param key - Mounted source.
   * @param artifact - Explicitly selected displayed source identity.
   * @param readings - Fixed conditions and values shown before confirmation.
   * @returns Whether the reviewed source is still available and the choice was attached.
   */
  chooseCurrent(key: string, artifact: ArtifactSnapshot, readings: ParticleQuestionReadings): boolean {
    const current = this.sources.get(key)?.capture()
    if (current === undefined || current.artifactId !== artifact.artifactId || current.revision !== artifact.revision
      || current.generation !== readings.generation || current.run.failed) return false
    this.releaseSelectionLease()
    this.selection.set({ kind: 'current-particle', key, artifactId: artifact.artifactId, revision: artifact.revision,
      title: artifact.title, readings, available: true })
    return true
  }

  /**
   * Attach the reviewed plot conditions while its source revision is current.
   * @param key - Current node/source identity.
   * @param artifact - Source that the user reviewed.
   * @param conditions - Selected function, parameters and analysis point.
   * @param sourceSeq - Exact source upsert when available for browser recovery.
   * @returns Whether the reviewed revision is still available.
   */
  chooseFunctionPlot(key: string, artifact: ArtifactSnapshot, conditions: FunctionPlotQuestionConditions, sourceSeq?: number): boolean {
    if (this.disposed) return false
    const request: FunctionPlotSelection = { kind: 'current-function-plot', artifactId: artifact.artifactId,
      revision: artifact.revision, functionId: conditions.functionId, x: conditions.x, parameters: { ...conditions.parameters } }
    return this.bindFunctionPlot(key, artifact.title, request, sourceSeq === undefined ? undefined : { key, sourceSeq, request })
  }

  /**
   * Keep the saved selection visible and non-sendable while its exact source is read.
   * @param draft - Saved function-plot lock restored after reload.
   * @param title - Title shown until the source revision is read.
   */
  stageFunctionPlotDraft(draft: FunctionPlotDraft, title: string): void {
    if (this.disposed || this.selection.getSnapshot() !== null) return
    this.selection.set({ kind: draft.request.kind, request: draft.request, draft, title, available: false, restoration: 'reading' })
  }

  /**
   * Keep the same locked selection after its source could not be read yet.
   * @param draft - Exact saved lock whose history read finished.
   */
  pauseFunctionPlotRestore(draft: FunctionPlotDraft): void {
    const selected = this.selection.getSnapshot()
    if (selected?.kind !== 'current-function-plot' || selected.draft !== draft || selected.restoration !== 'reading') return
    this.selection.set({ ...selected, restoration: 'retry' })
  }

  /** Request another history read for the unresolved lock in this Session. */
  retryFunctionPlotRestore(): void {
    const selected = this.selection.getSnapshot()
    if (selected?.kind !== 'current-function-plot' || selected.restoration !== 'retry') return
    this.selection.set({ ...selected, restoration: 'reading' })
  }

  /**
   * Recover the existing source lease only for the same pending lock.
   * @param draft - Pending lock whose source read finished.
   * @param artifact - Snapshot read for the locked revision, or `undefined` when history lacks it.
   */
  restoreFunctionPlotDraft(draft: FunctionPlotDraft, artifact: ArtifactSnapshot | undefined): void {
    const selected = this.selection.getSnapshot()
    if (this.disposed || selected?.kind !== 'current-function-plot' || selected.draft !== draft) return
    const { request } = draft
    const title = artifact?.title ?? selected.title
    if (artifact?.format === 'scene' && artifact.spec.kind === 'function-plot'
      && artifact.artifactId === request.artifactId && artifact.revision === request.revision
      && analyzeFunctionPlotSelection(artifact.spec, request) !== undefined
      && this.bindFunctionPlot(draft.key, title, request, draft)) return
    this.selection.set({ kind: request.kind, request, draft, title, available: false })
  }

  /**
   * Consume the locked draft only if the accepted attachment still matches it.
   * @param submitted - Function-plot request carried by the accepted prompt.
   */
  acceptFunctionPlot(submitted: unknown): void {
    const selected = this.selection.getSnapshot()
    if (selected?.kind === 'current-function-plot' && selected.draft !== undefined && deepEqualJson(submitted, selected.request)) this.clear()
  }

  private bindFunctionPlot(key: string, title: string, request: FunctionPlotSelection, draft?: FunctionPlotDraft): boolean {
    const source = this.sourceFor(key)
    const matchesSource = (): boolean => {
      const current = source.getSnapshot()
      return current?.format === 'scene' && current.spec.kind === 'function-plot'
        && current.artifactId === request.artifactId && current.revision === request.revision
    }
    if (!matchesSource()) return false
    this.releaseSelectionLease()
    this.releaseSourceSelection = source.subscribe(() => {
      const selected = this.selection.getSnapshot()
      if (selected?.kind === 'current-function-plot' && selected.request === request && selected.available && !matchesSource()) {
        this.selection.set({ ...selected, available: false })
      }
    })
    this.selection.set({ kind: 'current-function-plot', title, request, available: true, ...(draft === undefined ? {} : { draft }) })
    return true
  }

  /**
   * Attach a chart group by key and retain the inspected reading in the composer.
   * @param key - Current node/source identity.
   * @param artifact - Revision reviewed by the user.
   * @param groupKey - Group key in that revision.
   * @returns Whether the group and reviewed revision remain available.
   */
  chooseCsvGroup(key: string, artifact: ArtifactSnapshot, groupKey: string): boolean {
    if (this.disposed) return false
    const source = this.sourceFor(key)
    const request: CsvGroupSelection = { kind: 'current-csv-bar-chart', artifactId: artifact.artifactId,
      revision: artifact.revision, groupKey }
    const matchesSource = (current: ArtifactSnapshot | undefined): boolean => current?.format === 'scene'
      && current.spec.kind === 'csv-bar-chart' && current.artifactId === request.artifactId && current.revision === request.revision
    const current = source.getSnapshot()
    if (current?.format !== 'scene' || current.spec.kind !== 'csv-bar-chart' || !matchesSource(current)) return false
    const group = current.spec.groups.find(row => row.key === groupKey)
    if (group === undefined) return false
    this.releaseSelectionLease()
    this.releaseSourceSelection = source.subscribe(() => {
      const selected = this.selection.getSnapshot()
      if (selected?.kind === request.kind && selected.request === request && selected.available && !matchesSource(source.getSnapshot())) {
        this.selection.set({ ...selected, available: false })
      }
    })
    this.selection.set({ kind: request.kind, title: artifact.title, request, recipe: current.spec, group, available: true })
    return true
  }

  /**
   * Attach the immutable parent-local snapshot returned by an explicit Host lock.
   * @param artifact - Continued CSV chart snapshot returned by the lock.
   * @param groupKey - Locked group, which must match the snapshot's continuation.
   * @returns Whether the group was found and selected.
   */
  chooseLockedCsvGroup(artifact: SceneArtifactSnapshot, groupKey: string): boolean {
    if (this.disposed || artifact.spec.kind !== 'csv-bar-chart' || artifact.csvContinuation?.groupKey !== groupKey) return false
    const group = artifact.spec.groups.find(row => row.key === groupKey)
    if (group === undefined) return false
    const request: CsvGroupSelection = { kind: 'current-csv-bar-chart', artifactId: artifact.artifactId,
      revision: artifact.revision, groupKey }
    this.releaseSelectionLease()
    this.selection.set({ kind: request.kind, title: artifact.title, request, recipe: artifact.spec, group, available: true })
    return true
  }

  /**
   * Persist the reviewed comparison before making it the next question's attachment.
   * @param attachment - Reviewed comparison with its Host proof.
   * @returns Whether the Host draft now holds it; `false` without draft support.
   */
  async chooseCsvComparison(attachment: ArtifactCsvComparisonAttachment): Promise<boolean> {
    return await this.csvDraft?.save(attachment) ?? false
  }

  /**
   * Select the immutable experiment carried by a returned branch result.
   * @param request - Receiving Session and durable returned message identity.
   * @param replay - Exact recorded source and readings for review in the composer.
   */
  chooseBranchEvidence(request: BranchEvidenceSelection, replay: ArtifactQuestionReplay): void {
    if (this.disposed) return
    this.releaseSelectionLease()
    this.selection.set({ kind: 'branch-evidence', title: replay.artifact.title, request: { ...request }, replay })
  }

  /**
   * Retain the reviewed program report and its durable returned-evidence reference.
   * @param request - Parent-local notice identity and reviewed BFS checkpoint.
   * @param artifact - Recorded HTML source metadata for the composer.
   * @returns Whether the active Session accepted the local selection.
   */
  chooseBranchHtml(request: BranchHtmlSelection, artifact: Pick<ArtifactSnapshot, 'title' | 'revision'>): boolean {
    if (this.disposed) return false
    const detached = snapshotJsonValue(request)
    if (detached === undefined) return false
    this.releaseSelectionLease()
    this.selection.set({ kind: request.kind, title: artifact.title, revision: artifact.revision, request: deepFreeze(detached) })
    return true
  }

  /**
   * Select an immutable saved observation without copying its source.
   * @param observation - Explicitly selected immutable saved source.
   */
  chooseObservation(observation: SavedParticleObservation): void {
    this.releaseSelectionLease()
    this.selection.set({ kind: 'observation', observation: observationChoice(observation) })
  }

  /**
   * Select the exact saved pair displayed for comparison.
   * @param group - Comparison group.
   * @param control - Saved control.
   * @param variant - Saved variant.
   */
  chooseComparison(group: string, control: SavedParticleObservation, variant: SavedParticleObservation): void {
    this.releaseSelectionLease()
    this.selection.set({ kind: 'comparison', group, control: observationChoice(control), variant: observationChoice(variant) })
  }

  /**
   * Bind the explicitly selected physical HTML preview, without freezing its current state yet.
   * @param key - Existing node/source identity.
   * @param artifact - Displayed source when the user chose the preview.
   * @param identity - Physical runtime shown at the selection gesture.
   */
  chooseHtmlRuntime(key: string, artifact: ArtifactSnapshot, identity: ArtifactRuntimeIdentity): void {
    if (this.disposed) return
    if (this.html === undefined) throw new Error('HTML runtime question capture is not configured')
    this.releaseSelectionLease()
    const source = this.sourceFor(key)
    const runtime = this.html.runtimeFor(key)
    const releaseSource = source.subscribe(this.refreshHtmlSelection)
    const releaseRuntime = runtime.subscribe(this.refreshHtmlSelection)
    this.htmlSelectionLease = { source, runtime, release: () => { releaseSource(); releaseRuntime() } }
    this.selection.set({ kind: 'html-runtime', key, identity, title: artifact.title, availability: 'waiting' })
    this.refreshHtmlSelection()
  }

  /**
   * Attach the program-reported checkpoint shown in review. Later runtime reports cannot replace it.
   * @param key - Existing Artifact node/source identity.
   * @param artifact - Displayed source when review opened.
   * @param identity - Physical runtime that supplied the reviewed checkpoint.
   * @param reviewed - The checkpoint shown in review.
   * @returns Whether the original source and preview still match at confirmation.
   */
  chooseHtmlCheckpoint(
    key: string, artifact: ArtifactSnapshot, identity: ArtifactRuntimeIdentity, reviewed: ArtifactHtmlCheckpoint,
  ): boolean {
    if (this.disposed || this.html === undefined) return false
    const source = this.sourceFor(key)
    const runtime = this.html.runtimeFor(key).getSnapshot()
    const matchesSource = (): boolean => {
      const current = source.getSnapshot()
      return current?.format === 'html' && current.artifactId === identity.artifactId && current.revision === identity.revision
    }
    if (!matchesSource() || runtime?.identity.runtimeId !== identity.runtimeId
      || runtimeHtmlCheckpoint(runtime)?.kind !== reviewed.kind) return false
    const detached = snapshotJsonValue({ kind: 'html-runtime' as const, capturedSessionId: this.html.sessionId,
      artifactId: identity.artifactId, revision: identity.revision, runtimeId: identity.runtimeId,
      capture: reviewed.kind === 'bfs-checkpoint'
        ? { status: 'ready' as const, restore: 'bfs-checkpoint' as const, state: reviewed }
        : { status: 'ready' as const, restore: 'half-adder-checkpoint' as const, state: reviewed } })
    if (detached === undefined) return false
    const request = deepFreeze(detached)
    this.releaseSelectionLease()
    this.releaseSourceSelection = source.subscribe(() => {
      const selected = this.selection.getSnapshot()
      if ((selected?.kind === 'html-bfs' || selected?.kind === 'html-half-adder')
        && selected.request === request && selected.available && !matchesSource()) {
        this.selection.set({ ...selected, available: false })
      }
    })
    const kind = reviewed.kind === 'bfs-checkpoint' ? 'html-bfs' : 'html-half-adder'
    this.selection.set({ kind, title: artifact.title, request, checkpoint: request.capture.state, available: true })
    return true
  }

  /** Remove the composer choice without altering any experiment. */
  clear(): void {
    const selection = this.selection.getSnapshot()
    if (selection?.kind === 'csv-question-comparison' && this.csvDraft !== undefined) {
      void this.csvDraft.remove(selection.draft.receiptId)
      return
    }
    this.releaseSelectionLease()
    this.selection.set(null)
  }

  /**
   * Read reviewed conditions and saved identities, or freeze received program data at ordinary submission time.
   * @param unavailable - Localized failure for a source that changed or left the view.
   * @returns Explicit references, current fixed-step conditions, or an independently frozen program capture.
   */
  capture(unavailable: string): Exclude<ArtifactPromptContextSelection, { kind: 'csv-question-comparison' }> | undefined {
    if (this.csvDraft?.blocksSubmission === true) throw new Error(unavailable)
    const selection = this.selection.getSnapshot()
    if (selection === null) return undefined
    if (selection.kind === 'csv-question-comparison') return { kind: 'csv-comparison-draft', receiptId: selection.draft.receiptId }
    if (selection.kind === 'observation') return { kind: 'observation' as const,
      ref: selection.observation.ref }
    if (selection.kind === 'html-runtime') return this.captureHtml(unavailable)
    if (selection.kind === 'comparison') return { kind: 'comparison' as const, group: selection.group,
      control: selection.control.ref, variant: selection.variant.ref }
    if (selection.kind === 'branch-evidence' || selection.kind === 'branch-bfs-checkpoint'
      || selection.kind === 'branch-half-adder-checkpoint') return selection.request
    if (selection.kind === 'current-function-plot' || selection.kind === 'current-csv-bar-chart'
      || selection.kind === 'html-bfs' || selection.kind === 'html-half-adder') {
      if (!selection.available) throw new Error(unavailable)
      return selection.request
    }
    const current = this.sources.get(selection.key)?.capture()
    if (current === undefined || current.revision !== selection.revision || current.generation !== selection.readings.generation
      || current.run.failed) throw new Error(unavailable)
    return { kind: 'current-particle' as const, artifactId: selection.artifactId, revision: selection.revision,
      checkpoint: selection.readings.checkpoint,
      ...(selection.readings.gravityY === undefined ? {} : { gravityY: selection.readings.gravityY }) }
  }

  /** Release all unsaved runs and selected context with the Session binding. */
  dispose(): void {
    this.disposed = true
    this.csvDraft?.dispose()
    this.csvExplanation.clear()
    this.writeCsvSourceTrail = undefined
    this.updateCsvSourceTrail(undefined)
    for (const source of this.sources.values()) source.dispose()
    this.sources.clear()
    this.releaseSelectionLease()
    this.selection.set(null)
  }

  private captureHtml(unavailable: string): HtmlSelection {
    this.refreshHtmlSelection()
    const selected = this.selection.getSnapshot()
    if (selected?.kind !== 'html-runtime' || selected.availability === 'stale' || this.html === undefined
      || this.htmlSelectionLease === undefined) throw new Error(unavailable)
    const runtime = this.htmlSelectionLease.runtime.getSnapshot()
    if (runtime === undefined) throw new Error(unavailable)
    const availability = runtimeQuestionAvailability(runtime)
    if (availability !== 'state' && availability !== 'error') throw new Error(unavailable)
    let capture: ArtifactProgramQuestionCapture
    if (runtime.report.status === 'error') capture = { status: 'error', error: runtime.report.error }
    else if (runtime.report.status === 'ready' && runtime.state !== undefined) capture = { status: 'ready', state: runtime.state }
    else throw new Error(unavailable)
    const detached = snapshotJsonValue({ kind: 'html-runtime' as const, capturedSessionId: this.html.sessionId,
      artifactId: selected.identity.artifactId, revision: selected.identity.revision, runtimeId: selected.identity.runtimeId, capture })
    if (detached === undefined) throw new Error(unavailable)
    return deepFreeze(detached)
  }

  private readonly refreshHtmlSelection = (): void => {
    const selected = this.selection.getSnapshot()
    if (this.disposed || selected?.kind !== 'html-runtime' || selected.availability === 'stale'
      || this.htmlSelectionLease === undefined) return
    const source = this.htmlSelectionLease.source.getSnapshot()
    const runtime = this.htmlSelectionLease.runtime.getSnapshot()
    const identity = selected.identity
    const invalid = identity.renderer !== 'html' || source?.format !== 'html'
      || source.artifactId !== identity.artifactId || source.revision !== identity.revision
      || runtime === undefined || runtime.identity.runtimeId !== identity.runtimeId || runtime.identity.artifactId !== identity.artifactId
      || runtime.identity.revision !== identity.revision || runtime.identity.renderer !== 'html'
      || runtime.host === 'unavailable' || runtime.host === 'denied'
    const availability = invalid ? 'stale' : runtimeQuestionAvailability(runtime)
    if (availability !== selected.availability) this.selection.set({ ...selected, availability })
  }

  private releaseSelectionLease(): void {
    const lease = this.htmlSelectionLease
    this.htmlSelectionLease = undefined
    const releaseSource = this.releaseSourceSelection
    this.releaseSourceSelection = undefined
    lease?.release()
    releaseSource?.()
  }

  private refreshSelection(): void {
    const selected = this.selection.getSnapshot()
    if (selected?.kind !== 'current-particle') return
    const current = this.sources.get(selected.key)?.getSnapshot()
    const available = current !== undefined && current.revision === selected.revision
      && current.generation === selected.readings.generation && !current.run.failed
    if (available !== selected.available) this.selection.set({ ...selected, available })
  }
}
