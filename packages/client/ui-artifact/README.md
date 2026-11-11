---
description: "Sandboxed HTML and native SceneSpec Artifact cards for the Web GUI: revision replacement, source inspection, and user-confirmed actions sent to the owning Agent."
kind: "package-reference"
---

# @agentrans/client-ui-artifact

English | [中文](README.zh.md)

## Summary

Read interactive HTML Artifacts in the conversation that produced them. Each checkpoint renders independently, including restored history. A card stays in the message flow by default and can be docked, expanded, or floated. You can inspect the HTML source and send an Artifact action only after explicit confirmation. The preview runs without access to the parent application or remote dependencies. Six SceneSpec primitives (function-plot, flowchart, particle-system, timeline, network-graph, map) render natively through the shared safe expression parser, with direct confirmation of the current analysis. An optional `style` field selects the visual idiom.

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

Mount this plugin with the Conversation, Chat, locale, and Artifact Remote services in the Web composition. The Client option `runtimeCommandTimeoutMs` defaults to `10000` and bounds each authored command acknowledgement. The Web Host also mounts the [runtime report service](../../artifact/artifact-runtime/README.md).

### Reading and acting on an Artifact

The card shows the Artifact title and revision. An incoming revision replaces the rendered document and the iframe browsing context while retaining the Conversation Node identity. The presentation field selects the initial placement; one control switches between the four views and shows the source instead.

**Inline** keeps the card in the message flow, so it scrolls and wraps with the conversation instead of covering it. **Dock** fixes a persistent result pane to the right edge: the conversation body reserves that width and the transcript narrows instead of being covered, and the pane starts below the Session header. **Expand** presents the card over the whole window, and Escape returns to inline. **Float** keeps a small auxiliary pane in the corner. Placements are `ViewRequest` intents, not window-control authority. Every placement keeps the current revision and the pending actions; the preview itself remounts when the card leaves the flow. Returning to inline scrolls the Artifact's own row back into view. The card also shows the current conversation or the parent branch title. A restored checkpoint never expands on mount; only a live turn may request that presentation.

Placement is shared per Session, not per card. Docking a second Artifact adds a background tab to the same pane instead of covering the first, closing the active tab selects its neighbour, and closing the last tab releases the reserved width. Only one float and one expanded view exist at a time, and one Artifact owns only one detached surface, so docking, floating, or expanding it moves it rather than opening another pane. Unmounting the Conversation Node releases every surface it owned. The branch action forks an independent inquiry from the Artifact's checkpoint, the export action downloads a self-contained HTML animation of the SceneSpec with an inline parser and a deterministic timeline player, and the exported page itself offers a WebM download button that records the same replay through the canvas stream and MediaRecorder.

An iframe action first enters a bounded queue of unconfirmed proposals in the card. Click **Send to Agent** to confirm the first proposal with `wake: true`. Nothing wakes the Agent merely because an iframe emitted a message. A successful send removes only the submitted proposal, preserving later queued actions. A full queue rejects additional proposals with an inline explanation until a send frees capacity.

Native confirmations, confirmed iframe actions and current-analysis comparisons share one submission lifecycle. Before dispatch, the owner freezes a stable request id, Artifact id, revision, action, complete payload and `wake`. While sending or awaiting confirmation of an unknown outcome, further confirmations are disabled and local experiments remain usable. The original request stays visible across source, view and revision changes. **Retry original action** resends exactly that request; an accepted retry adds no duplicate input. **Dismiss local retry** releases the local request without withdrawing input the Host may already have accepted.

<a id="chat-route"></a>

Root chats and ordinary manual branches expose Host operations. Subagent chats hide action confirmation, observation save/send, comparison send, question-context selection and saved HTML export creation/download. Local previews, controls, source inspection, saved-history browsing and restoration remain available, as does local WebM recording. Retained requests remain readable with retry disabled. Components derive this distinction from the current Session route; injected callbacks enforce it again before calling the Host.

### Isolation and input limits

The preview uses `srcDoc` with `sandbox="allow-scripts"` and never grants same-origin access. Its CSP permits inline scripts and styles plus data or Blob images and media, while blocking network connections, remote dependencies, forms, nested frames, plugins, workers, and navigation. Parent message handling also requires the current iframe's `contentWindow`; an origin string is not an identity check.

Standalone SceneSpec exports embed model strings as JSON data and create label and readout text through DOM text nodes. A label cannot introduce markup or close an exported script element.

Action messages must match the mounted Artifact id and positive revision and contain the exact five-field schema with a JSON payload. The complete serialized message is limited to 16,384 UTF-8 bytes. Payloads are limited to 32 nested values and 2,048 total values; cards retain at most 32 pending actions.

### Runtime readiness and supported operations

Each physical preview opens a revision-bound live report stream. Native canvases report ready only after a 2D context exists and the draw succeeds; particle numerical failure retains its code and bounded diagnostic. Native local controls are not declared as iframe bridge commands. A source declaration from `getArtifactSourceCapabilities` describes recomputable business operations, separately from a running preview, installed services and permissions.

Authored HTML opts in with `window.artifactRuntime.ready({ state: () => value, commands: { step: () => advance() } })`. Only actual callbacks declare support. `reportState(value)` publishes local state after state support was declared; `error(message)` reports a bounded failure. Startup script errors and unhandled promise rejections report failures. The injected bridge runs before authored scripts, while iframe load only requests the current report. An old document without readiness callbacks remains previewable and supports explicit action confirmation, but offers no shared playback controls.

Messages carry the exact Artifact id, revision and physical runtime id; the parent also checks the current iframe window. Source inspection, preview reopening and source replacement release the old stream and require a new identity. A lost stream clears its readiness evidence and offers to reopen the preview. Reports are live Client claims, not Host verification of rendered pixels or experiment correctness; publishing them creates no model input. Host delivery and local renderer readiness remain separate, and unavailable or denied report delivery is visible.

Shared HTML controls use only the ready pair's declared command intersection. The bridge awaits each real callback before acknowledging its request id. Controls remain pending until both sides acknowledge; errors, partial execution and missing acknowledgements remain visible without automatic replay. Closing the Session binding releases streams and pending commands. These reports and command outcomes are transient; only explicit confirmation or a model tool's logged inspection enters model history.

### Comparison groups

Snapshots with `comparison: { group, role }` use a separate Conversation Definition. Control and variant retain independent parameters and revisions. HTML and non-particle current-analysis comparisons use reports bound to both current source revisions. Shared playback controls require both iframe runtimes to report ready and declare the command. State reports do not wake the Agent. **Compare results** admits both current analyses through the current control revision.

For native particle comparisons, save an observation on each side and select **Use for comparison**. Each selection opens that observation's complete source read-only; **Return to latest** clears that side's selection. Both observations must share runtime version, time step and step count. **Send comparison** submits only the two saved references; the Host recomputes the values. The same ordered pair is admitted once per Session. Selection survives source revision changes but is local and must be repeated after reload. Saved observations remain available. When current HTML sources also have saved particle observations, an explicit mode choice separates the live and saved comparison paths.

An unknown saved-comparison outcome retains the submitted references for identity-safe retry. Cancel retry to change the selection; cancellation does not withdraw an input already admitted by the Host. A known rejection ends the request and explains whether to refresh missing evidence, create a smaller experiment, or choose compatible observations.

### SceneSpec primitives

The [function-plot template](../../../.agents/skills/artifact-design/references/function-plot.html) demonstrates a declarative mathematical SceneSpec: two functions, parameter sweep, viewport pan/zoom, trace, derivative, and integral. It reports local state for comparison and admits `plot.inspected` only after user confirmation. The [flowchart template](../../../.agents/skills/artifact-design/references/flowchart.html) applies the same pattern to nodes, edges, selectable concepts, and path advancement, with confirmed `flow.inspected` state. The [particle-system template](../../../.agents/skills/artifact-design/references/particle-system.html) adds deterministic physical simulation with fixed time steps and confirmed `physics.inspected` position and velocity. Use these as references for adding primitives rather than creating a separate plugin per subject. Wheel scrolling over an inline plot never hijacks the conversation: zooming requires Ctrl/Cmd+wheel, while ordinary wheel motion keeps scrolling the message flow.

Function plots leave gaps where a mathematical sample is undefined. Native previews and animation exports share numerical analysis; unavailable values display as `—` and become `null` in confirmed action and comparison payloads. Missing parameters and invalid expression trees remain errors. Numerical sampling does not detect every discontinuity or establish symbolic derivatives or improper integrals.

Native particle previews and exports share fixed-step explicit-Euler calculation. A card retains its current run across source inspection and placement changes, and exports replay from that step. Hidden previews pause. Revision changes and card unmounts discard unsaved runs. Numeric failure stops advancement, retains the last finite state, and offers Reset.

On a particle card, name an experiment and choose **Save observation**. Saved observations survive reload and reopening the Session. **Restore** opens the saved source revision read-only, even when the latest source has another format; **Return to latest** returns to the paused current run. Exports use the displayed source and checkpoint. Saving and restoring never send model input. A standalone card's **Send to Agent** explicitly admits the saved values once per Session; accepted retries do not duplicate input. Pending save identities survive source, placement, and revision changes so retries refer to the same request. Comparison cells select observations for the pair instead of sending them individually.

A full saved list or a changed source revision receives a specific explanation and ends that rejected save request. Existing observations remain available to restore and send. An unknown save outcome retains the request identity for retry; cancelling that retry does not undo a save that the Host may already have accepted.

### Fixed-source HTML export

Standalone Scene cards and comparison cells expose **Export animation**. The Host freezes the displayed source revision and particle checkpoint, persists the result file, and then the platform file-actions service handles download. Other Scene kinds export source defaults; local parameter sliders and selections are not captured. The saved export list survives reload and source updates, and **Download HTML** reads the original verified file without generating a new one.

An unknown generation outcome keeps its complete request and original conditions for **Retry export**. Dismissing that retry does not cancel work or delete a possibly committed result. A restored pending record has no confirmed producer or result; **Continue export** explicitly uses its original input. Failed records retain their failure and need a new export identity for another attempt. File readiness, a browser download request, actual native saving and download cancellation are reported separately. None of these operations sends model input.

### Asking about the selected experiment

Choose **Use for next question** on a current particle experiment or restored saved observation, or **Use comparison for next question** on a compatible saved pair. The composer shows a removable question-context chip. Typing and sending a normal question freezes the live particle checkpoint or saved references before asynchronous work. The Host recomputes facts and includes the complete original conditions in the same ordinary message. Selection, playback and clearing the chip send nothing by themselves.

Current selection is tied to the selected revision and mounted run. A source update or released run requires reselection or removal, instead of silently using another experiment. Saved references retain their original source. Selection does not persist across reload. Other native scene state is not attached by this capability. Selection callbacks and capture follow the [chat route restrictions](#chat-route).

On an HTML preview, **Use program report for next question** binds that particular physical preview. Sending freezes the latest state or error already received from it, independently of later messages or preview closure. This is a program report, not an instantaneous read of its heap or a Host-recomputed result. Ready previews need a declared state reader and an actual received state; `null`, `false`, `0` and an empty string remain valid values. An error can be attached without state. Starting previews, missing state and unsupported state reporting receive distinct guidance.

The HTML choice stores only source and runtime identity, title and availability. Same-instance ready/error changes and newly received state update what a future send captures; payloads are never mirrored into the choice. A temporarily withdrawn state capability can recover with fresh state from the same instance. Source replacement, physical remount or report-connection loss invalidates the choice until explicit reselection. A captured request stays detached and immutable; the generic submit owner retries its original content even after the chosen preview changes or disappears. The Host still rejects a source revision that changed before initial prompt admission. Selection and removal create no model input.

### Returning a branch conclusion with evidence

On a durable assistant conclusion in an ordinary manual branch, **Return with evidence** previews that conclusion and lets the user select a saved observation or compatible pair visible in the branch. The preview identifies the original source revision and checkpoint. Inherited baseline observations are eligible; later parent and sibling facts are not. Preview, selection and cancellation send no input.

Confirmation sends only the parent, branch, conclusion seq and saved references to the [Artifact branch bridge](../../artifact/artifact-branch/README.md). It appends the conclusion with self-contained evidence to the parent without starting a model turn or replacing parent Artifacts. An unknown outcome locks the original request and preview for retry. A changed selection for an already returned conclusion conflicts and offers to open the parent. Missing evidence, oversized content and unavailable services receive specific recovery instructions. Custom GUI Hosts must mount the bridge to enable admission.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The Conversation Definition treats every `artifact/upsert` as a complete start-capable checkpoint. Later events for the same Artifact id replace state through `update`, while the Node keeps `context.key` and its original anchor. The keyed `conversation.chat.node` renderer receives a narrow Session Remote callback through Slot injection; the component never receives Cordis context or a transport object.

A revision change remounts the revision-specific preview, retiring its listener, browsing context, unconfirmed iframe proposals and transient view state. The Artifact owner above that preview retains pending observation-save identities and confirmed action requests. Current comparisons use the same submission helper with their own local owner. Message parsing uses iterative JSON validation to avoid recursive call-stack growth. These owners are component-local, not durable records of Host admission.

-----

<a id="further-exploration"></a>
## Further Exploration

- [@agentrans/artifact](../../artifact/artifact/README.md) — owns durable snapshots, action admission, and the Host Remote method.
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

Rendering Artifacts does not add source to model requests. Only Host-admitted actions add bounded JSON text. Unconfirmed iframe proposals add none; dismissing a local retry does not remove already admitted text.

#### KV Cache effect

Revisions and view changes do not directly rewrite the model prefix. Only a Host-admitted action creates new model-visible history, under the ordinary cache rules.

##### Browser boundary

```markdown
Rendering does not make Artifact source model-visible; only a Host-admitted action adds history.
```

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Remote dependencies are unavailable** — self-contained HTML must use inline code and styles with permitted local data or Blob resources.
- **Proposals and retry requests are transient** — revision changes discard unconfirmed iframe proposals. Confirmed unknown requests survive revision and view changes, but disappear when their card or comparison owner unmounts or the page reloads; this does not undo Host admission.
- **Leaving the flow remounts the preview** — native particle state belongs to the card and survives placement and source-view changes. Hidden particle previews pause; a new revision or card unmount releases that run. Other previews still restart their local state when remounted.
- **Background dock tabs stay mounted** — only the active tab is painted, so switching tabs does not rebuild the preview, but moving between inline and a detached surface still remounts it.
- **Focus is card-local** — the expanded placement does not create a separate dialog or persist a viewing preference.

<a id="dev-note"></a>
### Dev Note

jsdom tests verify attributes, parsing, listener ownership, and component behavior; `tests/browser-smoke.mjs` checks iframe isolation and network denial. The keyless [Artifact interaction scenario](../../../apps/web/tests/artifact-interaction.e2e.ts) additionally verifies model-driven create/update, a real browser counter click, and confirmation-only action admission through the shipped Web composition. The [teaching Artifact scenario](../../../apps/web/tests/teaching-artifact.e2e.ts) covers prediction, launch, result comparison, and Agent feedback, using a user-declared `custom-provider` model route (`Custom Lab Model`). The [artifact-design skill](../../../.agents/skills/artifact-design/SKILL.md) supplies the shared design tokens, templates, motion primitives, and screenshot-review checklist.
