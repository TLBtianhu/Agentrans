---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-17-locked-function-plot-export

English | [中文](2026-11-17-locked-function-plot-export.zh.md)

## Summary

Records the saved function, parameters, probe and readings for version 2 HTML exports of continued function plots.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-17-locked-function-plot-export
baseline: false
changes:
  - root: "event:artifact/export"
    previous: "2026-11-14-csv-filtered-analysis"
    after: "c117be6cfbbe53f9caf765eae72858f9ef4246fa23a014feae644c2cb0a909d9"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The current reader preserves version 1 source-default and particle export records. Version 1 pending records continue their original conditions, and ready records keep their stored attachment bytes. The older export decoder uses a literal version 1 and a closed condition enum, so it rejects version 2 records before interpreting any readings.

<a id="verification"></a>
## Verification

The artifact-export service and reader compatibility suites cover cold replay and retry after the source advances, historical revision export, version 1 pending defaults, and rejection of invalid version 2 conditions.

<a id="dev-note"></a>
## Dev Note

None.
