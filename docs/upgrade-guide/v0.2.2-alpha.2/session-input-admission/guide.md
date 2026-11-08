---
kind: upgrade-guide
description: "Custom Session Controller compositions require shared input admission, and Artifact adapters must retain stable action identities."
---

# Share Session input admission

English | [中文](guide.zh.md)

## Change

Session Controller now requires `@deepseek-ai/dsh-session-input`. The shipped Web bundle mounts it; custom compositions must add it. The service owns the existing private prompt-receipt recovery and concurrent admission. State version 3 rebuilds older private checkpoints; Session log fields and message sources do not change.

Artifact adds `submitAction(agent, request)`. Its `requestId` is an existing `MessageId`, minted by the trusted Client and retained with artifact identity, source revision, action, payload and wake choice. An accepted identical message returns its earlier acknowledgment before current-source validation. Queue cancellation does not release that identity. A different source/content under the same message id conflicts. Source/content fingerprints do not persist delivery mode; after acceptance a retry cannot change it or re-wake the model.

The old synchronous `record` method remains available without the new service. It creates a fresh identity and does not provide safe retry. Current Web cards use stable submission for native confirmations, reviewed HTML actions and current comparisons. Subagent continuation chats retain local exploration but do not offer unsupported root-only saving, sending or stored-file export operations.

## Migration

1. Mount `@deepseek-ai/dsh-session-input` alongside `@deepseek-ai/dsh-session-projection` before using Session Controller or stable Artifact submissions. Custom package manifests must declare the mounted plugin. Headless source creation and legacy `record` do not need activation.
2. Custom action adapters forward the captured message id to `remote.artifacts.submitAction`; do not generate a new id inside each retry. Preserve the complete original payload and its encoded text order. An optional sixth argument on the UI `RecordArtifactAction` callback carries that identity; adapters must honor it when provided.
3. Distinguish known rejection/conflict from unconfirmed dispatch. Keep an unknown request through later source changes or temporary service unavailability, and retry that original request. Dismissing local retry never retracts accepted input. Before closing or reloading, retry or inspect history; browser-local capture is not a durable receipt.
4. Check ordinary prompt retry after queue cancellation, and accepted action retry after source replacement. Both must return acceptance without another inbox insertion or model turn. Confirm that the same action id with changed content conflicts, and that subagent local controls remain usable without invoking root-only operations.
