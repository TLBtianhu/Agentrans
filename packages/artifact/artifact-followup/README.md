---
description: "Attach explicitly selected particle experiments or program-reported HTML state and errors to an ordinary question."
kind: "package-reference"
---

# @deepseek-ai/dsh-artifact-followup

English | [中文](README.zh.md)

## Summary

Attach the exact experiment selected by the user to an ordinary question. The composer captures a current particle checkpoint, a saved observation reference, a compatible saved comparison, or an HTML program's reported state or error. The Host resolves source in the addressed Session and recomputes particle values; HTML reports retain their program attribution. The question and complete context enter one ordinary user message; local playback and selection alone add no model input.

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

Mount the plugin with Artifact and Session Controller. It registers the `artifact` prompt-context provider; it exposes no separate send operation. Ordinary `session/prompt` authorization and attachment admission remain in force. No filesystem access, additional message source, or new Session event is needed.

```yaml
- name: '@deepseek-ai/dsh-artifact-followup'
```

| Config | Default | Meaning |
|---|---|---|
| `maxContextBytes` | `16384` | Maximum UTF-8 bytes of the complete contributed text-block array, including source and explanatory text |

`ArtifactPromptContextSelection` carries one current particle Artifact id, revision and checkpoint; one saved observation reference; a comparison group and ordered saved references; or an `html-runtime` capture. Caller-supplied source bytes or particle coordinates are refused. Current source revisions must still match when Host admission resolves them. Saved references can use older revisions, including the addressed Session's inherited baseline, without consulting the parent's later state or a sibling Session.

An HTML capture contains the captured Session id, Artifact id, exact source revision, mounted runtime id, and either `{status:'ready',state}` or `{status:'error',error}`. Ready requires an actual state field: `false`, `0`, an empty string and `null` are valid reported values, while absence is not. An error carries no old state. Captured Session and receiving Session must match, and the current source must still be HTML at that revision. Source is supplied by the Host; runtime identity, status, state and error remain Client/program claims, not independently verified or recomputed observations.

A missing source, stale revision, mismatched captured Session, invalid checkpoint/report, unsupported source, incompatible pair or oversized context rejects the question before context admission. Re-select a current experiment or choose a saved observation when the source has changed. The generic prompt owner retains the complete captured request after an unknown outcome; accepted retries find the original receipt before resolving the selection again. A captured HTML report does not need an active runtime stream or runtime service when the Host resolves it; resolution never substitutes later live values.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin validates queued JSON at the registered provider and reads prepared source facts through the Artifact service's `resolveSceneSource`, `resolveSavedObservation` and `currentSnapshot` methods. It performs no full-log read, I/O, source mutation or model wake. Current particle values come from the shared versioned runtime; saved comparisons also use the shared comparison validator. HTML resolution does not query the live runtime registry, execute code, restore its heap or establish causal conclusions.

The provider emits one explanatory text block containing an `artifact-question-context` record with the addressed Session and complete original source. Particle facts retain their checkpoint and recomputed values; saved observations retain their labels and identities; comparisons retain common runtime, time step and step count with both original observations. HTML facts retain the submitted capture, mounted runtime id and `attribution:'program-reported'`, with a separate explanatory prefix. This block is appended to the user's ordinary content before one message is admitted, so replay retains the exact selected data. It does not claim replayability, causation or prior use by the assistant.

The complete serialized contribution is measured before return, including original source, captured report and explanatory text; none is silently truncated. Program captures share the bridge's bounded lossless JSON validation: depth 32, 2,048 visited values and 1,024 UTF-8 bytes for a complete encoded diagnostic. Negative zero, sparse arrays and accessors are rejected rather than normalized. Session Controller independently applies its aggregate context count and byte limits. The registration is an owned effect; disposing the plugin withdraws the provider, and an unavailable provider cannot silently omit the selected context.

<a id="further-exploration"></a>
## Further Exploration

- [Artifact subsystem](../../../docs/subsystems/artifact.md) — source revisions, saved observations and comparisons.
- [Session Controller](../../api/session-controller/README.md) — ordinary prompt admission and delivery.

<a id="model-experience"></a>
## Model Experience

### A question about an experiment

#### What the model sees

The same ordinary user message contains the question and an `artifact-question-context` text block with self-contained original source and selected facts. Particle facts are computed by the Host; HTML state and errors retain explicit program attribution. The stable particle prefix is:

##### Experiment context attribution

```markdown
The user selected the following experiment context for this question. Particle values are recomputed by the Host from the recorded source and checkpoint; no causal conclusion is inferred.
```

##### Program report attribution

```markdown
The user selected the following program-reported context for this question. The Host checked the source identity and revision; the runtime identity, status, state and error are Client/program reports, not independently verified or recomputed. This does not establish replayability or a causal conclusion.
```

#### Token effect

Only the accepted question adds context tokens. Complete source and particle facts or program reports can be larger than a question alone, so both the provider and generic prompt owner apply byte limits. Playback, choosing or clearing an experiment, and refused selections add no model input.

#### KV Cache effect

The context travels in the new user message at the ordinary history tail. It does not rewrite earlier messages or change the established prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Native checkpoint context supports particle scenes. Other Scene controls are unsupported, and HTML reports remain unverified program data rather than Host-recomputed facts.
- A current source changed before admission is refused; the provider does not retrieve arbitrary historical revisions. Save an observation when a result must remain referenceable after source changes.
- Selecting a pair requires already saved observations at compatible conditions. The provider does not infer causality or merge experiments.
- An HTML capture records reported data, not a restorable heap, validated observation or proof that its runtime remains online. It cannot supply an arbitrary older source revision after the current source changes.

<a id="dev-note"></a>
### Dev Note

The package tests cover source and captured-Session isolation, original saved revisions, comparison conditions, report/state validation, complete UTF-8 limits and registration disposal. Built Web replay verifies capture through the ordinary composer and durable message path.
