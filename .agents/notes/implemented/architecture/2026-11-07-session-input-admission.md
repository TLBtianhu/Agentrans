# Agent Note: One owner for accepted Session input

Status: implemented

English | [中文](2026-11-07-session-input-admission.zh.md)

## Problem

A Client can lose the response after an Agent accepts input. A fresh message id then repeats the action; re-reading a changed preview can also replace the original conditions. Prompt-specific receipts in the API controller cannot be reused by a domain without either a reverse dependency or a second acceptance index.

## Decision

[Session input](../../../../packages/session/session-input/README.md) owns the existing private receipt Projection and one in-flight admission map. Session Controller and Artifact are its current consumers. Domain code owns message construction, current-source validation and access policy; the shared service knows input identity and delivery, not Artifact business rules.

Ordinary RPC aliases preserve their existing acceptance behavior. Already-identified domain messages use the existing user message id plus a first-seen digest of source and content. Accepted retries return before current-source validation, even when the original queue item was edited or canceled. Inherited events do not reserve a child's identities. Delivery mode applies once; its absence from durable messages is not disguised as a recoverable mode-conflict check.

Consumer teardown retains consumer resources through its own operations, while the shared service owns admission reservation and settlement. Client request capture remains transient and immutable. Neither hiding an unsupported control nor formatting an acknowledgment supplies Host authorization, rollback or evidence of model execution.

## Alternatives considered

**A receipt map per Artifact surface** duplicates acceptance recovery and makes retries depend on a view's lifetime. **Calling the API controller from the Artifact core** reverses ownership. **Changing message source fields or adding another event** adds persistence machinery for identity already present in `UserMessage.id`. **Revalidating current source before acceptance lookup** rejects safe retries after a successful update. **Retrying an old identity with new data** replaces the question the user confirmed.

## Consequences

The old synchronous Artifact `record` method remains legacy and is not advertised as idempotent. New stable submissions need the shared service, with explicit errors when unavailable. Acknowledgment confirms input acceptance only. Identities and hashes grow linearly with this Session's own user-role inputs; retaining them prevents canceled or edited input from being resurrected. The owner documents copying and hashing costs rather than silently expiring receipts.
