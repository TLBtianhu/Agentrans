---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-04-artifact-scene-spec

[English](2026-11-04-artifact-scene-spec.md) | 中文

## 概述

将 artifact/upsert 快照从 HTML 扩展为同时支持声明式 SceneSpec。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有 HTML 快照仍然有效，因为 format:'html' 保留 source。Scene 快照使用 format:'scene' 并要求 spec，读取方拒绝缺失或非法 spec。现有 artifact id、revision、presentation、comparison 和操作语义不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/util/values/tests/scene-expression.spec.ts packages/artifact/artifact/tests/scene.spec.ts packages/artifact/artifact/tests/artifact.spec.ts：54 个测试通过。六条 Artifact/SceneSpec 浏览器回放通过。完整构建：10/10 个检查通过。

<a id="dev-note"></a>
## 开发备注

无。
