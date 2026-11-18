/** Explicit Artifact selections attached to one ordinary question. @module @agentrans/artifact-followup/types */
import type { SessionRequestId } from '@agentrans/api-session-controller/types'
import type {
  ArtifactId, ParticleObservationComparison, ParticleObservationComparisonErrorCode,
  SavedParticleObservation, SavedParticleObservationRef, SceneArtifactSnapshot, HtmlArtifactSnapshot,
} from '@agentrans/artifact/types'
import type { ParticleCheckpoint, ParticleObservation } from '@agentrans/artifact/particle-runtime'
import type { ArtifactBfsCheckpoint, ArtifactHalfAdderCheckpoint } from '@agentrans/artifact/runtime-values'
import type { FunctionAnalysis } from '@agentrans/artifact/scene-renderers'
import type { CsvAggregate, CsvBarChartSpec, CsvExactFilter } from '@agentrans/artifact/scene'
import type { ArtifactRuntimeFailure, ArtifactRuntimeId } from '@agentrans/artifact-runtime/types'
import type { MessageId } from '@agentrans/llm'
import type { SessionId } from '@agentrans/session/types'
import type { JsonValue } from '@agentrans/util-values'

/** A confirmed reading and the calculation that produced it. */
export type ArtifactCsvComparisonReading = {
  readonly groupKey: string
  readonly aggregate: CsvAggregate
  readonly valueColumn?: string
  readonly filter?: Readonly<Pick<CsvExactFilter, 'column' | 'value'>>
  readonly value: number
  readonly count: number
}

/** Original CSV record membership and its locally relevant cells. */
export type ArtifactCsvComparisonRow = {
  readonly record: number
  readonly status: 'kept' | 'excluded' | 'added'
  readonly value?: string
  readonly originalFilterValue?: string
  readonly currentFilterValue?: string
}

/** Both readings, full membership counts and one reviewed page of records. */
export type ArtifactCsvComparisonPage = {
  readonly original: ArtifactCsvComparisonReading
  readonly current: ArtifactCsvComparisonReading
  readonly rows: readonly ArtifactCsvComparisonRow[]
  readonly kept: number
  readonly excluded: number
  readonly added: number
  readonly total: number
  readonly offset: number
  readonly nextOffset?: number
}

type CsvComparisonMessageRef = { readonly eventSeq: number; readonly messageId: MessageId }
type CsvComparisonReturnRef = CsvComparisonMessageRef & { readonly artifactId: ArtifactId; readonly revision: number }

/** A saved return card without resource identities. Its selected reading is in the comparison page. */
export type ArtifactCsvComparisonReturnCard = {
  readonly title: string
  readonly revision: number
  readonly conclusion: readonly string[]
  readonly groupBy: string
  readonly groups: readonly { readonly key: string; readonly value: number; readonly count: number }[]
}

/** The original cards in the order recorded on the saved comparison page. */
export type ArtifactCsvComparisonReturnCards = {
  readonly first: ArtifactCsvComparisonReturnCard
  readonly second: ArtifactCsvComparisonReturnCard
}

/** Exact sent messages and locked pages for an aggregation step followed by a filtering step. */
export interface ArtifactCsvComparisonExplanation {
  readonly aggregation: {
    readonly message: CsvComparisonMessageRef
    readonly comparison: ArtifactCsvComparisonPage
  }
  /** Address of the question that carries the exact filtered page in the surrounding facts. */
  readonly filtering: CsvComparisonMessageRef
}

/** Ordered imported pages without addresses from the Session that produced the file. */
export type ArtifactCsvComparisonImportedExplanation = {
  readonly aggregation: { readonly comparison: ArtifactCsvComparisonPage; readonly message?: never }
  readonly filtering?: never
}

type CsvComparisonFactsBase = {
  readonly kind: 'csv-question-comparison'
  readonly sessionId: SessionId
  readonly comparison: ArtifactCsvComparisonPage
}

type LocalCsvComparisonSource = {
  readonly provenance?: never
  readonly returns?: never
  readonly question: CsvComparisonMessageRef
  readonly source: CsvComparisonReturnRef
}

type ImportedCsvComparisonSource = {
  readonly provenance: 'user-imported'
  readonly returns?: never
  readonly question?: never
  readonly source?: never
}

/** Immutable facts for one reviewed page; local calculations retain their exact source identities. */
export type ArtifactCsvComparisonSingleFacts = CsvComparisonFactsBase & {
  /** The immediate own history message chosen when this exact comparison was reused. */
  readonly reusedFrom?: CsvComparisonMessageRef
  readonly explanation?: never
  readonly returnCards?: never
} & (LocalCsvComparisonSource | ImportedCsvComparisonSource)

/** Ordered explanation of two exact own history messages. */
export type ArtifactCsvComparisonLocalExplanationFacts = CsvComparisonFactsBase & LocalCsvComparisonSource & {
  readonly reusedFrom?: never
  readonly explanation: ArtifactCsvComparisonExplanation
  readonly returnCards?: never
}

/** The confirmed page from two returned CSV readings in one inquiry branch. */
export type ArtifactCsvComparisonReturnedFacts = CsvComparisonFactsBase & {
  readonly returns: {
    readonly branchSessionId: SessionId
    readonly first: CsvComparisonReturnRef
    readonly second: CsvComparisonReturnRef
  }
  /** The immediate own history message chosen if the recorded comparison is reused. */
  readonly reusedFrom?: CsvComparisonMessageRef
  readonly question?: never
  readonly source?: never
  readonly provenance?: never
  readonly explanation?: never
  readonly returnCards?: never
}

/** An imported comparison and its two included return cards, independent of the donor Session. */
export type ArtifactCsvComparisonImportedReturnedFacts = CsvComparisonFactsBase & ImportedCsvComparisonSource & {
  readonly returnCards: ArtifactCsvComparisonReturnCards
  readonly reusedFrom?: CsvComparisonMessageRef
  readonly explanation?: never
}

/** A confirmed comparison page, returned comparison, or ordered explanation. */
export type ArtifactCsvComparisonQuestionFacts = ArtifactCsvComparisonSingleFacts | ArtifactCsvComparisonLocalExplanationFacts
  | ArtifactCsvComparisonReturnedFacts | ArtifactCsvComparisonImportedReturnedFacts
  | (CsvComparisonFactsBase & ImportedCsvComparisonSource & {
    /** The immediate own sent explanation chosen for this reuse. */
    readonly reusedFrom?: CsvComparisonMessageRef
    readonly explanation: ArtifactCsvComparisonImportedExplanation
    readonly returnCards?: never
  })

/** A reviewed comparison page and its transient proof for sending through the normal composer. */
export type ArtifactCsvComparisonAttachment = {
  readonly facts: ArtifactCsvComparisonQuestionFacts
  readonly proof: string
}

/** Owner-private draft reference and its reviewed, immutable comparison. */
export type ArtifactCsvComparisonDraft = {
  readonly receiptId: string
  readonly facts: ArtifactCsvComparisonQuestionFacts
  /** Only on an owner draft read when that bound request's acceptance is unresolved. */
  readonly pendingRequestId?: SessionRequestId
}

/** Reasons a draft could not be staged, restored, or consumed. */
export type ArtifactCsvComparisonDraftFailure =
  | 'UNAVAILABLE' | 'INVALID_REVIEW' | 'DRAFT_CHANGED' | 'PROMPT_NOT_DURABLE' | 'PROMPT_ALREADY_ACCEPTED' | 'PROMPT_IN_FLIGHT'
  | 'HISTORY_UNVERIFIED' | 'INCOMPATIBLE_PAIR' | 'EXPLANATION_TOO_LARGE'

/** User-selected program report; state is data reported by the program, not a Host-recomputed observation. */
export type ArtifactProgramQuestionCapture =
  | { readonly status: 'ready'; readonly state: JsonValue; readonly restore?: never }
  | { readonly status: 'ready'; readonly state: ArtifactBfsCheckpoint; readonly restore: 'bfs-checkpoint' }
  | { readonly status: 'ready'; readonly state: ArtifactHalfAdderCheckpoint; readonly restore: 'half-adder-checkpoint' }
  | { readonly status: 'error'; readonly error: Pick<ArtifactRuntimeFailure, keyof ArtifactRuntimeFailure> }

/** Inputs reviewed for the numerical analysis of one function at a trace position. */
export type FunctionPlotQuestionConditions = {
  readonly functionId: string
  readonly x: number
  readonly parameters: Readonly<Record<string, number>>
}

/** Captured selections; source comes from the Host, while HTML runtime state retains its program attribution. */
export type ArtifactPromptContextSelection =
  | {
    readonly kind: 'current-particle'
    readonly artifactId: ArtifactId
    readonly revision: number
    readonly checkpoint: Pick<ParticleCheckpoint, keyof ParticleCheckpoint>
    readonly gravityY?: number
  }
  | (FunctionPlotQuestionConditions & {
    readonly kind: 'current-function-plot'
    readonly artifactId: ArtifactId
    readonly revision: number
  })
  | { readonly kind: 'current-csv-bar-chart'; readonly artifactId: ArtifactId; readonly revision: number; readonly groupKey: string }
  | (ArtifactCsvComparisonAttachment & { readonly kind: 'csv-question-comparison' })
  | { readonly kind: 'csv-comparison-draft'; readonly receiptId: string }
  | { readonly kind: 'observation'; readonly ref: Pick<SavedParticleObservationRef, keyof SavedParticleObservationRef> }
  | {
    readonly kind: 'branch-evidence'
    readonly capturedSessionId: SessionId
    readonly eventSeq: number
    readonly messageId: MessageId
  }
  | {
    readonly kind: 'branch-bfs-checkpoint'
    readonly capturedSessionId: SessionId
    readonly eventSeq: number
    readonly messageId: MessageId
    readonly state: ArtifactBfsCheckpoint
  }
  | {
    readonly kind: 'branch-half-adder-checkpoint'
    readonly capturedSessionId: SessionId
    readonly eventSeq: number
    readonly messageId: MessageId
    readonly state: ArtifactHalfAdderCheckpoint
  }
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

/** Self-contained native readings from one exact source revision. */
export type NativeArtifactQuestionReadings =
  | {
    readonly kind: 'current-particle'
    readonly artifact: SceneArtifactSnapshot
    readonly checkpoint: ParticleCheckpoint
    readonly gravityY?: number
    readonly values: ParticleObservation
  }
  | (FunctionPlotQuestionConditions & {
    readonly kind: 'current-function-plot'
    readonly artifact: SceneArtifactSnapshot
    readonly values: FunctionAnalysis
  })
  | {
    readonly kind: 'current-csv-bar-chart'
    readonly artifact: SceneArtifactSnapshot
    readonly groupKey: string
    readonly values: CsvBarChartSpec['groups'][number]
  }

/** The durable parent-local notice and original branch question that carried the selected readings. */
export interface ArtifactQuestionBranchResult {
  readonly eventSeq: number
  readonly messageId: MessageId
  readonly branchSessionId: SessionId
  readonly resultSeq: number
  readonly questionSeq: number
}

/** Complete resolved source and experiment facts, with the notice identity for returned branch evidence. */
export type ArtifactPromptContextFacts =
  | NativeArtifactQuestionReadings
  | ArtifactCsvComparisonQuestionFacts
  | { readonly kind: 'branch-evidence'; readonly branchResult: ArtifactQuestionBranchResult; readonly readings: NativeArtifactQuestionReadings }
  | {
    readonly kind: 'branch-bfs-checkpoint'
    readonly branchResult: ArtifactQuestionBranchResult
    readonly artifact: HtmlArtifactSnapshot
    readonly attribution: 'program-reported'
    readonly state: ArtifactBfsCheckpoint
  }
  | {
    readonly kind: 'branch-half-adder-checkpoint'
    readonly branchResult: ArtifactQuestionBranchResult
    readonly artifact: HtmlArtifactSnapshot
    readonly attribution: 'program-reported'
    readonly state: ArtifactHalfAdderCheckpoint
  }
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
    'artifact-followup/csv-draft-unavailable': { readonly reason: ArtifactCsvComparisonDraftFailure }
    'artifact-followup/context-rejected': {
      readonly reason: ArtifactPromptContextRejectionReason
      readonly limit?: number
    }
  }
}
