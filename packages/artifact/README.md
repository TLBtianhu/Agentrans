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
| [`artifact-branch`](artifact-branch/README.md) | Returns a conclusion with user-selected saved evidence |
| [`artifact-export`](artifact-export/README.md) | Freezes Scene input and stores HTML export results |
| [`artifact-followup`](artifact-followup/README.md) | Resolves selected experiment facts within ordinary questions |
| [`artifact-runtime`](artifact-runtime/README.md) | Holds live renderer reports and provides exact-revision model inspection |
| [`ui-artifact`](../client/ui-artifact/README.md) | Folds Artifact events into stable Chat nodes and renders the restricted iframe |

## Related documentation

- [Artifact subsystem](../../docs/subsystems/artifact.md) — protocol values, durable events, and action semantics.
- [Conversation assembly](../../docs/subsystems/conversation.md) — stable event-to-node correlation and replay.
- [Distribution](../../DISTRIBUTION.md) — product identity and data-root separation.

## Dev Note

None.
