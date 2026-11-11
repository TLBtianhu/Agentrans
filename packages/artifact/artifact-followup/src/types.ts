/** Explicit Artifact selections attached to one ordinary question. @module @agentrans/artifact-followup/types */
import type {
  ArtifactId, ParticleObservationComparison, ParticleObservationComparisonErrorCode,
  SavedParticleObservation, SavedParticleObservationRef, SceneArtifactSnapshot, HtmlArtifactSnapshot,
} from '@agentrans/artifact/types'
import type { ParticleCheckpoint, ParticleObservation } from '@agentrans/artifact/particle-runtime'
import type { ArtifactRuntimeFailure, ArtifactRuntimeId } from '@agentrans/artifact-runtime/types'
import type { SessionId } from '@agentrans/session/types'
import type { JsonValue } from '@agentrans/util-values'

/** User-selected program report; state is data reported by the program, not a Host-recomputed observation. */
export type ArtifactProgramQuestionCapture =
  | { readonly status: 'ready'; readonly state: JsonValue }
  | { readonly status: 'error'; readonly error: Pick<ArtifactRuntimeFailure, keyof ArtifactRuntimeFailure> }

/** Captured selections; source comes from the Host, while HTML runtime state retains its program attribution. */
export type ArtifactPromptContextSelection =
  | {
    readonly kind: 'current-particle'
    readonly artifactId: ArtifactId
    readonly revision: number
    readonly checkpoint: Pick<ParticleCheckpoint, keyof ParticleCheckpoint>
  }
  | { readonly kind: 'observation'; readonly ref: Pick<SavedParticleObservationRef, keyof SavedParticleObservationRef> }
  | {
    readonly kind: 'comparison'
    readonly group: string
    readonly control: Pick<SavedParticleObservationRef, keyof SavedParticleObservationRef>
    readonly variant: Pick<SavedParticleObservationRef, keyof SavedParticleObservationRef>
  }
  | {
    readonly kind: 'html-runtime'
    readonly capturedSessionId: SessionId
    readonly artifactId: ArtifactId
    readonly revision: number
    readonly runtimeId: ArtifactRuntimeId
    readonly capture: ArtifactProgramQuestionCapture
  }

/** Complete resolved source and selected experiment facts, with program reports explicitly attributed. */
export type ArtifactPromptContextFacts =
  | { readonly kind: 'current-particle'; readonly artifact: SceneArtifactSnapshot; readonly checkpoint: ParticleCheckpoint; readonly values: ParticleObservation }
  | { readonly kind: 'observation'; readonly observation: SavedParticleObservation }
  | {
    readonly kind: 'comparison'
    readonly group: string
    readonly conditions: ParticleObservationComparison['conditions']
    readonly control: SavedParticleObservation
    readonly variant: SavedParticleObservation
  }
  | {
    readonly kind: 'html-runtime'
    readonly artifact: HtmlArtifactSnapshot
    readonly runtimeId: ArtifactRuntimeId
    readonly attribution: 'program-reported'
    readonly capture: ArtifactProgramQuestionCapture
  }

/** Self-contained question context stored as a text block on the same ordinary user message. */
export interface ArtifactQuestionContext {
  readonly kind: 'artifact-question-context'
  readonly sessionId: SessionId
  readonly facts: ArtifactPromptContextFacts
}

/** Refusals that admit no question with substituted or unvalidated Artifact facts. */
export type ArtifactPromptContextRejectionReason =
  | 'INVALID_SELECTION' | 'SOURCE_NOT_FOUND' | 'STALE_REVISION' | 'UNSUPPORTED_SOURCE' | 'INVALID_CHECKPOINT'
  | 'CONTEXT_TOO_LARGE' | 'SESSION_MISMATCH' | ParticleObservationComparisonErrorCode

declare module '@agentrans/typert-protocol' {
  interface RemoteErrorDetailsMap {
    'artifact-followup/context-rejected': {
      readonly reason: ArtifactPromptContextRejectionReason
      readonly limit?: number
    }
  }
}
