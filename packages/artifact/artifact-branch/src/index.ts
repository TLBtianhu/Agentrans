/** Confirmed branch-result return with Host-resolved, immutable Artifact evidence. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Context } from '@agentrans/cordis'
import z from '@agentrans/schemastery'
import type {} from '@agentrans/artifact'
import type {
  ArtifactId, ArtifactObservations, ArtifactPlotContinuation, SavedParticleObservation, SavedParticleObservationRef, SceneArtifactSnapshot,
} from '@agentrans/artifact/types'
import { buildParticleObservationComparison, ParticleObservationComparisonError } from '@agentrans/artifact/observation-comparison'
import { createParticleCheckpoint, observeParticleState, restoreParticleCheckpoint } from '@agentrans/artifact/particle-runtime'
import type { ArtifactHtmlCheckpointKind } from '@agentrans/artifact/runtime-values'
import type { CsvBarChartSpec, ParticleSystemSpec } from '@agentrans/artifact/scene'
import {
  buildSceneAnimationHtml, FUNCTION_PLOT_BASELINE_EXPORTER_VERSION, SCENE_EXPORTER_VERSION, type SceneExportOrigin,
} from '@agentrans/artifact/scene-export'
import { resolveReturnedHtmlSource, resolveReturnedReadings, returnedReadingNotice } from '@agentrans/artifact-followup'
import type { ArtifactCsvComparisonAttachment, ArtifactCsvComparisonDraft, NativeArtifactQuestionReadings } from '@agentrans/artifact-followup/types'
import type { SessionBranchResultValue } from '@agentrans/api-session-controller'
import { brandString } from '@agentrans/brand'
import { SessionId, SessionSeq } from '@agentrans/session'
import { selectBranchResult } from '@agentrans/session-branch'
import { admitBranchResult, BranchResultAdmissionBusy, BranchResultAdmissionConflict } from '@agentrans/session-branch/admission'
import { SessionQueryError, type SessionObservation } from '@agentrans/session-query'
import { principalOf, Remote, RemoteError, TypertRemoteService } from '@agentrans/typert-protocol'
import {
  bindCsvComparisonDraftRequest, checkCsvComparisonDraftRequest, clearCsvComparisonDraft, compareCsvQuestionToReturn, compareCsvReturns,
  csvAnalysisUnavailable, filterOptionsForReturnedCsv, importCsvComparison, readCsvComparisonDraft,
  readCsvQuestionRows, readReturnedCsvEvidenceRows, readReturnedCsvRows, recalculateReturnedCsv,
  resolveSentCsvComparisonExport, reviewCsvComparisonExplanation, reviewSentCsvComparison, saveCsvComparisonDraft,
} from './csv-analysis.ts'
import { renderCsvComparisonExplanationHtml, renderCsvComparisonHtml, renderCsvReturnedComparisonHtml } from './csv-comparison-export.ts'
import { encodeCsvComparisonSnapshot, encodeCsvReturnedComparisonSnapshot } from './csv-comparison-snapshot.ts'
import { resolveQuestionEvidence, resolveSentHtmlQuestion, resolveSentNativeQuestion } from './question-evidence.ts'
import type {
  ArtifactBranchBindCsvComparisonDraftRequest, ArtifactBranchBindCsvComparisonDraftValue,
  ArtifactBranchCheckCsvComparisonDraftRequest, ArtifactBranchCheckCsvComparisonDraftValue,
  ArtifactBranchClearCsvComparisonDraftRequest, ArtifactBranchClearCsvComparisonDraftValue,
  ArtifactBranchContinueParticleRequest, ArtifactBranchContinueParticleValue, ArtifactBranchContinuePlotRequest,
  ArtifactBranchContinuePlotValue,
  ArtifactBranchCsvFilterOptionsRequest, ArtifactBranchCsvFilterOptionsValue, ArtifactBranchCsvRowsRequest, ArtifactBranchCsvRowsValue,
  ArtifactBranchCsvQuestionComparisonRequest, ArtifactBranchCsvQuestionComparisonValue,
  ArtifactBranchCsvQuestionRowsRequest, ArtifactBranchCsvQuestionRowsValue, ArtifactBranchCsvReturnedComparisonRequest,
  ArtifactBranchCsvReturnedComparisonValue,
  ArtifactBranchCsvReturnedRowsRequest,
  ArtifactBranchEvidenceSelection, ArtifactBranchExportReturnedBfsRequest, ArtifactBranchExportReturnedBfsValue,
  ArtifactBranchExportReturnedHalfAdderRequest, ArtifactBranchExportReturnedHalfAdderValue,
  ArtifactBranchExportReturnedParticleRequest, ArtifactBranchExportReturnedPlotRequest,
  ArtifactBranchExportSentBfsRequest, ArtifactBranchExportSentCsvComparisonRequest, ArtifactBranchExportSentHalfAdderRequest,
  ArtifactBranchExportSentParticleRequest, ArtifactBranchExportSentPlotRequest,
  ArtifactBranchImportCsvComparisonRequest,
  ArtifactBranchLockCsvRequest, ArtifactBranchLockCsvValue,
  ArtifactBranchReadCsvComparisonDraftRequest, ArtifactBranchRecalculateCsvRequest, ArtifactBranchResultRequest,
  ArtifactBranchReviewCsvComparisonExplanationRequest, ArtifactBranchReviewSentCsvComparisonRequest,
  ArtifactBranchSaveCsvComparisonDraftRequest,
} from './types.ts'

export type * from './types.ts'

declare module '@agentrans/cordis' {
  interface Context {
    /** Return manually selected branch conclusions with Artifact evidence. */
    artifactBranchResults: ArtifactBranchResults
  }
}

/** Complete returned-message deployment budget. */
export interface Config {
  /** Maximum UTF-8 bytes of the complete parent UserMessage; default 16384, matching Artifact actions. */
  readonly maxActionBytes?: number
}

type ResolvedConfig = { readonly maxActionBytes: number }
type ContinuationKind = 'function-plot' | 'particle-system'
type ReturnedExperimentKind = ContinuationKind | ArtifactHtmlCheckpointKind

const CONTINUATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function continuationConflict(request: ArtifactBranchContinuePlotRequest): never {
  throw new RemoteError('artifact-branch/continuation-conflict', 'This continuation request already names another branch or incomplete preparation', {
    requestId: request.requestId,
  })
}

function unavailableExperiment(kind: ContinuationKind): never {
  const description = kind === 'function-plot' ? 'adjustable returned function-plot' : 'returned particle-system'
  throw new RemoteError('artifact-branch/evidence-unavailable', `The selected notice has no ${description} readings`, {
    reason: 'QUESTION_EVIDENCE_UNAVAILABLE',
  })
}

function jsonNumber(value: number | null): number | null {
  return Object.is(value, -0) ? 0 : value
}

function plotBaseline(
  { functionId, parameters, values, x }: Extract<NativeArtifactQuestionReadings, { kind: 'current-function-plot' }>,
): ArtifactPlotContinuation['baseline'] {
  return { functionId, x, parameters,
    values: { value: jsonNumber(values.value), derivative: jsonNumber(values.derivative), integral: jsonNumber(values.integral) } }
}

function returnedExperimentUnavailable(kind: ReturnedExperimentKind): never {
  const name = { 'function-plot': 'function plot', 'particle-system': 'particle experiment',
    'bfs-checkpoint': 'BFS checkpoint', 'half-adder-checkpoint': 'half-adder checkpoint' }[kind]
  throw new RemoteError('artifact-branch/evidence-unavailable', `The selected return has no downloadable ${name} readings`, {
    reason: 'QUESTION_EVIDENCE_UNAVAILABLE',
  })
}

function sentExperimentUnavailable(kind: ReturnedExperimentKind): never {
  const name = { 'function-plot': 'function plot', 'particle-system': 'particle experiment',
    'bfs-checkpoint': 'BFS checkpoint', 'half-adder-checkpoint': 'half-adder checkpoint' }[kind]
  throw new RemoteError('artifact-branch/evidence-unavailable', `The selected question has no downloadable ${name}`, {
    reason: 'QUESTION_EVIDENCE_UNAVAILABLE',
  })
}

function evidenceEventSeq(value: number): ReturnType<typeof SessionSeq> {
  try { return SessionSeq(value) } catch {
    throw new RemoteError('gateway/bad-request', 'eventSeq must be a non-negative safe integer', {})
  }
}

function returnedExportOrigin(
  { sessionId, eventSeq, messageId }: ArtifactBranchExportReturnedPlotRequest,
  { artifactId, revision }: SceneArtifactSnapshot,
  exporterVersion: SceneExportOrigin['exporterVersion'],
): SceneExportOrigin {
  return { exporterVersion, exportId: `return-${eventSeq}`, sessionId, artifactId, revision, returnedEvidence: { eventSeq, messageId } }
}

function particleSpecWithGravity(spec: ParticleSystemSpec, gravityY: number | undefined): ParticleSystemSpec {
  return gravityY === undefined ? spec : { ...spec, gravity: { ...spec.gravity, y: gravityY } }
}

function continuationSnapshot(
  kind: ContinuationKind, readings: NativeArtifactQuestionReadings, request: ArtifactBranchContinuePlotRequest,
  eventSeq: ReturnType<typeof SessionSeq>, artifactId: ArtifactId,
): SceneArtifactSnapshot | undefined {
  const { artifact } = readings
  const source = { sessionId: request.sessionId, eventSeq, messageId: request.messageId,
    artifactId: artifact.artifactId, revision: artifact.revision }
  const child = { artifactId, revision: 1, format: 'scene', title: artifact.title, presentation: 'inline' } as const
  if (kind === 'particle-system' && readings.kind === 'current-particle' && artifact.spec.kind === kind) {
    const { checkpoint, gravityY } = readings
    const spec = particleSpecWithGravity(artifact.spec, gravityY)
    return { ...child, spec, particleContinuation: { source, baseline: { checkpoint } } }
  }
  if (kind === 'function-plot' && readings.kind === 'current-function-plot' && artifact.spec.kind === kind
    && Object.values(artifact.spec.parameters).some(({ min, max }) => min < max)) {
    return { ...child, spec: artifact.spec, continuation: { source, baseline: plotBaseline(readings) } }
  }
  return undefined
}

function savedObservation(observations: ArtifactObservations, ref: SavedParticleObservationRef): SavedParticleObservation {
  const saved = observations[ref.artifactId]?.find(item => item.observationId === ref.observationId)
  if (saved === undefined) {
    throw new RemoteError('artifact-branch/evidence-unavailable', 'Saved observation is not visible in this branch', {
      reason: 'OBSERVATION_NOT_FOUND',
    })
  }
  if (saved.artifact.spec.kind !== 'particle-system') {
    throw new RemoteError('artifact-branch/evidence-unavailable', 'Saved evidence requires a particle-system source', {
      reason: 'UNSUPPORTED_OBSERVATION',
    })
  }
  const state = restoreParticleCheckpoint(saved.artifact.spec, saved.checkpoint)
  return { observationId: saved.observationId, label: saved.label, artifact: saved.artifact,
    checkpoint: createParticleCheckpoint(state), values: observeParticleState(state) }
}

function savedEvidenceFacts(
  observations: ArtifactObservations, selection: Exclude<ArtifactBranchEvidenceSelection, { kind: 'question' }>,
) {
  if (selection.kind === 'observation') return {
    kind: 'observation' as const, observation: savedObservation(observations, selection.observation),
  }
  const control = savedObservation(observations, selection.control)
  const variant = savedObservation(observations, selection.variant)
  try {
    const comparison = buildParticleObservationComparison(selection.group, control, variant)
    return { kind: 'comparison' as const, group: comparison.group, conditions: comparison.conditions, control, variant }
  } catch (error) {
    if (!(error instanceof ParticleObservationComparisonError)) throw error
    throw new RemoteError('artifact-branch/evidence-unavailable', error.message, { reason: error.code }, { cause: error })
  }
}

/** Artifact-owned API for manually attaching experiment evidence to one branch conclusion. */
export class ArtifactBranchResults extends TypertRemoteService {
  static inject = ['sessionQuery', 'sessionController', 'sessions', 'artifacts']

  static Config: z<Config, ResolvedConfig> = z.object({
    maxActionBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
  })

  private readonly maxActionBytes: number
  private readonly continuing = new Map<SessionId, {
    readonly kind: ContinuationKind
    readonly eventSeq: number
    readonly messageId: ArtifactBranchContinuePlotRequest['messageId']
    readonly result: Promise<ArtifactBranchContinuePlotValue>
  }>()

  /**
   * @param ctx - Host services for branch reads, parent activation and Artifact projection ownership.
   * @param config - Complete returned-message byte budget; omission uses the Artifact-action default.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'artifactBranchResults')
    this.maxActionBytes = ArtifactBranchResults.Config(config).maxActionBytes
  }

  /**
   * Fork a returned function plot into an editable child without waking either Agent.
   * @param request - Receiving Session, exact evidence notice identity and retry UUID.
   * @returns The durable child Session and its initial editable Artifact.
   * @throws {RemoteError} For unavailable evidence or conflicting reuse of the request identity.
   * A durability or workspace error can follow creation. Retry the identical request to recover the child.
   */
  @Remote({ resources: { session: (request: ArtifactBranchContinuePlotRequest) => request.sessionId } })
  async continuePlot(request: ArtifactBranchContinuePlotRequest): Promise<ArtifactBranchContinuePlotValue> {
    return await this.continueExperiment(request, 'function-plot')
  }

  /**
   * Export the exact locked function plot in an original branch-return notice as offline HTML.
   * @param request - Receiving Session and exact notice sequence and message ID.
   * @returns UTF-8 HTML with the recorded source revision and replay conditions.
   * @throws {RemoteError} For unavailable or unverified evidence.
   */
  @Remote({ resources: { session: (request: ArtifactBranchExportReturnedPlotRequest) => request.sessionId } })
  async exportReturnedPlot(request: ArtifactBranchExportReturnedPlotRequest): Promise<Uint8Array> {
    const readings = await this.observeReturnedExperiment(request, 'function-plot')
    if (readings.kind !== 'current-function-plot') return returnedExperimentUnavailable('function-plot')
    const { artifact } = readings
    const origin = returnedExportOrigin(request, artifact, FUNCTION_PLOT_BASELINE_EXPORTER_VERSION)
    return new TextEncoder().encode(buildSceneAnimationHtml(artifact.spec, artifact.title, undefined, origin, plotBaseline(readings)))
  }

  /**
   * Export the exact function plot locked on a sent follow-up as offline HTML.
   * @param request - Owning Session and exact question sequence and message ID.
   * @returns UTF-8 HTML with the recorded source revision and replay conditions.
   * @throws {RemoteError} For unavailable or unverified evidence.
   */
  @Remote({ resources: { session: (request: ArtifactBranchExportSentPlotRequest) => request.sessionId } })
  async exportSentPlot(request: ArtifactBranchExportSentPlotRequest): Promise<Uint8Array> {
    const readings = await this.observeSentNativeQuestion(request, 'function-plot')
    if (readings?.kind !== 'current-function-plot') return sentExperimentUnavailable('function-plot')
    const { sessionId, eventSeq, messageId } = request
    const { artifact } = readings
    const origin: SceneExportOrigin = { exporterVersion: FUNCTION_PLOT_BASELINE_EXPORTER_VERSION, exportId: `sent-${eventSeq}`,
      sessionId, artifactId: artifact.artifactId, revision: artifact.revision, sentQuestion: { eventSeq, messageId } }
    return new TextEncoder().encode(buildSceneAnimationHtml(artifact.spec, artifact.title, undefined, origin, plotBaseline(readings)))
  }

  /**
   * Export the checkpoint of a returned particle experiment as offline HTML.
   * @param request - Receiving Session and exact notice sequence and message ID.
   * @returns UTF-8 HTML with the original revision and confirmed replay conditions.
   * @throws {RemoteError} For unavailable or unverified evidence.
   */
  @Remote({ resources: { session: (request: ArtifactBranchExportReturnedParticleRequest) => request.sessionId } })
  async exportReturnedParticle(request: ArtifactBranchExportReturnedParticleRequest): Promise<Uint8Array> {
    const readings = await this.observeReturnedExperiment(request, 'particle-system')
    if (readings.kind !== 'current-particle' || readings.artifact.spec.kind !== 'particle-system') {
      return returnedExperimentUnavailable('particle-system')
    }
    const { artifact, checkpoint, gravityY } = readings
    const spec = particleSpecWithGravity(readings.artifact.spec, gravityY)
    const origin = returnedExportOrigin(request, artifact, SCENE_EXPORTER_VERSION)
    return new TextEncoder().encode(buildSceneAnimationHtml(spec, artifact.title, checkpoint, origin))
  }

  /**
   * Export the particle experiment locked on a sent follow-up as offline HTML.
   * @param request - Owning Session and exact question sequence and message ID.
   * @returns UTF-8 HTML with the recorded revision, effective gravity and confirmed checkpoint.
   * @throws {RemoteError} For unavailable or unverified evidence.
   */
  @Remote({ resources: { session: (request: ArtifactBranchExportSentParticleRequest) => request.sessionId } })
  async exportSentParticle(request: ArtifactBranchExportSentParticleRequest): Promise<Uint8Array> {
    const readings = await this.observeSentNativeQuestion(request, 'particle-system')
    if (readings?.kind !== 'current-particle' || readings.artifact.spec.kind !== 'particle-system') {
      return sentExperimentUnavailable('particle-system')
    }
    const { sessionId, eventSeq, messageId } = request
    const { artifact, checkpoint, gravityY } = readings
    const spec = particleSpecWithGravity(readings.artifact.spec, gravityY)
    const origin: SceneExportOrigin = { exporterVersion: SCENE_EXPORTER_VERSION, exportId: `sent-${eventSeq}`,
      sessionId, artifactId: artifact.artifactId, revision: artifact.revision, sentQuestion: { eventSeq, messageId } }
    return new TextEncoder().encode(buildSceneAnimationHtml(spec, artifact.title, checkpoint, origin))
  }

  /**
   * Read the original program and checkpoint of an exact BFS return for offline download.
   * @param request - Receiving Session and exact notice sequence and message ID.
   * @returns The source revision and the program-reported checkpoint confirmed on that notice.
   * @throws {RemoteError} For unavailable or unverified evidence.
   */
  @Remote({ resources: { session: (request: ArtifactBranchExportReturnedBfsRequest) => request.sessionId } })
  async exportReturnedBfs(request: ArtifactBranchExportReturnedBfsRequest): Promise<ArtifactBranchExportReturnedBfsValue> {
    const notice = await this.observeReturnedNotice(request, 'bfs-checkpoint')
    const replay = resolveReturnedHtmlSource(notice, request.eventSeq, 'bfs-checkpoint')
    if (replay?.checkpoint.kind !== 'bfs-checkpoint') return returnedExperimentUnavailable('bfs-checkpoint')
    return { artifact: replay.artifact, checkpoint: replay.checkpoint }
  }

  /**
   * Read the exact original program and the step locked on a sent BFS follow-up for offline download.
   * @param request - Owning Session and exact sent question sequence and message ID.
   * @returns The source revision from the verified return and the follow-up's recorded checkpoint.
   * @throws {RemoteError} For unavailable or unverified evidence.
   */
  @Remote({ resources: { session: (request: ArtifactBranchExportSentBfsRequest) => request.sessionId } })
  async exportSentBfs(request: ArtifactBranchExportSentBfsRequest): Promise<ArtifactBranchExportReturnedBfsValue> {
    const evidence = await this.observeSentHtmlQuestion(request, 'bfs-checkpoint')
    if (evidence.checkpoint.kind !== 'bfs-checkpoint') return sentExperimentUnavailable('bfs-checkpoint')
    return { artifact: evidence.artifact, checkpoint: evidence.checkpoint }
  }

  /**
   * Read the original program and checkpoint of an exact half-adder return for offline download.
   * @param request - Receiving Session and exact notice sequence and message ID.
   * @returns The source revision and the program-reported checkpoint confirmed on that notice.
   * @throws {RemoteError} For unavailable or unverified evidence.
   */
  @Remote({ resources: { session: (request: ArtifactBranchExportReturnedHalfAdderRequest) => request.sessionId } })
  async exportReturnedHalfAdder(
    request: ArtifactBranchExportReturnedHalfAdderRequest,
  ): Promise<ArtifactBranchExportReturnedHalfAdderValue> {
    const notice = await this.observeReturnedNotice(request, 'half-adder-checkpoint')
    const replay = resolveReturnedHtmlSource(notice, request.eventSeq, 'half-adder-checkpoint')
    if (replay?.checkpoint.kind !== 'half-adder-checkpoint') return returnedExperimentUnavailable('half-adder-checkpoint')
    return { artifact: replay.artifact, checkpoint: replay.checkpoint }
  }

  /**
   * Read the original program and state locked on a sent half-adder follow-up for offline download.
   * @param request - Owning Session and exact sent question sequence and message ID.
   * @returns The source revision from the verified return and the input and output bits recorded on the question.
   * @throws {RemoteError} For unavailable or unverified evidence.
   */
  @Remote({ resources: { session: (request: ArtifactBranchExportSentHalfAdderRequest) => request.sessionId } })
  async exportSentHalfAdder(request: ArtifactBranchExportSentHalfAdderRequest): Promise<ArtifactBranchExportReturnedHalfAdderValue> {
    const evidence = await this.observeSentHtmlQuestion(request, 'half-adder-checkpoint')
    if (evidence.checkpoint.kind !== 'half-adder-checkpoint') return sentExperimentUnavailable('half-adder-checkpoint')
    return { artifact: evidence.artifact, checkpoint: evidence.checkpoint }
  }

  /**
   * Fork returned native particle readings into an editable child without waking either Agent.
   * @param request - Receiving Session, exact evidence notice identity and retry UUID.
   * @returns The durable child Session and its initial editable Artifact at the original checkpoint.
   * @throws {RemoteError} For unavailable evidence or conflicting reuse of the request identity.
   * A durability or workspace error can follow creation. Retry the identical request to recover the child.
   */
  @Remote({ resources: { session: (request: ArtifactBranchContinueParticleRequest) => request.sessionId } })
  async continueParticle(request: ArtifactBranchContinueParticleRequest): Promise<ArtifactBranchContinueParticleValue> {
    return await this.continueExperiment(request, 'particle-system')
  }

  /**
   * Recalculate the groups from one exact CSV return without mutating the Session.
   * @param request - Receiving Session, exact evidence notice and selected calculation.
   * @returns A chart source computed from the original attachment, grouping column and numeric column.
   * @throws {RemoteError} For unavailable evidence, attachment, or calculation.
   */
  @Remote({ resources: { session: (request: ArtifactBranchRecalculateCsvRequest) => request.sessionId } })
  async recalculateCsv(request: ArtifactBranchRecalculateCsvRequest): Promise<CsvBarChartSpec> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    return (await recalculateReturnedCsv(this.ctx, request, signal)).spec
  }

  /**
   * Inspect the CSV columns and a bounded list of distinct values for one column without mutating the Session.
   * @param request - Exact approved return and optional column name.
   * @returns The available columns and the requested column options.
   */
  @Remote({ resources: { session: (request: ArtifactBranchCsvFilterOptionsRequest) => request.sessionId } })
  async csvFilterOptions(request: ArtifactBranchCsvFilterOptionsRequest): Promise<ArtifactBranchCsvFilterOptionsValue> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    return await filterOptionsForReturnedCsv(this.ctx, request, signal)
  }

  /**
   * Inspect a page of original CSV records contributing to a group before confirmation.
   * @param request - Exact approved return, current recipe, group key and optional offset.
   * @returns The matching record range with filter and measure cells only.
   */
  @Remote({ resources: { session: (request: ArtifactBranchCsvRowsRequest) => request.sessionId } })
  async csvParticipatingRows(request: ArtifactBranchCsvRowsRequest): Promise<ArtifactBranchCsvRowsValue> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    return await readReturnedCsvRows(this.ctx, request, signal)
  }

  /**
   * Inspect the records that contributed to the adopted CSV reading.
   * @param request - Exact receiving Session, return identity and optional record offset.
   * @returns A page from the original branch CSV using the adopted group and recipe.
   */
  @Remote({ resources: { session: (request: ArtifactBranchCsvReturnedRowsRequest) => request.sessionId } })
  async csvReturnedParticipatingRows(request: ArtifactBranchCsvReturnedRowsRequest): Promise<ArtifactBranchCsvRowsValue> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    return await readReturnedCsvEvidenceRows(this.ctx, request, signal)
  }

  /**
   * Inspect the records that contributed to a sent CSV question's confirmed reading.
   * @param request - Exact receiving Session, question identity and optional record offset.
   * @returns A page from the original branch CSV using the stored group and filter.
   */
  @Remote({ resources: { session: (request: ArtifactBranchCsvQuestionRowsRequest) => request.sessionId } })
  async csvQuestionParticipatingRows(request: ArtifactBranchCsvQuestionRowsRequest): Promise<ArtifactBranchCsvQuestionRowsValue> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    return await readCsvQuestionRows(this.ctx, request, signal)
  }

  /**
   * Compare the confirmed CSV readings and their contributing records.
   * @param request - Exact receiving Session, sent question identity and optional record offset.
   * @returns A page of kept, excluded and added records for the same group of the original CSV.
   */
  @Remote({ resources: { session: (request: ArtifactBranchCsvQuestionComparisonRequest) => request.sessionId } })
  async compareCsvQuestionToReturn(request: ArtifactBranchCsvQuestionComparisonRequest): Promise<ArtifactBranchCsvQuestionComparisonValue> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    return await compareCsvQuestionToReturn(this.ctx, request, signal)
  }

  /**
   * Compare two confirmed CSV returns and their record membership.
   * @param request - Parent Session, exact saved returns in comparison order, and optional page offset.
   * @returns The saved readings, the bounded record page and its confirmation proof when available to the owner.
   */
  @Remote({ resources: { session: (request: ArtifactBranchCsvReturnedComparisonRequest) => request.sessionId } })
  async compareCsvReturns(request: ArtifactBranchCsvReturnedComparisonRequest): Promise<ArtifactBranchCsvReturnedComparisonValue> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    return await compareCsvReturns(this.ctx, request, signal)
  }

  /**
   * Restore the owner's unsent CSV comparison for the receiving Session.
   * @param request - The receiving Session identity.
   * @returns The exact confirmed draft, or null when there is no draft.
   */
  @Remote({ resources: { session: (request: ArtifactBranchReadCsvComparisonDraftRequest) => request.sessionId } })
  async readCsvComparisonDraft(request: ArtifactBranchReadCsvComparisonDraftRequest): Promise<ArtifactCsvComparisonDraft | null> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    return await readCsvComparisonDraft(this.ctx, request, signal)
  }

  /**
   * Durably save an explicitly confirmed CSV comparison before prompt admission.
   * @param request - Receiving Session, sealed reviewed page, and expected current receipt.
   * @returns The private receipt and the exact comparison visible in the draft.
   */
  @Remote({ resources: { session: (request: ArtifactBranchSaveCsvComparisonDraftRequest) => request.sessionId } })
  async saveCsvComparisonDraft(request: ArtifactBranchSaveCsvComparisonDraftRequest): Promise<ArtifactCsvComparisonDraft> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    return await saveCsvComparisonDraft(this.ctx, request, signal)
  }

  /**
   * Bind the exact confirmed draft to the next ordinary prompt request.
   * @param request - Owner receiving Session, current draft receipt and prompt request identity.
   * @returns Confirmation that the request identity is durable.
   */
  @Remote({ resources: { session: (request: ArtifactBranchBindCsvComparisonDraftRequest) => request.sessionId } })
  async bindCsvComparisonDraftRequest(
    request: ArtifactBranchBindCsvComparisonDraftRequest,
  ): Promise<ArtifactBranchBindCsvComparisonDraftValue> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    return await bindCsvComparisonDraftRequest(this.ctx, request, signal)
  }

  /**
   * Check whether the exact identified comparison prompt reached the Session.
   * @param request - The owner receiving Session and original prompt identity.
   * @returns Whether this comparison prompt is durably accepted and its exact chat or inbox identity when available.
   */
  @Remote({ resources: { session: (request: ArtifactBranchCheckCsvComparisonDraftRequest) => request.sessionId } })
  async checkCsvComparisonDraftRequest(
    request: ArtifactBranchCheckCsvComparisonDraftRequest,
  ): Promise<ArtifactBranchCheckCsvComparisonDraftValue> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    return await checkCsvComparisonDraftRequest(this.ctx, request, signal)
  }

  /**
   * Review the exact single comparison or imported explanation attached to an own sent question.
   * @param request - Receiving Session and exact message coordinates from chat history.
   * @returns The unchanged reviewed pages and transient proof for a fresh explicit draft lock.
   */
  @Remote({ resources: { session: (request: ArtifactBranchReviewSentCsvComparisonRequest) => request.sessionId } })
  async reviewSentCsvComparison(request: ArtifactBranchReviewSentCsvComparisonRequest): Promise<ArtifactCsvComparisonAttachment> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    return await reviewSentCsvComparison(this.ctx, request, signal)
  }

  /**
   * Review two exact sent CSV comparisons as an ordered explanation before confirmation.
   * @param request - Receiving Session and both exact history message addresses in either selection order.
   * @returns The saved pages in recipe order with a transient proof for explicit draft confirmation.
   */
  @Remote({ resources: { session: (request: ArtifactBranchReviewCsvComparisonExplanationRequest) => request.sessionId } })
  async reviewCsvComparisonExplanation(
    request: ArtifactBranchReviewCsvComparisonExplanationRequest,
  ): Promise<ArtifactCsvComparisonAttachment> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    return await reviewCsvComparisonExplanation(this.ctx, request, signal)
  }

  /**
   * Export the exact recorded pages of a sent CSV comparison or explanation as offline HTML.
   * @param request - Receiving Session, exact message coordinates, and optional document language.
   * @returns UTF-8 HTML with the saved readings, reviewed records, and original return cards when the comparison records them.
   */
  @Remote({ resources: { session: (request: ArtifactBranchExportSentCsvComparisonRequest) => request.sessionId } })
  async exportSentCsvComparison(request: ArtifactBranchExportSentCsvComparisonRequest): Promise<Uint8Array> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    const { facts: { comparison, explanation, attribution }, returnCards } = await resolveSentCsvComparisonExport(this.ctx, request, signal)
    signal.throwIfAborted()
    if (returnCards !== undefined) return renderCsvReturnedComparisonHtml(comparison, returnCards, attribution, request.locale)
    return explanation === undefined ? renderCsvComparisonHtml(comparison, attribution, request.locale)
      : renderCsvComparisonExplanationHtml(explanation.aggregation.comparison, comparison, attribution, request.locale)
  }

  /**
   * Export the reviewed pages of the exact own sent comparison or explanation as portable JSON.
   * @param request - Receiving Session and exact message coordinates from chat history.
   * @returns Bounded UTF-8 JSON containing the exact reviewed pages and any original return cards without local resource identities.
   */
  @Remote({ resources: { session: (request: ArtifactBranchReviewSentCsvComparisonRequest) => request.sessionId } })
  async exportSentCsvComparisonJson(request: ArtifactBranchReviewSentCsvComparisonRequest): Promise<Uint8Array> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    const { facts: { comparison, explanation }, returnCards } = await resolveSentCsvComparisonExport(this.ctx, request, signal)
    signal.throwIfAborted()
    return returnCards === undefined ? encodeCsvComparisonSnapshot(comparison, explanation?.aggregation.comparison)
      : encodeCsvReturnedComparisonSnapshot(comparison, returnCards)
  }

  /**
   * Review a portable comparison or explanation in a destination Session before the user confirms it.
   * @param request - Destination Session and decoded JSON file selected by the caller.
   * @returns Exact imported readings, their explicit source classification and a transient review proof.
   */
  @Remote({ resources: { session: (request: ArtifactBranchImportCsvComparisonRequest) => request.sessionId } })
  async importCsvComparison(request: ArtifactBranchImportCsvComparisonRequest): Promise<ArtifactCsvComparisonAttachment> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    return await importCsvComparison(this.ctx, request, signal)
  }

  /**
   * Remove the matching draft on explicit discard or after its accepted prompt reaches durability.
   * @param request - Receiving Session, exact receipt, and optional accepted prompt request ID.
   * @returns Whether that matching receipt was removed.
   */
  @Remote({ resources: { session: (request: ArtifactBranchClearCsvComparisonDraftRequest) => request.sessionId } })
  async clearCsvComparisonDraft(
    request: ArtifactBranchClearCsvComparisonDraftRequest,
  ): Promise<ArtifactBranchClearCsvComparisonDraftValue> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    return await clearCsvComparisonDraft(this.ctx, request, signal)
  }

  /**
   * Confirm and persist one recalculated group in the receiving Session without waking the Agent.
   * @param request - Exact returned evidence, selected aggregation and group.
   * @returns The new immutable source and its confirmed group after the durability checkpoint.
   * @throws {RemoteError} For invalid or unavailable source, group or conflicting result. An identical retry reuses the same source.
   */
  @Remote({ resources: { session: (request: ArtifactBranchLockCsvRequest) => request.sessionId } })
  async lockCsv(request: ArtifactBranchLockCsvRequest): Promise<ArtifactBranchLockCsvValue> {
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    const { spec, source, title } = await recalculateReturnedCsv(this.ctx, request, signal)
    const { groupKey } = request
    if (!spec.groups.some(group => group.key === groupKey)) return csvAnalysisUnavailable('INVALID_GROUP')
    const filterKey = spec.filter === undefined ? [] : [spec.filter.column, spec.filter.value]
    const identity = createHash('sha256').update(JSON.stringify([source.sessionId, source.eventSeq, source.messageId,
      spec.aggregate, groupKey, ...filterKey])).digest('hex')
    const artifactId = brandString<ArtifactId>(`continued-csv-${identity.slice(0, 32)}`)
    let snapshot: SceneArtifactSnapshot = { artifactId, revision: 1, format: 'scene', presentation: 'inline', title, spec,
      csvContinuation: { source, groupKey } }
    const resolved = await this.ctx.sessionController.resolveAgent(source.sessionId)
    if ('error' in resolved) throw resolved.error
    signal.throwIfAborted()
    const { agent } = resolved
    let existing = this.ctx.artifacts.currentSnapshot(agent, artifactId)
    if (existing !== undefined && !isDeepStrictEqual(existing, snapshot)) {
      if (existing.format !== 'scene' || existing.spec.kind !== 'csv-bar-chart'
        || (spec.aggregate !== 'sum' && spec.aggregate !== 'mean')) return csvAnalysisUnavailable('RESULT_CONFLICT')
      const previousGroups = existing.spec.groups
      const previousReadings = spec.groups.map((group, index) => ({ ...group, value: previousGroups[index]?.value ?? group.value }))
      if (!isDeepStrictEqual(existing, { ...snapshot, spec: { ...spec, groups: previousReadings } })) {
        return csvAnalysisUnavailable('RESULT_CONFLICT')
      }
      // A corrected calculation can coexist with an immutable lock made by older arithmetic.
      const corrected = createHash('sha256').update(JSON.stringify([identity, spec.groups])).digest('hex')
      snapshot = { ...snapshot, artifactId: brandString<ArtifactId>(`continued-csv-${corrected.slice(0, 32)}`) }
      existing = this.ctx.artifacts.currentSnapshot(agent, snapshot.artifactId)
    }
    if (existing === undefined) this.ctx.artifacts.commit(agent, snapshot)
    else if (!isDeepStrictEqual(existing, snapshot)) return csvAnalysisUnavailable('RESULT_CONFLICT')
    await this.ctx.sessions.flush(agent.session)
    return { artifact: snapshot, groupKey }
  }

  private async observeReturnedExperiment(
    request: ArtifactBranchExportReturnedPlotRequest, kind: ContinuationKind,
  ): Promise<NativeArtifactQuestionReadings> {
    const notice = await this.observeReturnedNotice(request, kind)
    return resolveReturnedReadings(notice, request.eventSeq)?.readings ?? returnedExperimentUnavailable(kind)
  }

  private async observeReturnedNotice(
    request: ArtifactBranchExportReturnedPlotRequest, kind: ReturnedExperimentKind,
  ): Promise<NonNullable<ReturnType<typeof returnedReadingNotice>>> {
    if (principalOf(this.ctx.invocation) !== undefined) return returnedExperimentUnavailable(kind)
    const eventSeq = evidenceEventSeq(request.eventSeq)
    const { sessionId, messageId } = request
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    using parent = await this.observeEvidenceSession(sessionId, signal)
    const event = parent.events[eventSeq]
    if (parent.header.origin === 'subagent' || eventSeq < parent.inheritedEventCount || event?.seq !== eventSeq) {
      return returnedExperimentUnavailable(kind)
    }
    const notice = returnedReadingNotice(event)
    if (notice?.messageId !== messageId) return returnedExperimentUnavailable(kind)
    signal.throwIfAborted()
    return notice
  }

  private async observeEvidenceSession(sessionId: SessionId, signal: AbortSignal): Promise<SessionObservation> {
    try {
      return await this.ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none', signal })
    } catch (error) {
      if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
    }
  }

  private async observeSentNativeQuestion(request: ArtifactBranchExportReturnedPlotRequest, kind: ContinuationKind) {
    if (principalOf(this.ctx.invocation) !== undefined) return sentExperimentUnavailable(kind)
    const { sessionId, messageId } = request
    const eventSeq = evidenceEventSeq(request.eventSeq)
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    using session = await this.observeEvidenceSession(sessionId, signal)
    const readings = resolveSentNativeQuestion(session, eventSeq, messageId, kind)
    signal.throwIfAborted()
    return readings
  }

  private async observeSentHtmlQuestion(request: ArtifactBranchExportReturnedPlotRequest, kind: ArtifactHtmlCheckpointKind) {
    if (principalOf(this.ctx.invocation) !== undefined) return sentExperimentUnavailable(kind)
    const { sessionId, messageId } = request
    const eventSeq = evidenceEventSeq(request.eventSeq)
    const signal = this.ctx.invocation?.signal ?? new AbortController().signal
    using session = await this.observeEvidenceSession(sessionId, signal)
    const evidence = resolveSentHtmlQuestion(session, eventSeq, messageId, kind)
    signal.throwIfAborted()
    return evidence ?? sentExperimentUnavailable(kind)
  }

  private async continueExperiment(
    request: ArtifactBranchContinuePlotRequest, kind: ContinuationKind,
  ): Promise<ArtifactBranchContinuePlotValue> {
    let eventSeq: ReturnType<typeof SessionSeq>
    try { eventSeq = SessionSeq(request.eventSeq) } catch {
      throw new RemoteError('gateway/bad-request', 'eventSeq must be a non-negative safe integer', {})
    }
    if (!CONTINUATION_ID.test(request.requestId)) throw new RemoteError('gateway/bad-request', 'requestId must be a UUID', {})
    const identity = createHash('sha256').update(JSON.stringify([request.sessionId, request.requestId.toLowerCase()])).digest('hex')
    const childId = SessionId(`session-${identity.slice(0, 32)}`)
    const label = kind === 'function-plot' ? 'plot' : 'particle'
    const artifactId = brandString<ArtifactId>(`continued-${label}-${identity.slice(0, 32)}`)
    const pending = this.continuing.get(childId)
    if (pending !== undefined) {
      if (pending.kind !== kind || pending.eventSeq !== eventSeq || pending.messageId !== request.messageId) {
        return continuationConflict(request)
      }
      return pending.result
    }
    const result = this.forkExperiment(request, kind, eventSeq, childId, artifactId)
    this.continuing.set(childId, { kind, eventSeq, messageId: request.messageId, result })
    try {
      return await result
    } finally {
      this.continuing.delete(childId)
    }
  }

  private async forkExperiment(request: ArtifactBranchContinuePlotRequest, kind: ContinuationKind, eventSeq: ReturnType<typeof SessionSeq>,
    childId: SessionId, artifactId: ArtifactId): Promise<ArtifactBranchContinuePlotValue> {
    let observed: SessionObservation
    try {
      observed = await this.ctx.sessionQuery.observeSession(request.sessionId)
    } catch (error) {
      if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      throw new RemoteError('session/not-found', `session "${request.sessionId}" not found`, { sessionId: request.sessionId })
    }
    using source = observed
    const event = source.events[eventSeq]
    if (source.header.origin === 'subagent' || event?.seq !== eventSeq) return unavailableExperiment(kind)
    const notice = returnedReadingNotice(event)
    if (notice?.messageId !== request.messageId) return unavailableExperiment(kind)
    const readings = resolveReturnedReadings(notice, eventSeq)?.readings
    const snapshot = readings === undefined ? undefined : continuationSnapshot(kind, readings, request, eventSeq, artifactId)
    if (snapshot === undefined) return unavailableExperiment(kind)
    await this.ctx.sessionController.forkObserved(source, eventSeq, {
      childId,
      initialise: (agent) => { this.ctx.artifacts.commit(agent, snapshot) },
      verifyExisting: (child) => {
        if (child.header.parentSession !== source.header.id || child.inheritedEventCount !== eventSeq + 1
          || !child.events.slice(child.inheritedEventCount).some(item => item.type === 'artifact/upsert'
            && item.data.artifactId === artifactId && item.data.revision === 1 && isDeepStrictEqual(item.data, snapshot))) {
          continuationConflict(request)
        }
      },
    })
    return { sessionId: childId, artifactId }
  }

  /**
   * Return one child-owned conclusion with evidence selected by the user, without starting a model turn.
   * @param request - Direct parent, child-owned conclusion and a branch-visible evidence reference.
   * @returns Parent-local event and message ids after the durability checkpoint; identical retries reuse the receipt.
   * @throws {RemoteError} For invalid lineage, unavailable evidence, oversized content, a busy parent or different earlier content.
   * Other failures preserve an unknown outcome after append; retry the identical request to recover its receipt.
   */
  @Remote({ resources: { session: (request: ArtifactBranchResultRequest) => [request.sessionId, request.branchSessionId] } })
  async returnResult(request: ArtifactBranchResultRequest): Promise<SessionBranchResultValue> {
    let resultSeq: ReturnType<typeof SessionSeq>
    try { resultSeq = SessionSeq(request.resultSeq) } catch {
      throw new RemoteError('gateway/bad-request', 'resultSeq must be a non-negative safe integer', {})
    }
    let observed: SessionObservation
    const evidence = request.evidence
    try {
      observed = await this.ctx.sessionQuery.observeSession(request.branchSessionId, evidence.kind === 'question' ? { projectionMode: 'none' } : undefined)
    } catch (error) {
      if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      throw new RemoteError('session/not-found', `session "${request.branchSessionId}" not found`, { sessionId: request.branchSessionId })
    }
    const selected = (() => {
      using child = observed
      const selection = selectBranchResult(child, request.sessionId, resultSeq)
      if (!selection.ok) {
        throw new RemoteError('session/branch-result-unavailable', `branch result is unavailable: ${selection.reason}`, {
          parentSessionId: request.sessionId, branchSessionId: request.branchSessionId, resultSeq, reason: selection.reason,
        })
      }
      const block = (facts: object, prefix: string) => ({ type: 'text' as const,
        text: prefix + JSON.stringify({ kind: 'branch-result-artifact-evidence', branchSessionId: request.branchSessionId, evidence: facts }),
      })
      if (evidence.kind === 'question') {
        const facts = resolveQuestionEvidence(child, resultSeq, evidence)
        if (facts === undefined) {
          throw new RemoteError('artifact-branch/evidence-unavailable', 'Artifact evidence is unavailable for the selected branch question', {
            reason: 'QUESTION_EVIDENCE_UNAVAILABLE',
          })
        }
        const prefix = 'The user selected the following Artifact readings from a branch question to accompany this conclusion. '
          + 'This does not state that the assistant used them when producing the conclusion.\n'
        const result = selection.value
        return {
          selection: facts.facts.kind === 'html-runtime'
            ? { ...result, reference: { ...result.reference, artifactEvidence: facts.facts.capture.restore } }
            : result,
          evidence: block(facts, prefix),
        }
      }
      const observations = child.projections?.values.artifactObservations
      if (observations === undefined) {
        throw new RemoteError('artifact-branch/evidence-unavailable', 'Artifact observations are unavailable for this branch', {
          reason: 'PROJECTION_UNAVAILABLE',
        })
      }
      const prefix = 'The user selected the following saved Artifact evidence to accompany this conclusion. '
        + 'This does not state that the assistant used it when producing the conclusion.\n'
      return { selection: selection.value, evidence: block(savedEvidenceFacts(observations, evidence), prefix) }
    })()
    const resolved = await this.ctx.sessionController.resolveAgent(request.sessionId)
    if ('error' in resolved) throw resolved.error
    const parent = resolved.agent
    try {
      const receipt = await admitBranchResult(parent, selected.selection, {
        observeParent: signal => this.ctx.sessionQuery.observeSession(parent.id, { projectionMode: 'none', signal }),
        flushParent: () => this.ctx.sessions.flush(parent.session),
        validateMessage: (message) => {
          if (Buffer.byteLength(JSON.stringify(message), 'utf8') > this.maxActionBytes) {
            throw new RemoteError('artifact-branch/result-too-large', 'The complete conclusion and evidence exceed the return limit', {
              limit: this.maxActionBytes,
            })
          }
        },
      }, [selected.evidence])
      return { parentSessionId: parent.id, ...receipt }
    } catch (error) {
      if (error instanceof BranchResultAdmissionBusy) {
        throw new RemoteError('session/agent-busy', error.message, { reason: 'branch-result-parent-busy' }, { cause: error })
      }
      if (error instanceof BranchResultAdmissionConflict) {
        throw new RemoteError('session/branch-result-conflict', error.message, {
          parentSessionId: request.sessionId, branchSessionId: request.branchSessionId, resultSeq,
        }, { cause: error })
      }
      throw error
    }
  }
}

export default ArtifactBranchResults
