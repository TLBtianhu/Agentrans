---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-07-saved-artifact-observations

English | [中文](2026-11-07-saved-artifact-observations.zh.md)

## Summary

Adds durable saved particle observations and acknowledges the existing six-kind SceneSpec union referenced by their source snapshots.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-saved-artifact-observations
baseline: false
changes:
  - root: "event:artifact/observations"
    previous: null
    after: "0fd31cb885dfc6296db96b70902c0a23d94629258804a98816fb614a9d3133b9"
    decision: same-version
  - root: "event:artifact/upsert"
    previous: "2026-11-04-artifact-scene-spec"
    after: "b6041b5f5ce15b87913b3f6bef7313572fb4dc4abc4f1a52fe02d617c38d2e52"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing HTML and function-plot snapshots retain their discriminators and required source fields. The previously acknowledged SceneSpec schema contains only function-plot; the five additional native kinds use distinct kind literals and the function-only validation path explicitly rejects them. This record acknowledges that existing catalog expansion without claiming an old published binary was exercised. Saved observations use a new required artifact/observations discriminator, complete source revision and runtime-versioned checkpoint. A released V4 reader whose known vocabulary omits the new event refuses the Session rather than dropping saved experiments; current readers retain it. New readers restore old logs with an empty saved list. The writer remains V4 because unfamiliar variants can be refused safely; downgrade support is not promised. No frozen schemas or migration generations are changed.

<a id="verification"></a>
## Verification

Focused Artifact, saved-observation, released-reader compatibility, SceneSpec compatibility and TypeScript SDK tests: 81 passed. The required-event test round-trips a real Session through the released V4 codec and checks unknown-vocabulary refusal and known-vocabulary retention. The SceneSpec test reads the frozen acknowledgement, preserves existing function-plot computation fields and rejects each additional kind in the function-only validator. The Python SDK saved-observation projection test passed.

<a id="dev-note"></a>
## Dev Note

None.
