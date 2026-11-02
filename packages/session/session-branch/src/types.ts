/** Pure vocabulary for manually confirmed branch-result return. */

import type { MessageId, TextBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type {
  SessionEvent, SessionHeader, SessionId, SessionLogOffset, SessionSeq,
} from '@deepseek-ai/dsh-session/types'

/** Durable source reference carried by a confirmed branch-result user message. */
export interface BranchResultSource {
  readonly kind: 'branch-result'
  readonly branchSessionId: SessionId
  readonly resultSeq: SessionSeq
  readonly resultMessageId: MessageId
  readonly form: 'notice'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * User-confirmed conclusion reread from an ordinary manual branch. Readers
     * preserve the message and derive ordinary model history without the producer;
     * this kind supplies attribution only and grants no session, tool, or approval authority.
     * @persistenceAttribution
     */
    'branch-result': BranchResultSource
  }
}

/** Exact child-log facts needed to validate and select one branch result. */
export interface BranchLogObservation {
  readonly header: Pick<SessionHeader, 'id' | 'parentSession' | 'isSeeded' | 'origin'>
  readonly inheritedEventCount: SessionLogOffset
  readonly events: readonly SessionEvent[]
}

/** Why a child event cannot be returned to the requested parent. */
export type BranchResultSelectionFailure =
  | 'not-branch'
  | 'subagent'
  | 'wrong-parent'
  | 'inherited-result'
  | 'result-not-found'
  | 'empty-result'

/** One validated child-owned assistant conclusion and its durable reference. */
export interface BranchResultSelection {
  readonly reference: BranchResultSource
  /** Visible text blocks only; reasoning, tool calls, and other content never cross. */
  readonly content: readonly TextBlock[]
}

/** Selection either produces one confirmed result candidate or names its rejection. */
export type BranchResultSelectionResult =
  | { readonly ok: true; readonly value: BranchResultSelection }
  | { readonly ok: false; readonly reason: BranchResultSelectionFailure }

/** A newly constructed parent-local user message. */
export type BranchResultMessage = UserMessage & { readonly source: BranchResultSource }

/** Existing parent event that already carries the same branch-result reference. */
export interface ExistingBranchResult {
  readonly eventSeq: SessionSeq
  readonly messageId: MessageId
}
