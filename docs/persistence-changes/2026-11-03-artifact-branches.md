---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-03-artifact-branches

English | [中文](2026-11-03-artifact-branches.zh.md)

## Summary

Add complete HTML Artifact snapshots, user-reviewed Artifact actions, and confirmed manual-branch result returns.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-03-artifact-branches
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "92843df0cc1168a61b959b5427c5d1e58718440c526dcb99b63eeb1c0cb0e126"
    decision: same-version
  - root: "event:artifact/upsert"
    previous: null
    after: "04bc9576386503c1fcb0ec5dc335d25bc6121b93f7ce8c7f3ea04e10be6b1baf"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "f98c46829fb2ab39996800104635651dd8dc7462868e57c69dc97062a205395b"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "36ef07a3a605eed8f119fa583211e8ad6c59992ee7a7229d5de4de4c33f312d2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "d89cd90e1ddccfbfc59b3afd3fadf8df9a86fb36c5150a8143ce40c275b937bf"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The new artifact/upsert event is additive and required-on-read; older readers without its declaration cannot safely interpret it and must not silently skip it. artifact-action and branch-result are attribution-only message source kinds. They preserve and derive ordinary user messages even without their producers, and they grant no filesystem, network, approval, or other authority. Existing logs and Session format version remain unchanged.

<a id="verification"></a>
## Verification

Artifact Host: 48/48 tests with 100% statement, branch, function, and line coverage. Artifact Client: 40/40 tests with 100% coverage. A real headless Edge sandbox smoke confirmed inline execution, opaque-origin isolation, CSP network denial, and action return. Manual-branch domain, lineage, and return tests: 42/42 passed. The first-slice full build passed 10/10 gates and recorded 370 client artifacts.

<a id="dev-note"></a>
## Dev Note

None.
