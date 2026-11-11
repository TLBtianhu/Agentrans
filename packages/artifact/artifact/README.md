---
description: "Session-backed HTML and SceneSpec artifacts, model-facing create/update tools, and user-confirmed interaction messages."
kind: "package-reference"
---

# @agentrans/artifact

English | [中文](README.zh.md)

## Summary

This package owns durable HTML and SceneSpec Artifacts: complete snapshots with a stable id, compare-and-set revisions, semantic presentation, and model-facing `artifact` and `scene` tools. Its stable Remote `submitAction` and legacy `record` convert user-confirmed actions into text `UserMessage`s; actions never grant filesystem, network, or approval authority.

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

Mount the service as `@agentrans/artifact`, the HTML tool as `@agentrans/artifact/tool`, and the SceneSpec tool as `@agentrans/artifact/scene-tool`. The service requires Session Projection and awaits registration before synchronous reads. It owns validation, current-revision lookup, and Session commits. Each tool prepares a snapshot but commits it only after its authoritative successful tool result. SceneSpec validation uses the versioned SceneCatalog and a safe expression parser, never `eval`.

| Config | Default | Meaning |
|---|---|---|
| `maxSourceBytes` | `262144` | Maximum UTF-8 bytes of one complete HTML source |
| `maxActionBytes` | `16384` | Maximum UTF-8 bytes of the complete encoded action message |
| `maxSavedObservationsPerArtifact` | `32` | Maximum named observations; additional saves are rejected |

A create starts at revision 1. An update supplies `baseRevision` and succeeds only when it equals the current durable revision. Every `artifact/upsert` contains the complete `ArtifactSnapshot`, never a delta.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

An Artifact can post `{ kind: 'artifact-action', artifactId, revision, action, payload }` to its parent. This proposes user intent; UI policy decides when human confirmation is required. `wake: false` uses `agent.inject`; `wake: true` uses `agent.steer`.

`submitAction(agent, request)` accepts a trusted Client-minted `requestId` with the complete frozen action. That id becomes the existing user message id; source kind and complete action text retain their existing meanings. [Session input](../../session/session-input/README.md) checks the original acceptance before current revision and size checks. Identical accepted retries do not send again, even after source replacement or queue cancellation; conflicting source/content under the same id is rejected. Delivery mode applies only at first acceptance, not on a later retry. The exact frozen payload must be retained, including its encoded text order.

Stable submission requires Session input and the exact live root Agent. Remote calls require the owner principal; the request cannot supply caller attribution. Known refusal, identity conflict, service unavailability and unconfirmed dispatch are distinct. The synchronous `record` method remains available to legacy callers, creates a fresh identity each time and does not provide safe retry. Source creation and legacy use do not activate Session input.

Scene snapshots use `format: 'scene'` and a complete `spec`. The catalog validates function plots, flowcharts, particle systems, timelines, network graphs, and maps. Invalid expressions, parameter ranges, and references are rejected before commit.

The DOM-free `capabilities` entry exposes `getArtifactSourceCapabilities(snapshot)`. The SceneCatalog owns the source declaration for each primitive: particles support Host-recomputed observations, saving, restoration, fixed saved-pair comparison and question context; other native scenes support HTML export from source defaults. Particle export can preserve a checkpoint or use source defaults. HTML question context retains program-reported state or errors; it does not gain Host-calculated observations, saved checkpoints, restoration, fixed comparison or HTML export. These declarations neither enable optional services nor grant permission, report renderer readiness or verify a result. Each operation still validates its source and inputs.

The `runtime-values` entry supplies shared JSON traversal and diagnostic limits. Its bounded lossless plain-data subset rejects negative zero, sparse arrays, accessors, symbols, extra array properties and non-plain objects instead of changing or discarding reported data. Browser parsing, the isolated program bridge and Host question admission use this validator; it neither executes getters nor verifies the values reported by a program.

The DOM-free `@agentrans/artifact/particle-runtime` entry supplies the same fixed-step particle calculation to previews and standalone exports. Its versioned checkpoint records a step count and requires the same SceneSpec and revision for restoration. Observation output converts `-0` to `0` for JSON; internal integration state is unchanged. It does not persist state or grant execution permissions.

The browser-safe `scene-renderers` and `scene-export` entries own the shared canvas calculations and standalone HTML generator. Every renderer takes a resolved `ScenePalette` and draws only from its roles — ink, muted ink, accent, success, surface, grid, four series colors, and a highlight — so it never reads the document and one sheet retints all native scenes. `resolveScenePalette(read)` maps those roles onto `--dsw-alias-*` custom properties and throws `ScenePaletteError` naming the missing role instead of drawing transparent ink. `SCENE_STYLE_PALETTES` declares the palette owner for each style: `editorial` draws from the host palette, while `transit-map`, `blueprint`, `math-proof-lecture` and `particles` are `self-contained` styles that keep their own deliberate palette. `buildSceneAnimationHtml(spec, title, checkpoint?, origin?)` embeds optional fixed source identity and replay conditions as escaped JSON. An export has no host theme, so it pins both of its own palettes and hands the matching one to the same renderers. Export generation uses source defaults for non-particle scenes; it does not capture browser-local sliders, selection, or iframe state. Durable file generation and retry receipts belong to the separate [Artifact export service](../artifact-export/README.md).

Saved particle observations keep their complete source revision and Host-recomputed values. Saving appends a whole-list event without waking the Agent. The opened Session projection supplies observations; compact summaries omit them. Explicit sending can reference an older revision and deduplicates accepted retries from durable inbox and user-message receipts. First-admission live actions retain current-revision validation; accepted stable retries return their original acknowledgment before that validation. See [saved observation semantics](../../../docs/subsystems/artifact.md#presentation-and-recovery).

The browser-safe `observation-comparison` entry resolves a fixed control/variant pair at common runtime version, time step and step count. `confirmObservationComparison` reads both saved references in the current Session and admits one `comparison.completed` input for that ordered pair. It uses the saved source revisions, rejects incompatible conditions, and does not accept Client-computed values. Individual sends and comparison sends have independent admission receipts.

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

- Durable state covers source, revision, and semantic action messages, not iframe JavaScript heap, canvas pixels, scroll position, or unconfirmed pending actions.
- Revision checks are serialized by the enclosing Agent operation; they are not a cross-process transaction.
- The service does not execute or sanitize HTML. Execution belongs to the Client's opaque iframe and content policy.

<a id="dev-note"></a>

### Dev Note

None.
