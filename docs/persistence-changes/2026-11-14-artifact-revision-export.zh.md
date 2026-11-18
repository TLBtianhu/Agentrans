---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-14-artifact-revision-export

[English](2026-11-14-artifact-revision-export.md) | 中文

## 概述

固定输入的 HTML 导出记录增加历史 Scene 修订引用。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

当前修订与已保存观察的导出记录保留原字段。新的历史导出请求指向会话日志中的确切 Scene 修订，并保存冻结的源码。旧版 Host 无法校验这种历史导出记录。Session 版本与事件分帧保持原样。

<a id="verification"></a>
## 验证

导出测试恢复含有两个修订的会话，生成原版 HTML，并验证不存在的修订会被拒绝，同一导出 ID 也无法用于另一个修订。

<a id="dev-note"></a>
## 开发备注

无。
