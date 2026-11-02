---
description: "Pure direct-parent validation, confirmed assistant-result selection, parent-local message construction, and idempotent lookup for ordinary manual Session branches."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-branch

English | [中文](README.zh.md)

## Summary

Use `dsh-session-branch` for the domain rules of a first-class manual Session branch. The package selects visible text from a child-owned durable `assistant/message`, constructs a fresh parent-local `user/message` with a `branch-result` source, and finds an earlier return of the same result. It performs no Session I/O, Agent scheduling, Remote dispatch, or model invocation.

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

-----

<a id="model-experience"></a>
## Model Experience

### Branch result history

#### What the model sees

A returned conclusion becomes ordinary model-visible user history only when the Host appends it to the parent Session. Reasoning, tool calls, sibling output, inherited parent content, and later parent events are not copied into that new message. This package itself never sends a provider request.

#### Token effect

Only selected visible text blocks enter the parent message. No child transcript or sibling text is added by the return operation. Repeated returns of the same result reuse an earlier receipt rather than appending duplicate text.

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

None.
