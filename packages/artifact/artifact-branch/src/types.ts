/** User-confirmed Artifact evidence selected for one ordinary branch conclusion. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SavedParticleObservationRef, ParticleObservationComparisonErrorCode } from '@deepseek-ai/dsh-artifact/types'

/** Exact saved observation or ordered comparison pair resolved only in the child Session. */
export type ArtifactBranchEvidenceSelection =
  | { readonly kind: 'observation'; readonly observation: SavedParticleObservationRef }
  | {
    readonly kind: 'comparison'
    readonly group: string
    readonly control: SavedParticleObservationRef
    readonly variant: SavedParticleObservationRef
  }

/** Return one child-owned assistant conclusion with explicitly selected saved evidence. */
export interface ArtifactBranchResultRequest {
  readonly sessionId: SessionId
  readonly branchSessionId: SessionId
  readonly resultSeq: number
  readonly evidence: ArtifactBranchEvidenceSelection
}

/** A source selection that cannot supply the requested branch-local evidence. */
export type ArtifactBranchEvidenceFailure = 'OBSERVATION_NOT_FOUND' | 'PROJECTION_UNAVAILABLE' | ParticleObservationComparisonErrorCode

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The child cut cannot resolve compatible saved evidence; no parent message was appended. */
    'artifact-branch/evidence-unavailable': { readonly reason: ArtifactBranchEvidenceFailure }
    /** The complete conclusion and evidence message exceeds the configured byte budget. */
    'artifact-branch/result-too-large': { readonly limit: number }
  }
}
