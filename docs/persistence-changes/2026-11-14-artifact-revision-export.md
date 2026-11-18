---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-14-artifact-revision-export

English | [中文](2026-11-14-artifact-revision-export.zh.md)

## Summary

Adds a historical Scene revision reference to fixed-input HTML export records.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-artifact-revision-export
baseline: false
changes:
  - root: "event:artifact/export"
    previous: "2026-11-12-artifact-particle-continuation"
    after: "7eb7f09a41108e5a418923c11fe9cb216945e88b22dbe14879dc3bb0eff6f8a2"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Current and saved-observation export records retain their existing fields. New historical requests point to an exact Scene revision in the Session log and store its frozen source. Hosts that predate this selection cannot validate new historical export records. The Session version and event framing are unchanged.

<a id="verification"></a>
## Verification

The export tests restore a Session with two versions, then generate the original HTML, reject an unknown revision, and reject reusing an export identity for a different revision.

<a id="dev-note"></a>
## Dev Note

None.
