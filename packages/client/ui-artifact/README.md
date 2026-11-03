---
description: "Sandboxed HTML and native SceneSpec Artifact cards for the Web GUI: revision replacement, source inspection, and user-confirmed actions sent to the owning Agent."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-artifact

English | [中文](README.zh.md)

## Summary

Read interactive HTML Artifacts beside the conversation that produced them. Each checkpoint renders independently, including when history contains only the latest revision. You can switch between inline and expanded views, inspect the HTML source, and send an Artifact action only after explicit confirmation. The preview runs without access to the parent application or remote dependencies. A `function-plot` SceneSpec renders natively through the shared safe expression parser, with direct confirmation of the current analysis.

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

Mount this plugin with the Conversation, Chat, locale, and Artifact Remote services in the Web composition. It has no package configuration fields.

### Reading and acting on an Artifact

The card shows the Artifact title and revision. An incoming revision replaces the rendered document and the iframe browsing context while retaining the Conversation Node identity. The presentation field selects the initial inline or expanded layout; local controls can switch layout or show the source instead.

The SceneHost also supports beside and picture-in-picture placements. These are `ViewRequest` intents, not arbitrary window-control permissions. Users can move between inline, beside, focus, and PiP while keeping the same iframe, current revision, and pending actions. Overlay ancestors are marked visible so virtualized history cannot hide the scene. The scene shows its current conversation or parent branch origin; **View in conversation** returns to inline and scrolls to the source anchor without resetting the Artifact.

An iframe action first enters a bounded pending queue in the card. Click **Send to Agent** to record the first pending action with `wake: true`. Nothing wakes the Agent merely because an iframe emitted a message. A failure keeps the action visible and offers a retry; a successful send removes only that submitted action. A full queue rejects additional actions with an inline explanation until a send frees capacity.

### Isolation and input limits

The preview uses `srcDoc` with `sandbox="allow-scripts"` and never grants same-origin access. Its CSP permits inline scripts and styles plus data or Blob images and media, while blocking network connections, remote dependencies, forms, nested frames, plugins, workers, and navigation. Parent message handling also requires the current iframe's `contentWindow`; an origin string is not an identity check.

Action messages must match the mounted Artifact id and positive revision and contain the exact five-field schema with a JSON payload. The complete serialized message is limited to 16,384 UTF-8 bytes. Payloads are limited to 32 nested values and 2,048 total values; cards retain at most 32 pending actions.

### Comparison groups

Snapshots with `comparison: { group, role }` use a separate Conversation Definition. Control and variant render side by side while keeping independent parameters and revisions. Shared `artifact-command` messages synchronize play, pause, step, and reset. Local `artifact-state` reports supply current parameters for comparison; they do not wake the Agent. **Compare results** admits one `comparison.completed` action through the control Artifact with both current states.

### SceneSpec primitives

The [function-plot template](../../../.agents/skills/artifact-design/references/function-plot.html) demonstrates a declarative mathematical SceneSpec: two functions, parameter sweep, viewport pan/zoom, trace, derivative, and integral. It reports local state for comparison and admits `plot.inspected` only after user confirmation. The [flowchart template](../../../.agents/skills/artifact-design/references/flowchart.html) applies the same pattern to nodes, edges, selectable concepts, and path advancement, with confirmed `flow.inspected` state. The [particle-system template](../../../.agents/skills/artifact-design/references/particle-system.html) adds deterministic physical simulation with fixed time steps and confirmed `physics.inspected` position and velocity. Use these as references for adding primitives rather than creating a separate plugin per subject.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The Conversation Definition treats every `artifact/upsert` as a complete start-capable checkpoint. Later events for the same Artifact id replace state through `update`, while the Node keeps `context.key` and its original anchor. The keyed `conversation.chat.node` renderer receives a narrow Session Remote callback through Slot injection; the component never receives Cordis context or a transport object.

A revision change remounts the card, which retires the old listener, browsing context, pending queue, and transient view state. Message parsing uses iterative JSON validation to avoid recursive call-stack growth. Pending state is component-local and is not a durable record of Host admission.

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-artifact](../../artifact/artifact/README.md) — owns durable snapshots, action admission, and the Host Remote method.
- [Conversation assembly](../../../docs/subsystems/conversation.md) — defines checkpoint replay and stable Node identity.
- [Web Client Slots](../../../docs/subsystems/slots.md) — defines Session-scoped injection and keyed renderers.
- [HTML document preview](../ui-sidebar-documentpreview/README.md) — provides the adjacent opaque-iframe isolation patterns.

-----

<a id="model-experience"></a>
## Model Experience

### Artifact presentation and actions

#### What the model sees

The model sees the Host-owned Artifact tool and any confirmed action admitted as ordinary user input. This browser package does not invent another model-history channel: `artifact/upsert` is log-only, while the action becomes a bounded JSON text block.

#### Token effect

No Artifact source is added to a model request by rendering it. A confirmed action adds only its bounded JSON text; pending, cancelled, and rejected actions add nothing.

#### KV Cache effect

Revisions and view changes do not directly rewrite the model prefix. Only a Host-admitted action creates new model-visible history, under the ordinary cache rules.

##### Browser boundary

```markdown
Rendering does not make Artifact source model-visible; only a Host-admitted action adds history.
```

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Remote dependencies are unavailable** — self-contained HTML must use inline code and styles with permitted local data or Blob resources.
- **Pending actions are transient** — a revision change, page reload, or unmount discards them before Host admission; the Artifact must emit the action again.
- **Focus is card-local** — the expanded presentation does not create a separate dialog or persist a viewing preference.

<a id="dev-note"></a>
### Dev Note

jsdom tests verify attributes, parsing, listener ownership, and component behavior; `tests/browser-smoke.mjs` checks iframe isolation and network denial. The keyless [Artifact interaction scenario](../../../apps/web/tests/artifact-interaction.e2e.ts) additionally verifies model-driven create/update, a real browser counter click, and confirmation-only action admission through the shipped Web composition. The [teaching Artifact scenario](../../../apps/web/tests/teaching-artifact.e2e.ts) covers prediction, launch, result comparison, and Agent feedback, using a user-declared `custom-provider` model route (`Custom Lab Model`). The [artifact-design skill](../../../.agents/skills/artifact-design/SKILL.md) supplies the shared design tokens, templates, motion primitives, and screenshot-review checklist.
