---
description: "The Artifact group map: durable executable explanations, their model-facing operations, and browser presentation."
kind: "package-group"
---

# packages/artifact

English | [中文](README.zh.md)

## Summary

The Artifact family stores code-generated interactive explanations without confusing them with files, tool cards, or browser-only state. The Host package owns complete Session snapshots, revisions, and action messages; the Client package renders them in isolated HTML frames and returns user-confirmed intent.

## Packages

| Package | Role |
|---|---|
| [`artifact`](artifact/README.md) | Validates and commits Artifact snapshots; exposes the model-facing tool and action Remote |
| [`ui-artifact`](../client/ui-artifact/README.md) | Folds Artifact events into stable Chat nodes and renders the restricted iframe |

## Related documentation

- [Artifact subsystem](../../docs/subsystems/artifact.md) — protocol values, durable events, and action semantics.
- [Conversation assembly](../../docs/subsystems/conversation.md) — stable event-to-node correlation and replay.
- [Distribution](../../DISTRIBUTION.md) — product identity and data-root separation.

## Dev Note

None.
