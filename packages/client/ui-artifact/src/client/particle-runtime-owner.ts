/** Particle calculation and explicit question choices over canonical particle and program-report sources. */
import { createSnapshotStore, type ObservableSnapshot } from '@agentrans/client-store'
import type { ArtifactId, ArtifactSnapshot, SavedParticleObservation, SavedParticleObservationRef } from '@agentrans/artifact/types'
import type { ParticleSystemSpec } from '@agentrans/artifact/scene'
import { deepFreeze, snapshotJsonValue } from '@agentrans/util-values'
import type { ArtifactRuntimeIdentity } from '@agentrans/artifact-runtime/types'
import type { SessionId } from '@agentrans/session/types'
import type { ArtifactRuntimeSnapshot } from './runtime-owner.ts'
import { runtimeQuestionAvailability, type RuntimeQuestionAvailability } from './runtime-question.ts'
import type { ArtifactProgramQuestionCapture, ArtifactPromptContextSelection } from '@agentrans/artifact-followup/types'
import { createParticleCheckpoint } from '@agentrans/artifact/particle-runtime'
import { createParticleRun, updateParticleRun, type ParticleRun, type ParticleRunCommand } from './particle-run.ts'

/** Current source and its sole live calculation. */
export interface ArtifactParticleRuntime {
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly run: ParticleRun
  readonly generation: number
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

/** Explicit user choice carried by the composer; runtime data remains with its source owner. */
export type ArtifactPromptBinding =
  | {
    readonly kind: 'current-particle'
    readonly key: string
    readonly artifactId: ArtifactId
    readonly revision: number
    readonly title: string
    readonly generation: number
    readonly available: boolean
  }
  | {
    readonly kind: 'html-runtime'
    readonly key: string
    readonly identity: ArtifactRuntimeIdentity
    readonly title: string
    readonly availability: RuntimeQuestionAvailability | 'stale'
  }
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
      this.changed()
    }
  }

  /**
   * Apply user intent or clock advancement to the sole live calculation.
   * @param command - Semantic user or clock command.
   */
  command(command: ParticleRunCommand): void {
    if (this.value === undefined || this.spec === undefined || this.releaseSource === undefined) return
    const run = updateParticleRun(this.spec, this.value.run, command)
    if (run === this.value.run) return
    this.value = { ...this.value, run }
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
    this.publish()
    this.listeners.clear()
  }

  private readonly refresh = (): void => {
    const artifact = this.source.getSnapshot()
    if (artifact?.format !== 'scene' || artifact.spec.kind !== 'particle-system') {
      if (this.value === undefined) return
      this.value = undefined
      this.spec = undefined
      this.publish()
      return
    }
    if (this.value?.artifactId === artifact.artifactId && this.value.revision === artifact.revision) return
    this.spec = artifact.spec
    this.value = { artifactId: artifact.artifactId, revision: artifact.revision, generation: ++this.generation,
      run: createParticleRun(artifact.spec) }
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
  private readonly sources = new Map<string, ArtifactParticleSource>()
  private htmlSelectionLease: HtmlQuestionLease | undefined
  private disposed = false

  /**
   * @param sourceFor - Resolve the existing Chat Node source without another log fold.
   * @param html - Explicit program-report readers and Session identity, omitted by particle-only consumers.
   */
  constructor(private readonly sourceFor: (key: string) => ObservableSnapshot<ArtifactSnapshot | undefined>,
    private readonly html?: {
      readonly sessionId: SessionId
      readonly runtimeFor: (key: string) => ObservableSnapshot<ArtifactRuntimeSnapshot | undefined>
    }) {}

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
   * Select one displayed live runtime for the next ordinary question.
   * @param key - Mounted source.
   * @param artifact - Explicitly selected displayed source identity.
   */
  chooseCurrent(key: string, artifact: ArtifactSnapshot): void {
    this.releaseHtmlSelection()
    const current = this.sources.get(key)?.capture()
    this.selection.set({ kind: 'current-particle', key, artifactId: artifact.artifactId, revision: artifact.revision,
      title: artifact.title, generation: current?.generation ?? -1,
      available: current?.revision === artifact.revision && !current.run.failed })
  }

  /**
   * Select an immutable saved observation without copying its source.
   * @param observation - Explicitly selected immutable saved source.
   */
  chooseObservation(observation: SavedParticleObservation): void {
    this.releaseHtmlSelection()
    this.selection.set({ kind: 'observation', observation: observationChoice(observation) })
  }

  /**
   * Select the exact saved pair displayed for comparison.
   * @param group - Comparison group.
   * @param control - Saved control.
   * @param variant - Saved variant.
   */
  chooseComparison(group: string, control: SavedParticleObservation, variant: SavedParticleObservation): void {
    this.releaseHtmlSelection()
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
    this.releaseHtmlSelection()
    const source = this.sourceFor(key)
    const runtime = this.html.runtimeFor(key)
    const releaseSource = source.subscribe(this.refreshHtmlSelection)
    const releaseRuntime = runtime.subscribe(this.refreshHtmlSelection)
    this.htmlSelectionLease = { source, runtime, release: () => { releaseSource(); releaseRuntime() } }
    this.selection.set({ kind: 'html-runtime', key, identity, title: artifact.title, availability: 'waiting' })
    this.refreshHtmlSelection()
  }

  /** Remove the composer choice without altering any experiment. */
  clear(): void {
    this.releaseHtmlSelection()
    this.selection.set(null)
  }

  /**
   * Freeze selected conditions, saved identities, or received program data at ordinary submission time.
   * @param unavailable - Localized failure for a source that changed or left the view.
   * @returns Explicit references, current fixed-step conditions, or an independently frozen program capture.
   */
  capture(unavailable: string): ArtifactPromptContextSelection | undefined {
    const selection = this.selection.getSnapshot()
    if (selection === null) return undefined
    if (selection.kind === 'observation') return { kind: 'observation' as const,
      ref: selection.observation.ref }
    if (selection.kind === 'html-runtime') return this.captureHtml(unavailable)
    if (selection.kind === 'comparison') return { kind: 'comparison' as const, group: selection.group,
      control: selection.control.ref, variant: selection.variant.ref }
    const current = this.sources.get(selection.key)?.capture()
    if (current === undefined || current.revision !== selection.revision || current.generation !== selection.generation
      || current.run.failed) throw new Error(unavailable)
    return { kind: 'current-particle' as const, artifactId: selection.artifactId, revision: selection.revision,
      checkpoint: createParticleCheckpoint(current.run.state) }
  }

  /** Release all unsaved runs and selected context with the Session binding. */
  dispose(): void {
    this.disposed = true
    for (const source of this.sources.values()) source.dispose()
    this.sources.clear()
    this.clear()
  }

  private captureHtml(unavailable: string): ArtifactPromptContextSelection {
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

  private releaseHtmlSelection(): void {
    const lease = this.htmlSelectionLease
    this.htmlSelectionLease = undefined
    lease?.release()
  }

  private refreshSelection(): void {
    const selected = this.selection.getSnapshot()
    if (selected?.kind !== 'current-particle') return
    const current = this.sources.get(selected.key)?.getSnapshot()
    const available = current !== undefined && current.revision === selected.revision
      && current.generation === selected.generation && !current.run.failed
    if (available !== selected.available) this.selection.set({ ...selected, available })
  }
}
