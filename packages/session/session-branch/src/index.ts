/**
 * Pure manual-branch result selection, parent-message construction, and replay lookup.
 * @module @deepseek-ai/dsh-session-branch
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type {
  BranchLogObservation, BranchResultMessage, BranchResultSelectionResult,
  BranchResultSource, ExistingBranchResult,
} from './types.ts'

export type * from './types.ts'

/**
 * Validate direct ordinary-branch lineage and select visible text from one child-owned assistant message.
 * @param observation - immutable child Session cut.
 * @param parentSessionId - requested direct parent; ancestry beyond one hop is not accepted here.
 * @param resultSeq - exact child event sequence chosen by the user.
 * @returns the confirmed text and source reference, or a stable rejection reason.
 */
export function selectBranchResult(
  observation: BranchLogObservation,
  parentSessionId: SessionId,
  resultSeq: SessionSeq,
): BranchResultSelectionResult {
  const { header } = observation
  if (header.origin === 'subagent') return { ok: false, reason: 'subagent' }
  if (!header.isSeeded || header.parentSession === undefined) return { ok: false, reason: 'not-branch' }
  if (header.parentSession !== parentSessionId) return { ok: false, reason: 'wrong-parent' }
  if (resultSeq < observation.inheritedEventCount) return { ok: false, reason: 'inherited-result' }
  const event = observation.events[resultSeq]
  if (event?.seq !== resultSeq || event.type !== 'assistant/message') {
    return { ok: false, reason: 'result-not-found' }
  }
  const content = event.data.message.content.filter(block => block.type === 'text')
  if (content.every(block => block.text.trim() === '')) return { ok: false, reason: 'empty-result' }
  return {
    ok: true,
    value: {
      reference: {
        kind: 'branch-result',
        branchSessionId: header.id,
        resultSeq,
        resultMessageId: event.data.message.id,
        form: 'notice',
      },
      content,
    },
  }
}

/**
 * Construct the parent-local user message for one selected conclusion.
 * @param selection - successful result of {@link selectBranchResult}.
 * @returns a message with a fresh parent-local id and no copied child message identity.
 */
export function createBranchResultMessage(
  selection: Extract<BranchResultSelectionResult, { readonly ok: true }>['value'],
): BranchResultMessage {
  return createUserMessage({ content: selection.content, source: selection.reference })
}

function sameReference(left: BranchResultSource, right: BranchResultSource): boolean {
  return left.branchSessionId === right.branchSessionId
    && left.resultSeq === right.resultSeq
}

/**
 * Find an already-returned result anywhere in the current parent log, including inherited history.
 * @param events - immutable parent Session cut.
 * @param reference - child result identity whose `(parent, branch, resultSeq)` tuple must commit at most once.
 * @returns the existing parent-local event and message ids, or undefined before the first return.
 */
export function findBranchResult(
  events: readonly SessionEvent[],
  reference: BranchResultSource,
): ExistingBranchResult | undefined {
  for (const event of events) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'branch-result') continue
    if (sameReference(event.data.source, reference)) {
      return { eventSeq: event.seq, messageId: event.data.id }
    }
  }
  return undefined
}
