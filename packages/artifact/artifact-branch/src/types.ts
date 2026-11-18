/** User-confirmed Artifact evidence selected for one ordinary branch conclusion. */
import type { SessionId } from '@agentrans/session/types'
import type { SessionRequestId } from '@agentrans/api-session-controller/types'
import type {
  SavedParticleObservationRef, ParticleObservationComparisonErrorCode, ArtifactId, HtmlArtifactSnapshot, SceneArtifactSnapshot,
} from '@agentrans/artifact/types'
import type { CsvAggregate, CsvExactFilter } from '@agentrans/artifact/scene'
import type { ArtifactBfsCheckpoint, ArtifactHalfAdderCheckpoint } from '@agentrans/artifact/runtime-values'
import type {
  ArtifactCsvComparisonAttachment, ArtifactCsvComparisonPage, ArtifactCsvComparisonReading, ArtifactCsvComparisonRow,
} from '@agentrans/artifact-followup/types'
import type { Branded } from '@agentrans/brand'
import type { MessageId } from '@agentrans/llm'

/** Saved particle evidence or an exact experiment attachment to an earlier child-owned question. */
export type ArtifactBranchEvidenceSelection =
  | { readonly kind: 'observation'; readonly observation: SavedParticleObservationRef }
  | {
    readonly kind: 'comparison'
    readonly group: string
    readonly control: SavedParticleObservationRef
    readonly variant: SavedParticleObservationRef
  }
  | { readonly kind: 'question'; readonly questionSeq: number; readonly blockIndex: number }

/** Return one child-owned assistant conclusion with explicitly selected experiment evidence. */
export interface ArtifactBranchResultRequest {
  readonly sessionId: SessionId
  readonly branchSessionId: SessionId
  readonly resultSeq: number
  readonly evidence: ArtifactBranchEvidenceSelection
}

/** UUID identifying one continuation attempt, reused for an identical retry. */
export type ArtifactBranchContinuePlotRequestId = Branded<'ArtifactBranchContinuePlotRequestId'>

/** Exact returned function-plot evidence to continue from the receiving Session. */
export interface ArtifactBranchContinuePlotRequest {
  readonly sessionId: SessionId
  readonly eventSeq: number
  readonly messageId: MessageId
  readonly requestId: ArtifactBranchContinuePlotRequestId
}

/** Exact returned function-plot evidence to download from its receiving Session. */
export type ArtifactBranchExportReturnedPlotRequest = Pick<ArtifactBranchContinuePlotRequest, 'sessionId' | 'eventSeq' | 'messageId'>

/** Exact sent function-plot question to download from its owning Session. */
export type ArtifactBranchExportSentPlotRequest = ArtifactBranchExportReturnedPlotRequest

/** Exact returned native particle evidence to download from its receiving Session. */
export type ArtifactBranchExportReturnedParticleRequest = ArtifactBranchExportReturnedPlotRequest

/** Exact sent native particle question to download from its owning Session. */
export type ArtifactBranchExportSentParticleRequest = ArtifactBranchExportReturnedParticleRequest

/** Exact returned BFS evidence to download from its receiving Session. */
export type ArtifactBranchExportReturnedBfsRequest = ArtifactBranchExportReturnedPlotRequest

/** The original program and its locked BFS checkpoint, validated for offline assembly. */
export interface ArtifactBranchExportReturnedBfsValue {
  readonly artifact: HtmlArtifactSnapshot
  readonly checkpoint: ArtifactBfsCheckpoint
}

/** Exact sent BFS follow-up to download from the Session that owns the return and question. */
export type ArtifactBranchExportSentBfsRequest = ArtifactBranchExportReturnedBfsRequest

/** Exact returned half-adder evidence to download from its receiving Session. */
export type ArtifactBranchExportReturnedHalfAdderRequest = ArtifactBranchExportReturnedPlotRequest

/** The original program and its locked half-adder checkpoint, validated for offline assembly. */
export interface ArtifactBranchExportReturnedHalfAdderValue {
  readonly artifact: HtmlArtifactSnapshot
  readonly checkpoint: ArtifactHalfAdderCheckpoint
}

/** Exact sent half-adder follow-up to download from the Session that owns the return and question. */
export type ArtifactBranchExportSentHalfAdderRequest = ArtifactBranchExportReturnedHalfAdderRequest

/** The new ordinary branch and its editable experiment. */
export interface ArtifactBranchContinuePlotValue {
  readonly sessionId: SessionId
  readonly artifactId: ArtifactId
}

/** Exact returned particle evidence to continue from the receiving Session. */
export type ArtifactBranchContinueParticleRequest = ArtifactBranchContinuePlotRequest

/** The new ordinary branch and its editable particle experiment. */
export type ArtifactBranchContinueParticleValue = ArtifactBranchContinuePlotValue

/** Identify an adopted CSV evidence notice in the receiving Session. */
export interface ArtifactBranchCsvEvidenceRef {
  readonly sessionId: SessionId
  readonly eventSeq: number
  readonly messageId: MessageId
}

/** Select the aggregation and optional exact-match filter for one returned CSV result. */
export interface ArtifactBranchRecalculateCsvRequest extends ArtifactBranchCsvEvidenceRef {
  readonly aggregate: CsvAggregate
  readonly filter?: CsvExactFilter
}

/** Confirm one group in the Host result calculated from the returned CSV. */
export interface ArtifactBranchLockCsvRequest extends ArtifactBranchRecalculateCsvRequest {
  readonly groupKey: string
}

/** The fixed reading's parent-local Artifact revision and exact group key. */
export interface ArtifactBranchLockCsvValue {
  readonly artifact: SceneArtifactSnapshot
  readonly groupKey: string
}

/** Request CSV headings and optional sample values for a single heading. */
export interface ArtifactBranchCsvFilterOptionsRequest extends ArtifactBranchCsvEvidenceRef {
  readonly column?: string
}

/** Headings and a bounded distinct-value list for the requested column. */
export interface ArtifactBranchCsvFilterOptionsValue {
  readonly columns: readonly string[]
  readonly values: readonly string[]
  readonly hasMore: boolean
}

/** Request one page of records contributing to the selected group and recipe. */
export interface ArtifactBranchCsvRowsRequest extends ArtifactBranchRecalculateCsvRequest {
  readonly groupKey: string
  readonly offset?: number
}

/** Request one page of records contributing to the adopted CSV reading. */
export interface ArtifactBranchCsvReturnedRowsRequest extends ArtifactBranchCsvEvidenceRef {
  readonly offset?: number
}

/** Only the selected filter and measure cells are exposed, in original record order. */
export interface ArtifactBranchCsvRowsValue {
  readonly rows: readonly { readonly record: number; readonly filterValue?: string; readonly value?: string }[]
  readonly total: number
  readonly offset: number
  readonly nextOffset?: number
}

/** Read a page of rows for one sent CSV continuation question. */
export interface ArtifactBranchCsvQuestionRowsRequest {
  readonly sessionId: SessionId
  readonly eventSeq: number
  readonly messageId: MessageId
  readonly offset?: number
}

/** Original CSV measure heading and the page of records used by the confirmed group. */
export interface ArtifactBranchCsvQuestionRowsValue extends ArtifactBranchCsvRowsValue {
  readonly valueColumn?: string
}

/** Read a page comparing one sent CSV question with the return it continued. */
export type ArtifactBranchCsvQuestionComparisonRequest = ArtifactBranchCsvQuestionRowsRequest

/** Compare two CSV returns from the same inquiry branch, in the selected order. */
export interface ArtifactBranchCsvReturnedComparisonRequest {
  readonly sessionId: SessionId
  readonly first: Omit<ArtifactBranchCsvEvidenceRef, 'sessionId'>
  readonly second: Omit<ArtifactBranchCsvEvidenceRef, 'sessionId'>
  /** Start of the requested record page. Omission starts at zero. */
  readonly offset?: number
}

/** The recorded page and an owner-only proof when it can be confirmed for a question. */
export interface ArtifactBranchCsvReturnedComparisonValue extends ArtifactCsvComparisonPage {
  readonly attachment?: ArtifactCsvComparisonAttachment
}

/** The confirmed reading and calculation used on either side of a comparison. */
export type ArtifactBranchCsvComparisonReading = ArtifactCsvComparisonReading

/** Original CSV record membership and the cells needed to explain it. */
export type ArtifactBranchCsvComparisonRow = ArtifactCsvComparisonRow

/** Both confirmed readings, full membership counts and one page of the union of records. */
export interface ArtifactBranchCsvQuestionComparisonValue extends ArtifactCsvComparisonPage {
  readonly attachment?: ArtifactCsvComparisonAttachment
}

/** Read the current owner-private CSV comparison draft of this receiving Session. */
export interface ArtifactBranchReadCsvComparisonDraftRequest {
  readonly sessionId: SessionId
}

/** Confirm the exact reviewed Host page against the currently displayed draft receipt. */
export interface ArtifactBranchSaveCsvComparisonDraftRequest extends ArtifactBranchReadCsvComparisonDraftRequest {
  readonly attachment: ArtifactCsvComparisonAttachment
  readonly expectedReceiptId: string | null
}

/** Bind the next ordinary prompt attempt to this exact owner-private draft. */
export interface ArtifactBranchBindCsvComparisonDraftRequest extends ArtifactBranchReadCsvComparisonDraftRequest {
  readonly receiptId: string
  readonly requestId: SessionRequestId
}

/** The request identity is durable before the ordinary prompt is sent. */
export interface ArtifactBranchBindCsvComparisonDraftValue {
  readonly bound: true
}

/** Query one exact earlier comparison prompt by its browser-issued request identity. */
export interface ArtifactBranchCheckCsvComparisonDraftRequest extends ArtifactBranchReadCsvComparisonDraftRequest {
  readonly requestId: SessionRequestId
}

/** Locate the exact own history message holding a confirmed CSV comparison for review or export. */
export type ArtifactBranchReviewSentCsvComparisonRequest = ArtifactBranchCsvEvidenceRef

/** Export the exact saved comparison as HTML using the caller's current interface language. */
export interface ArtifactBranchExportSentCsvComparisonRequest extends ArtifactBranchCsvEvidenceRef {
  /** Language identifier at download time. Omission uses English. */
  readonly locale?: string
}

/** Review two own sent comparison pages for an ordered explanation. */
export interface ArtifactBranchReviewCsvComparisonExplanationRequest {
  readonly sessionId: SessionId
  readonly first: Omit<ArtifactBranchCsvEvidenceRef, 'sessionId'>
  readonly second: Omit<ArtifactBranchCsvEvidenceRef, 'sessionId'>
}

/** Validate a versioned portable CSV comparison in the destination Session before confirmation. */
export interface ArtifactBranchImportCsvComparisonRequest {
  readonly sessionId: SessionId
  readonly json: string
}

/** Durable acceptance, or whether the Host is still confirming that exact prompt. */
export type ArtifactBranchCheckCsvComparisonDraftValue =
  | {
    readonly accepted: true
    readonly pending?: never
    /** Exact history message when the accepted comparison is visible in the Session chat. */
    readonly message?: { readonly eventSeq: number; readonly messageId: MessageId }
    /** Identity of the admitted inbox message before its chat event is known. */
    readonly queuedMessageId?: MessageId
  }
  | { readonly accepted: false; readonly pending?: true }

/** Discard the exact draft or consume it once the matching prompt is durable. */
export interface ArtifactBranchClearCsvComparisonDraftRequest extends ArtifactBranchReadCsvComparisonDraftRequest {
  readonly receiptId: string
  readonly requestId?: SessionRequestId
}

/** A stale receipt has no effect on the currently confirmed draft. */
export interface ArtifactBranchClearCsvComparisonDraftValue {
  readonly cleared: boolean
}

/** A returned CSV result could not be resolved, calculated, or locked. */
export type ArtifactBranchCsvFailure =
  | 'SOURCE_NOT_FOUND' | 'ATTACHMENT_UNAVAILABLE' | 'AGGREGATE_UNAVAILABLE' | 'RESULT_UNAVAILABLE'
  | 'INVALID_GROUP' | 'GROUP_MISMATCH' | 'RESULT_CONFLICT'

/** A source selection that cannot supply the requested branch-local evidence. */
export type ArtifactBranchEvidenceFailure =
  | 'OBSERVATION_NOT_FOUND' | 'PROJECTION_UNAVAILABLE' | 'QUESTION_EVIDENCE_UNAVAILABLE' | ParticleObservationComparisonErrorCode

declare module '@agentrans/typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The portable JSON snapshot exceeds a limit or fails validation. */
    'artifact-branch/csv-comparison-import-invalid': { readonly reason: 'INVALID_SNAPSHOT' | 'SNAPSHOT_TOO_LARGE' | 'PROMPT_LIMIT' }
    /** The saved comparison cannot be represented by the portable JSON format. */
    'artifact-branch/csv-comparison-export-unavailable': { readonly reason: 'INVALID_SNAPSHOT' | 'SNAPSHOT_TOO_LARGE' }
    /** The child cut cannot resolve the selected experiment evidence; no parent message was appended. */
    'artifact-branch/evidence-unavailable': { readonly reason: ArtifactBranchEvidenceFailure }
    /** The complete conclusion and evidence message exceeds the configured byte budget. */
    'artifact-branch/result-too-large': { readonly limit: number }
    /** The continuation request identity already names a different branch or incomplete preparation. */
    'artifact-branch/continuation-conflict': { readonly requestId: ArtifactBranchContinuePlotRequestId }
    /** The original evidence, a compatible calculation, or the immutable lock is unavailable. */
    'artifact-branch/csv-analysis-unavailable': { readonly reason: ArtifactBranchCsvFailure }
  }
}
