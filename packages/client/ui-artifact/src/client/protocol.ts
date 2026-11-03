/** Client-local Artifact protocol types and the generated-Remote adapter. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ArtifactId, ArtifactSnapshot } from '@deepseek-ai/dsh-artifact/types'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

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
/** Host-to-Artifact command message with no parameter mutation. */
export interface ArtifactCommandMessage {
  readonly kind: 'artifact-command'
  readonly command: ArtifactCommand
}

/** Local-only state report from an Artifact; it never wakes the Agent by itself. */
export interface ArtifactStateMessage {
  readonly kind: 'artifact-state'
  readonly state: JsonValue
}

/** Narrow callback supplied to the keyed renderer; wake is explicit at every call site. */
export type RecordArtifactAction = (
  artifactId: ArtifactId,
  revision: number,
  action: string,
  payload: ArtifactPayload,
  wake: boolean,
) => Promise<void>

/** Business face injected into one Session-scoped Artifact renderer. */
export interface ArtifactNodeInjected {
  readonly recordAction: RecordArtifactAction
}

/** Local declaration while the Host Remote contribution is absent from the generated Client map. */
interface ArtifactRemote {
  readonly artifacts: {
    record(
      sessionId: SessionId,
      artifactId: ArtifactId,
      revision: number,
      action: string,
      payload: ArtifactPayload,
      wake: boolean,
    ): Promise<RemoteResult<unknown>>
  }
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
): Promise<void> {
  const remote = ctx.remote as ClientContext['remote'] & ArtifactRemote
  const result = await remote.artifacts.record(
    sessionId, artifactId, revision, action, payload, wake,
  )
  if (!result.ok) throw new Error(result.error.message)
}
