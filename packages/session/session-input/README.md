---
description: "Retry confirmed Session input without replacing an accepted message or re-enqueueing a canceled item."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-input

English | [中文](README.zh.md)

## Summary

Confirm the same input after an uncertain response without sending it again. Concurrent identical attempts share one result; conflicting identified messages are refused. Accepted identities survive queue edits, cancellation and replay within their own Session. Consumers retain their own source validation and permissions, and acceptance does not prove that the model executed an input.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this service beside Session Projection before consumers such as Session Controller. The Web bundle includes it. Headless source creation and legacy Artifact recording do not require its activation; stable Artifact submission explicitly refuses a missing service.

```yaml
- name: '@deepseek-ai/dsh-session-input'
```

Ordinary prompts reserve their RPC identity before asynchronous Agent preparation and read acceptance before resolving context or attachments. A domain that already constructs the complete immutable user message uses its stable message id instead. First-admission checks run only when no matching receipt exists, so an accepted retry does not depend on the current source revision.

The delivery choice applies once. An accepted retry never moves a queued item, revives a canceled input or wakes the model again. Permission checks and source attribution belong to each caller; this service grants neither.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One private Projection recovers ordinary RPC aliases and first-seen source/content fingerprints from this Session's own inbox insertions and user messages. It excludes the inherited prefix. The existing `session/promptReceipts` key uses state version 3; an older checkpoint is rebuilt from events. No Session event, source field or second receipt log is added. Later edits of the same message id never replace its original fingerprint.

One service-owned in-flight map separates RPC and message identities. Requests are detached before the job starts; identical concurrent attempts join, while conflicting requests fail. Unload rejects new work and awaits admitted jobs. A consumer also retains its own resources until its calls settle. No maintenance lock or Agent activation is introduced. The typed dispatch failure preserves an unknown outcome, and only a same-identity retry can resolve it.

Receipt storage grows with accepted identities and is not silently evicted. First-seen message hashing reads the complete source and content, preserves array order and treats text as opaque; the message index uses 256 sparse buckets selected by a hash of the opaque id, so an update copies the outer index and affected bucket rather than all message receipts. Ordinary RPC alias updates retain their original dictionary cost. The service retains hashes and identities rather than message bodies or event-sequence lists. See the [source](src/index.ts) and [receipt fold](src/receipts.ts).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session](../../../docs/subsystems/session.md) — durable input and delivery semantics.
- [Session Projection](../session-projection/README.md) — preparation, checkpoint recovery and private state.
- [Session Controller](../../api/session-controller/README.md) — ordinary prompts, context and attachments.
- [Artifact](../../artifact/artifact/README.md) — source-bound confirmed user intent.

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

This package registers no tool or prompt text. Consumers append their existing ordinary or domain-attributed `UserMessage` only on first admission. A receipt is not a model result or evidence of execution.

#### Token effect

Retries do not append another accepted input. Identities and fingerprints remain private and do not enter model requests.

#### KV Cache effect

Admission leaves earlier conversation unchanged. The first accepted input follows its consumer's normal append path.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Ordinary RPC receipts preserve existing identity-only acceptance; completed prompt retries do not gain a durable raw-request fingerprint.
- Message fingerprints do not persist the delivery choice. A retry after completion cannot change delivery or reliably detect a mode-only difference; active conflicting requests are still refused.
- Acceptance follows Session inbox persistence guarantees and does not establish execution, a still-pending item or rollback of downstream effects.
- In-flight work is process-local. Consumers retain frozen requests for retry and must not describe losing local retry state as canceling an accepted input.

<a id="dev-note"></a>
### Dev Note

None.
