/** Host-only commit rules shared by plain and evidence-bearing branch-result consumers. */
import type { Agent } from '@agentrans/agent'
import type { TextBlock } from '@agentrans/llm'
import type { SessionEvent } from '@agentrans/session/types'
import { createBranchResultMessage, findBranchResult } from './index.ts'
import type { BranchResultMessage, BranchResultSelection, ExistingBranchResult } from './types.ts'

/** I/O capabilities bound by the caller to the exact parent Agent and Session. */
export interface BranchResultAdmissionCapabilities {
  /** Read one parent cut while its maintenance task holds the writer. */
  readonly observeParent: (signal: AbortSignal) => Promise<Disposable & { readonly events: readonly SessionEvent[] }>
  /** Complete the parent's durability checkpoint; a rejection preserves an unknown outcome. */
  readonly flushParent: () => Promise<unknown>
  /** Optional complete-message policy before a new append; omission adds no policy beyond Session validation. */
  readonly validateMessage?: (message: BranchResultMessage) => void
}

/** The parent already returned this conclusion with different user-confirmed content. */
export class BranchResultAdmissionConflict extends Error {
  /** Create a conflict for an already-returned conclusion with different content. */
  constructor() {
    super('This branch conclusion was already returned with different content')
    this.name = 'BranchResultAdmissionConflict'
  }
}

/** The parent rejected maintenance before the branch-result job started. */
export class BranchResultAdmissionBusy extends Error {
  /** @param cause - failure to acquire the idle parent's maintenance phase. */
  constructor(cause: unknown) {
    super('The parent branch is running; retry when it becomes idle.', { cause })
    this.name = 'BranchResultAdmissionBusy'
  }
}

/**
 * Append one confirmed branch conclusion, or acknowledge the identical earlier parent message.
 * @param parent - Agent whose maintenance phase serializes the parent-local append.
 * @param selection - Child-owned conclusion validated against this direct parent.
 * @param capabilities - Exact-parent observation and durability operations.
 * @param additionalContent - Host-built text appended to the conclusion; omission returns the conclusion alone.
 * @returns The existing or newly committed parent-local event and message ids after a flush.
 * @throws {BranchResultAdmissionBusy} Before the maintenance job starts; no message was appended.
 * @throws {BranchResultAdmissionConflict} When the same conclusion was returned with different content.
 * @throws Other errors unchanged, including flush failures after append; retry the identical selection and content.
 */
export async function admitBranchResult(
  parent: Pick<Agent, 'session' | 'runMaintenance'>,
  selection: BranchResultSelection,
  capabilities: BranchResultAdmissionCapabilities,
  additionalContent: readonly TextBlock[] = [],
): Promise<ExistingBranchResult> {
  const content = [...selection.content, ...additionalContent]
  const job = { started: false }
  try {
    return await parent.runMaintenance(async (signal) => {
      job.started = true
      using current = await capabilities.observeParent(signal)
      const existing = findBranchResult(current.events, selection.reference)
      if (existing !== undefined) {
        const event = current.events[existing.eventSeq]
        if (event?.type !== 'user/message' || event.data.content.length !== content.length
          || !event.data.content.every((block, index) => block.type === 'text' && block.text === content[index]?.text)) {
          throw new BranchResultAdmissionConflict()
        }
        await capabilities.flushParent()
        return existing
      }
      const message = createBranchResultMessage({ ...selection, content })
      capabilities.validateMessage?.(message)
      const event = parent.session.append('user/message', message, { surfaceOp: 'append' })
      await capabilities.flushParent()
      return { eventSeq: event.seq, messageId: event.data.id }
    })
  } catch (error) {
    if (!job.started) throw new BranchResultAdmissionBusy(error)
    throw error
  }
}
