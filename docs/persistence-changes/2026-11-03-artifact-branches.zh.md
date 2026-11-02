---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-03-artifact-branches

[English](2026-11-03-artifact-branches.md) | 中文

## 概述

新增完整 HTML Artifact 快照、用户确认的 Artifact 操作，以及手动分支结论确认回流。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

新增 artifact/upsert 事件是增量且读取时必需的类型；没有其声明的旧读者不能安全解释它，也不得静默跳过。artifact-action 与 branch-result 只是消息来源 attribution 类型，即使没有对应 producer 也会保留并派生普通用户消息，不授予文件、网络、批准或其他权限。既有日志和 Session format version 不变。

<a id="verification"></a>
## 验证

Artifact Host：48/48 测试，语句、分支、函数、行覆盖率均 100%。Artifact Client：40/40 测试，覆盖率均 100%。真实无头 Edge 沙箱冒烟验证了 inline 执行、不透明 origin 隔离、CSP 网络拒绝和操作回传。手动分支领域、谱系和回流测试 42/42 通过。第一轮完整构建 10/10 通过，记录 370 个 Client artifacts。

<a id="dev-note"></a>
## 开发备注

无。
