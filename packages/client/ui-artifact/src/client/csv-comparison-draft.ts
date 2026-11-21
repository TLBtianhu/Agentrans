/** Session-local presentation and synchronization of one Host-owned comparison draft. */
import type { ArtifactCsvComparisonAttachment, ArtifactCsvComparisonDraft } from '@agentrans/artifact-followup/types'
import { createSnapshotStore } from '@agentrans/client-store'
import type { SessionRequestId } from '@agentrans/api-session-controller/types'
import type { MessageId } from '@agentrans/llm/brand'
import type { SessionId } from '@agentrans/session/types'
import type { TokenSpan } from '@agentrans/client-ui-conversation/client'
import { deepEqualJson, deepFreeze, snapshotJsonValue } from '@agentrans/util-values'

/** Operations scoped to one retained Session. */
export interface CsvComparisonDraftCommands {
  readonly read: () => Promise<ArtifactCsvComparisonDraft | null>
  readonly reconcile?: (expectedRequestId?: SessionRequestId) => Promise<CsvComparisonRecovery>
  readonly check?: (requestId: SessionRequestId) => Promise<CsvComparisonDraftCheck>
  readonly save: (attachment: ArtifactCsvComparisonAttachment, expectedReceiptId: string | null) => Promise<ArtifactCsvComparisonDraft>
  readonly clear: (receiptId: string, requestId?: SessionRequestId) => Promise<boolean>
}

/** Observable state of synchronizing a comparison with the Host. */
export type CsvComparisonDraftPhase = 'idle' | 'restoring' | 'awaiting-confirmation' | 'saving' | 'clearing' | 'ready'
  | 'restore-failed' | 'clear-failed'

/** The verified result of the previous question, after the composer had to wait. */
export interface CsvSentQuestion {
  readonly eventSeq: number
  readonly messageId: MessageId
}

/** One page of a two-step explanation: the aggregation change or the filter change. */
export type CsvExplanationStep = 'aggregation' | 'filtering'
/** Imported evidence carried by a source message whose pages open from history. */
export type CsvComparisonSourceKind = 'imported-explanation' | 'imported-return-comparison'

/** Which side of a confirmed comparison opened an original returned reading. */
export type CsvReturnComparisonSide = 'first' | 'second'

type CsvDraftSourceDeparture = {
  readonly kind: 'draft'
  readonly receiptId: string
  readonly selection: TokenSpan
  readonly digest?: string
}

/** A sent comparison or draft side that opens an original returned reading. */
export type CsvReturnedSourceOrigin =
  | { readonly kind: 'returned-comparison'; readonly message: CsvSentQuestion; readonly side: CsvReturnComparisonSide }
  | (CsvDraftSourceDeparture & { readonly returnSide: CsvReturnComparisonSide; readonly step?: never })

/** One open source visit and the place from which it was opened. */
export type CsvComparisonSourceOrigin = (CsvDraftSourceDeparture & { readonly step?: CsvExplanationStep; readonly returnSide?: never })
  | { readonly kind: 'comparison'; readonly message: CsvSentQuestion }
  | { readonly kind: 'explanation'; readonly message: CsvSentQuestion; readonly step: CsvExplanationStep }
  | CsvReturnedSourceOrigin

/**
 * Distinguish a departure to an original returned reading from other source visits.
 * @param origin - Recorded departure.
 * @returns Whether the destination is an original returned reading.
 */
export function isCsvReturnedSourceOrigin(origin: CsvComparisonSourceOrigin): origin is CsvReturnedSourceOrigin {
  return origin.kind === 'returned-comparison' || (origin.kind === 'draft' && origin.returnSide !== undefined)
}

/**
 * Read which comparison side opened an original returned reading.
 * @param origin - Departure to an original returned reading.
 * @returns Its selected comparison side.
 */
export function csvReturnedSourceSide(origin: CsvReturnedSourceOrigin): CsvReturnComparisonSide {
  return origin.kind === 'draft' ? origin.returnSide : origin.side
}

/** Exact source message and the view that opened it. */
export interface CsvComparisonSourceVisit {
  readonly source: CsvSentQuestion
  readonly origin: CsvComparisonSourceOrigin
  readonly sourceKind?: CsvComparisonSourceKind
}

/** Consecutive visits from the original departure to the currently open source. */
export type CsvComparisonSourceTrail = readonly [CsvComparisonSourceVisit, ...CsvComparisonSourceVisit[]]

/** The existing receipt status and, when present, an exact durable transcript target. */
export type CsvComparisonDraftCheck = { readonly status: 'pending' | 'unconfirmed' }
  | { readonly status: 'accepted'; readonly message?: CsvSentQuestion; readonly queuedMessageId?: MessageId }

/** Feedback for the previous question: accepted with its durable target, or not confirmed. */
export type CsvComparisonDraftOutcome = Extract<CsvComparisonDraftCheck, { status: 'accepted' }>
  | { readonly status: 'unconfirmed' }

/** Recovery of an exact browser marker, when one exists. */
export type CsvComparisonRecovery = { readonly status: 'untracked' } | (CsvComparisonDraftCheck & { readonly requestId: SessionRequestId })

const CONFIRMATION_POLL_INTERVAL = 1_000
const CONFIRMATION_POLL_MAX_INTERVAL = 4_000
const QUEUED_QUESTION_POLL_LIMIT = 15

/** Synchronize exact receipts and keep out-of-order reads/acceptances from replacing the current choice. */
export class CsvComparisonDraftOwner {
  /** Current synchronization phase with the Host. */
  readonly phase = createSnapshotStore<CsvComparisonDraftPhase>('idle')
  /** Whether deleting an accepted receipt failed and awaits `retryCleanup`. */
  readonly cleanupFailed = createSnapshotStore(false)
  /** Feedback for the previous question, cleared when the user submits another. */
  readonly outcome = createSnapshotStore<CsvComparisonDraftOutcome | undefined>(undefined)
  /** Accepted message selected by the composer shortcut, offering a return to the draft. */
  readonly returnToDraftTarget = createSnapshotStore<CsvSentQuestion | undefined>(undefined)
  private active: ArtifactCsvComparisonDraft | null = null
  private awaitingRequest: SessionRequestId | undefined
  private queuedRequest: SessionRequestId | undefined
  private checkingQueued = false
  private queuedChecks = 0
  private operation: Promise<unknown> | undefined
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private pollInterval = CONFIRMATION_POLL_INTERVAL
  private pollingAllowed = false
  private readonly accepted = new Set<string>()
  private readonly pendingCleanup = new Map<string, SessionRequestId>()
  private disposed = false

  constructor(private readonly sessionId: SessionId, private readonly commands: CsvComparisonDraftCommands,
    private readonly publish: (draft: ArtifactCsvComparisonDraft | null, explicit: boolean) => void) {}

  /** Whether a read, save, removal or pending confirmation must finish before the composer submits. */
  get blocksSubmission(): boolean {
    const phase = this.phase.getSnapshot()
    return phase !== 'idle' && phase !== 'ready'
  }

  /** Start on successful read-access resolution. Calling again while active is harmless. */
  restore(): void {
    const phase = this.phase.getSnapshot()
    if (this.operation !== undefined || this.disposed || phase === 'ready') return
    if (phase === 'awaiting-confirmation') { this.scheduleConfirmationCheck(); return }
    if (this.phase.getSnapshot() === 'clear-failed') { void this.remove(); return }
    void this.run('restoring', async () => await this.read())
  }

  /**
   * Bound polling to the life of the retained Session route and its read access.
   * @param allowed - Whether the route currently retains the Session with read access.
   */
  allowConfirmationPolling(allowed: boolean): void {
    this.pollingAllowed = allowed
    if (allowed) this.scheduleConfirmationCheck()
    else {
      this.cancelConfirmationCheck()
      this.returnToDraftTarget.set(undefined)
    }
  }

  /**
   * Save only a deliberately confirmed review against the receipt currently present.
   * @param attachment - Reviewed attachment for this owner's Session.
   * @returns Whether the Host draft now holds this attachment.
   */
  async save(attachment: ArtifactCsvComparisonAttachment): Promise<boolean> {
    if (this.disposed || attachment.facts.sessionId !== this.sessionId || this.operation !== undefined) return false
    if (this.phase.getSnapshot() !== 'ready') { this.restore(); return false }
    this.clearOutcome()
    return await this.run('saving', async () => {
      try {
        const expectedReceiptId = this.active?.receiptId ?? null
        const draft = this.detach(await this.commands.save(attachment, expectedReceiptId))
        if (this.accepted.has(draft.receiptId)) {
          await this.read()
          return false
        }
        this.update(draft, true)
        this.settle('ready')
        return true
      } catch (_error) {
        // A lost response may have committed the draft. Read the authoritative receipt before sending anything.
        const restored = await this.read()
        if (!restored || this.active === null || !deepEqualJson(this.active.facts, attachment.facts)) return false
        this.publish(this.active, true)
        return true
      }
    })
  }

  /**
   * Remove the exact active receipt. A conflicting newer draft is adopted only after rereading the Host.
   * @param receiptId - Receipt to delete; defaults to the active draft's receipt.
   */
  async remove(receiptId = this.active?.receiptId): Promise<void> {
    if (receiptId === undefined || this.disposed || this.operation !== undefined
      || this.phase.getSnapshot() === 'awaiting-confirmation') return
    this.clearOutcome()
    await this.run('clearing', async () => {
      try {
        const cleared = await this.commands.clear(receiptId)
        if (cleared || this.active?.receiptId !== receiptId) {
          if (this.active?.receiptId === receiptId) this.update(null)
          this.settle('ready')
        } else await this.read()
      } catch (_error) { this.settle(this.active?.receiptId === receiptId ? 'clear-failed' : 'ready') }
    })
  }

  /**
   * Respond to admission of the captured receipt, leaving any newer local selection alone.
   * @param receiptId - Receipt captured when the question was sent.
   * @param requestId - Client request ID of the admitted prompt.
   */
  accept(receiptId: string, requestId: SessionRequestId): void {
    if (this.disposed) return
    this.accepted.add(receiptId)
    if (this.active?.receiptId === receiptId) this.update(null)
    void this.clearAccepted(receiptId, requestId)
  }

  /** Retry deleting every accepted receipt whose earlier deletion failed. */
  retryCleanup(): void {
    for (const [receiptId, requestId] of this.pendingCleanup) void this.clearAccepted(receiptId, requestId)
  }

  /** End the prior question's feedback when the user deliberately submits another. */
  clearOutcome(): void {
    this.queuedRequest = undefined
    if (this.phase.getSnapshot() !== 'awaiting-confirmation') this.cancelConfirmationCheck()
    this.outcome.set(undefined)
    this.returnToDraftTarget.set(undefined)
  }

  /**
   * Retain only the accepted message selected by the composer shortcut.
   * @param target - Durable message the user opened.
   * @returns Whether it matches the accepted outcome and became the return target.
   */
  selectSentQuestion(target: CsvSentQuestion): boolean {
    const outcome = this.outcome.getSnapshot()
    if (this.disposed || outcome?.status !== 'accepted' || !sameCsvSentQuestion(outcome.message, target)) return false
    this.returnToDraftTarget.set(target)
    return true
  }

  /**
   * Consume the return action only for the same durable question.
   * @param target - Durable message whose return action was used.
   */
  clearReturnToDraft(target: CsvSentQuestion): void {
    if (sameCsvSentQuestion(this.returnToDraftTarget.getSnapshot(), target)) this.returnToDraftTarget.set(undefined)
  }

  /**
   * Restart exact lookup when the queued question's own Chat event is observed after the bounded checks.
   * @param messageId - Message ID of the observed Chat event.
   */
  observeSentQuestion(messageId: MessageId): void {
    const outcome = this.outcome.getSnapshot()
    if (outcome?.status !== 'accepted' || outcome.message !== undefined || outcome.queuedMessageId !== messageId
      || this.queuedRequest === undefined) return
    this.queuedChecks = 0
    this.scheduleConfirmationCheck()
  }

  /** Stop polling, clear the return target and ignore later Host responses. */
  dispose(): void {
    this.disposed = true
    this.returnToDraftTarget.set(undefined)
    this.cancelConfirmationCheck()
  }

  private async read(): Promise<boolean> {
    try {
      const draft = await this.commands.read()
      if (this.disposed) return false
      const expected = this.awaitingRequest ?? draft?.pendingRequestId
      if (this.awaitingRequest === undefined && draft?.pendingRequestId !== undefined) this.awaitConfirmation(draft.pendingRequestId)
      this.updateFromRead(draft)
      const recovery = await this.commands.reconcile?.(expected)
      const check = recovery?.status === 'untracked' || recovery === undefined
        ? expected === undefined ? undefined : await this.commands.check?.(expected)
        : recovery
      const status = check?.status
      const latest = status === 'accepted' && draft !== null ? await this.commands.read() : draft
      if (latest !== draft) this.updateFromRead(latest)
      const pending = (recovery?.status === 'pending' ? recovery.requestId : undefined)
        ?? (status === 'pending' ? expected : undefined) ?? latest?.pendingRequestId
      if (pending !== undefined) {
        this.awaitConfirmation(pending)
        return false
      }
      const resolved = recovery !== undefined && recovery.status !== 'untracked' ? recovery.requestId : expected
      if (resolved !== undefined && resolved === this.awaitingRequest && check !== undefined) {
        if (check.status === 'accepted') this.publishOutcome(check, resolved)
        if (check.status === 'unconfirmed') this.publishOutcome({ status: 'unconfirmed' }, resolved)
      }
      this.awaitingRequest = undefined
      this.settle('ready')
      return !this.disposed
    } catch (_error) {
      if (this.phase.getSnapshot() !== 'awaiting-confirmation') this.settle('restore-failed')
      return false
    }
  }

  private awaitConfirmation(requestId: SessionRequestId): void {
    this.awaitingRequest = requestId
    this.clearOutcome()
    this.settle('awaiting-confirmation')
  }

  private publishOutcome(outcome: CsvComparisonDraftOutcome, requestId: SessionRequestId): void {
    if (this.disposed) return
    const queued = outcome.status === 'accepted' && outcome.message === undefined && outcome.queuedMessageId !== undefined
      ? requestId : undefined
    if (this.queuedRequest !== queued) this.queuedChecks = 0
    this.queuedRequest = queued
    const next = outcome.status === 'accepted' ? { status: outcome.status,
      ...(outcome.message === undefined ? {} : { message: outcome.message }),
      ...(outcome.queuedMessageId === undefined ? {} : { queuedMessageId: outcome.queuedMessageId }),
    } : outcome
    if (!deepEqualJson(this.outcome.getSnapshot(), next)) {
      if (!sameCsvSentQuestion(outcome.status === 'accepted' ? outcome.message : undefined, this.returnToDraftTarget.getSnapshot())) {
        this.returnToDraftTarget.set(undefined)
      }
      this.outcome.set(next)
    }
  }

  private async checkQueuedQuestion(requestId: SessionRequestId): Promise<void> {
    this.checkingQueued = true
    this.queuedChecks++
    try {
      const result = await this.commands.check?.(requestId)
      if (requestId !== this.queuedRequest || !this.pollingAllowed) return
      if (result?.status === 'accepted') this.publishOutcome(result, requestId)
      if (result?.status === 'unconfirmed') this.queuedRequest = undefined
    } catch (_error) { /* Retain the known accepted result and recheck the same queued request. */ }
    finally { this.checkingQueued = false; this.scheduleConfirmationCheck() }
  }

  private updateFromRead(draft: ArtifactCsvComparisonDraft | null): void {
    if (draft === null) this.update(null)
    else if (!this.accepted.has(draft.receiptId)) this.update(this.detach(draft))
  }

  private scheduleConfirmationCheck(): void {
    const waiting = this.phase.getSnapshot() === 'awaiting-confirmation'
    const queued = this.queuedRequest
    if (!this.pollingAllowed || this.disposed || this.operation !== undefined || this.pollTimer !== undefined
      || !waiting && (queued === undefined || this.checkingQueued || this.queuedChecks >= QUEUED_QUESTION_POLL_LIMIT
        || this.commands.check === undefined)) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined
      this.pollInterval = Math.min(this.pollInterval * 2, CONFIRMATION_POLL_MAX_INTERVAL)
      if (waiting) void this.run('awaiting-confirmation', async () => await this.read())
      else if (queued !== undefined) void this.checkQueuedQuestion(queued)
    }, this.pollInterval)
  }

  private cancelConfirmationCheck(): void {
    clearTimeout(this.pollTimer)
    this.pollTimer = undefined
    this.pollInterval = CONFIRMATION_POLL_INTERVAL
  }

  private detach(draft: ArtifactCsvComparisonDraft): ArtifactCsvComparisonDraft {
    const detached = snapshotJsonValue(draft)
    if (detached === undefined || detached.facts.sessionId !== this.sessionId) throw new Error('Invalid CSV comparison draft')
    return deepFreeze(detached)
  }

  private update(draft: ArtifactCsvComparisonDraft | null, explicit = false): void {
    if (this.disposed) return
    this.active = draft
    this.publish(draft, explicit)
  }

  private async clearAccepted(receiptId: string, requestId: SessionRequestId): Promise<void> {
    this.pendingCleanup.delete(receiptId)
    try {
      await this.commands.clear(receiptId, requestId)
      const inFlight = this.operation
      if (inFlight !== undefined) await inFlight
      this.accepted.delete(receiptId)
    } catch (_error) { this.pendingCleanup.set(receiptId, requestId) }
    if (!this.disposed) this.cleanupFailed.set(this.pendingCleanup.size > 0)
  }

  private settle(phase: CsvComparisonDraftPhase): void {
    if (!this.disposed) this.phase.set(phase)
    if (phase !== 'awaiting-confirmation' && this.queuedRequest === undefined) this.cancelConfirmationCheck()
  }

  private run<T>(phase: CsvComparisonDraftPhase, task: () => Promise<T>): Promise<T> {
    const operation = Promise.resolve().then(task).finally(() => {
      if (this.operation !== operation) return
      this.operation = undefined
      this.scheduleConfirmationCheck()
    })
    this.operation = operation
    this.phase.set(phase)
    return operation
  }
}

/**
 * Compare both parts of the durable chat message identity.
 * @param left - First message identity, if any.
 * @param right - Second message identity, if any.
 * @returns Whether both are present with equal event sequence and message ID.
 */
export function sameCsvSentQuestion(left: CsvSentQuestion | undefined, right: CsvSentQuestion | undefined): boolean {
  return left !== undefined && right !== undefined && left.eventSeq === right.eventSeq && left.messageId === right.messageId
}

/**
 * Address the comparison disclosure on an exact Chat history message.
 * @param target - Durable message carrying the comparison.
 * @param step - Explanation page to expand inside the comparison disclosure, if any.
 * @returns JSON focus request naming the message and the control to open.
 */
export function csvSentQuestionFocus(target: CsvSentQuestion, step?: CsvExplanationStep): string {
  const focus = { kind: 'message', eventSeq: target.eventSeq, messageId: target.messageId }
  const disclosure = 'artifact-csv-comparison'
  return JSON.stringify(step === undefined ? { ...focus, control: disclosure }
    : { ...focus, control: `artifact-csv-explanation-${step}`, expandControl: disclosure })
}
