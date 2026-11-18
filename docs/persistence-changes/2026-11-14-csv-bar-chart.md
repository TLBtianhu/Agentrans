---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-14-csv-bar-chart

English | [中文](2026-11-14-csv-bar-chart.zh.md)

## Summary

Adds the Host-computed CSV bar chart Scene kind to Artifact snapshots and frozen HTML export inputs.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-csv-bar-chart
baseline: false
changes:
  - root: "event:artifact/export"
    previous: "2026-11-14-artifact-revision-export"
    after: "d4cc994bfeca3a14631cbb72349d7a1f14b297ef419b26118f9c115babd522e8"
    decision: same-version
  - root: "event:artifact/observations"
    previous: "2026-11-12-artifact-particle-continuation"
    after: "56f7e81b2dd31aaab76e7133b91f464f56c0c11134155318b7278bf66aad47f2"
    decision: same-version
  - root: "event:artifact/upsert"
    previous: "2026-11-12-artifact-particle-continuation"
    after: "4275a3b0168940a312597b839ea65ab1738606da3f97bbc9374dd4771c0bb875"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Scene kinds and their export records retain their original structure. A CSV snapshot uses the required `spec.kind: 'csv-bar-chart'` discriminator. Older Artifact and export projections reject the unknown kind when restoring executable state. Historical readers that keep events opaque retain the record. The Session envelope and framing are unchanged. The shared Scene type also appears in saved particle observations, whose validation still requires a particle source.

<a id="verification"></a>
## Verification

Focused tests cover source creation, changed aggregation on the same Artifact, stale and forged selections, branch evidence validation against the original revision, and standalone HTML selection. The live DeepSeek and Edge test locks the original Warm mean of 30 from two rows, verifies the revised total of 60, reloads the returned evidence, and opens the original chart revision offline.

<a id="dev-note"></a>
## Dev Note

None.
