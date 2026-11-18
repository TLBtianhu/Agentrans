---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-17-locked-function-plot-export

[English](2026-11-17-locked-function-plot-export.md) | 中文

## 概述

为从回流证据继续的函数图记录 HTML 导出器版本 2 所需的函数、参数、探针和读数。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-17-locked-function-plot-export
baseline: false
changes:
  - root: "event:artifact/export"
    previous: "2026-11-14-csv-filtered-analysis"
    after: "c117be6cfbbe53f9caf765eae72858f9ef4246fa23a014feae644c2cb0a909d9"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

当前读取器保留版本 1 的源码默认条件与粒子导出记录。版本 1 的待完成记录仍按原条件继续，已完成记录保留原附件字节。旧导出解码器只接受版本 1 和封闭的条件枚举，会在解释读数前拒绝版本 2 记录。

<a id="verification"></a>
## 验证

artifact-export 服务及读取兼容测试覆盖冷恢复、源码推进后重试、历史修订导出、版本 1 待完成记录的原始条件及拒绝无效的版本 2 条件。

<a id="dev-note"></a>
## 开发备注

无。
