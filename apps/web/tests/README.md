# apps/web browser e2e

English | [中文](README.zh.md)

These tests boot the real web composition in-process and drive it with real browsers over real HTTP. Chromium runs the full lane; the [model and reasoning picker scenario](declared-reasoning.e2e.ts) also runs in WebKit to cover native mouse focus behavior. [Session replay recovery](session-replay-reload.e2e.ts) also runs in WebKit, sharing the `fresh-round-trip` recording and expected output without rewriting them. It covers active-stream reload, completed-turn reload, and reopening a Session. The lane's mechanics — modes, fixtures, goldens, and the deliberate composition divergences from `agentrans web` — are documented in [`scaffold.ts`](scaffold.ts) and the [browser e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md).

After installing workspace dependencies, install the browsers and their system dependencies from the repository root:

```sh
pnpm --filter @agentrans/web-frontend exec playwright install --with-deps chromium webkit
```

On Linux, `--with-deps` installs dependencies through the system package manager. The persistent CI VM must provide these dependencies through image maintenance; CI installs only the browser binaries, as required by the [failover runbook](../../../.agents/notes/implemented/process/2026-07-26-ci-failover-runbook.md).

Ordinary scenarios begin with no registered Workspace or Session and a durable marker recording a removed default Workspace, so explicit folder-selection scenarios retain control of their cwd. `launchWebScaffold({ firstUse: true })` leaves initialization eligible for startup scenarios.

Same-day message goldens use the shared `WEB_FIXTURE_TIME`: seeded transcripts pass it as `createdAt` and pin the browser calendar with `pinBrowserClock`; scenarios that submit live messages also use `pinHostClock` and restore it after teardown. These clocks advance with real elapsed time while keeping native timers intact, so midnight does not change a scenario's date labels.

## Fixture ownership

`snapshots/web/` owns recorded Sessions that serve as both replay input and complete expected persisted output. Their `snapshot.yml` declares composition, recording, and header ownership. A browser case may borrow an existing corpus owner; the scaffold validates that owner before startup even when `compareReplaySession` is `false`.

`fixtures/replay/` owns input-only Session-format replay scripts. These cases explicitly select `compareReplaySession: false`, check fixture roles and normalization with `assertFixtureInventory`, and assert their actual browser and Host behavior. Those assertions do not make the input a complete persistence or migration oracle. Keep parent and child files together. Reviewed relocation preserves file bytes and generation names; it does not record or refresh a Session. See the [corpus rules](../../../snapshots/AGENTS.md).

## Live Artifact acceptance

The live Artifact suite requires a nonempty `DEEPSEEK_API_KEY`, `AGENTRANS_ARTIFACT_LIVE=1`, and `AGENTRANS_SNAPSHOT=record`. Set `AGENTRANS_ARTIFACT_LIVE_OUTPUT_DIR` to an evidence directory, then run `node node_modules/vitest/vitest.mjs run --config vitest.web.config.ts apps/web/tests/artifact-live.e2e.ts --maxWorkers=1 --retry=0 --reporter=verbose`. Set `AGENTRANS_PLAYWRIGHT_EXECUTABLE_PATH` to use an existing Chromium-compatible browser. The suite uses the shipped `deepseek-flash` model and a fresh workspace per case. It checks whether the default Agent offers a function plot and a particle experiment when asked to test a prediction, updates the same Artifact from confirmed readings, and answers a short derivative question directly. The branch case verifies that the provider receives the selected returned readings with an ordinary follow-up and that the question replays after reload. The particle continuation case varies only vertical gravity at the returned checkpoint, asks the provider using the confirmed result, and replays both returned readings after reload. The generated BFS case verifies that the provider receives the checkpoint confirmed in the branch, the adopted stepper supplies a new confirmed checkpoint for a parent question, and both steps reopen independently after reload. The generated half-adder case checks all four truth-table rows, locks two different input/output states for branch and parent questions, and reopens both independently after reload. Each evidence directory contains a Session, screenshots, and HTTP request statuses. [Live test](artifact-live.e2e.ts)

The generated double-slit case asks for an experiment in a fresh workspace, then checks that the model loads the bundled design skill and uses its parameter explorer template. It checks slit separation, a pointer drag on the probe, and the path difference after keyboard input at a 390 px viewport.

The BFS and half-adder Web replays lock and return a reading, then revise the style of the same Artifact in its original branch. After reloading the parent, the browser downloads the original return and checks its revision, locked readings and original style offline. BFS can step to C and D and reset to B. The half-adder can cycle through the four truth-table rows and reset to both inputs on. Each download leaves provider requests, branches and Session events unchanged. [Keyless replay](artifact-program-question.e2e.ts)

The Chat CSV case uploads measurements, checks that the model requests a native bar chart with an attachment ID and aggregation recipe, and locks the mean for Warm before selecting Cold. It verifies the model received that mean, the same Artifact displays the new sum, and a reloaded parent still replays the mean. The historical HTML download opens offline and shows the same groups as the original revision.

The CSV continuation case returns the Warm mean to the parent conversation. It switches to the sum, locks Warm at 60 across two rows, then selects Cold at 100. It verifies that the comparison and lock issue no model request and that the follow-up sends the locked Warm sum. After reload the sent question compares the returned mean of 30 with the locked sum of 60 and marks both CSV records as kept.

The filtered CSV case selects `Batch = B` and compares the original Warm sum of 60 across two rows with the filtered sum of 35 from one row. It checks the source record number and cells, then locks the reading and switches to Cold. The provider receives the locked Warm value and exact filter on send. After reload, the returned mean of 30 shows records 4 and 5, and the filtered sum of 35 on the sent question shows only record 5. The sent question comparison pairs both readings and marks record 4 as excluded and record 5 as kept. The test checks the tables at 390 px and verifies that each lookup issues no model request and leaves both session histories intact. The keyless fixture checks that the readings stay visible and that all three lookups offer a retry when source records are unavailable.

The same live case reviews and attaches the filtered comparison, types the explanation request, and checks that Edge restores the unsent text and the same reviewed records after refresh. It then stops the Web Host and starts a new runtime and HTTP listener over the same test roots and origin in the Vitest process. After reauthentication, Edge restores the draft again. The test opens a different sent question's unfiltered comparison and submits the restored text without retyping. The provider receives the exact reviewed facts, with the attachment proof and draft receipt kept out of the message. It explains the original mean of 30, the unfiltered sum of 60, and the filtered sum of 35 using records 4 and 5. After acceptance the Host draft is cleared. Reload replays the exact attached comparison from the explanation question without recalculating it or calling the model.

Three intentional Edge tab closures exercise submission recovery. The first holds the prompt after the Host binds the draft receipt, then closes the tab before the prompt reaches the Host. The reopened tab restores the exact text and comparison without submitting automatically. Both later attempts pause the real Host admission job after it reserves the bound request ID. The restored draft remains editable and its rows can be reviewed while the native Send button is disabled. Mouse and Enter gestures issue no request. A refusal reports that the Host has yet to receive the previous question, restores Send, and retains the edited text and locked comparison. When the last attempt is accepted, the composer reports success, removes the sent attachment, and retains text for a new question. **View sent question** focuses the exact recorded message's expanded comparison. Keyboard activation of **Return to draft** restores the composer and its exact caret offset. After reload, ordinary history replay has no return shortcut. The test verifies that recovery and the round trip do not resubmit the prompt, recalculate the comparison, or call the model.

The filtered CSV case also reuses the original question's comparison for the next draft. Cancel leaves the draft untouched. Confirm verifies the exact sent message and adds the same rows and readings to the draft. Only the deliberate next send calls the model. **View source question** opens the saved comparison from the draft or the sent replay. The browser follows two source links from a draft and reloads at the earliest comparison. It checks both stepwise return and direct jumps from **Source path** to the intermediate comparison and to the original draft, including the caret and attachment receipt. Reloading after completion leaves the path closed. Navigation never reads the original CSV, recalculates data, or calls the model.

The two-step CSV case selects two saved comparisons from the same branch return in reverse order. The confirmed attachment first shows Warm mean 30 and sum 60 over records 4 and 5. It then shows the sum of 35 after `Batch = B` excludes record 4 and keeps record 5. Before sending, the browser opens both sources from the same draft, refreshes at each source, and returns to the original text, selection, and confirmed attachment. The test then checks the exact attachment received by DeepSeek, verifies that the answer explains the two changes separately, and opens each original comparison after the sent question reloads. It checks for zero CSV reads and recalculations and one provider request from the explicit send.

The keyless two-step replay opens each saved source from the same explanation. After refreshing the source page, **Return to two-step explanation** expands the original explanation and focuses the button for that step. A second refresh leaves the source visit closed. The test checks for zero model calls, attachment reads, and CSV recalculations. [Keyless replay](csv-comparison-explanation-replay.e2e.ts)

The keyless draft case opens each saved source from a two-step explanation already attached to an unsent question. **Return to draft** after a source reload restores the question, its exact selection, and both locked pages. A second reload keeps the visit closed and the draft intact. The test confirms there is no prompt submission, model call, attachment read, or CSV recalculation.

The keyless export case downloads a sent explanation as one HTML document. After stopping the Host, the browser opens the local file offline, checks the ordered readings, and expands each original locked page to check its saved row membership. It verifies zero model calls, CSV reads, and recalculations. [CSV offline export](csv-sent-comparison-export.e2e.ts)

The portable two-step case downloads the exact pair as versioned JSON and imports it into a new Chat. Edge opens both original pages under **User imported** in preview and saved replay. DeepSeek receives the two exact pages and their imported attribution from one deliberate send. The test counts no original CSV reads, recalculations or other model calls. [Live portable two-step case](artifact-csv-explanation-portable-support.ts)

The imported reuse case opens **Reuse entire explanation** on the second of two saved questions with identical imported readings, where the second already reuses the first. After confirmation and reload, Edge opens the selected source from the draft, checks both locked pages, and returns to the same question and attachment. One explicit send reaches DeepSeek with both original pages and the imported attribution. The new sent question opens the complete source chain in order after reload. Reloading at the earliest source preserves both stops for a stepwise return to the expanded new question. The test checks zero CSV reads, recalculations and model calls outside the explicit send.

The keyless imported-source case uses two sent **User imported** cards with identical readings. From both a restored draft and a saved follow-up, **View source question** opens the exact card selected for this reuse. Edge checks the record states in both original pages and verifies zero prompt submissions, model calls, CSV reads and recalculations.

The imported chain case follows two consecutive reuses from both a draft and a saved follow-up. After a reload at the earliest question, Edge returns through the intermediate question to the exact draft or expanded follow-up. The draft retains its text, caret and locked pages. The test checks both original pages and verifies zero prompt submissions, model calls, CSV reads and recalculations.

The browser also opens **View full source chain** on the draft, dismisses the list, and verifies its two saved questions. Selecting the earliest question opens it directly without opening the intermediate comparison. After reload, the return path still leads to the same caret and attachment receipt.

The browser repeats the full-chain jump from a new sent question. It reloads at the earliest source and returns to the exact sent comparison without affecting an unrelated draft. It also checks that opening the list on a sent question already reached from the draft extends the original return path.

When the earlier history page is temporarily unavailable, the browser checks that the preview shows only the verified sources. The visible comparison is still available to open, and **Retry** fills in the missing source when history requests succeed again. A source reference with a mismatched message ID marks its exact level as invalid and leaves the verified comparison available to open.

The browser also reloads an open source with the same two interruptions. It verifies fallback to the last available comparison, retry of the original position, and the preserved draft caret and receipt. A broken reference reports its level on the fallback comparison. The browser holds a successful history response during a retry, then returns to the draft, opens a different source path, or switches Sessions and opens a source comparison there. When the response arrives, the browser checks the selected Session, focused comparison, and return path. Reload restores that Session's path without a model request or CSV recalculation.

A test tab in the right sidebar keeps the first Session open while the browser switches away and back during a retry. The browser releases the earlier history response and verifies that the target comparison stays closed and focus stays where the user left it. Clicking **Retry** again opens the target and restores its return path. Reload reopens the same comparison and path without calling the model or recalculating the CSV.

The browser repeats the switch and starts a fresh retry before releasing the first held history page. Both attempts share the Session's history load. While the page containing the target is still held, the fresh retry stays pending and focus remains on the last verified comparison. Releasing the target page opens the requested comparison. Reload restores that comparison and its return path with no model request or CSV recalculation.

The two-page regression runs three outcomes. The sidebar retains the first Session while the browser switches between Sessions and the target history page waits.

- The browser leaves the first Session with its latest retry pending and opens the second Session's source comparison. The delayed page reaches the first Session's retained history. Focus and the return path stay in the second Session.
- The browser returns to the first Session before the page arrives. The last verified comparison keeps focus and the target stays closed after the response. A fresh click on **Retry** opens the target using loaded history.
- The browser returns to the first Session and starts a fresh retry while the page is still held. The fallback keeps focus while the retry is pending. When the page arrives, only the fresh retry opens the target, once.

Each outcome reloads with only the selected Session's comparison and return path. Navigation and retries make no model request, do not read the original CSV, and do not recalculate it. The Client regression uses 2, 3, 9, and 12 attempts. It checks a shared history response and separate responses with the latest attempt resolving both before and after older attempts.

The keyless Web replay seeds two saved Sessions and runs each outcome with two completed round trips against the Host's history pages. It shares browser assertions with the live case, which runs eight round trips per outcome. The regular Web browser lane runs the replay with Playwright Chromium in PR CI. Set `AGENTRANS_PLAYWRIGHT_EXECUTABLE_PATH` to run the same case in Edge locally. [Keyless source retry replay](csv-source-retry-replay.e2e.ts)

## Completion observations

State-sensitive cases use Workspace, admission, attachment, and model-stream barriers to separate visible intermediate states from completed operations. Model-picker persistence assertions wait for the saved default, independently of menu closure. Details close waits for frame transitions; archive verification assigns an explicit title to the seeded Session and follows that identity across reload. The [CI test reliability workflow](../../../.agents/skills/dsh-ci-test-reliability/SKILL.md#synchronize-on-state) owns these synchronization rules.

[Idle-submission handoff](idle-submission-handoff.e2e.ts) waits up to the scaffold's 30-second turn-completion budget for Host frames and browser placement. Vitest owns scaffold teardown so a replay-consumption error does not replace the failed scenario assertion.

Plugin-manager and HMR lifecycle switches wait up to `PLUGIN_TOGGLE_SETTLE_MS` (10 seconds) for the Host's profile write and the store's follow-up inventory read, the two steps that republish `aria-checked`; that constant's JSDoc records the measured chain.

Explicit scrolling uses `scrollIntoView` from `support.ts`: it resolves the locator again when its old element detaches and checks connection in the same browser task as native scrolling. Scenarios retain their visibility and geometry assertions after scrolling.

Question-composer resize assertions wait for overflow, the clipping mask, and toggle visibility to agree after CSS scroll timelines update.

[The snapshot after closing a sidebar pane](shortcuts-panels.e2e.ts) moves the pointer outside the controls and waits for hover tooltips to close before capture. Keyboard focus remains on the pane.

[The same-origin terminal case](sidebar-terminal.e2e.ts) waits for the UI-triggered Host close operation before checking process termination. It also checks the first window's process, saved bindings and layout after reload.

## These are Host-face tests

They type-check in the root `tsconfig.host.json`, not in the Client aggregate, because they read Host services directly: `ctx.connection`, the Host `SessionStore`, and `ctx.sessionProjectionCache`. Driving a browser at runtime does not make a file part of the Client program — the two faces merge Cordis `Context` under the same keys with different services, so one program cannot see both. Moving these files into the Client aggregate makes every Host-service access fail to compile.

A new scenario joins both program lists in the same change: its file in the root `tsconfig.host.json` include and in the Client aggregate's `apps/web/tsconfig.json` exclude. That project includes all of `tests`, so a file missing from the exclude compiles as Client code, and the Client compiler gate of `pnpm run typecheck` keeps failing with Host-service errors until it is listed.

## Do not import `@agentrans/client-*` here

Importing a Client package — a value or a type — pulls its TypeScript project and referenced projects into the Host build graph. Generated Remote declarations are available before package compilation, but this does not make the Host and Client Cordis `Context` declarations compatible. Keep these tests on the Host face and use only the explicit built-client harness exception below.

When a scenario needs a Client-owned constant or pure function, mirror it here instead, next to the commented-out import that names the source module. A drift then surfaces as a missed selector or a stale mirrored value — a loud failure, never a silent pass. `scaffold.ts` follows this rule for the welcome-notice namespace, acknowledgement field, version, and asserted Chinese copy.

The built-client harness is the exception. `assembled-boot.ts` imports `AppWebEntry`, the boot-manifest type, and `RemoteMock`; `assembled-remote.ts` imports the Client test runtime's default responses and `RemoteMock`. These packages are explicit project references for booting the real shell against a test-owned carrier. The chat scenarios mirror `conversationContextKey` in `support.ts` instead of importing its Client owner.

Nothing mechanically enforces this rule; keep it in review.
