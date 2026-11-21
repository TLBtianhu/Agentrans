---
description: "Return a manual branch conclusion with user-selected Artifact readings for review in the parent conversation."
kind: "package-reference"
---

# @agentrans/artifact-branch

English | [中文](README.zh.md)

## Summary

Return one child conclusion with user-selected question readings, a saved observation, or a fixed comparison. The parent receives the conclusion with the source and readings needed to replay the evidence. Confirmation saves the result for later review. Repeating the same return reuses its receipt, and different evidence for an already returned conclusion is rejected.

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

The Web composition mounts this plugin alongside Artifact, Session Query and Session Controller. Custom Web compositions add an `@agentrans/artifact-branch` plugin row. The main Artifact service and headless compositions do not require this bridge.

```yaml
- name: '@agentrans/artifact-branch'
```

| Config | Default | Meaning |
|---|---|---|
| `maxActionBytes` | `16384` | Maximum UTF-8 bytes of the complete returned UserMessage, including conclusion, evidence and metadata |

Call `artifactBranchResults.returnResult` with the direct parent, child result seq and one evidence selection. A saved observation can come from the child's inherited prefix. A comparison needs the same group, complementary roles, runtime version, time step and step count. For native question readings or an opted-in HTML checkpoint, supply the seq and text-block index of a child-owned ordinary question preceding the conclusion.

An unknown result can safely retry the identical request. A changed selection conflicts with an earlier return of that conclusion, including a return made without evidence. Open the parent to review the accepted content. Oversized messages require a smaller experiment, and unavailable evidence requires a new selection.

Call `artifactBranchResults.continuePlot` for a function plot or `artifactBranchResults.continueParticle` for a particle system. Supply the receiving Session, returned notice sequence and message id, and a retry UUID. The Host verifies the original question readings, forks at the notice, and records a new child Artifact with the fixed baseline on its first revision. The response identifies the child Session and Artifact. Retrying the same request after an unknown result recovers the child when its initial Artifact matches. A child left with only the inherited seed after a failure reports a continuation conflict.

Call `artifactBranchResults.exportReturnedPlot` with the receiving Session, event sequence and message ID of a returned function plot. The Host verifies that the Session owns the notice and returns self-contained HTML for the locked function, parameters and probe. The file preserves the original Artifact revision and the returned notice address. Opening or resetting the file restores the selected readings. The download creates no Session events.

Call `artifactBranchResults.exportReturnedParticle` with the same address fields for a returned particle experiment. The HTML displays the confirmed gravity, step, positions and velocities. Playback starts at the locked step, and Reset restores it. The download creates no Session events.

For a returned BFS or half-adder checkpoint, `artifactBranchResults.exportReturnedBfs` or `artifactBranchResults.exportReturnedHalfAdder` verifies the same address and returns the original HTML revision and locked readings. BFS records the current node, queue and visited nodes. The half-adder records both input bits, sum and carry. The client packages them into a standalone HTML file, where the program runs in an isolated frame and **Reset to locked step** restores the checkpoint. The download creates no Session events.

When the receiving Session owner sends a follow-up with a continued BFS or half-adder checkpoint, `artifactBranchResults.exportSentBfs` or `artifactBranchResults.exportSentHalfAdder` accepts that question's event sequence and message ID. The Host matches its recorded source revision against the earlier return and uses the program-reported state saved with the sent question. The standalone file resets to the sent checkpoint. The download creates no Session events.

For a sent function-plot question, `artifactBranchResults.exportSentPlot` accepts the same address fields. The Host verifies the recorded revision and locked function, parameters and probe against the question history. The standalone file opens and resets to those conditions. It reads the question without creating Session events.

For a sent particle experiment question, `artifactBranchResults.exportSentParticle` accepts the same address fields. The Host verifies the original revision and the gravity, fixed step, positions and velocities recorded with the question. The standalone file starts and resets at that checkpoint. The download creates no Session events.

`artifactBranchResults.lockCsv` can save a corrected sum or mean as a separate immutable source when only the calculated readings differ from an older lock for the same evidence and calculation. A retry uses the same corrected source. Existing questions retain their original readings.

`artifactBranchResults.compareCsvReturns` compares two exact returns from one inquiry branch for the same CSV and group. It uses the saved readings and reads the source attachment to identify records. The owner can confirm a page in return order as a draft attachment. The draft records the identities of both returns and the exact reviewed page.

Call `artifactBranchResults.exportSentCsvComparison` with the receiving Session and the exact sequence and message ID of a sent comparison or two-step explanation. The Host verifies the recorded evidence against its prompt admission and returns one standalone HTML document. Each reviewed page includes its original and locked readings, membership totals, and reviewed record range. A comparison of two inquiry returns lets the reader expand both original cards from the same document. A two-step explanation shows the ordered readings and lets the reader expand both original pages independently. For a user import, the HTML identifies the source as a single-page JSON comparison, a JSON explanation with two original locked pages, or a JSON comparison with two original return cards. The optional `locale` selects the report language. The Web client sends its active language when the user downloads, and the file keeps that language offline. The Host uses English when the requested language has no report translation or the request omits it. Generation uses saved history and requires no original CSV access, recalculation, or model request.

`artifactBranchResults.exportSentCsvComparisonJson` exports versioned JSON for a reviewed page, a comparison with two original return cards, or both pages of a two-step explanation. Version 1 of `agentrans-csv-return-comparison` carries the locked page and both cards' conclusions and chart revisions. Version 1 of `agentrans-csv-comparison-explanation` carries the exact aggregation and filtering pages. Portable files omit local Session and message addresses. `artifactBranchResults.importCsvComparison` validates the file before the user reviews it. The draft preserves the confirmed content and its user-imported attribution for the follow-up.

`artifactBranchResults.reviewCsvComparisonExplanation` accepts the destination Session and two exact sent comparison references. The Host verifies both against their saved messages and checks that they belong to one original return. Eligible pages capture an unfiltered change from mean to sum on the same records and a sum with a filter that removes records. Review uses the saved pages and their recorded values.

`artifactBranchResults.reviewSentCsvComparison` verifies an exact sent user-imported explanation or return comparison for reuse in the same Session. The review proof covers the saved pages or return cards, the import attribution, and the exact question selected for reuse. One user confirmation stores those facts in the current draft.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The service resolves the conclusion and evidence from one immutable child observation. It matches the attachment's source against an earlier Artifact revision in that log. For native scenes it recomputes and checks the readings. For HTML it checks the checkpoint and sets the durable `artifactEvidence` marker so the parent can reopen the verified revision. The shared `session-branch/admission` operation serializes the parent append and flush. The parent receives the conclusion and a self-contained evidence block in one ordinary `branch-result` user message. Source copies in that message support replay independently of parent Artifact state.

Continuing an experiment uses the ordinary fork lifecycle. The initial child Artifact stores the notice identity and original Artifact revision with the native source. Function plots store the selected function, trace, parameters and baseline readings. Particle systems store the exact fixed-step checkpoint, and vertical gravity can vary at that step for a reviewed question. A later continuation starts with the gravity confirmed in the selected question. The initial snapshot is flushed before success, and the standard question and evidence return mechanisms handle later reviewed readings.

The [admission decision](../../../.agents/notes/implemented/architecture/2026-11-07-evidence-bearing-branch-results.md) explains why a returned conclusion stays immutable and why the bridge is separate from the main Artifact service.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Manual branches](../../../docs/subsystems/branch.md) — lineage, result identity and shared admission.
- [Artifact](../../../docs/subsystems/artifact.md) — saved sources and fixed comparisons.
- [Artifact Client](../../client/ui-artifact/README.md) — user selection and confirmation.

-----

<a id="model-experience"></a>
## Model Experience

### Confirmed evidence-bearing result

#### What the model sees

The parent receives the selected visible conclusion and experimental evidence with its original source snapshot and selected settings. Native observations carry recomputed values. HTML checkpoints retain the reported BFS traversal state or half-adder input and output bits. The attribution identifies the user's selection as an attachment to the conclusion. Returning the result stores it for the parent's next request.

#### Token effect

Only confirmation adds the bounded conclusion and evidence message. Complete source copies can use more context than a plain conclusion. Preview, cancellation and rejected selections add no model input; identical retries do not duplicate it.

#### KV Cache effect

The new user message participates in the parent's next request under ordinary cache rules. The operation appends at the current tail without rewriting the existing prefix or changing child history.

##### Evidence attribution

```markdown
The user selected the following saved Artifact evidence to accompany this conclusion. This does not state that the assistant used it when producing the conclusion.
```

##### Branch question attribution

```markdown
The user selected the following Artifact readings from a branch question to accompany this conclusion. This does not state that the assistant used them when producing the conclusion.
```

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only a direct ordinary manual branch and child-owned durable assistant conclusion are eligible.
- One return attaches a saved particle observation, a compatible pair, or one question attachment. Question evidence supports function plots, particle systems and opted-in BFS and half-adder checkpoints. Creating a new experiment branch from returned evidence supports function plots and particle systems.
- The complete-message limit can reject large source snapshots; existing saved observations are retained.

<a id="dev-note"></a>
### Dev Note

See [branch verification](../../../docs/subsystems/branch.md#verification) for the shipped confirmation path.
