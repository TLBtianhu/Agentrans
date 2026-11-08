---
kind: upgrade-guide
description: "Ordinary questions can capture explicitly selected HTML state or errors as unverified program reports."
---

# Attach a program report to a question

English | [中文](guide.zh.md)

## Change

The Artifact context provider accepts `html-runtime` selections alongside existing particle and saved-evidence selections. Submission captures the selected instance's latest received state or current error. Host admission checks the target Session and exact current HTML source, without consulting the live runtime registry. The complete original source and explicitly attributed `program-reported` capture enter one ordinary user message. The old particle prefix and user-message format are unchanged; history does not restore an active runtime. See the [ownership decision](../../../../.agents/notes/implemented/architecture/2026-11-07-artifact-runtime-reports.md).

The pure source capability `questionContext` includes `program-reported` for HTML. This describes the kind of question data, without granting Host recomputation, replayability, plugin availability or permission. A separate `artifact-program-context` text variation renders a neutral expandable summary; existing particle summary fields stay unchanged.

Program JSON uses a bounded lossless plain-data subset. Sparse arrays, negative zero (`-0`), accessors, undefined, non-finite numbers and discarded object properties are rejected before a state is forwarded. The validator does not call getters or normalize values. An initial state must validate before the bridge announces ready; invalid later reports become a visible program error.

## Migration

1. Program authors return synchronous plain JSON data from the state callback. Null, false, zero and an empty string are valid reported values. Make deliberate application-level conversions when needed; do not rely on JSON serialization to discard values or turn array holes into null.
2. Custom composers forward the captured `ArtifactPromptContextSelection` through the existing ordinary prompt context path. HTML capture names `capturedSessionId`, Artifact id, revision and runtime id, plus ready/state or error/diagnostic. Missing state is not null, and error captures do not include stale state.
3. Bind selection to the physical instance. Capture synchronously before asynchronous work; later unknown-result retries retain that same immutable request. Source replacement, remount and disconnection require reselection or removal. A captured question may still be admitted after the frame closes if its source revision remains current.
4. Handle `program-reported` source support and the new optional text variation without treating either as verification. Retain the complete raw text for copying and older readers. The original particle text remains Host-recomputed context.
5. Verify selection at count 1 followed by an update to 2 captures 2 at submission, while updates to 3 and frame closure do not replace it. Confirm an error-only question can repair the same Artifact, a changed source refuses admission while keeping the draft, and refresh retains historical message data while discarding the transient choice.
