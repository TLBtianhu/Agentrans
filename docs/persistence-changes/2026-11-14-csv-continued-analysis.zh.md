---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-14-csv-continued-analysis

[English](2026-11-14-csv-continued-analysis.md) | 中文

## 概述

父会话的 CSV 图表快照增加原始回流证据的引用和已确认的分组键。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-csv-continued-analysis
baseline: false
changes:
  - root: "event:artifact/export"
    previous: "2026-11-14-csv-bar-chart"
    after: "910a3344f9dbbc4e711c2b7e35bf495619237eccce4b1ef507772b0699a5cbb6"
    decision: same-version
  - root: "event:artifact/observations"
    previous: "2026-11-14-csv-bar-chart"
    after: "da675f7c0f9113bd09fadcfad8b8ecbe7c125a3c919e63b10fe2c0a299af2945"
    decision: same-version
  - root: "event:artifact/upsert"
    previous: "2026-11-14-csv-bar-chart"
    after: "eab8bfd91b3e717c5daf0a15459e9f69a9c8ebfb6b76e87ddb25f282ea2caa3f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有快照省略可选的 `csvContinuation` 字段，行为保持原样。新快照包含完整的 CSV 图表修订。支持 CSV 图表的旧读取器仍可显示图表中的数值，并以文本保留新的追问附件。新读取器用此字段记录来源并锁定分组，同时保留父会话的专用身份，拒绝写入第二个修订。Session 信封和原始证据保持原样。

<a id="verification"></a>
## 验证

追问测试验证已确认快照会拒绝另一个分组、客户端传入的数值以及后续修订。真实 DeepSeek 和 Edge 测试确认，锁定 Warm 两行数据的总和 60 后，发送前选择 Cold 也不会改变附件。刷新后，原证据复现 Warm 均值 30，新追问复现总和 60。

<a id="dev-note"></a>
## 开发备注

无。
