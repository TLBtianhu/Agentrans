---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-12-half-adder-branch-evidence

[English](2026-11-12-half-adder-branch-evidence.md) | 中文

## 概述

扩展可选的分支结果来源标记，支持已经核对的半加器检查点。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

既有分支结果通知保留原标记，也可省略该字段。较早的读取器把半加器回流显示为普通分支结果。新的读取器在标记和报告均匹配时重开原始 HTML。Session 版本和事件封装保持原格式。

<a id="verification"></a>
## 验证

Artifact、运行时、追问、Artifact 分支及 Session 分支测试共 332 项通过。半加器用例覆盖全部四行真值表、带标记的分支回流，以及从回流 HTML 源码解析新确认的设置。

<a id="dev-note"></a>
## 开发备注

无。
