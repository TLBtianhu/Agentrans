---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-12-bfs-branch-evidence

[English](2026-11-12-bfs-branch-evidence.md) | 中文

## 概述

在分支结果来源中添加可选标记，表示 BFS 检查点已与子分支的原始 Artifact 修订核对。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

既有分支结果消息省略该标记，保留普通消息语义。较早的读取器可把带标记的回流显示为普通分支结果。新的读取器只会重开具有标记的回流 HTML。标记不改变 Session 版本、事件封装或模型历史。

<a id="verification"></a>
## 验证

Artifact 分支、Session 分支、Artifact 追问及 Session Controller 分支回流测试共 97 项通过。BFS 用例核对原始 HTML、检查点校验和重开后重试，并验证普通文本回执不能代替带标记的证据回执。

<a id="dev-note"></a>
## 开发备注

无。
