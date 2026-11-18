---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-14-csv-filtered-analysis

English | [中文](2026-11-14-csv-filtered-analysis.zh.md)

## Summary

Adds an optional exact filter to the immutable CSV chart recipe.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-csv-filtered-analysis
baseline: false
changes:
  - root: "event:artifact/export"
    previous: "2026-11-14-csv-continued-analysis"
    after: "350d8e92d41903a27531ca532e7062d12636316b529d774e75217673696ff250"
    decision: same-version
  - root: "event:artifact/observations"
    previous: "2026-11-14-csv-continued-analysis"
    after: "dc976e9cce200fa9306171dcfe0f60211cb5a00fa9b9e134bf4f3c6ca05638ec"
    decision: same-version
  - root: "event:artifact/upsert"
    previous: "2026-11-14-csv-continued-analysis"
    after: "5aab1d8e58cac882f9c57d80c0e7f9e236627ffd02250337e4efe04fa01ea7f8"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing charts and question attachments omit the filter and retain their previous behavior and identity. A new filtered chart stores its complete group results and sample counts. Older readers that support the native chart display the recorded results and retain the original event and attachment text, while the filter condition may be absent from their chart display. New readers show the exact filter and use it during replay. Only a confirmed continuation can commit a filtered chart. The Session envelope and original CSV are unchanged.

<a id="verification"></a>
## Verification

Focused tests cover literal matching, empty results, original CSV record numbers, paged rows, and independent identity for filtered locks. The live DeepSeek and Edge test verifies that Batch B leaves record 5 for Warm, that the sent reading stays at 35 from one row after selecting Cold, and that the original and filtered results both replay after reload.

<a id="dev-note"></a>
## Dev Note

None.
