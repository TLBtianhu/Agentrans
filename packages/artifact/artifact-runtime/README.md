---
description: "Inspect source-supported operations and currently connected renderer or program reports without treating generated code as runtime success."
kind: "package-reference"
---

# @agentrans/artifact-runtime

English | [中文](README.zh.md)

## Summary

Keep source support and reported execution separate. One physical Remote stream owns one source-bound runtime report; disconnect, unmount, source replacement or service disposal removes it. The `artifact_runtime` tool reads the exact current source revision and can wait once for a matching readiness or error report within a bounded budget. Its ordinary tool result records a point observation, not durable proof that a program remains ready.

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

Mount this service beside Artifact, and mount `@agentrans/artifact-runtime/tool` in Agent presets that offer interactive artifacts. The Remote namespace and Context service key are `artifactRuntime`. Report registration uses an explicit Session resource; it does not resolve an Agent, open a cold Session, append input or execute authored code. The Web composition restricts report attachment to the owner.

```yaml
- name: '@agentrans/artifact-runtime'
```

| Config | Default | Meaning |
|---|---|---|
| `maxViewsPerSession` | `16` | Maximum concurrently attached physical runtime reports for one Session |
| `maxViewsTotal` | `128` | Maximum concurrently attached physical runtime reports on this Host |
| `maxErrorBytes` | `2048` | Maximum UTF-8 bytes of one complete JSON-encoded diagnostic object |
| `maxWaitMs` | `5000` | Maximum requested duration of one readiness wait |
| `maxWaitsPerSession` | `4` | Maximum pending waits in one Session |
| `maxWaitsTotal` | `32` | Maximum pending waits on this Host |

`attach(sessionId, identity, signal)` returns a duplex Remote stream. Identity fixes Artifact id, source revision, unique mounted runtime id and native/HTML renderer. The opening acknowledgement is `{kind:'attached'}`; every accepted replacement report receives `{kind:'accepted',sequence}` starting at one. Reports are `starting`, `ready` with declared state/command support, or `error` with a stable code and message. Duplicate runtime identities cannot replace another stream. Invalid, oversized or over-capacity registrations terminate with `artifact-runtime/rejected` and retain no rejected report.

Registration records a Client claim and does not prove the named source exists. Inspection reads the authoritative current Artifact through its prepared Projection and selects only matching Session, Artifact, revision and renderer reports. Missing and changed source revisions fail explicitly. Multiple physical runs remain distinct; one tab's ready report never overwrites another tab's error. No active report means absence of evidence, not proof that every browser is closed.

`wait(agent, artifactId, revision, waitMs, signal)` waits for a current matching ready/error report, including a first attachment after source commit. It returns every matching run without deriving an overall success. Deadline expiry distinguishes a still-starting report (`timeout`) from no active report (`no-active-report`); loss of all previously observed matching reports returns `disconnected`. Source replacement fails as stale, while Session/service closure and capacity failures are explicit wait errors. Caller cancellation rejects with its original reason. Waiting never runs code, sends a command or retries work.

The `/tool` entry has separate policy configuration:

| Config | Default | Meaning |
|---|---|---|
| `maxQueriesPerTurn` | `4` | Shared inspection/wait attempts per Agent turn |
| `maxRepairAttemptsPerTurn` | `2` | Shared source-update attempts for Artifacts whose error this turn has read |

Both policy limits accept zero. After a successful final runtime result exposes an error, updates to that Artifact through either `artifact` or `scene` consume the shared repair budget before execution. Normal edits without an exposed error are unaffected. Attempts are not refunded after cancellation or later refusal. A new source revision or later ready report does not reset the budget; a new turn does. A budget refusal asks the model to explain the unresolved result rather than retry.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The service keeps bounded live state owned by report streams. It reuses Gateway uplink validation, capacity and cancellation instead of maintaining heartbeats or another input queue. Source replacement invalidates older revisions; stream termination and Session/service disposal release their reports. A source change or disconnect while the Host is waiting for input ends the report stream. Historical tool results never restore this live state.

Source capabilities come from Artifact's pure `getArtifactSourceCapabilities` declaration. They state which observations, saved conditions, comparisons, question context and HTML export semantics the source supports. They do not establish plugin availability, permissions, renderer readiness or correctness. A ready report's program commands and state-reporting declaration grant no Host saving, file access or Agent authority.

The model tool reads one exact current revision, immediately by default or with an explicit `waitMs`. Waits subscribe to attachment, report and lifecycle changes rather than polling; each operation releases its timer and listeners on every settlement. Source creation still commits independently of any renderer. The normal `tool/result` event supplies model-visible persistence; no runtime Session event or Projection is added. Neither reporting nor inspection wakes an Agent or sends a user message. Source generation and CAS updates retain their original behavior.

<a id="further-exploration"></a>
## Further Exploration

- [Artifact](../artifact/README.md) — durable source revisions and source-supported operations.
- [Artifact Client](../../client/ui-artifact/README.md) — renderer ownership, HTML handshake and visible failure feedback.
- [Gateway](../../api/gateway/README.md) — duplex Remote stream validation and cancellation.

<a id="model-experience"></a>
## Model Experience

### artifact_runtime

#### What the model sees

The tool accepts an Artifact id, exact current source revision and optional `waitMs` (zero or absent means a snapshot). Its result contains compact source metadata, source capabilities, `reportAuthority: 'client-reported'`, matching connected runs, the wait outcome/limit and remaining query/repair attempts. Each run identifies its mounted runtime and renderer, with `starting`, declared `ready` capabilities, or a bounded `error`. A missing source or stale revision is an error. No source bytes or local high-frequency state are repeated.

#### Token effect

One schema is added to participating presets. Inspections contribute only their bounded metadata, current reports and policy counters; per-Session view and per-report diagnostic limits bound the result. Reports themselves add no model input. Empty runs must not be described as successful rendering.

#### KV Cache effect

Inspection appends its ordinary tool result and does not rewrite source, earlier conversation or the model prefix. A recorded ready result describes that past inspection and cannot establish current availability.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Client and program reports are assertions, not Host verification of pixels, observations or causal conclusions.
- Source capabilities are implementation support, not confirmation that the relevant plugin is mounted or the caller is authorized.
- Reports live only while their physical streams remain connected. A disconnected runtime must attach a new generation and report again; old ready/error reports are not restored.
- Commands and state support describe the current bridge protocol. They do not establish arbitrary seek, deterministic replay or execution acknowledgements.
- Turn budgets are process-local loop controls, not durable quotas. Tool reload or Agent recreation resets them; calls between turns share one temporary scope. They neither stop unrelated tools nor guarantee eventual rendering or a fixed number of total model steps.
- Registration intentionally performs no cold-source read. Claims with absent, stale or incompatible source identities cannot enter a successful inspection.

<a id="dev-note"></a>
### Dev Note

Host tests cover exact-source filtering, concurrent runs, resource declarations, capacity, diagnostic limits, source invalidation and cleanup while Gateway input is blocked. Model-tool tests exercise the canonical output and refusal through the executor. The shipped Web replay covers the complete runtime-to-inspection path.
