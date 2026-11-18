# Manual branch

English | [中文](branch.zh.md)

A manual branch is an independent Session created from an exact prefix of another Session. Its `SessionId` is its branch identity. `header.parentSession` records the direct source; `origin` remains absent, so an ordinary manual branch is not a subagent.

## Fork and lineage

A fork at inclusive `atSeq` inherits the source prefix through that event, marks the inherited cut with `session/end-seed`, and closes any open tools, steps, and turns with fork-specific outcomes. The source log does not change. Nested branches point to their direct parent, not the root.

`inheritedEventCount` counts copied source events, excluding the seed marker and synthetic closers. For a nonempty branch, the source fork position is `inheritedEventCount - 1`; no second `atSeq` field is required.

The child derives model messages only from its own log. Parent events appended after the fork and sibling conversations do not enter that child. A nested child inherits its direct parent's prefix, which already contains the relevant ancestors.

## Inquiry from selected answer text

Select text in a completed answer and choose **Start inquiry branch from selection**. The fork inherits the whole completed turn, so the child can operate the same function plot. The Host checks that the excerpt matches the specified UTF-16 range in the exact assistant message and stores it in the child header. Opening the branch leaves the parent unchanged and does not start a model turn.

The browser places the passage in the new branch's draft as a removable quote. Reload restores the current draft and any locked function-plot reading in the same tab. Removing the quote or successfully sending it leaves the draft in that state when the branch reopens.

If opening the inquiry fails, choose **Retry** to continue the same request with its original passage. If the child was already saved, the Host reuses it and completes any pending workspace attachment before the browser opens it and prefills the draft. Starting another inquiry after a successful open creates a separate branch.

The corresponding branch link appears beneath the source answer. **View returned result** opens the branch's confirmed question evidence and replays its saved state. If several results were returned, choose one in the order they were confirmed. CSV choices show the saved group, aggregate, and value. A particle replay stays paused at its recorded step. In a BFS replay, you can advance from the locked node, queue, and visited set. In a half-adder replay, you can change the inputs after checking the saved inputs and outputs. For an original CSV chart, **View participating rows** reads the source records for the locked group without recomputing the aggregate. **Find the selected passage** on the evidence card scrolls back to the exact highlighted passage. These controls are available after reload and make no model request.

Inquiry currently supports a continuous literal selection of up to 512 UTF-16 code units in the final answer of a completed turn. See the [Session format acknowledgement](../persistence-changes/2026-11-16-inquiry-fork-anchor.md) for compatibility with earlier readers.

For multiple original CSV returns from one inquiry branch, **View returned result → Compare returned results** lets you select two confirmed returns for the same source CSV and group. The comparison shows the locked readings in confirmation order and marks which records participated in both. The Host uses the source attachment for record membership and uses the saved aggregate values. After reloading the tab, open the comparison again from the source answer to recover the last selected pair. Viewing it makes no model request.

Choose **Review and attach to next question** to confirm the page currently displayed. Selecting another pair or page leaves the attachment in the composer. After sending the question, choose **Replay attached comparison** on that question to see both locked readings and the reviewed records. Replay uses the stored page without reading the CSV.

In a sent comparison, **View original return** opens the exact return on that side. **Return to comparison** expands the original comparison and focuses the button you used. The return path survives a refresh in the same tab. Opening either return and going back use saved conversation history.

**Download comparison as HTML** saves the confirmed comparison and both original return cards in one file. Open either card offline to see its original conclusion, saved chart revision, and participating records from the reviewed page. The download uses saved history without reading the CSV or recalculating the results.

**Download comparison as JSON** also carries both original cards. In another conversation, choose **Import CSV comparison** to review them with the **User imported** label. Confirming the attachment keeps both cards with the same page, including after the question is sent and the tab is refreshed.

On a sent **User imported** comparison, choose **Reuse entire return comparison** to review the same locked page and both original cards for a new question. Confirming keeps the reviewed contents and the import label together in the draft. Reload the tab to resume that draft.

After reuse, **View source question** in the draft or sent question opens the exact imported comparison you chose. Both cards remain available after refresh, including when another source question contains identical readings.

Choose **View full source chain** from the draft or sent comparison to see the questions selected at every reuse. You can open each source, review its original cards, and return one question at a time, even after refreshing at an earlier source. Returning to the draft restores its text, cursor, and locked attachment. This reads only saved conversation history.

The draft attachment also offers **View original return** for each side. After opening a card, **Return to draft** restores the draft question, cursor, and confirmed attachment, including after a refresh in the same tab. Returning consumes the route, so a later refresh stays in the conversation.

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

The evidence bridge reads the conclusion and selected evidence from one immutable child cut. It appends the evidence as an ordinary text block in the parent's `branch-result` message. See [Artifact branch evidence](artifact.md) for selection rules and replay.

<a id="verification"></a>
## Verification

The keyless [branch-result scenario](../../apps/web/tests/branch-result.e2e.ts) replays a parent answer and an independent child answer through the shipped Web composition. The browser forks the parent, opens the child-owned result preview, cancels once without a return, then confirms. The test checks that the preview excludes reasoning, the parent gains exactly one `branch-result` user message with the child reference and visible text only, and no parent model turn starts before or after confirmation.

The [branch evidence scenarios](../../apps/web/tests/branch-evidence.e2e.ts) return saved comparisons and native question readings with a child conclusion. They reopen the confirmed revision and readings in the parent before and after reload. The comparison also checks an identical retry after a lost response, a conflict for changed evidence, and preservation of a same-named parent Artifact.

The [live inquiry scenario](../../apps/web/tests/artifact-live.e2e.ts) selects the Chinese phrase “切线斜率” with a browser pointer, operates the inherited function plot, and checks the locked reading sent to DeepSeek. After return and reload, it verifies the original reading, the visible highlight of the exact passage, and the link to the same child.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->
<a id="cordis-surface"></a>
## Cordis API
<!-- END GENERATED cordis-surface -->

## Limitations

- Prefix inheritance uses the existing Session fork seed; it is not a zero-copy cross-Session overlay.
- Returning a result copies only the selected visible text blocks and their reference, not the child's entire transcript, tools, reasoning, or sibling state.
- Branch lineage supports navigation and validation, not automatic semantic merge or conflict resolution.
