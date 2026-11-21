---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-14-csv-continued-analysis

English | [中文](2026-11-14-csv-continued-analysis.zh.md)

## Summary

Adds the original returned-evidence reference and confirmed group key to a parent-local CSV chart snapshot.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-csv-continued-analysis
baseline: false
changes:
  - root: "event:artifact/export"
    previous: "2026-11-14-csv-bar-chart"
    after: "910a3344f9dbbc4e711c2b7e35bf495619237eccce4b1ef507772b0699a5cbb6"
    decision: same-version
  - root: "event:artifact/observations"
    previous: "2026-11-14-csv-bar-chart"
    after: "da675f7c0f9113bd09fadcfad8b8ecbe7c125a3c919e63b10fe2c0a299af2945"
    decision: same-version
  - root: "event:artifact/upsert"
    previous: "2026-11-14-csv-bar-chart"
    after: "eab8bfd91b3e717c5daf0a15459e9f69a9c8ebfb6b76e87ddb25f282ea2caa3f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing snapshots omit the optional `csvContinuation` field and retain their behavior. The new snapshot contains a complete CSV chart revision. Older readers that support CSV charts can render its values and retain the new question attachment as text. The marker records the returned source and locks the group for new readers. They reserve the parent-local identity and refuse attempts to write a second revision. The Session envelope and the original evidence remain unchanged.

<a id="verification"></a>
## Verification

The follow-up tests verify that a confirmed snapshot rejects another group, supplied values, and a subsequent revision. The live DeepSeek and Edge test confirms that a Warm total of 60 from two rows survives selecting Cold before sending. After reload, the original evidence replays the Warm mean of 30 and the new question replays its total of 60.

<a id="dev-note"></a>
## Dev Note

None.
