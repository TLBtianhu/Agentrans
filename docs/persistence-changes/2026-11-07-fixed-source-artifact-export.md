---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-07-fixed-source-artifact-export

English | [中文](2026-11-07-fixed-source-artifact-export.zh.md)

## Summary

Add the required artifact/export fact with immutable request identity, complete original Scene input, explicit exporter/runtime conditions, and pending, ready or failed generation state. Ready results reference content-addressed attachment bytes rather than embedding HTML in Session logs.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-fixed-source-artifact-export
baseline: false
changes:
  - root: "event:artifact/export"
    previous: null
    after: "a211f1c23f6644a71f8a487deea922b5f61be86197e450ab425a8c50e34d39b9"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The event discriminator is new and remains required-on-read. Existing v4 Sessions without exports are unchanged. A released v4 codec preserves the complete event, and a reader lacking artifact/export explicitly refuses restoration with SessionFormatUnsupportedMigrationError without mutating the artifact. An aware reader retains the original source, checkpoint, generation state and file reference. No frozen codec, former schema generation or format version is changed.

<a id="verification"></a>
## Verification

packages/artifact/artifact-export/tests/reader-compat.spec.ts verifies old-reader refusal without mutation and aware-reader round-trip equality through the released v4 codec (2 tests passed). packages/sdk/client/tests/artifact-export-projection.spec.ts preserves the complete fact in events and notifications with unchanged assistant output; the Python SDK parametrized artifact-export projection case also passes. Host behavior tests cover fixed-source retries and result-file recovery.

<a id="dev-note"></a>
## Dev Note

None.
