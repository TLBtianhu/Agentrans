# Manual branch

English | [中文](branch.zh.md)

A manual branch is an independent Session created from an exact prefix of another Session. Its `SessionId` is its branch identity. `header.parentSession` records the direct source; `origin` remains absent, so an ordinary manual branch is not a subagent.

## Fork and lineage

A fork at inclusive `atSeq` inherits the source prefix through that event, marks the inherited cut with `session/end-seed`, and closes any open tools, steps, and turns with fork-specific outcomes. The source log does not change. Nested branches point to their direct parent, not the root.

`inheritedEventCount` counts copied source events, excluding the seed marker and synthetic closers. For a nonempty branch, the source fork position is `inheritedEventCount - 1`; no second `atSeq` field is required.

The child derives model messages only from its own log. Parent events appended after the fork and sibling conversations do not enter that child. A nested child inherits its direct parent's prefix, which already contains the relevant ancestors.

<a id="confirmed-result-return"></a>
## Confirmed result return

`SessionBranchResultRequest` contains `sessionId` for the direct parent, `branchSessionId` for the child, and `resultSeq` for a child-owned durable `assistant/message`. The request carries no conclusion text. The Host rereads the exact child event and validates its message id and nonempty visible text.

`SessionBranchResultValue` contains `parentSessionId`, the parent-local `eventSeq`, and the parent-local `messageId`. Retrying the same `(parent, branch, resultSeq)` with identical confirmed content returns an existing receipt instead of appending a duplicate. Different content for that conclusion reports `session/branch-result-conflict`, including plain versus evidence-bearing returns.

The accepted result becomes a new ordinary `user/message` at the parent's current tail. Its source is `branch-result` with:

| Field | Meaning |
|---|---|
| `branchSessionId` | Child Session that owns the result |
| `resultSeq` | Exact child event sequence |
| `resultMessageId` | Stable id of the child assistant message |
| `form` | `notice` |

The child seq is not placed in `sourceEventSeqs`, which accepts only earlier events from the same Session. A confirmed return creates new parent-local message identity and does not rewrite history or start a model turn.

Selection rejects a non-branch, subagent, wrong parent, inherited event, missing result, or empty visible text. An idle parent accepts the append through maintenance serialization and a durability flush; a running parent reports busy instead of receiving an implicit steer.

Plain return and the [Artifact evidence bridge](../../packages/artifact/artifact-branch/README.md) share the Host-only `session-branch/admission` operation. It compares existing content while holding parent maintenance, then appends and flushes only a new message. A failure after the operation starts can leave an unknown outcome; retry the identical selection to recover its receipt. Only a failure to enter maintenance is reported as busy.

The evidence bridge reads the conclusion and saved observations from one immutable child cut. It appends user-selected evidence as additional ordinary text without changing the `branch-result` source or the child's history. Inherited baseline observations may be selected, but later parent and sibling facts are unavailable. Evidence selection does not assert that the assistant used those facts to produce its earlier conclusion.

<a id="verification"></a>
## Verification

The keyless [branch-result scenario](../../apps/web/tests/branch-result.e2e.ts) replays a parent answer and an independent child answer through the shipped Web composition. The browser forks the parent, opens the child-owned result preview, cancels once without a return, then confirms. The test checks that the preview excludes reasoning, the parent gains exactly one `branch-result` user message with the child reference and visible text only, and no parent model turn starts before or after confirmation.

The [branch evidence scenario](../../apps/web/tests/branch-evidence.e2e.ts) returns old-revision observations with a child conclusion, drops the first successful response, and retries the frozen request. It checks one durable parent input, conflicts for changed evidence, an unchanged child log, and preservation of a same-named parent Artifact.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->
<a id="cordis-surface"></a>
## Cordis API
<!-- END GENERATED cordis-surface -->

## Limitations

- Prefix inheritance uses the existing Session fork seed; it is not a zero-copy cross-Session overlay.
- Returning a result copies only the selected visible text blocks and their reference, not the child's entire transcript, tools, reasoning, or sibling state.
- Branch lineage supports navigation and validation, not automatic semantic merge or conflict resolution.
