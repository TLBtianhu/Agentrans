---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-16-inquiry-fork-anchor

[English](2026-11-16-inquiry-fork-anchor.md) | 中文

## 概述

手动探究分支将选中的助手原文写入子 Session header 和 JSONL header 行的可选 inquiry 字段。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-16-inquiry-fork-anchor
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-09-11-initial"
    after: "0be486bfbfc5be794025190e28b5049c72431826a474c98c9bc15b0783e580cc"
    decision: same-version
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "9ae228c37b0e13402dff526e4b2237f8a08ca2136bd3c8b006e39f664ff6520e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

当前读取器接受缺省 inquiry 的旧 header。普通开岔保留原有 header 结构。较早的严格 V4 读取器会在回放或写入前拒绝带 inquiry 的 header，因此旧版本无法打开新建的探究分支。两种读取器都会在处理事件日志前拒绝无效的 header。

<a id="verification"></a>
## 验证

Session 开岔命令测试核对选段的 UTF-16 范围和父级已完成回答。V4 编解码测试覆盖字段往返和旧 framing 拒绝。JSONL 测试以全新存储实例打开子分支，通过 list、stat 和回放恢复原文定位信息。

<a id="dev-note"></a>
## 开发备注

无。
