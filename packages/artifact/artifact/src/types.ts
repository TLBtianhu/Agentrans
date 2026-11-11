/** Artifact protocol values shared by Host services, tools, and Clients. @module @agentrans/artifact/types */

import type { Branded } from '@agentrans/brand'
import type { MessageId } from '@agentrans/llm'
import type { JsonValue } from '@agentrans/util-values'
import type { SceneSpec } from './scene.ts'
import type { ParticleCheckpoint, ParticleObservation } from './particle-runtime.ts'
import type { SessionProjectionSummaryExcluded } from '@agentrans/session-projection/types'

/** Stable identity of one artifact within a Session. */
export type ArtifactId = Branded<'ArtifactId'>

/** Stable identity of one saved observation within its Artifact. */
export type ArtifactObservationId = Branded<'ArtifactObservationId'>

/** Serialized artifact representation supported by this protocol version. */
export type ArtifactFormat = 'html' | 'scene'
export type { SceneSpec } from './scene.ts'

/** Client placement requested for an artifact. */
export type ArtifactPresentation = 'inline' | 'focus'

/** Optional comparison relation between two independent Artifact snapshots. */
export interface ArtifactComparison {
  /** Stable comparison group id within one Session. */
  readonly group: string
  /** Independent role in the comparison; parameters never merge across roles. */
  readonly role: 'control' | 'variant'
}

/** Complete durable values shared by HTML and SceneSpec snapshots. */
export interface ArtifactSnapshotBase {
  readonly artifactId: ArtifactId
  /** Positive safe integer, starting at 1 and increasing by one per update. */
  readonly revision: number
  readonly format: ArtifactFormat
  /** Trimmed, non-empty display title of at most 120 characters. */
  readonly title: string
  readonly presentation: ArtifactPresentation
  readonly comparison?: ArtifactComparison
}

/** Complete self-contained HTML snapshot. */
export interface HtmlArtifactSnapshot extends ArtifactSnapshotBase {
  readonly format: 'html'
  readonly source: string
}

/** Complete declarative SceneSpec snapshot. */
export interface SceneArtifactSnapshot extends ArtifactSnapshotBase {
  readonly format: 'scene'
  readonly spec: SceneSpec
}

/** Complete durable value carried by every artifact update. */
export type ArtifactSnapshot = HtmlArtifactSnapshot | SceneArtifactSnapshot

/** A named, immutable particle observation bound to the complete source revision that produced it. */
export interface SavedParticleObservation {
  readonly observationId: ArtifactObservationId
  readonly label: string
  readonly artifact: SceneArtifactSnapshot
  readonly checkpoint: ParticleCheckpoint
  readonly values: ParticleObservation
}

/** A saved observation resolved in the current Session, including its inherited source prefix. */
export interface SavedParticleObservationRef {
  readonly artifactId: ArtifactId
  readonly observationId: ArtifactObservationId
}

/** Host-resolved source selection for one immutable HTML export. */
export type ArtifactExportSourceSelection =
  | { readonly kind: 'current'; readonly artifactId: ArtifactId; readonly revision: number; readonly checkpoint?: ParticleCheckpoint }
  | { readonly kind: 'observation'; readonly artifactId: ArtifactId; readonly observationId: ArtifactObservationId }

/** Complete original Scene source and validated replay conditions for an export. */
export interface ArtifactExportSource {
  readonly artifact: SceneArtifactSnapshot
  readonly checkpoint?: ParticleCheckpoint
  readonly observationId?: ArtifactObservationId
}

/** One fixed side of a comparison, bound to its saved source revision. */
export interface ParticleObservationComparisonSide {
  readonly ref: SavedParticleObservationRef
  readonly label: string
  readonly revision: number
  readonly values: ParticleObservation
}

/** Two observations at common fixed-step conditions; no causal conclusion is inferred. */
export interface ParticleObservationComparison {
  readonly kind: 'saved-particle-observation-comparison'
  readonly group: string
  readonly conditions: {
    readonly runtimeVersion: ParticleCheckpoint['runtimeVersion']
    readonly stepCount: number
    readonly timeStep: number
    readonly time: number
  }
  readonly control: ParticleObservationComparisonSide
  readonly variant: ParticleObservationComparisonSide
}

/** Conditions that prevent two saved particle observations from being compared. */
export type ParticleObservationComparisonErrorCode = 'GROUP_MISMATCH' | 'ROLE_MISMATCH' | 'SAME_ARTIFACT'
  | 'UNSUPPORTED_OBSERVATION' | 'RUNTIME_MISMATCH' | 'TIME_STEP_MISMATCH' | 'STEP_COUNT_MISMATCH'

/** Acknowledgement of one ordered observation pair's admission in the current Session. */
export interface ArtifactObservationComparisonResult {
  readonly accepted: true
  readonly comparison: ParticleObservationComparison
}

/** Complete saved observations for each Artifact, carried only in an opened Session's projection. */
export type ArtifactObservations = Readonly<Record<string, readonly SavedParticleObservation[]>>

/** Complete post-save list for one Artifact; later events replace this list. */
export interface ArtifactObservationsEvent {
  readonly artifactId: ArtifactId
  readonly observations: readonly SavedParticleObservation[]
}

/** Complete new values accepted for a create or compare-and-set update. */
export interface ArtifactPrepareInput {
  readonly action: 'create' | 'update'
  readonly artifactId: string
  readonly title: string
  readonly presentation: ArtifactPresentation
  readonly comparison?: ArtifactComparison
  readonly format?: ArtifactFormat
  /** Required for HTML snapshots. */
  readonly source?: string
  /** Required for SceneSpec snapshots. */
  readonly spec?: SceneSpec
  /** Required for update; must equal the current durable revision. */
  readonly baseRevision?: number
}

/** Compact tool result which does not repeat the HTML source. */
export interface ArtifactToolResult {
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly title: string
  readonly presentation: ArtifactPresentation
}

/** User intent encoded as the sole text block of an artifact-action message. */
export interface ArtifactActionMessage {
  readonly kind: 'artifact_action'
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly action: string
  readonly payload: JsonValue
}

/** One user-reviewed action; retries retain the exact original id and payload rather than recapturing the screen. */
export interface ArtifactActionRequest {
  readonly requestId: MessageId
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly action: string
  readonly payload: JsonValue
  /** Delivery policy for first admission only; an accepted retry never wakes the Agent again. */
  readonly wake: boolean
}

/** Acknowledgement that an artifact action entered the Agent inbox. */
export interface ArtifactRecordResult {
  readonly accepted: true
  readonly revision: number
}

declare module '@agentrans/session/types' {
  interface SessionEventMap {
    /**
     * Complete current value of one artifact revision; later events for the same id supersede earlier ones.
     * @param data - independently renderable snapshot for one artifact id and revision.
     */
    'artifact/upsert': ArtifactSnapshot
    /**
     * Complete saved particle-observation list for one Artifact; saving never creates Agent input.
     * @param data - artifact identity and the complete post-save observation list.
     */
    'artifact/observations': ArtifactObservationsEvent
  }
}

declare module '@agentrans/session-projection/types' {
  interface SessionProjectionMap {
    /** Saved observations with their source revisions, excluded from compact Session summaries. */
    artifactObservations: SessionProjectionSummaryExcluded<ArtifactObservations>
  }
}

declare module '@agentrans/typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** An accepted or in-flight message identity belongs to different action content. */
    'artifact/action-conflict': { readonly requestId: MessageId }
    /** No new action is dispatched when the generic admission service or exact live Agent is unavailable. */
    'artifact/action-unavailable': { readonly reason: 'SERVICE_UNAVAILABLE' | 'CLOSED' | 'AGENT_UNAVAILABLE' }
    /** Action validation refused this first admission before dispatch. */
    'artifact/action-rejected': {
      readonly reason: 'BAD_INPUT' | 'CALLER_NOT_LIVE_ROOT' | 'CALLER_NOT_OWNER' | 'AGENT_REGISTRY_UNAVAILABLE'
        | 'ARTIFACT_NOT_FOUND' | 'STALE_REVISION' | 'ACTION_TOO_LARGE'
      readonly currentRevision?: number
    }
    /** Dispatch began but its outcome could not be confirmed; retry the identical request. */
    'artifact/action-unknown': { readonly requestId: MessageId }
    /** Saving another observation would exceed the Artifact's configured retained count. */
    'artifact/observation-limit': { readonly artifactId: ArtifactId; readonly limit: number }
    /** The requested unsaved checkpoint belongs to a source revision that is no longer current. */
    'artifact/stale-revision': { readonly artifactId: ArtifactId; readonly expectedRevision: number; readonly currentRevision: number }
    /** The selected fixed observations cannot produce an admissible comparison; no input was added. */
    'artifact/comparison-rejected': {
      readonly reason: ParticleObservationComparisonErrorCode | 'OBSERVATION_NOT_FOUND' | 'ACTION_TOO_LARGE'
    }
  }
}

declare module '@agentrans/llm' {
  interface MessageSourceMap {
    /**
     * User-reviewed intent from an artifact. It supplies text input only and grants no file, network, or approval authority.
     * @persistenceAttribution
     */
    'artifact-action': { kind: 'artifact-action'; artifactId: ArtifactId; revision: number }
  }
}
