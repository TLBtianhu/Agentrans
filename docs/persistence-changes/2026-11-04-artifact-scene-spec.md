---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-04-artifact-scene-spec

English | [中文](2026-11-04-artifact-scene-spec.zh.md)

## Summary

Extends artifact/upsert snapshots with declarative SceneSpec payloads alongside HTML.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-04-artifact-scene-spec
baseline: false
changes:
  - root: "event:artifact/upsert"
    previous: "2026-11-03-artifact-branches"
    after: "afa935bb99405c14bf090ff62f76bf45aaee85652a1fd337f434e451d9a30810"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing HTML snapshots remain valid because format:'html' retains source. Scene snapshots use format:'scene' and require spec; readers reject missing or invalid specs. Existing artifact ids, revisions, presentations, comparisons, and action semantics are unchanged.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/util/values/tests/scene-expression.spec.ts packages/artifact/artifact/tests/scene.spec.ts packages/artifact/artifact/tests/artifact.spec.ts: 54 tests passed. Six Artifact/SceneSpec browser replays passed. Full build: 10/10 gates passed.

<a id="dev-note"></a>
## Dev Note

None.
