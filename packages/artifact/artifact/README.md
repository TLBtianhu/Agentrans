---
description: "Session-backed HTML and SceneSpec artifacts, model-facing create/update tools, and user-confirmed interaction messages."
kind: "package-reference"
---

# @deepseek-ai/dsh-artifact

English | [中文](README.zh.md)

## Summary

This package owns durable HTML and SceneSpec Artifacts: complete snapshots with a stable id, compare-and-set revisions, semantic presentation, and model-facing `artifact` and `scene` tools. Its Remote `record` method converts a user-confirmed action into an ordinary text `UserMessage`; actions never grant filesystem, network, or approval authority.

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

Mount the service as `@deepseek-ai/dsh-artifact`, the HTML tool as `@deepseek-ai/dsh-artifact/tool`, and the SceneSpec tool as `@deepseek-ai/dsh-artifact/scene-tool`. The service owns validation, current-revision lookup, and Session commits. Each tool prepares a snapshot but commits it only after its authoritative successful tool result. SceneSpec validation uses the versioned SceneCatalog and a safe expression parser, never `eval`.

| Config | Default | Meaning |
|---|---|---|
| `maxSourceBytes` | `262144` | Maximum UTF-8 bytes of one complete HTML source |
| `maxActionBytes` | `16384` | Maximum UTF-8 bytes of the complete encoded action message |

A create starts at revision 1. An update supplies `baseRevision` and succeeds only when it equals the current durable revision. Every `artifact/upsert` contains the complete `ArtifactSnapshot`, never a delta.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

An Artifact can post `{ kind: 'artifact-action', artifactId, revision, action, payload }` to its parent. The Host validates the current revision and complete message size before routing the action. `wake: false` uses `agent.inject`; `wake: true` uses `agent.steer`. UI policy decides when a human review is required.

Scene snapshots use `format: 'scene'` and a complete `spec`. The current catalog supports `function-plot` with functions, bounded parameters, viewport, and trace settings. Unknown variables or functions, invalid parameter ranges, and non-finite expression results are rejected before commit.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Artifact subsystem](../../../docs/subsystems/artifact.md) — protocol values and durable semantics.
- [Artifact Client](../../client/ui-artifact/README.md) — sandboxed HTML presentation and confirmed actions.
- [Conversation assembly](../../../docs/subsystems/conversation.md) — stable event-to-node correlation.

-----

<a id="model-experience"></a>
## Model Experience

### scene

#### What the model sees

The `scene` tool accepts `action`, `kind`, `sceneId`, `title`, a complete `spec`, `presentation`, and update-only `baseRevision`. Its result repeats only `sceneId`, `revision`, `title`, `kind`, and `presentation`. SceneSpec JSON is validated before commit; it is not HTML and does not execute model-generated JavaScript.

#### Token effect

The scene tool adds one bounded JSON schema per selected preset. Results are short and contain no source.

#### KV Cache effect

Creating or updating a scene appends a log-only event and does not rewrite the model prefix.

### artifact

#### What the model sees

The `artifact` tool accepts `action`, `artifactId`, `title`, `source`, `presentation`, optional `comparison`, and update-only `baseRevision`. `comparison` is an optional `{ group, role: 'control' | 'variant' }` relation; it does not merge the two snapshots. Its result repeats only `artifactId`, `revision`, `title`, and `presentation`, not the HTML source. The tool description carries the iframe message format and the rule that actions are input rather than authorization.

#### Token effect

One tool schema is mounted per selected preset. Create/update results add only a short JSON value. Action messages contain one bounded JSON text block and can be reconstructed as ordinary user input.

#### KV Cache effect

Creating or revising an Artifact appends a log-only event and does not rewrite an earlier model prefix. Admitting an Artifact action adds ordinary user input under the receiving Agent's normal cache rules.

##### Artifact actions

```markdown
A confirmed action becomes one bounded user message; it grants no additional authority.
```

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The current SceneCatalog supports only `function-plot`; flowchart and particle-system remain reference HTML templates until their native SceneSpec migrations.
- Durable state covers source, revision, and semantic action messages, not iframe JavaScript heap, canvas pixels, scroll position, or unconfirmed pending actions.
- Revision checks are serialized by the enclosing Agent operation; they are not a cross-process transaction.
- The service does not execute or sanitize HTML. Execution belongs to the Client's opaque iframe and content policy.

<a id="dev-note"></a>
### Dev Note

None.
