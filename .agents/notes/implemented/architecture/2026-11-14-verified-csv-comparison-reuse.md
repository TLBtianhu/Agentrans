# Agent Note: Verified reuse of sent CSV comparisons

Status: implemented

English | [中文](2026-11-14-verified-csv-comparison-reuse.zh.md)

## Problem

A saved CSV comparison remains readable from message history when its source CSV is gone. The same message log can contain pasted text formatted like a comparison. Giving either block a fresh attachment proof on the strength of its format would let pasted values enter a later question as Host-verified readings.

## Decision

The draft binder records a digest of the sealed comparison under the receiving Session and request ID before sending. Reuse pairs that private digest with the exact historical user message. The Host seals the facts with the immediate message reference for deliberate confirmation in the same Session. It replaces this one reference at each reuse so the comparison keeps a fixed-size provenance field and the original calculation source. The [Artifact subsystem reference](../../../../docs/subsystems/artifact.md) describes the replay and reattachment behavior.

A portable comparison file carries one reviewed page and its format version. The destination Host validates the page and labels it as user-imported evidence before issuing a review proof for that Session. The proof binds the reviewed bytes to prompt admission. Imported facts retain their attribution through confirmation, sending and replay, with their citations scoped to subsequent messages in the destination Session.

## Alternatives considered

Recomputing from the CSV would depend on the original attachment being available. A provenance field on every prompt would affect the shared message format. A private digest keeps ownership in Artifact follow-up and uses the original comparison already present in the log.

## Consequences

The digest survives Host restart and draft cleanup. Historical messages without a matching digest remain readable in the transcript. The private record contains neither source rows nor credentials, and the model continues to receive the recorded comparison facts.
