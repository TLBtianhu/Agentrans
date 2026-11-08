---
description: "Return a manual branch conclusion with user-selected saved Artifact observations or a fixed comparison, without starting the parent model."
kind: "package-reference"
---

# @deepseek-ai/dsh-artifact-branch

English | [中文](README.zh.md)

## Summary

Return one child conclusion with a saved observation or fixed comparison that the user explicitly selects. The parent receives the conclusion and self-contained source, checkpoint and computed evidence. Preview and cancellation change no history, and confirmation starts no model turn. Repeating the same return reuses its receipt; different evidence for an already returned conclusion is rejected.

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

The Web composition mounts this plugin alongside Artifact, Session Query and Session Controller. Custom Web compositions add an `@deepseek-ai/dsh-artifact-branch` plugin row. The main Artifact service and headless compositions do not require this bridge.

```yaml
- name: '@deepseek-ai/dsh-artifact-branch'
```

| Config | Default | Meaning |
|---|---|---|
| `maxActionBytes` | `16384` | Maximum UTF-8 bytes of the complete returned UserMessage, including conclusion, evidence and metadata |

Call `artifactBranchResults.returnResult` with the direct parent, child result seq and saved references. The request contains no conclusion text, coordinates or arbitrary evidence Session. An observation can be inherited in the child's visible prefix. A comparison must retain the same group, complementary roles, runtime version, time step and step count.

An unknown result can safely retry the identical request. A changed selection conflicts with an earlier return of that conclusion, including a return made without evidence. Open the parent to review the accepted content. Oversized messages require a smaller experiment; a missing observation requires refreshed evidence. Neither rejection appends input.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The service reads the conclusion and observations from one immutable child observation. It recomputes evidence and uses the shared `session-branch/admission` operation to serialize the parent append and flush. The parent receives an ordinary `branch-result` user message with additional evidence text. Its source fields and Session event vocabulary are unchanged. Saved source copies remain message data and never replace the parent's Artifacts.

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

The parent receives only the selected visible conclusion and user-selected experimental evidence, including original source snapshots, checkpoints and computed values. This does not assert that the assistant used that evidence when it wrote the conclusion. No reasoning, full child transcript, sibling history or later parent state is merged. Neither the child nor parent model is invoked by returning the result.

#### Token effect

Only confirmation adds the bounded conclusion and evidence message. Complete source copies can use more context than a plain conclusion. Preview, cancellation and rejected selections add no model input; identical retries do not duplicate it.

#### KV Cache effect

The new user message participates in the parent's next request under ordinary cache rules. The operation appends at the current tail without rewriting the existing prefix or changing child history.

##### Evidence attribution

```markdown
The user selected the following saved Artifact evidence to accompany this conclusion. This does not state that the assistant used it when producing the conclusion.
```

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only a direct ordinary manual branch and child-owned durable assistant conclusion are eligible.
- One return attaches a saved particle observation or one compatible pair. It does not infer causality, edit a conclusion or merge chats automatically.
- The complete-message limit can reject large source snapshots; existing saved observations are retained.

<a id="dev-note"></a>
### Dev Note

See [branch verification](../../../docs/subsystems/branch.md#verification) for the shipped confirmation path.
