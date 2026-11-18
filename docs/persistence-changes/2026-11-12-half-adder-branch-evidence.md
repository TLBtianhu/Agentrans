---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-12-half-adder-branch-evidence

English | [中文](2026-11-12-half-adder-branch-evidence.zh.md)

## Summary

Extends the optional branch-result source marker to cover a verified half-adder checkpoint.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-half-adder-branch-evidence
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-12-bfs-branch-evidence"
    after: "ae0887d5588af5fc349a31e84e36b1aa0f3430e438353a3795cee47b267e8e24"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-12-bfs-branch-evidence"
    after: "c0b6e0f03d49f3c224691d691c5f287decff976896598e615e92ee5cfae97c1b"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-12-bfs-branch-evidence"
    after: "ccb3e1a65b71f68ec3ab1d0637c8b9d605580b78fb398a159f93fc3a05de7331"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-12-bfs-branch-evidence"
    after: "f6c9b7773ac278c96f5b001d8d3f6a9022df6f2b40a1b1e59fc441e437c62db9"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing branch-result notices keep their original markers or omit the field. Older readers display half-adder returns as ordinary branch results. New readers require the half-adder marker and matching report before reopening the original HTML. The Session version and event framing are unchanged.

<a id="verification"></a>
## Verification

332 tests passed in the Artifact, runtime, follow-up, Artifact branch and Session branch suites. The half-adder tests cover all four truth-table rows, marked branch return, and a newly confirmed setting resolved from the returned HTML source.

<a id="dev-note"></a>
## Dev Note

None.
