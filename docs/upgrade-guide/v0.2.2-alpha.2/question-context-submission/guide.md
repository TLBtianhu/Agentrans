---
kind: upgrade-guide
description: "Custom composer integrations must preserve captured question context and handle an uncertain submission outcome."
---

# Handle contextual question submission

English | [中文](guide.zh.md)

## Change

The ordinary composer captures optional `{kind, value}` question context before asynchronous work. `SessionPromptRequest.contexts` carries it to a registered Host resolver. The question and resolved facts remain one ordinary user message; no new Session event or source is introduced. Existing messages and requests without context keep their behavior.

The public input phase union includes `uncertain`, and default sends may return `DefaultSubmitOutcome` with `kind: 'unknown'`. A custom composer that treats every non-sending phase as editable must handle this phase. Command `SubmitOutcome` remains success or error. Contextual retries retain the original text, attachments, request id, conditions and time zone while their Session binding remains active.

## Migration

1. Custom composer views render `uncertain` as a frozen original submission with `InputActions.retrySubmission` and `InputActions.dismissSubmission`. Explain that dismissing does not retract an already admitted question. Before leaving or refreshing, retry or inspect history; the local retry record is not restored after binding disposal.
2. Custom ordinary-send adapters forward the captured optional contexts rather than reading the current screen after asynchronous work. Prefer the existing Conversation submission path, which owns request identity, attachments and late acceptance. After a successful unknown-result retry, release its local optimistic echo and let Host inbox/history supply the display: historical acceptance can belong to a queue entry that was subsequently removed. Releasing the echo does not cancel Host input. Ordinary callers without context need no new argument.
3. Custom Session Controller compositions mount `@agentrans/session-input`; see [input admission](../session-input-admission/guide.md). Artifact question contexts additionally require `@agentrans/artifact-followup` and Artifact. Missing or rejected context must remain visible and must not silently change the question's conditions.
4. Offer context selection only on the root Session prompt route. A subagent continuation accepts ordinary text but no question contexts; use the actual subagent descriptor rather than parent Session identity, because manual branches still support contexts. Keep a visible explanation and reject unsupported capture locally without silently dropping selected facts.
5. Verify that a six-step question still contains six-step facts when the scene advances before Host admission. An unknown retry must reuse the same request id; a command must keep its original route.
