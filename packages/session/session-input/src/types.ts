/** Stable identities and outcomes for Session input admission. @module @agentrans/session-input/types */
import type { Branded } from '@agentrans/brand'
import type { MessageId } from '@agentrans/llm'

/** Existing ordinary-prompt identity; the brand remains unchanged across its owner migration. */
export type SessionInputRequestId = Branded<'session-request-id'>

/** Ordinary RPC identities and already-identified messages occupy different namespaces. */
export type SessionInputIdentity =
  | { readonly kind: 'rpc'; readonly requestId: SessionInputRequestId }
  | { readonly kind: 'message'; readonly messageId: MessageId }

/** Delivery policy applied only when the input is first admitted. */
export type SessionInputMode = 'queue' | 'steer' | 'inject'

/** Acceptance describes inbox admission, not execution or a still-pending queue item. */
export interface SessionInputReceipt { readonly accepted: true }

/** Structured failures owned by admission rather than a caller's business validation. */
export type SessionInputAdmissionFailure = 'CLOSED' | 'INVALID_INPUT' | 'CONFLICT' | 'AGENT_UNAVAILABLE' | 'UNKNOWN_OUTCOME'
