/** Remote admission of a confirmed branch conclusion, shared by every branch-result endpoint. */
import type { Agent } from '@agentrans/agent'
import type { Context } from '@agentrans/cordis'
import type { TextBlock } from '@agentrans/llm'
import type { SessionId } from '@agentrans/session'
import { admitBranchResult, branchResultAdmissionRefusal, type BranchResultReturnIdentity } from '@agentrans/session-branch/admission'
import type { BranchResultMessage, BranchResultSelection } from '@agentrans/session-branch/types'
import type {} from '@agentrans/session-query'
import { RemoteError } from '@agentrans/typert-protocol'
import type { SessionBranchResultValue } from './types.ts'

/** Endpoint-specific additions to the shared admission. */
export interface RemoteBranchResultOptions {
  /** Complete-message policy before a new append. */
  readonly validateMessage?: (message: BranchResultMessage) => void
  /** Host-built text appended to the conclusion. */
  readonly additionalContent?: readonly TextBlock[]
}

/**
 * Append a confirmed branch conclusion to its idle parent, or acknowledge the identical earlier return.
 * A running parent and a conflicting earlier return are reported as `session/agent-busy` and
 * `session/branch-result-conflict`; other failures propagate unchanged.
 * @param ctx - Host context carrying Session query and persistence.
 * @param parent - Resolved parent Agent.
 * @param selection - Conclusion validated against this direct parent.
 * @param identity - Parent, branch, and result sequence the remote failure reports.
 * @param options - Endpoint-specific message policy and additional content.
 * @returns The parent-local event and message of the returned conclusion.
 */
export async function admitRemoteBranchResult(
  ctx: Context, parent: Agent, selection: BranchResultSelection,
  identity: BranchResultReturnIdentity<SessionId, number>, options: RemoteBranchResultOptions = {},
): Promise<SessionBranchResultValue> {
  try {
    const receipt = await admitBranchResult(parent, selection, {
      observeParent: signal => ctx.sessionQuery.observeSession(parent.id, { projectionMode: 'none', signal }),
      flushParent: () => ctx.sessions.flush(parent.session),
      ...options.validateMessage === undefined ? {} : { validateMessage: options.validateMessage },
    }, options.additionalContent)
    return { parentSessionId: parent.id, ...receipt }
  } catch (error) {
    const refusal = branchResultAdmissionRefusal(error, identity)
    if (refusal !== undefined) throw new RemoteError(refusal.code, refusal.message, refusal.details, { cause: error })
    throw error
  }
}
