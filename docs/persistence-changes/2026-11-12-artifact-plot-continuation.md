---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-12-artifact-plot-continuation

English | [中文](2026-11-12-artifact-plot-continuation.zh.md)

## Summary

Adds optional continuation metadata to the first revision of a function plot created from returned branch evidence.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-artifact-plot-continuation
baseline: false
changes:
  - root: "event:artifact/export"
    previous: "2026-11-07-fixed-source-artifact-export"
    after: "325d2dd05d1d215613bcc3d3f921f146f403984886f20c9d43ac3d50f5763507"
    decision: same-version
  - root: "event:artifact/observations"
    previous: "2026-11-07-saved-artifact-observations"
    after: "48dc82198a32db07999f8f5b23da7a24434d5c0e23f0a7588c54735a0b7647de"
    decision: same-version
  - root: "event:artifact/upsert"
    previous: "2026-11-07-saved-artifact-observations"
    after: "a55bc45ef821d6d8d422030bb0bb65f642ed22c573c812bfe3e9f6975e86c52b"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records omit the optional continuation and remain independently renderable. Readers that predate this field render the native function plot from its SceneSpec defaults. New readers restore the fixed function, parameters, trace and baseline readings from the optional metadata. The current Session format still identifies the existing Artifact events.

<a id="verification"></a>
## Verification

244 tests passed in the Artifact, branch evidence, follow-up and Session fork suites. The continuation test checks the exact original SceneSpec, a trace outside the default viewport, immutable source identities, and recovery of the same child after reopening.

<a id="dev-note"></a>
## Dev Note

None.
