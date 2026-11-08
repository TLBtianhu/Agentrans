---
kind: upgrade-guide
description: "HTML programs declare actual runtime support and acknowledge commands through the injected Artifact API."
---

# Declare Artifact runtime support

English | [中文](guide.zh.md)

## Change

Shared HTML controls require ready reports and explicit implemented callbacks from both current runtimes. Unscoped `artifact-command` and `artifact-state` messages no longer establish control or state support. Existing HTML still previews, and the user-reviewed `artifact-action` path is unchanged. Source creation confirms source acceptance, not renderer execution.

Custom Web compositions using the current Artifact Client mount `@deepseek-ai/dsh-artifact-runtime` alongside Artifact and expose its generated Remote contribution. Agent presets may mount its `/tool` entry for exact-revision `artifact_runtime` inspection. The shipped Web composition includes both. No Session migration is needed; old tool results never restore live readiness. See the [ownership decision](../../../../.agents/notes/implemented/architecture/2026-11-07-artifact-runtime-reports.md).

Runtime inspection results now include `wait` and `budget`. Optional `waitMs` waits once for a reported ready/error within the Host limit; zero or omission remains an immediate snapshot. Read all runs and the outcome: a timeout or empty report list is not execution failure or success. The tool applies turn-scoped query and repair-attempt limits; it never schedules repairs automatically.

Current-analysis comparisons freeze the complete request and retain its stable identity for unknown-result retries. Saved comparisons keep their existing reference receipts. See [input admission](../session-input-admission/guide.md) for custom action adapters.

## Migration

1. Call `window.artifactRuntime.ready({ state: () => ({ count }), commands: { step: () => advance() } })` after successful program initialization. State and each of play, pause, step and reset are optional callbacks; register only implemented operations.
2. Call `window.artifactRuntime.reportState(value)` for subsequent bounded JSON state, and `window.artifactRuntime.error(message)` when the program cannot continue. A command callback may return a Promise; the bridge acknowledges its settlement. Failure requires an explicit new ready declaration or a new preview/source.
3. Use the injected API rather than constructing runtime identities. The host creates a fresh identity for each physical preview, including returning from source view at the same revision. Do not treat a load event, stored report or old callback acknowledgment as current readiness.
4. Treat `runtimeCommandTimeoutMs` as a wait for confirmation, not proof of failure or rollback. Inspect the result before repeating a command. Runtime reports grant no Host permission or deterministic save/restore capability.

5. Update strict result consumers for `wait` and `budget`. Configure `maxWaitMs`, `maxWaitsPerSession` and `maxWaitsTotal` on the service, and `maxQueriesPerTurn` / `maxRepairAttemptsPerTurn` on `/tool` where the defaults do not fit. A new revision does not renew repair attempts; explain unresolved failures when the budget is exhausted.
6. Verify a declared command is enabled only when both programs are ready, remains pending until its callbacks settle, and reports failure visibly. Read the exact error with `artifact_runtime`, update the same Artifact, and confirm a new runtime reports the replacement. Close the browser and confirm no live reports remain; historical tool results must stay readable.
7. Retry an unconfirmed current comparison with its original frozen request. Dismissal only clears local retry state and never retracts accepted input; a later explicit send captures a new comparison.
