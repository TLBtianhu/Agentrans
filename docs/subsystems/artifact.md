# Artifact

English | [中文](artifact.zh.md)

An Artifact is a versioned, code-generated interactive explanation. Its durable source is complete HTML or a SceneSpec; frames, screenshots, videos, and downloads are projections or exports.

## Protocol values

`ArtifactSnapshot` contains:

| Field | Meaning |
|---|---|
| `artifactId` | Stable branded id within the owning Session |
| `revision` | Positive safe integer, starting at 1 and increasing by one per accepted update |
| `format` | `html` or `scene` |
| `title` | Trimmed 1–120 character display title |
| `source` / `spec` | Complete self-contained HTML or validated SceneSpec, selected by `format` |
| `presentation` | Semantic placement request: `inline` or `focus` |
| `comparison` | Optional `{ group, role: 'control' | 'variant' }` relation for independent comparison scenes |

Every `artifact/upsert` Session event carries a complete snapshot. Later events for the same id supersede earlier revisions. A tail containing only the latest upsert still renders the current Artifact.

`SavedParticleObservationRef` names an Artifact and a saved observation in the current Session, including inherited observations. `ParticleObservationComparison` fixes an ordered control/variant pair with each reference, label, source revision and computed values. Its common conditions record runtime version, time step, step count and elapsed time; it does not infer a causal conclusion.

## Mutation and action semantics

The `artifact` tool creates or updates a snapshot. Creation rejects an existing id; update requires the current revision as `baseRevision`. The snapshot commits only after the authoritative tool result succeeds. Failures, cancellation, stale revisions, and post-execute blocks do not commit.

`record` accepts an action only for the exact live root Agent and current revision. It validates the action name and complete UTF-8 message size, then creates an ordinary `UserMessage` with `source.kind = 'artifact-action'`. Its single text block contains bounded JSON with `kind: 'artifact_action'`, the id, revision, action, and payload. `wake` selects `agent.steer` or `agent.inject`.

`submitAction` accepts an `ArtifactActionRequest` containing a Client-owned `MessageId`, the complete original action fields and `wake`. The optional [shared input admission service](../../packages/session/session-input/README.md) freezes in-flight requests and deduplicates accepted own-Session message identities. Equal retries return the original acknowledgment without waking the Agent; changed content conflicts. The service checks the exact live root Agent and owner principal before admission. Accepted retries survive source changes, queue cancellation and replay. Legacy `record` mints a new identity on every call and has no safe-retry guarantee.

Artifact actions are user intent, not authority. They cannot approve a tool, read a file, open a socket, or bypass policy. The action payload is not a new LLM content block or Session event type. Revision- and runtime-bound local messages carry declared state and acknowledged commands. These messages do not wake the Agent; only the confirmed `comparison.completed` action includes both independent states.

`confirmObservationComparison` resolves two saved references through the Artifact Projection. The saved sources must name different Artifacts in the same group with control and variant roles, and share runtime version, time step and step count. The DOM-free `observation-comparison` entry supplies these rules and recomputes both observations for Client review and Host admission. The Host accepts references, not caller-supplied numbers. A rejection admits no input.

Confirmation emits `comparison.completed` with a `saved-particle-observation-comparison` payload through the saved control source revision, even after newer sources exist. `ArtifactObservationComparisonResult` acknowledges the resolved pair. Own-Session inbox and user-message receipts deduplicate each ordered pair independently of individual observation sends; inherited receipts do not block child admission. No comparison event or separate ledger is added. A new generic live action requires the current revision; an accepted stable-request retry returns its original acknowledgment before revision validation.

### Branch evidence return

The optional `artifact-branch` Host plugin owns `artifactBranchResults.returnResult`. `ArtifactBranchResultRequest` names the direct parent, child branch, child-owned conclusion seq and `ArtifactBranchEvidenceSelection`: either an observation reference or a comparison group with ordered control/variant references. It declares both Session resources and resolves all evidence from the same child cut as the conclusion. The main Artifact service has no dependency on this Web bridge.

The parent receives an ordinary `branch-result` message with the visible conclusion and additional user-selected evidence text. Each observation includes its complete original source, checkpoint and recomputed values; comparisons share the pure compatibility rules above. Source copies never update the parent's Artifact namespace. These are user-attached observations, not a claim about which facts the assistant used earlier. Shared [branch admission](branch.md#confirmed-result-return) prevents a second return of the same conclusion with different content and preserves identical retries after unknown outcomes.

`artifact-branch/evidence-unavailable` reports `ArtifactBranchEvidenceFailure` for missing observations, unavailable projections or incompatible comparison conditions. `artifact-branch/result-too-large` reports the configured complete-message limit. Both reject before a new append. Existing `branch-result` source fields and Session event types are unchanged; released readers and SDKs retain the evidence as ordinary text blocks.

## Runtime readiness and supported operations

Source acceptance and runtime readiness are separate. The pure `capabilities` entry reads source-supported operations from SceneCatalog: particle observation, saving, restoration, fixed comparison and recomputed question context use versioned particle semantics; HTML question context is explicitly `program-reported`, and Scene HTML export declares checkpoint or source-default conditions. These declarations do not establish that an optional plugin is mounted, a caller has permission, or a renderer is running. `currentSnapshot` reads an independent current source from the Artifact service's prepared Projection without opening history.

The `artifact-runtime` service owns one live report per attached physical runtime. Its duplex `attach` stream names the Session resource explicitly and never resolves or activates an Agent. Each report carries the source identity, revision and fresh `ArtifactRuntimeId`; current inspection accepts only the same Session's exact current source and matching renderer. Stream cancellation, disconnection, source replacement and disposal release reports. No live ready state is restored from history, and no report means no active report rather than successful execution.

Native previews report ready only after obtaining a Canvas context and completing an actual draw; calculation initialization alone is insufficient. HTML calls the injected `window.artifactRuntime.ready` after successful program initialization. Optional state and command callbacks declare only the bridge operations that program implements. An iframe load event does not establish readiness. Diagnostics are bounded, and parent receivers check the current frame and complete runtime identity. Reports remain Client/program claims, not proof of correct pixels, recomputable observations or causal conclusions.

Shared HTML commands require both current programs to report ready and declare the command. A request identity correlates each command with its callback-completion acknowledgment; missing or failed acknowledgment remains visible. A timed-out callback may already have effects, so the Client does not automatically retry it. Legacy HTML without the handshake still previews and may offer explicit user actions, but does not acquire undeclared controls or state capabilities.

The read-only `artifact_runtime` model tool inspects one exact current revision and optionally waits once for a ready/error report within a requested limit. Its ordinary `tool/result` logs every matching run, the wait outcome and remaining turn budgets; no report, still-starting timeout and disconnection remain distinct. A reported ready does not conceal another run's error. Waiting is event-driven, cancels with its caller and ends on source/Session/service changes; it never starts code or repeats a command. Tool policy bounds queries and source-update attempts for Artifacts whose runtime error the turn has read. These temporary counters reset at a new turn, not at a new revision, and add no runtime event, Projection or dynamic prompt input. Creation tools commit source after their successful results and never wait for a browser to acknowledge unpublished content. See the [runtime package](../../packages/artifact/artifact-runtime/README.md) and [runtime ownership decision](../../.agents/notes/implemented/architecture/2026-11-07-artifact-runtime-reports.md).

<a id="presentation-and-recovery"></a>
## Presentation and recovery

The Client correlates snapshots by `artifactId` and preserves Conversation identity across revisions. Revision changes replace the browsing context. The iframe uses an opaque origin and a restrictive content policy; the parent accepts only messages from the current frame with the current id/revision and a bounded JSON body.

The SceneHost supports `inline`, `beside`, `focus`, and `pip` placements. A `ViewRequest` expresses placement intent rather than window authority. A Session-scoped presentation store owns dock tabs and allows one floating and one focused surface. Placements retain the revision and pending actions, but previews remount when moving between the flow and a detached surface. Returning inline locates the original row. The card identifies its conversation source; branching uses the node's anchor sequence. Only a live turn can request initial focus. Inline plot zooming requires Ctrl/Cmd+wheel. SceneSpec export produces standalone HTML; its WebM button records playback through the canvas stream and MediaRecorder.

A comparison group uses its own Conversation Node to show control and variant side by side. HTML and non-particle current-analysis comparisons use reports bound to each current Artifact revision and mounted runtime. Shared commands target ready iframe previews that both declare support, and remain hidden for native scenes. Native particle comparisons select saved observations and display their original sources read-only; changing a live source does not replace a selected observation. Selection is local and must be repeated after reload; saved observations and admitted actions remain durable. Saved-pair retries retain references and use their existing admission receipt. Current-analysis confirmation uses the same stable action submission as native and HTML cards: it freezes the original request before asynchronous work, retains it across source/state changes and retries with the original identity. Dismissal clears only local retry state; it does not retract accepted input.

The SceneCatalog supports `function-plot`, `flowchart`, `particle-system`, `timeline`, `network-graph`, and `map` primitives: function plots use the shared safe expression parser for native rendering, flowcharts render nodes, directed edges, and an advancing path with a confirmed `flow.inspected` action, particle systems run a fixed-step simulation with velocity vectors and a confirmed `physics.inspected` action, timelines pair a horizontal timeline with a per-event detail card and a confirmed `timeline.inspected` action, network graphs use a deterministic force-directed layout with a confirmed `network.inspected` action, and maps position markers with a detail card and a confirmed `map.inspected` action. All six export a standalone HTML animation and a WebM recording of the same replay.

Function-plot previews and exports share finite sampling, centered derivatives, and trapezoid integration from zero. Undefined samples split curves; unavailable readings display as `—` and are represented by `null` in confirmed analysis. Exported labels are text, and embedded SceneSpec JSON cannot terminate a script element.

Native particle runs belong to one card revision. Source inspection and placement changes retain their step count; hidden previews pause, and a new revision or card unmount releases the run. Preview and HTML export use one explicit-Euler calculation with bounded trails. Export captures the current step and replays from it. Unsaved runs remain transient.

Standalone particle cards can save named observations. Each `SavedParticleObservation` has an `ArtifactObservationId`, the complete original scene revision, a versioned `ParticleCheckpoint`, and Host-computed values. `artifact/observations` carries the complete saved list for one Artifact; Session Projection restores it without model or runtime effects. The list is excluded from compact Session summaries. The default limit is 32 observations per Artifact; a full list refuses new saves rather than replacing an experiment.

Restoring selects a read-only preview of the saved source and checkpoint, including after the latest source changes revision or format. Returning to the latest source does not overwrite either revision. Saving and restoring never create Agent input. Explicit sending reads the durable observation and admits `physics.inspected` through the normal inbox; matching own-Session inbox or user-message receipts prevent duplicate admission on retry. Parent receipts do not prevent a child Session from sending its inherited observation. A new generic live action requires the current revision; an accepted stable-request retry returns its original acknowledgment before revision validation.

Durable recovery covers source snapshots, saved observations, and admitted action messages. Iframe JavaScript heap, unsaved runs, canvas pixels, scroll position and source-view state remain transient. A mounted card retains a confirmed unknown-result request across source revisions, but does not restore local retry state after full unmount or reload; retry or inspect history first. The Client exposes Host-only save, send, comparison and HTML export operations on root routes, including manual branches; subagent continuations retain local exploration. Route availability is separate from source capabilities and Host authorization. Older readers that do not recognize the required observation event refuse the Session; see the [upgrade guide](../upgrade-guide/v0.2.2-alpha.2/saved-artifact-observations/guide.md).

## Verification

The keyless [Artifact interaction scenario](../../apps/web/tests/artifact-interaction.e2e.ts) drives the shipped Web composition using the model-replay input in [session.v4.jsonl](../../apps/web/tests/fixtures/replay/artifact-interaction/session.v4.jsonl). It creates and updates an interactive counter, expands the completed process group, clicks the counter in a real browser, and confirms the pending action. The test checks revisions 1 and 2, no Artifact action or second turn before confirmation, and one parent-local `artifact-action` plus a second turn after confirmation.

The [teaching Artifact scenario](../../apps/web/tests/teaching-artifact.e2e.ts) applies the same path to a prediction lab. The user selects an angle, predicts a hit, launches, compares the actual result, and confirms the semantic action. The Agent then updates the Artifact to revision 2 with prediction feedback. This exercises observation, prediction, manipulation, and feedback rather than visualization alone. The replay also mounts a user-declared `custom-provider` model route, so the model picker shows `Custom Lab Model` instead of a built-in DeepSeek route.

The [legacy comparison scenario](../../apps/web/tests/comparison-artifacts.e2e.ts) groups control and variant parameter explorers under `damping-study`. Both old programs remain locally interactive, but their unscoped messages establish no shared controls or state capability; an explicit ordinary question remains ordinary user text. The [runtime scenario](../../apps/web/tests/artifact-runtime.e2e.ts) verifies declared shared commands, execution acknowledgments, model inspection of a failure, correction of the same Artifact, fresh preview identities and removal of reports after browser closure.

The [learning-journey scenario](../../apps/web/tests/artifact-learning-journey.e2e.ts) connects manipulation, a saved baseline, an ordinary contextual question, revision replacement, restoration and fixed-source export in one conversation. The [unconfirmed-comparison scenario](../../apps/web/tests/artifact-current-comparison-unknown.e2e.ts) loses a response after Host acceptance, preserves the original pair while local state changes, and requires explicit dismissal before a new send.

The [function-plot scenario](../../apps/web/tests/function-plot.e2e.ts) verifies a SceneSpec-driven mathematical scene: two functions, parameter sweep, zoom, derivative, integral, and one confirmed `plot.inspected` action with numeric tolerance for numerical analysis.

The [function-domain scenario](../../apps/web/tests/scene-function-domain.e2e.ts) replays a square-root boundary, confirms a nullable derivative, and opens the downloaded animation to check that model labels remain text and domain gaps remain usable.

The [flowchart scenario](../../apps/web/tests/flowchart.e2e.ts) verifies a SceneSpec-driven concept map: node selection, path advancement, zoom, and one confirmed `flow.inspected` action containing the selected concept and current step.

The [particle-system scenario](../../apps/web/tests/particle-system.e2e.ts) verifies a deterministic physical scene: two particles, fixed 1/30-second steps, gravity, trails, velocity vectors, and one confirmed `physics.inspected` action with position and velocity.

The [native particle runtime scenario](../../apps/web/tests/scene-particle-runtime.e2e.ts) verifies state retention across source and placement changes, exports the current six-step checkpoint, and checks the same values in the exported program and the explicitly confirmed observation. View changes and export do not send an Agent message.

The [saved observation scenario](../../apps/web/tests/scene-saved-observations.e2e.ts) saves two named checkpoints, reloads and reopens the Session, restores both, and exports a saved checkpoint. After a source revision changes, it restores the original source and returns to the latest revision. Saving and restoring produce no Agent input; explicitly sending one observation admits one action.

The [saved observation comparison scenario](../../apps/web/tests/saved-observation-comparison.e2e.ts) checks fixed control/variant evidence, rejects unequal step counts, preserves old source revisions after both sources advance, and reselects saved observations after reload. Explicit comparison admission produces one action; repeating the same pair after another reload produces no duplicate input.

## Fixed-source HTML exports

The optional Web Host service `artifactExports` freezes a complete Scene source before generating an HTML file. `ArtifactHtmlExportRequest` contains a stable `exportId`, `format: 'html'`, and either a current Artifact id/revision/checkpoint or a saved observation reference. The Host resolves source bytes and recomputes saved particle conditions. Later source updates cannot change an accepted request. Non-particle exports use source defaults; unsaved local parameters, selection, viewport and iframe heaps are not captured.

`artifact/export` stores the complete immutable request and `frozen` input, with `exporterVersion: 1` and explicit `parameters`, followed by `pending`, `ready` with a content-addressed `FileAttachmentRef`, or `failed` with a machine-readable failure. The `artifactExports` Projection restores these records; HTML bytes remain in attachment storage under the current instance. Required export events cause older readers without this event to refuse restoration rather than lose output history.

`create` flushes the frozen request before rendering, stores the complete file before appending readiness, and flushes the result before returning it. Identical retries return the existing receipt or explicitly continue its fixed input; a changed request with the same id is rejected. An unconfirmed pending record after restart does not imply a live producer or success. Read failures do not erase an earlier generation receipt. File reads resolve only Session-owned export ids and verify the entire stored object before returning bytes.

Both standalone cards and comparison cells offer export and a recoverable result list. Ready records can download their original HTML again after source changes or reload. Generation and download have separate outcomes: Web reports a download request, while Desktop reports an actual saved file or cancellation. No export starts a model turn. Host video, batch rendering, automatic retry/resume, deletion and automatic file retention are deferred; expensive providers will reuse Jobs instead of introducing a second execution system.

## Experiment context for ordinary questions

The `artifact-followup` Web plugin registers the `artifact` prompt-context provider on Session Controller. `ArtifactPromptContextSelection` selects a current particle checkpoint, saved observation, compatible fixed comparison, or an explicitly selected HTML runtime. Particle values are recomputed from Host-owned source and recorded conditions. HTML captures carry the target Session, source identity, revision, runtime identity and `ArtifactProgramQuestionCapture`: either ready with an actually received JSON state, or error with its diagnostic. The Host reads the complete current HTML source and checks the addressed Session and revision; the program data remains unverified `program-reported` context.

The provider contributes one text block to the same ordinary `user` message as the question. `ArtifactQuestionContext` retains the complete source and selected facts. Particle and program reports have distinct explanatory prefixes; the latter never claims Host recomputation, replayability or causation. No new Session event, message source, runtime ledger or separate model wake is added. Recognized text renders as an expandable summary while copying, history, released readers and model input retain the full original text. This display grants no validation or execution authority. The complete block array, including source and reports, is bounded by `maxContextBytes` and the generic prompt limits, without silent truncation.

A removable composer chip identifies the user's selection. Particle capture reads the sole calculation owner. HTML selection holds the physical runtime identity and prepared node/runtime sources, without copying state into the selection; synchronous submission captures the latest received state or current error before asynchronous reference or attachment work. Ready without a state is not an empty state: null, false, zero and an empty string are valid values, while absent data is unavailable. Source replacement, remount and connection loss latch a live selection as stale and require reselection or removal. Clearing the choice and disposing either owner release its subscriptions without looking up a closing service.

Once captured, the immutable question data does not depend on the frame remaining open. The Host does not query the live runtime registry or replace it with a later report. A changed current source is a definite refusal before admission; an already accepted request returns its original acknowledgment first. Unknown-result retries retain the full original request, even after later state changes. Saved references retain their original evidence. Selection is transient and never inferred from visible content; historical question text survives reload without reviving a runtime. Other Scene controls and subagent continuation context remain unsupported. The Client uses the actual subagent route descriptor to suppress unsupported question-context choices and explains that ordinary text questions remain available; manual branches keep the root route. Choose and capture callbacks enforce the same restriction before sending. See the [program-context guide](../upgrade-guide/v0.2.2-alpha.2/program-question-context/guide.md) and [browser scenario](../../apps/web/tests/artifact-program-question.e2e.ts).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxartifactbranchresults--artifactbranchresults"></a>

### `ctx.artifactBranchResults` — `ArtifactBranchResults`

Artifact-owned API for manually attaching saved evidence to one branch conclusion.

```ts cordis-catalog
/**
 * Return one child-owned conclusion with evidence selected by the user, without starting a model turn.
 * @param request - Direct parent, branch conclusion and branch-visible saved references; no text or coordinates are accepted.
 * @returns Parent-local event and message ids after the durability checkpoint; identical retries reuse the receipt.
 * @throws {RemoteError} For invalid lineage, unavailable evidence, oversized content, a busy parent or different earlier content.
 * Other failures preserve an unknown outcome after append; retry the identical request to recover its receipt.
 */
@Remote({ resources: { session: (request: ArtifactBranchResultRequest) => [request.sessionId, request.branchSessionId] } }) async returnResult(request: ArtifactBranchResultRequest): Promise<SessionBranchResultValue>
```

Types: [SessionBranchResultValue](branch.md)

Source: [`packages/artifact/artifact-branch/src/index.ts`](../../packages/artifact/artifact-branch/src/index.ts)

<a id="ctxartifactexports--artifactexports"></a>

### `ctx.artifactExports` — `ArtifactExports`

Owns fixed HTML export inputs, explicit continuation, and verified result reads.

```ts cordis-catalog
/**
 * Capture and generate one Scene HTML export without adding model input.
 * @param agent - Exact live root owning the result record.
 * @param input - Stable request identity and current-revision or saved-observation reference.
 * @returns The settled record after flush; generation failures return a durable failed record.
 * @throws {RemoteError} Before admission for invalid, conflicting, missing, stale, or over-limit requests.
 * Append or flush failures retain an unknown outcome; retry the identical request to recover or explicitly continue it.
 */
@Remote async create(agent: Agent, input: ArtifactHtmlExportRequest): Promise<ArtifactHtmlExportRecord>

/**
 * Read the exact stored file after the attachment provider verifies all bytes.
 * @param agent - Exact live root whose result records authorize the read.
 * @param exportId - Ready export identity, never an arbitrary file reference or path.
 * @returns Complete verified HTML bytes; a partial read never reaches the caller.
 * @throws {RemoteError} When the export is not ready or its stored bytes are missing or corrupt.
 */
@Remote async read(agent: Agent, exportId: ArtifactExportId): Promise<Uint8Array>
```

Types: [Agent](core.md)

Source: [`packages/artifact/artifact-export/src/index.ts`](../../packages/artifact/artifact-export/src/index.ts)

<a id="ctxartifactruntime--artifactruntime"></a>

### `ctx.artifactRuntime` — `ArtifactRuntime`

Owns only currently attached report streams; inspection reads authoritative source identity separately.

```ts cordis-catalog
/**
 * Attach one stream-owned runtime report without opening a Session or activating an Agent.
 * Registration records a Client claim, not proof that the named source exists or rendered successfully.
 * @param sessionId - Session resource whose rendered source the Client names.
 * @param identity - Exact source revision and unique mounted runtime identity.
 * @param signal - Carrier generation; cancellation, disconnect and disposal remove its live report.
 * @returns Registration followed by a monotonic acknowledgement for each accepted replacement report.
 * @throws {RemoteError} Invalid, duplicate, over-budget or unavailable streams retain no rejected report.
 */
@Remote({ mode: 'stream', resources: { session: (sessionId: SessionId) => sessionId } }) async *attach(sessionId: SessionId, identity: ArtifactRuntimeIdentity, signal: AbortSignal): RemoteStream<RuntimeAck, RuntimeReport>

/**
 * Inspect one exact current source and its connected matching runtime reports without adding input.
 * @param agent - Agent whose own Session supplies the authoritative current source.
 * @param artifactId - Artifact to inspect in that Session.
 * @param revision - Exact current source revision expected by the caller.
 * @returns Detached source capabilities and active Client reports at this read; no report is a rendering proof.
 * @throws {RemoteError} For absent or changed source revisions.
 */
inspect(agent: Agent, artifactId: ArtifactId, revision: number): ArtifactRuntimeInspection

/**
 * Wait once for any matching current run to report ready or error, including a not-yet-attached view.
 * Reports remain independent Client assertions; this never executes code or wakes an Agent.
 * @param agent - Agent whose own Session supplies the authoritative current source.
 * @param artifactId - Artifact to inspect in that Session.
 * @param revision - Exact current source revision; replacement rejects instead of following the new source.
 * @param waitMs - Positive integer duration within the configured maximum; it is never silently shortened.
 * @param signal - Invocation cancellation; rejection preserves its reason and releases all wait resources.
 * @returns All matching reports at settlement; expiration with starting reports, no reports, and disconnect are distinct.
 * @throws {RemoteError} For unavailable source, invalid or over-capacity waits, and Session/service disposal.
 */
async wait( agent: Agent, artifactId: ArtifactId, revision: number, waitMs: number, signal: AbortSignal, ): Promise<ArtifactRuntimeWaitResult>
```

Types: [Agent](core.md) · [RemoteStream](typert.md) · [SessionId](core.md)

Source: [`packages/artifact/artifact-runtime/src/index.ts`](../../packages/artifact/artifact-runtime/src/index.ts)

<a id="ctxartifacts--artifactservice"></a>

### `ctx.artifacts` — `ArtifactService`

`ctx.artifacts`: validated artifact snapshots and user-action routing.

```ts cordis-catalog
/**
 * Read one source revision visible in an already prepared Session.
 * @param agent - Agent whose Session defines the visible source prefix.
 * @param artifactId - Artifact identity within that Session.
 * @returns An independent snapshot, or undefined when the source is not visible; no activation or I/O occurs.
 */
currentSnapshot(agent: Agent, artifactId: ArtifactId): ArtifactSnapshot | undefined

/**
 * Read an original saved observation visible in one prepared Session.
 * @param agent - Agent whose Session owns the visible source prefix.
 * @param ref - Artifact and saved-observation identity in that Session.
 * @returns Independent saved source, checkpoint and recomputed particle values.
 * @throws {ArtifactError} When the saved observation is not visible.
 */
resolveSavedObservation(agent: Agent, ref: SavedParticleObservationRef): SavedParticleObservation

/**
 * Resolve a Scene selection to a complete original source and validated replay point.
 * @param agent - Agent whose prepared Session owns the source and saved observations.
 * @param selection - Current source revision or a previously saved observation reference.
 * @returns Independent complete source values; particle coordinates are recomputed.
 * @throws {ArtifactError} For missing, stale, or unsupported sources.
 * @throws {ParticleRuntimeError} For invalid replay conditions.
 */
resolveSceneSource(agent: Agent, selection: ArtifactExportSourceSelection): ArtifactExportSource

/**
 * Validate and normalize one complete create or update without committing it.
 * @param agent - Agent whose Session supplies the current artifact revision.
 * @param input - Complete new values and, for update, the observed base revision.
 * @returns The snapshot to commit after the enclosing operation succeeds.
 * @throws {ArtifactError} `ARTIFACT_EXISTS`, `ARTIFACT_NOT_FOUND`, `STALE_REVISION`,
 * `BAD_SOURCE`, or `BAD_INPUT`; no Session event is appended.
 */
prepare(agent: Agent, input: ArtifactPrepareInput): ArtifactSnapshot

/**
 * Append one validated complete snapshot and perform no other operation.
 * @param agent - Agent owning the Session log.
 * @param snapshot - Prepared complete artifact value.
 * @throws {ArtifactError} when the snapshot violates the same persistent validation as `prepare`.
 */
commit(agent: Agent, snapshot: ArtifactSnapshot): void

/**
 * Save a named particle observation without adding input or waking the Agent.
 * @param agent - Exact live root Agent owning the Session.
 * @param artifactId - Particle Artifact to inspect.
 * @param revision - Current source revision that produced the checkpoint.
 * @param observationId - Client-generated retry identity, stable until the request succeeds.
 * @param label - User label containing 1-80 characters after trimming.
 * @param checkpoint - Runtime version and step count; coordinates are recomputed by the Host.
 * @returns The immutable saved value; an identical retry returns the existing observation.
 * @throws {RemoteError} `artifact/stale-revision` or `artifact/observation-limit`; no observation is appended.
 * @throws {ArtifactError} For conflicting retry identities, unsupported sources, or invalid caller input.
 * @throws {ParticleRuntimeError} For an invalid checkpoint or non-finite derived state; no event is appended.
 */
@Remote saveObservation( agent: Agent, artifactId: ArtifactId, revision: number, observationId: ArtifactObservationId, label: string, checkpoint: ParticleCheckpoint, ): SavedParticleObservation

/**
 * Send an explicitly selected saved observation, including one from an older source revision.
 * @param agent - Exact live root Agent owning the saved observation.
 * @param artifactId - Artifact under which the observation was saved.
 * @param observationId - Durable observation identity; caller-supplied values are never used.
 * @param wake - Whether to steer the Agent or inject without waking.
 * @returns Inbox admission and the saved source revision; retries do not enqueue a second message.
 * @throws {ArtifactError} For an unknown observation, invalid caller or oversized action; no source revision is changed.
 */
@Remote sendObservation(agent: Agent, artifactId: ArtifactId, observationId: ArtifactObservationId, wake: boolean): ArtifactRecordResult

/**
 * Confirm one fixed control/variant observation pair as ordinary user input.
 * @param agent - Exact live root Agent whose Session resolves both saved references.
 * @param group - Comparison group on the saved source revisions, independent of current revisions.
 * @param controlRef - Saved control observation; Client coordinates are never accepted.
 * @param variantRef - Saved variant observation with equal runtime, time step and step count.
 * @param wake - Whether to steer the Agent or inject without waking.
 * @returns The recomputed comparison; the same ordered pair is admitted at most once per Session.
 * @throws {RemoteError} `artifact/comparison-rejected` for incompatible, missing or oversized observations; no input is added.
 * @throws {ArtifactError} For invalid references, group or caller. An admission failure may have committed input; retry the same pair.
 */
@Remote confirmObservationComparison( agent: Agent, group: string, controlRef: SavedParticleObservationRef, variantRef: SavedParticleObservationRef, wake: boolean, ): ArtifactObservationComparisonResult

/**
 * Encode one user-reviewed artifact intent as a single-text-block UserMessage.
 * The message is input, never an authorization to perform the named action.
 * @param agent - Exact live root Agent owning the artifact Session.
 * @param artifactId - Existing artifact identity.
 * @param revision - Current artifact revision reviewed by the user.
 * @param action - Trimmed 1-64 character action name matching `[A-Za-z][A-Za-z0-9._-]*`.
 * @param payload - Lossless JSON payload included in the bounded text message.
 * @param wake - `false` injects without waking; `true` steers the Agent.
 * @returns Acceptance and the revision carried by the message.
 * @throws {ArtifactError} for a non-root caller, unknown or stale artifact,
 * invalid action/payload, or an oversized complete message; no message is routed on validation failure.
 */
@Remote record( agent: Agent, artifactId: ArtifactId, revision: number, action: string, payload: JsonValue, wake: boolean, ): ArtifactRecordResult

/**
 * Admit one identified user action, or acknowledge the exact message accepted earlier in this Session.
 * @param agent - Exact live root Agent owning the action and receipt.
 * @param request - Original request identity, reviewed source, action, payload and first-admission delivery policy.
 * @returns Acceptance of that original message; retries do not dispatch or wake again.
 * @throws {RemoteError} A known refusal, conflicting identity, unavailable admission service, or unknown dispatch outcome.
 */
@Remote async submitAction(agent: Agent, request: ArtifactActionRequest): Promise<ArtifactRecordResult>
```

Types: [Agent](core.md)

Source: [`packages/artifact/artifact/src/index.ts`](../../packages/artifact/artifact/src/index.ts)
<!-- END GENERATED cordis-surface -->

## Limitations

- Only self-contained HTML is accepted; there is no external dependency loader.
- Revision checking depends on the enclosing Agent's operation ordering and is not a distributed transaction.
- A message-source record preserves user input; it does not persist arbitrary iframe runtime state or prove that a visual result was correct.
