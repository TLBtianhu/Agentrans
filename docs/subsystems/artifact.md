# Artifact

English | [中文](artifact.zh.md)

An Artifact is a versioned, code-generated interactive explanation. It is not a file delivery, a generative image, or a browser-only card. The durable source is complete HTML; frames, screenshots, videos, and downloads are projections or exports.

## Protocol values

`ArtifactSnapshot` contains:

| Field | Meaning |
|---|---|
| `artifactId` | Stable branded id within the owning Session |
| `revision` | Positive safe integer, starting at 1 and increasing by one per accepted update |
| `format` | Currently `html` |
| `title` | Trimmed 1–120 character display title |
| `source` | Complete self-contained HTML document |
| `presentation` | Semantic placement request: `inline` or `focus` |

Every `artifact/upsert` Session event carries a complete snapshot. Later events for the same id supersede earlier revisions. A tail containing only the latest upsert still renders the current Artifact.

## Mutation and action semantics

The `artifact` tool creates or updates a snapshot. Creation rejects an existing id; update requires the current revision as `baseRevision`. The snapshot commits only after the authoritative tool result succeeds. Failures, cancellation, stale revisions, and post-execute blocks do not commit.

`record` accepts an action only for the exact live root Agent and current revision. It validates the action name and complete UTF-8 message size, then creates an ordinary `UserMessage` with `source.kind = 'artifact-action'`. Its single text block contains bounded JSON with `kind: 'artifact_action'`, the id, revision, action, and payload. `wake` selects `agent.steer` or `agent.inject`.

Artifact actions are user intent, not authority. They cannot approve a tool, read a file, open a socket, or bypass policy. The action payload is not a new LLM content block or Session event type.

## Presentation and recovery

The Client correlates snapshots by `artifactId` and preserves Conversation identity across revisions. Revision changes replace the browsing context. The iframe uses an opaque origin and a restrictive content policy; the parent accepts only messages from the current frame with the current id/revision and a bounded JSON body.

The SceneHost supports `inline`, `beside`, `focus`, and `pip` placements. A `ViewRequest` expresses placement intent rather than window authority. Users can change placement while retaining the same browsing context and pending actions. Overlay ancestors are marked visible so virtualized history does not hide a fixed scene.

Durable recovery covers snapshots and admitted action messages. Iframe JavaScript heap, canvas pixels, scroll position, source-view state, and unconfirmed pending actions are transient.

## Verification

The keyless [Artifact interaction scenario](../../apps/web/tests/artifact-interaction.e2e.ts) drives the shipped Web composition with the recorded model stream in [session.v4.jsonl](../../snapshots/web/artifact-interaction/session.v4.jsonl). It creates and updates an interactive counter, expands the completed process group, clicks the counter in a real browser, and confirms the pending action. The test checks revisions 1 and 2, no Artifact action or second turn before confirmation, and one parent-local `artifact-action` plus a second turn after confirmation.

The [teaching Artifact scenario](../../apps/web/tests/teaching-artifact.e2e.ts) applies the same path to a prediction lab. The user selects an angle, predicts a hit, launches, compares the actual result, and confirms the semantic action. The Agent then updates the Artifact to revision 2 with prediction feedback. This exercises observation, prediction, manipulation, and feedback rather than visualization alone. The replay also mounts a user-declared `custom-provider` model route, so the model picker shows `Custom Lab Model` instead of a built-in DeepSeek route.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxartifacts--artifactservice"></a>

### `ctx.artifacts` — `ArtifactService`

`ctx.artifacts`: validated artifact snapshots and user-action routing.

```ts cordis-catalog
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
```

Types: [Agent](core.md)

Source: [`packages/artifact/artifact/src/index.ts`](../../packages/artifact/artifact/src/index.ts)
<!-- END GENERATED cordis-surface -->

## Limitations

- Only self-contained HTML is accepted; there is no external dependency loader.
- Revision checking depends on the enclosing Agent's operation ordering and is not a distributed transaction.
- A message-source record preserves user input; it does not persist arbitrary iframe runtime state or prove that a visual result was correct.
