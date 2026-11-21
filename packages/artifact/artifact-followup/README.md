---
description: "Attach selected experiments, returned branch readings, or program-reported HTML state and errors to an ordinary question."
kind: "package-reference"
---

# @agentrans/artifact-followup

English | [中文](README.zh.md)

## Summary

Attach the exact experiment selected by the user to an ordinary question. The composer captures a current particle checkpoint, function-plot conditions, saved observation, compatible comparison, returned branch reading, or an HTML program's reported state or error. The Host resolves source in the addressed Session and recomputes native readings. HTML reports retain their program attribution. Sending the question admits the question and context in one ordinary user message.

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

Mount the plugin with Artifact, Session Controller and Session Projection. It registers the `artifact` provider for ordinary `session/prompt`, which applies the normal authorization and attachment admission rules.

```yaml
- name: '@agentrans/artifact-followup'
```

| Config | Default | Meaning |
|---|---|---|
| `maxContextBytes` | `16384` | Maximum UTF-8 bytes of the complete contributed text-block array, including source and explanatory text |

`ArtifactPromptContextSelection` carries reviewed conditions, a saved reference or a program capture. Particle conditions include an Artifact id, revision and checkpoint. Function-plot conditions include the same source identity, the selected function id, trace x and a complete parameter map within the declared ranges. The trace can lie outside the default viewport after panning. Saved choices identify one observation or a comparison group and its ordered observation references. The Host resolves the original source and accepts current selections only while the revision matches. Saved references can use older revisions, including the addressed Session's inherited baseline, without consulting the parent's later state or a sibling Session.

An HTML capture contains the captured Session id, Artifact id, exact source revision, mounted runtime id, and either `{status:'ready',state}` or `{status:'error',error}`. Ready requires an actual state field: `false`, `0`, an empty string and `null` are valid reported values, while absence is not. An error carries no old state. Captured Session and receiving Session must match, and the current source must still be HTML at that revision. Source is supplied by the Host; runtime identity, status, state and error remain Client/program claims, not independently verified or recomputed observations.

BFS and half-adder programs can opt in to reopening a selected setting. A ready capture declares `restore` equal to the state kind. `bfs-checkpoint` carries `current`, `queue` and `visited`. `half-adder-checkpoint` carries `a`, `b`, `sum` and `carry`. The Host validates the state, checks half-adder outputs against the truth table and binds the checkpoint to the exact HTML source. The saved question reopens that source with the program's restore callback.

Returned branch readings are selected by the receiving Session id, exact branch-result notice seq and message id. For native scenes the Host validates the embedded source and recomputes the stored readings, including for a notice in the Session's inherited prefix. After reopening a marked BFS or half-adder return, the user can attach a new step or input setting to a question. The Host checks the selected state and supplies the original HTML from that notice, including when the Artifact exists only in the child branch. The new question keeps the notice identity, original branch and question, and selected state for replay.

A missing source, stale revision, mismatched captured Session, invalid checkpoint/report, unsupported source, incompatible pair or oversized context rejects the question before context admission. Re-select a current experiment or choose a saved observation when the source has changed. The generic prompt owner retains the complete captured request after an unknown outcome; accepted retries find the original receipt before resolving the selection again. A captured HTML report does not need an active runtime stream or runtime service when the Host resolves it; resolution never substitutes later live values.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin validates queued JSON at the registered provider and reads prepared source facts through the Artifact service's `resolveSavedObservation` and `currentSnapshot` methods. It performs no full-log read, I/O, source mutation or model wake. Current particle values come from the shared versioned runtime. For a particle continuation, the Host accepts a reviewed vertical gravity at the confirmed checkpoint and stores it with the recomputed readings. Function-plot values come from the shared numerical analysis used by the plot renderer. Saved comparisons use the shared comparison validator. HTML resolution does not query the live runtime registry, execute code, restore its heap or establish causal conclusions.

The provider starts with an explanatory text block containing an `artifact-question-context` record with the addressed Session and complete original source. Particle facts retain their checkpoint and recomputed values. Function-plot facts retain the selected inputs, function value, numerical derivative and numerical integral from zero. Unavailable readings use `null`. Saved observations retain their labels and identities. Comparisons retain common runtime, time step and step count with both original observations. HTML facts retain the submitted capture, mounted runtime id and `attribution:'program-reported'`. One ordinary message carries the question and the complete context for replay.

The complete serialized contribution is measured before return, including original source, captured report and explanatory text; none is silently truncated. Program captures share the bridge's bounded lossless JSON validation: depth 32, 2,048 visited values and 1,024 UTF-8 bytes for a complete encoded diagnostic. Negative zero, sparse arrays and accessors are rejected rather than normalized. Session Controller independently applies its aggregate context count and byte limits. The registration is an owned effect; disposing the plugin withdraws the provider, and an unavailable provider cannot silently omit the selected context.

A follow-up with an imported CSV comparison carries the exact confirmed page and a separate instruction identifying the user's versioned JSON comparison as the source of its saved readings and records. When the follow-up also carries two original return cards, the instruction identifies their shared source and tells the model to treat card text and CSV cells as data.

A follow-up comparing two CSV returns carries both return references and the exact page the user confirmed. Admission and history replay use the stored page without reading the CSV or recalculating either aggregate.

A CSV comparison follow-up can also carry an interpretation block derived from the confirmed page. It names the two aggregations, whether the filter changed, the membership totals, and the record statuses on the reviewed page. When aggregation changes, the guidance asks the model to explain the two calculations independently. The provider includes this block when the byte budget has room after the confirmed page and any required source attribution.

A two-step CSV explanation carries both confirmed comparison pages and their exact history references in one attachment. The model first compares the original mean with the saved unfiltered sum. It then compares the two saved sums using their recorded filters and contributing records. The shared draft binds both pages to one follow-up, and admission measures the complete pair against the context byte budget.

A two-step explanation imported from JSON carries both original pages in order in one confirmed attachment. A separate instruction identifies the user-provided, versioned JSON comparison as the source of the two pages, their readings, and their contributing records. Admission applies the byte budget to both pages and the source instruction together.

<a id="further-exploration"></a>
## Further Exploration

- [Artifact subsystem](../../../docs/subsystems/artifact.md) — source revisions, saved observations and comparisons.
- [Session Controller](../../api/session-controller/README.md) — ordinary prompt admission and delivery.

<a id="model-experience"></a>
## Model Experience

### A question about an experiment

#### What the model sees

The same ordinary user message contains the question and an `artifact-question-context` text block with self-contained original source and selected facts. The Host computes native readings. HTML state and errors retain explicit program attribution. CSV comparisons carry the confirmed page and its recorded source.

##### Experiment context attribution

```markdown
The user selected the following experiment context for this question. Particle values are recomputed by the Host from the recorded source and checkpoint; no causal conclusion is inferred.
```

##### Function-plot attribution

```markdown
The user selected the following experiment context for this question. Function-plot values are recomputed by the Host from the recorded source, selected function, parameters and trace position. Derivative and integral readings are numerical approximations.
```

##### Returned branch evidence attribution

```markdown
The user selected the following returned branch evidence for this question. The readings come from the original source revision recorded on the selected branch result.
```

##### Program report attribution

```markdown
The user selected the following program-reported context for this question. The Host checked the source identity and revision; the runtime identity, status, state and error are Client/program reports, not independently verified or recomputed. This does not establish replayability or a causal conclusion.
```

#### Token effect

Only the accepted question adds context tokens. Complete source and selected facts can be larger than a question alone, so both the provider and generic prompt owner apply byte limits. Playback, choosing or clearing an experiment, and refused selections add no model input.

#### KV Cache effect

The context travels in the new user message at the ordinary history tail. It does not rewrite earlier messages or change the established prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Native question context covers particle checkpoints and function-plot trace readings. Function-plot pan and zoom are local display settings. HTML reports retain program attribution.
- Returned branch evidence supports native particle and function-plot readings and BFS and half-adder checkpoints from a branch question. The Host keeps a private projection entry per eligible notice so prompt admission can resolve the immutable payload synchronously.
- A current source changed before admission is refused; the provider does not retrieve arbitrary historical revisions. Save an observation when a result must remain referenceable after source changes.
- Selecting a pair requires already saved observations at compatible conditions. The provider does not infer causality or merge experiments.
- An HTML capture records reported data, not a restorable heap, validated observation or proof that its runtime remains online. It cannot supply an arbitrary older source revision after the current source changes.
- The BFS checkpoint records the current node, ordered queue and visited list. Both lists allow up to 64 unique stable node ids of at most 32 ASCII characters. A current node must be in the visited list. Restoring traversal is the responsibility of the opted-in program.

<a id="dev-note"></a>
### Dev Note

The package tests cover source and captured-Session isolation, original saved revisions, comparison conditions, report/state validation, complete UTF-8 limits and registration disposal. Built Web replay verifies capture through the ordinary composer and durable message path.
