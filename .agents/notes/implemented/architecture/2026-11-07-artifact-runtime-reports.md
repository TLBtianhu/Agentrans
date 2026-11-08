# Agent Note: Artifact readiness belongs to a connected runtime

Status: implemented

English | [中文](2026-11-07-artifact-runtime-reports.zh.md)

## Problem

Accepting generated source does not establish that a browser initialized it. Format-based shared controls sent commands without knowing whether either program implemented or completed them. A persisted ready flag would also survive the runtime that reported it and misrepresent a later browser session.

## Decision

SceneCatalog owns pure source capability declarations. The separate [Artifact runtime service](../../../../packages/artifact/artifact-runtime/README.md) owns only reports attached to live duplex Remote streams. The Session id is an explicit resource rather than an Agent lookup, so opening a report does not activate a cold Agent. Exact-revision model inspection separately reads current source through the Artifact service's prepared Projection and labels every runtime report as Client-reported.

Each physical preview has a fresh runtime identity. Parent receivers check its frame, Artifact identity and revision. HTML explicitly registers implemented state and command callbacks after initialization; native previews report only after actual Canvas drawing. Commands carry request identities and acknowledge callback completion. A timeout leaves effects unconfirmed and does not automatically repeat work.

The normal `artifact_runtime` tool result records the report snapshot seen by the model. A user may also bind a physical HTML preview for an ordinary question: submission freezes its latest received state or current error and the Host pairs that claim with its own exact current source. This capture never re-reads the live registry, and a later disconnect cannot alter an admitted question. No runtime Session event or recoverable ready Projection is added. Disconnect, source replacement, preview release and service disposal end live ownership; historical tool results and question text do not establish current execution. Source creation never waits for a renderer that cannot see it until commit.

An explicit readiness wait is one finite operation subscribed to the same live reports. It also covers first attachment after source commit, but never keeps a background retry alive. Its outcome distinguishes no active report, still-starting timeout and disconnection. All current runs are returned, including mixed ready and error claims. The tool's per-Agent turn budget limits inspection attempts and update attempts after a final result exposes a runtime error; source revisions do not renew that budget. These process-local counters control a repair loop, not durable authorization or an automatic repair scheduler.

## Alternatives considered

**Deriving ready from successful source validation or iframe load** confuses different operations and hides runtime failures. **Persisting current readiness** lets a dead browser claim that a new instance works. **Polling or heartbeat leases** duplicate the existing stream lifetime and add clock-dependent ownership. **Injecting the latest private report into prompts** prevents reconstructing what the model actually read.

## Consequences

No browser means no live report. Legacy HTML still previews and supports explicit user intent, but receives no undeclared shared controls. Reported readiness and command completion do not verify pixels, observations or causal conclusions. Source capabilities do not grant plugin availability or permission. Restorable experiments continue to use durable source and saved observations, independently of preview lifetime.
