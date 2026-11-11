/** Shared, source-independent ownership of Session input receipts and in-flight admission. @module @agentrans/session-input */
import { Context, Service } from '@agentrans/cordis'
import type { Agent } from '@agentrans/agent'
import type {} from '@agentrans/agent'
import type { UserMessage } from '@agentrans/llm'
import type { SessionId } from '@agentrans/session'
import type { ProjectionHandle } from '@agentrans/session-projection'
import { deepEqualJson, deepFreeze, snapshotJsonValue } from '@agentrans/util-values'
import { acceptedMessageDigest, inputMessageDigest, inputReceiptProjection, type InputReceiptState } from './receipts.ts'
import type {
  SessionInputAdmissionFailure, SessionInputIdentity, SessionInputMode, SessionInputReceipt, SessionInputRequestId,
} from './types.ts'

export type * from './types.ts'

declare module '@agentrans/cordis' {
  interface Context {
    /** Shared accepted-input identities; callers retain their own source validation and delivery policy. */
    sessionInputs: SessionInputAdmission
  }
}

/** A refusal before admission, or an explicitly unconfirmed outcome after dispatch began. */
export class SessionInputAdmissionError extends Error {
  /**
   * @param code - Stable classification.
   * @param message - Description for the owning adapter.
   * @param options - Underlying failure, if any.
   */
  constructor(readonly code: SessionInputAdmissionFailure, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SessionInputAdmissionError'
  }
}

interface PendingAdmission {
  readonly input: unknown
  readonly promise: Promise<SessionInputReceipt>
}

/** Owns one replayable receipt index and one process-local admission lifetime for every consumer. */
export class SessionInputAdmission extends Service {
  static inject = ['sessionProjections']
  private receipts!: ProjectionHandle<InputReceiptState>
  private closing = false
  private readonly pending = new Map<SessionId, Map<string, PendingAdmission>>()

  /** @param ctx - Projection preparation and live Agent identity owners. */
  constructor(ctx: Context) {
    super(ctx, 'sessionInputs')
  }

  protected async [Service.init](): Promise<void> {
    this.receipts = await this.ctx.sessionProjections.register(inputReceiptProjection)
    this.ctx.effect(() => async () => {
      this.closing = true
      await Promise.allSettled([...this.pending.values()].flatMap(entries => [...entries.values()].map(entry => entry.promise)))
    }, 'Session input admission settlement')
  }

  /**
   * Reserve an input identity before any asynchronous preparation and join identical in-flight work.
   * This operation owns no Agent activation or business validation; the job supplies those policies.
   * @param sessionId - Target Session identity; RPC and message identities have separate namespaces.
   * @param identity - Stable Client identity for this admission attempt.
   * @param input - Complete JSON request, including first-attempt delivery choices.
   * @param job - Preparation and admission using only the detached frozen request.
   * @returns The shared admission receipt; failures release only the in-flight reservation.
   * @throws {SessionInputAdmissionError} For closing, invalid JSON or conflicting in-flight input.
   */
  async run<T>(sessionId: SessionId, identity: SessionInputIdentity, input: T,
    job: (frozenInput: T) => SessionInputReceipt | Promise<SessionInputReceipt>): Promise<SessionInputReceipt> {
    if (this.closing) throw new SessionInputAdmissionError('CLOSED', 'Session input admission is closing')
    const detached = snapshotJsonValue(input)
    if (detached === undefined) throw new SessionInputAdmissionError('INVALID_INPUT', 'Session input must contain lossless JSON')
    const frozen = deepFreeze(detached)
    const key = identity.kind === 'rpc' ? `rpc:${identity.requestId}` : `message:${identity.messageId}`
    const entries = this.pending.get(sessionId) ?? new Map<string, PendingAdmission>()
    const active = entries.get(key)
    if (active !== undefined) {
      if (!deepEqualJson(active.input, frozen)) throw new SessionInputAdmissionError('CONFLICT', 'Input identity already belongs to different input')
      return active.promise
    }
    const promise = Promise.resolve().then(() => job(frozen))
    entries.set(key, { input: frozen, promise })
    this.pending.set(sessionId, entries)
    try { return await promise } finally {
      entries.delete(key)
      if (entries.size === 0) this.pending.delete(sessionId)
    }
  }

  /**
   * Read the original ordinary-prompt acceptance before resolving optional context or attachments.
   * @param agent - Agent whose already-prepared own Session supplies the receipts.
   * @param requestId - Ordinary prompt identity; inherited aliases do not count.
   * @returns Whether the original input was accepted, even if its queue item was edited or canceled.
   */
  hasPromptReceipt(agent: Agent, requestId: SessionInputRequestId): boolean {
    return Object.hasOwn(this.receipts.stateOf(agent.session).accepted, requestId)
  }

  /**
   * Admit one already-identified message or return its original acceptance before current-source validation.
   * Delivery mode applies only once; a cold retry cannot change delivery or detect a mode-only difference.
   * @param agent - Exact live Agent; this method never resumes or activates another Agent.
   * @param message - Complete immutable source and content with the Client's stable message identity.
   * @param mode - First-admission delivery policy.
   * @param validateFirst - Domain checks executed only before the first admission, never on an accepted retry.
   * @returns Acceptance without replacing or re-enqueueing an accepted message.
   * @throws {SessionInputAdmissionError} For unavailable Agent, identity conflict, or unconfirmed dispatch effects.
   */
  admitMessage(agent: Agent, message: UserMessage, mode: SessionInputMode, validateFirst?: () => void): Promise<SessionInputReceipt> {
    return this.run(agent.id, { kind: 'message', messageId: message.id }, { message, mode }, (input) => {
      if (this.ctx.get('agents')?.get(agent.id) !== agent) {
        throw new SessionInputAdmissionError('AGENT_UNAVAILABLE', 'Session input requires the exact live Agent')
      }
      const fingerprint = inputMessageDigest(input.message)
      const accepted = acceptedMessageDigest(this.receipts.stateOf(agent.session), input.message.id)
      if (accepted !== undefined) {
        if (accepted !== fingerprint) {
          throw new SessionInputAdmissionError('CONFLICT', 'Accepted message identity already belongs to different content')
        }
        return { accepted: true }
      }
      validateFirst?.()
      try {
        if (input.mode === 'steer') agent.steer(input.message)
        else if (input.mode === 'queue') agent.followup(input.message)
        else agent.inject(input.message)
      } catch (error) {
        throw new SessionInputAdmissionError('UNKNOWN_OUTCOME', 'Unable to confirm Session input admission', { cause: error })
      }
      return { accepted: true }
    })
  }
}

export default SessionInputAdmission
