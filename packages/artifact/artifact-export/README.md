---
description: "Capture original Scene sources and replay conditions, generate immutable HTML files, and retain their result records without starting the model."
kind: "package-reference"
---

# @agentrans/artifact-export

English | [中文](README.zh.md)

## Summary

Export one original Scene revision or saved particle observation as standalone HTML. The Host resolves source references, freezes the complete source and replay checkpoint, and stores the exact output through the attachment provider. The Session keeps the request, output conditions and pending, ready or failed result. Later source changes cannot change an accepted export.

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

Mount the plugin with Artifact, the Agent registry, Session projections and an attachment provider that supports verbatim file storage and verified streamed reads. The Web composition mounts it for standalone cards and comparison cells. The main Artifact service remains independent of file storage.

```yaml
- name: '@agentrans/artifact-export'
```

| Config | Default | Meaning |
|---|---|---|
| `maxExportsPerSession` | `32` | Maximum retained export identities in one Session; no automatic eviction |
| `maxInputBytes` | `262144` | Maximum UTF-8 bytes of the complete pending record, including original source, Session identity and request |
| `maxOutputBytes` | `2097152` | Maximum UTF-8 bytes of the complete generated HTML, including embedded renderers and source identity |

Call `artifactExports.create` with a stable `exportId`, `format: 'html'`, and either a current Artifact id, revision and particle checkpoint, or a saved observation reference. A current particle source requires a checkpoint. Other Scene kinds explicitly use source defaults; local sliders, selections and view state are not captured. The browser supplies neither source bytes nor computed coordinates.

Keep the complete request unchanged after an unknown response. Repeating a ready or failed request returns its existing receipt after a durability flush. Repeating a pending request explicitly continues its frozen input. Existing identities bypass a subsequently reduced input or retained-count budget. A failed request needs a new export identity for a new attempt. Reusing an identity with different intent is rejected, even if the first request failed. Oversized new inputs are rejected before appending a record or storing a file; reduce the source and start a new request.

Call `artifactExports.read` with the owning Session and ready export id to retrieve the verified exact bytes. The operation accepts no filesystem path or arbitrary attachment reference. Missing or corrupted bytes produce an explicit read failure while preserving the ready generation history. File generation, browser download request and a file actually saved by the user are separate facts.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The Artifact owner resolves the exact current revision or saved observation. Particle checkpoints are recomputed against their original source. The export owner appends a complete pending `artifact/export` record and flushes before generation. It uses the shared browser-safe `artifact/scene-export` generator, whose version, original Session identity and source identity are embedded in the output. Inherited records retain the Session that originally admitted the export. Attachment storage commits the complete immutable file before the ready record is appended and flushed. Generation or storage failures retain a failed record and its original input; an append or flush failure keeps an unknown outcome instead of claiming rollback.

The private awaited `artifactExports` Projection restores complete current records without file I/O, rendering or Agent input. Its potentially large source copies are excluded from Session summaries. A pending record after restart means incomplete or unknown work; restoring it never starts a producer. Explicit continuation can finish that exact input. Process-local concurrent identical requests share one operation, and plugin disposal waits for admitted operations to settle.

The local attachment provider stores files below the selected instance's `DSH_HOME/attachments/v1`. Development, verification and user instances therefore retain their existing filesystem separation. No export writes to source files or an arbitrary user-selected host path.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Artifact](../../../docs/subsystems/artifact.md) — source revisions and saved observations.
- [Attachment service](../../attachment/attachment/README.md) — immutable file references and verified reads.
- [Artifact Client](../../client/ui-artifact/README.md) — export controls, frozen retries and download requests.

-----

<a id="model-experience"></a>
## Model Experience

### User-requested HTML generation

#### What the model sees

`artifact/export` records export facts; exporting or downloading adds no model input and starts no model turn. The request, frozen input and result remain durable Session facts available to supported Session readers. They do not automatically become assistant evidence or a claim that the browser saved the file.

#### Token effect

No request tokens are added by generation, continuation, reading or download. A later explicitly authored message can describe a result under ordinary message rules.

#### KV Cache effect

Export records do not rewrite model history or invalidate its existing prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only native Scene HTML is supported. Free-form HTML runtime state, video and batch rendering are outside this operation.
- Particle exports retain the selected fixed step. Other Scene exports use source defaults and do not replay unsaved local view changes.
- Pending work does not resume automatically. Expensive future producers should use the existing Jobs capability and keep result files separate from process-local job state.
- Result deletion, retention cleanup and attachment garbage collection are not provided. A full result index refuses new identities without evicting earlier facts.

<a id="dev-note"></a>
### Dev Note

The focused tests cover source changes during storage, saved historical sources, retry receipts, unknown flush outcomes, exact output limits, file integrity, checkpoint suffix recovery and disposal. Built Web replay owns verification of the shipped user controls.
