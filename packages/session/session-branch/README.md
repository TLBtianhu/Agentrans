---
description: "Pure direct-parent validation, confirmed assistant-result selection, parent-local message construction, and idempotent lookup for ordinary manual Session branches."
kind: "package-reference"
---

# @agentrans/session-branch

English | [中文](README.zh.md)

## Summary

Use `@agentrans/session-branch` for the domain rules of a first-class manual Session branch. The root entry selects visible text from a child-owned durable `assistant/message`, constructs a fresh parent-local `user/message` with a `branch-result` source, and finds an earlier return of the same result without I/O. The Host-only `/admission` entry shares maintenance serialization, content conflict checks and durability across return providers. Neither entry invokes a model.

## Table of Contents

- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="api"></a>
## API

- `selectBranchResult(observation, parentSessionId, resultSeq)` requires an ordinary seeded child whose `header.parentSession` is exactly the requested parent. The selected seq must be at or after `inheritedEventCount`, identify a durable assistant message, and contain non-whitespace visible text. Only text blocks are selected.
- `createBranchResultMessage(selection)` creates a new parent-local message id and carries the child branch id, result seq, and result message id in `source`. The child event seq is not a parent `sourceEventSeqs` value.
- `findBranchResult(events, reference)` returns the existing parent event and message ids when the same reference was already returned.

`admitBranchResult` from `/admission` accepts the parent Agent, validated selection and exact-parent observation/flush capabilities. It can append Host-built evidence text. Identical content returns the old receipt; changed content reports a conflict. Validation runs before a new append. Only refusal before maintenance starts is busy; a later failure retains an unknown outcome and requires the identical request for retry.

-----

<a id="model-experience"></a>
## Model Experience

### Branch result history

#### What the model sees

A returned conclusion becomes ordinary model-visible user history only when the Host appends it to the parent Session. Reasoning, tool calls, sibling output, inherited parent content, and later parent events are not copied into that new message. This package itself never sends a provider request.

#### Token effect

The root selection includes only visible text blocks. The Host admission entry can also append explicitly selected evidence supplied by its domain owner. No child transcript or sibling text is copied. Repeated returns with identical content reuse an earlier receipt rather than appending duplicate text.

#### KV Cache effect

The returned user text participates in the parent Session's next model request under the ordinary prefix-cache rules. No child transcript or sibling text is added to that request by the return operation.

##### Selection boundary

```markdown
Only selected visible text blocks become parent history; child and sibling transcripts stay out.
```

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The package addresses direct ordinary branches only. Subagent settlement, automatic return, branch graphs, and UI navigation are owned by their respective runtime and client packages.

### Dev Note

Package rules are covered by `tests/branch-result.spec.ts`. The shipped UI path is documented in the [manual branch verification](../../../docs/subsystems/branch.md#verification).
