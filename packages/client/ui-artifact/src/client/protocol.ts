/** Client-local Artifact protocol types and the generated-Remote adapter. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  ArtifactId, ArtifactSnapshot, ArtifactObservationId, SavedParticleObservation, SavedParticleObservationRef, ArtifactActionRequest,
} from '@deepseek-ai/dsh-artifact/types'
import type { ParticleCheckpoint } from '@deepseek-ai/dsh-artifact/particle-runtime'
import type { RemoteErrorCode, RemoteErrorDetailsMap } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ArtifactBranchResultRequest } from '@deepseek-ai/dsh-artifact-branch/types'
import type { SessionBranchResultValue } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ArtifactExportId, ArtifactHtmlExportRecord, ArtifactHtmlExportRequest } from '@deepseek-ai/dsh-artifact-export/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ArtifactParticleRuntime } from './particle-runtime-owner.ts'
import type { ParticleRunCommand } from './particle-run.ts'
import type { ArtifactRuntimeIdentity } from '@deepseek-ai/dsh-artifact-runtime/types'
import type { ArtifactRuntimeActions, ArtifactRuntimeSnapshot } from './runtime-owner.ts'
import type { FileSaveResult } from '@deepseek-ai/dsh-client-ui-file-actions/client'

/** Semantic placement requested by the user or Agent; the host owns the actual layout. */
export type ArtifactPlacement = 'inline' | 'beside' | 'focus' | 'pip'

/** ViewRequest is an intent, never an arbitrary window-control authority. */
export interface ViewRequest {
  readonly placement: ArtifactPlacement
}

/** JSON value accepted in an Artifact action message. */
export type ArtifactPayload = JsonValue
export type { ArtifactId, ArtifactSnapshot }

/** A pair of independent Artifact snapshots sharing one comparison group. */
export interface ArtifactComparisonSnapshot {
  readonly group: string
  readonly control?: ArtifactSnapshot
  readonly variant?: ArtifactSnapshot
}

/** Host-to-Artifact commands synchronize behavior without changing parameters. */
export type ArtifactCommand = 'play' | 'pause' | 'step' | 'reset'
/** Narrow callback supplied to the keyed renderer; wake is explicit at every call site. */
export type RecordArtifactAction = (
  artifactId: ArtifactId,
  revision: number,
  action: string,
  payload: ArtifactPayload,
  wake: boolean,
  requestId?: ArtifactActionRequest['requestId'],
) => Promise<void>

/** Recovery classification for a stable Artifact action submission. */
export type ArtifactActionFailure = 'invalid' | 'denied' | 'stale' | 'source-unavailable' | 'too-large' | 'conflict' | 'unavailable' | 'unknown'

/** A known refusal ends this attempt; unknown outcomes must retain the original identity and values. */
export class ArtifactActionRequestError extends Error {
  /** @param failure - Safe recovery classification. @param cause - Original transport or Host diagnostic. */
  constructor(readonly failure: ArtifactActionFailure, cause: Error) {
    super(cause.message, { cause })
    this.name = 'ArtifactActionRequestError'
  }
}

/** Save a named checkpoint without creating model input. */
export type SaveArtifactObservation = (
  artifactId: ArtifactId, revision: number, observationId: ArtifactObservationId, label: string, checkpoint: ParticleCheckpoint,
) => Promise<SavedParticleObservation>

/** Explicitly send an already saved observation as model input. */
export type SendArtifactObservation = (artifactId: ArtifactId, observationId: ArtifactObservationId, wake: boolean) => Promise<void>

/** Confirm an ordered pair of saved observations; the Host supplies and checks their values. */
export type ConfirmObservationComparison = (
  group: string, control: SavedParticleObservationRef, variant: SavedParticleObservationRef, wake: boolean,
) => Promise<void>

/** Adopt one branch conclusion with Host-resolved evidence, without waking the parent. */
export type ReturnArtifactBranchResult = (request: ArtifactBranchResultRequest) => Promise<SessionBranchResultValue>

/** Session-scoped fixed-input export generation and verified file transfer. */
export interface ArtifactExportCommands {
  readonly create: (request: ArtifactHtmlExportRequest) => Promise<ArtifactHtmlExportRecord>
  readonly download: (record: ArtifactHtmlExportRecord & { readonly status: 'ready' }) => Promise<FileSaveResult>
}

/** Known refusals end admission; unknown outcomes retain the original request identity. */
export type ArtifactExportRequestFailure = 'unknown' | 'limit' | 'source-unavailable' | 'conflict'
  | 'service-unavailable' | 'denied' | 'invalid' | 'input-too-large'

/** Structured export failure consumed by localized recovery controls. */
export class ArtifactExportRequestError extends Error {
  /** @param failure - Recovery action derived from a stable code. @param cause - Original diagnostic. */
  constructor(readonly failure: ArtifactExportRequestFailure, cause: Error) {
    super(cause.message, { cause })
    this.name = 'ArtifactExportRequestError'
  }
}

/** Recovery actions for an evidence-backed adoption request. */
export type ArtifactBranchReturnFailure =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'evidence-unavailable' }
  | { readonly kind: 'result-unavailable' }
  | { readonly kind: 'service-unavailable' }
  | { readonly kind: 'too-large'; readonly limit: number }
  | { readonly kind: 'busy' }
  | { readonly kind: 'unknown' }

/** Structured adoption failure; unknown outcomes retain the captured conclusion and evidence references. */
export class ArtifactBranchReturnError extends Error {
  /** @param code - Stable Remote code. @param failure - Localized recovery classification. @param cause - Original diagnostic. */
  constructor(readonly code: RemoteErrorCode, readonly failure: ArtifactBranchReturnFailure, cause: Error) {
    super(cause.message, { cause })
    this.name = 'ArtifactBranchReturnError'
  }
}

/** A comparison refusal guarantees that no new comparison input was admitted. */
export class ArtifactComparisonRequestError extends Error {
  /**
   * @param reason - Structured Host refusal; no diagnostic parsing is needed.
   * @param cause - Original Remote diagnostic.
   */
  constructor(readonly reason: RemoteErrorDetailsMap['artifact/comparison-rejected']['reason'], cause: Error) {
    super(cause.message, { cause })
    this.name = 'ArtifactComparisonRequestError'
  }
}

/** Save refusals with different recovery actions; unknown outcomes retain the request identity. */
export type ObservationSaveFailure =
  | { readonly kind: 'limit'; readonly limit: number }
  | { readonly kind: 'stale'; readonly currentRevision: number }
  | { readonly kind: 'unknown' }

/** Client-local save failure retaining the Remote's stable code and original diagnostic. */
export class ArtifactObservationSaveError extends Error {
  /**
   * @param code - The original Remote failure code.
   * @param failure - Localized recovery classification derived from that code and its typed details.
   * @param cause - Original Remote diagnostic; messages are never parsed for classification.
   */
  constructor(readonly code: RemoteErrorCode, readonly failure: ObservationSaveFailure, cause: Error) {
    super(cause.message, { cause })
    this.name = 'ArtifactObservationSaveError'
  }
}

/** Business face injected into one Session-scoped Artifact renderer. */
export interface ArtifactNodeInjected {
  readonly keyedHooks: {
    readonly particleRuntime: (key: string) => ObservableSnapshot<ArtifactParticleRuntime | undefined>
    readonly artifactRuntime: (key: string) => ObservableSnapshot<ArtifactRuntimeSnapshot | undefined>
  }
  readonly runtimeActions: ArtifactRuntimeActions
  readonly commandParticleRuntime: (key: string, command: ParticleRunCommand) => void
  readonly chooseRuntimePromptContext: (key: string, source: ArtifactSnapshot, identity: ArtifactRuntimeIdentity) => void
  readonly chooseParticlePromptContext: (key: string, source: ArtifactSnapshot) => void
  readonly chooseObservationPromptContext: (saved: SavedParticleObservation) => void
  readonly chooseComparisonPromptContext: (group: string, control: SavedParticleObservation, variant: SavedParticleObservation) => void
  readonly recordAction: RecordArtifactAction
  readonly saveObservation: SaveArtifactObservation
  readonly sendObservation: SendArtifactObservation
  readonly confirmObservationComparison: ConfirmObservationComparison
  readonly exports?: ArtifactExportCommands | undefined
}

/**
 * Admit one immutable HTML export through the Session Remote.
 * @param ctx - Client root carrying generated Artifact export Remotes.
 * @param sessionId - Session owning the selected source and output record.
 * @param request - Fixed identity and source conditions retained across retries.
 * @returns The latest durable generation state; transport failures may have committed.
 */
export async function createArtifactExport(
  ctx: ClientContext, sessionId: SessionId, request: ArtifactHtmlExportRequest,
): Promise<ArtifactHtmlExportRecord> {
  const result = await ctx.remote.artifactExports.create(sessionId, request)
  if (result.ok) return result.value
  const error = result.error
  let failure: ArtifactExportRequestFailure = 'unknown'
  if (error.code === 'artifact-export/limit') failure = 'limit'
  else if (error.code === 'artifact-export/input-too-large') failure = 'input-too-large'
  else if (error.code === 'artifact-export/source-unavailable') failure = 'source-unavailable'
  else if (error.code === 'artifact-export/request-conflict') failure = 'conflict'
  else if (error.code === 'remote-access/denied') failure = 'denied'
  else if (error.code === 'gateway/bad-request') failure = 'invalid'
  else if (error.code === 'gateway/invocation-unavailable' || error.code === 'gateway/service-unavailable'
    || error.code === 'gateway/definition-unavailable' || error.code === 'gateway/method-unavailable') failure = 'service-unavailable'
  throw new ArtifactExportRequestError(failure, error)
}

/**
 * Transfer a verified durable output through the platform's file-saving owner.
 * @param ctx - Client root carrying generated Remotes and fileActions.
 * @param sessionId - Session owning the export record.
 * @param record - File-ready record selected from the Session projection or create response.
 * @returns Browser download request, native completion, or native cancellation.
 */
export function downloadArtifactExport(
  ctx: ClientContext, sessionId: SessionId, record: ArtifactHtmlExportRecord & { readonly status: 'ready' },
): Promise<FileSaveResult> {
  const exportId: ArtifactExportId = record.request.exportId
  return ctx.fileActions.save({
    url: `artifact-export:${encodeURIComponent(sessionId)}/${encodeURIComponent(exportId)}`,
    name: record.file.name,
    mediaType: 'text/html',
    read: async (signal) => {
      signal.throwIfAborted()
      const result = await ctx.remote.artifactExports.read(sessionId, exportId)
      signal.throwIfAborted()
      if (!result.ok) throw result.error
      return new Blob([new Uint8Array(result.value)], { type: 'text/html' })
    },
  }, 'download')
}

/**
 * Record one confirmed action through the Session Remote.
 * @param ctx - Client root carrying the Artifact Remote namespace.
 * @param sessionId - Session whose Typert scope resolves the Host Agent.
 * @param artifactId - Artifact that emitted the action.
 * @param revision - Exact source revision that emitted the action.
 * @param action - Artifact-defined action name.
 * @param payload - Validated JSON payload.
 * @param wake - Whether the Host should wake the Agent.
 * @param requestId - Stable identity captured by the action owner before asynchronous work; absence is rejected.
 * @returns after Host admission; business and transport failures reject.
 */
export async function recordArtifactAction(
  ctx: ClientContext,
  sessionId: SessionId,
  artifactId: ArtifactId,
  revision: number,
  action: string,
  payload: ArtifactPayload,
  wake: boolean,
  requestId?: ArtifactActionRequest['requestId'],
): Promise<void> {
  if (requestId === undefined) {
    throw new ArtifactActionRequestError('invalid', new Error('Artifact action submission requires a captured request identity'))
  }
  const result = await ctx.remote.artifacts.submitAction(sessionId, { requestId, artifactId, revision, action, payload, wake })
  if (result.ok) return
  const error = result.error
  let failure: ArtifactActionFailure = 'unknown'
  if (error.code === 'artifact/action-conflict') failure = 'conflict'
  else if (error.code === 'artifact/action-unavailable') failure = 'unavailable'
  else if (error.code === 'artifact/action-rejected') {
    switch (error.details.reason) {
      case 'BAD_INPUT': failure = 'invalid'; break
      case 'CALLER_NOT_LIVE_ROOT':
      case 'CALLER_NOT_OWNER': failure = 'denied'; break
      case 'AGENT_REGISTRY_UNAVAILABLE': failure = 'unavailable'; break
      case 'ARTIFACT_NOT_FOUND': failure = 'source-unavailable'; break
      case 'STALE_REVISION': failure = 'stale'; break
      case 'ACTION_TOO_LARGE': failure = 'too-large'; break
    }
  } else if (error.code === 'remote-access/denied') failure = 'denied'
  else if (error.code === 'gateway/bad-request') failure = 'invalid'
  else if (error.code === 'gateway/invocation-unavailable' || error.code === 'gateway/service-unavailable'
    || error.code === 'gateway/definition-unavailable' || error.code === 'gateway/method-unavailable') failure = 'unavailable'
  throw new ArtifactActionRequestError(failure, error)
}

/**
 * Save a particle observation through the Session Remote without waking the Agent.
 * @param ctx - Client root carrying the Artifact Remote namespace.
 * @param sessionId - Session owning the source revision.
 * @param artifactId - Particle Artifact identity.
 * @param revision - Current source revision captured by the user.
 * @param observationId - Stable request identity retained for safe retries.
 * @param label - User name or localized default label.
 * @param checkpoint - Captured fixed step for this source revision.
 * @returns The Host-computed saved observation; failures reject.
 */
export async function saveArtifactObservation(
  ctx: ClientContext, sessionId: SessionId, artifactId: ArtifactId, revision: number,
  observationId: ArtifactObservationId, label: string, checkpoint: ParticleCheckpoint,
): Promise<SavedParticleObservation> {
  const result = await ctx.remote.artifacts.saveObservation(sessionId, artifactId, revision, observationId, label, checkpoint)
  if (!result.ok) {
    const error = result.error
    let failure: ObservationSaveFailure = { kind: 'unknown' }
    if (error.code === 'artifact/observation-limit') failure = { kind: 'limit', limit: error.details.limit }
    else if (error.code === 'artifact/stale-revision') failure = { kind: 'stale', currentRevision: error.details.currentRevision }
    throw new ArtifactObservationSaveError(error.code, failure, error)
  }
  return result.value
}

/**
 * Send an immutable saved observation, including one from an older source revision.
 * @param ctx - Client root carrying the Artifact Remote namespace.
 * @param sessionId - Session owning the saved observation.
 * @param artifactId - Artifact whose saved list supplies the observation.
 * @param observationId - Durable saved observation identity.
 * @param wake - Whether to wake the Agent after admission.
 * @returns After Host admission; business and transport failures reject.
 */
export async function sendArtifactObservation(
  ctx: ClientContext, sessionId: SessionId, artifactId: ArtifactId, observationId: ArtifactObservationId, wake: boolean,
): Promise<void> {
  const result = await ctx.remote.artifacts.sendObservation(sessionId, artifactId, observationId, wake)
  if (!result.ok) throw new Error(result.error.message)
}

/**
 * Confirm one saved pair through the Session Remote, without sending browser-derived values.
 * @param ctx - Client root carrying the generated Artifact Remote namespace.
 * @param sessionId - Session owning both observations.
 * @param group - Comparison group shown for review.
 * @param control - Immutable saved control reference.
 * @param variant - Immutable saved variant reference.
 * @param wake - Whether to wake the Agent after admission.
 * @returns After Host confirmation; an unknown outcome can retry the same ordered pair.
 */
export async function confirmArtifactObservationComparison(
  ctx: ClientContext, sessionId: SessionId, group: string,
  control: SavedParticleObservationRef, variant: SavedParticleObservationRef, wake: boolean,
): Promise<void> {
  const result = await ctx.remote.artifacts.confirmObservationComparison(sessionId, group, control, variant, wake)
  if (!result.ok) {
    if (result.error.code === 'artifact/comparison-rejected') throw new ArtifactComparisonRequestError(result.error.details.reason, result.error)
    throw result.error
  }
}

/**
 * Adopt one selected conclusion and immutable evidence through the optional Artifact branch Remote.
 * @param ctx - Client root carrying the generated Artifact branch namespace.
 * @param request - Parent, branch, durable conclusion sequence, and complete tagged evidence references.
 * @returns The new or existing parent-local receipt; this operation never requests a model turn.
 */
export async function returnArtifactBranchResult(
  ctx: ClientContext, request: ArtifactBranchResultRequest,
): Promise<SessionBranchResultValue> {
  const result = await ctx.remote.artifactBranchResults.returnResult(request)
  if (!result.ok) {
    const error = result.error
    let failure: ArtifactBranchReturnFailure = { kind: 'unknown' }
    if (error.code === 'session/branch-result-conflict') failure = { kind: 'conflict' }
    else if (error.code === 'artifact-branch/evidence-unavailable') failure = { kind: 'evidence-unavailable' }
    else if (error.code === 'artifact-branch/result-too-large') failure = { kind: 'too-large', limit: error.details.limit }
    else if (error.code === 'session/branch-result-unavailable' || error.code === 'session/not-found') failure = { kind: 'result-unavailable' }
    else if (error.code === 'session/agent-busy') failure = { kind: 'busy' }
    else if (error.code === 'gateway/invocation-unavailable' || error.code === 'gateway/service-unavailable'
      || error.code === 'gateway/definition-unavailable' || error.code === 'gateway/method-unavailable') failure = { kind: 'service-unavailable' }
    throw new ArtifactBranchReturnError(error.code, failure, error)
  }
  return result.value
}
