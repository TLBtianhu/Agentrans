---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-12-artifact-particle-continuation

English | [中文](2026-11-12-artifact-particle-continuation.zh.md)

## Summary

Adds an optional source reference and particle checkpoint to the first revision of a particle system created from returned branch evidence.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-artifact-particle-continuation
baseline: false
changes:
  - root: "event:artifact/export"
    previous: "2026-11-12-artifact-plot-continuation"
    after: "301da286ed765b427bb3ac2f6a1d2d1c8f97f34a7ea4814ce09a1d3e85618bc0"
    decision: same-version
  - root: "event:artifact/observations"
    previous: "2026-11-12-artifact-plot-continuation"
    after: "a807875423a864f3f21a9a74fc5f566acb5cfcaad436e3c22091833e40bfe83c"
    decision: same-version
  - root: "event:artifact/upsert"
    previous: "2026-11-12-artifact-plot-continuation"
    after: "9b80d2db5883cdf4834535260f2061ff4441032958fc4412f062cb4cab56324e"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records omit the optional field and render from their SceneSpec. Older readers can render new particle sources from the SceneSpec's initial conditions. New readers use the checkpoint and native source to restore the exact baseline. The current Session format continues to identify the existing Artifact events.

<a id="verification"></a>
## Verification

233 tests passed in the Artifact, branch evidence and follow-up suites. The particle continuation case checks the original revision after a source update, identical retries after reopening, gravity override rejection at a different step, and a new continuation seeded by the reviewed gravity.

<a id="dev-note"></a>
## Dev Note

None.
