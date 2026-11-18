---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-12-bfs-branch-evidence

English | [中文](2026-11-12-bfs-branch-evidence.zh.md)

## Summary

Adds an optional branch-result source marker for a BFS checkpoint validated against the original child Artifact revision.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-bfs-branch-evidence
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-03-artifact-branches"
    after: "1dd53885ce46a50c56b8fbe0a7423077937b328270be382696686658da8e97b2"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-03-artifact-branches"
    after: "495f6ce82e0df84d6870e09f449a329a96a7b44381b152e4fc211144be6d805c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-03-artifact-branches"
    after: "60d0f14bc355600bf0540a7ef0b144a7e0d65fc8454d4ab316d540ee25754623"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-03-artifact-branches"
    after: "d6f1605ad2a75abe1c8f5fcc394d78216906a8dcf60d2ddd835c975b342bf8b1"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing branch-result messages omit the marker and retain their ordinary message semantics. Older readers can display marked returns as ordinary branch results. New readers require the marker before reopening HTML from a branch-result notice. The marker does not change the Session version, event framing, or model history.

<a id="verification"></a>
## Verification

97 tests passed across the Artifact branch, Session branch, Artifact follow-up and Session Controller branch-return suites. The BFS cases verify exact historical HTML, checkpoint validation, retry after reopening, and rejection of a receipt match between plain text and marked evidence.

<a id="dev-note"></a>
## Dev Note

None.
