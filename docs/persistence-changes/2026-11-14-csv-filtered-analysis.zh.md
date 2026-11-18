---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-14-csv-filtered-analysis

[English](2026-11-14-csv-filtered-analysis.md) | 中文

## 概述

不可变 CSV 图表计算条件增加可选的精确筛选。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-csv-filtered-analysis
baseline: false
changes:
  - root: "event:artifact/export"
    previous: "2026-11-14-csv-continued-analysis"
    after: "350d8e92d41903a27531ca532e7062d12636316b529d774e75217673696ff250"
    decision: same-version
  - root: "event:artifact/observations"
    previous: "2026-11-14-csv-continued-analysis"
    after: "dc976e9cce200fa9306171dcfe0f60211cb5a00fa9b9e134bf4f3c6ca05638ec"
    decision: same-version
  - root: "event:artifact/upsert"
    previous: "2026-11-14-csv-continued-analysis"
    after: "5aab1d8e58cac882f9c57d80c0e7f9e236627ffd02250337e4efe04fa01ea7f8"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

现有图表和追问附件省略筛选条件，保留原有行为和身份。新筛选图表保存完整分组结果及样本数。支持原生图表的旧版仍可显示已记录的结果，保留原事件及附件文本，图表上可能省略筛选条件。新版显示确切条件并在复现时使用它。只有已确认的继续分析可以提交筛选图表。Session 信封和原始 CSV 保持原样。

<a id="verification"></a>
## 验证

专项测试覆盖文本精确匹配、空结果、CSV 原记录序号、参与行分页，以及筛选锁定的独立身份。真实 DeepSeek 与 Edge 测试验证 Batch B 下 Warm 只剩记录 5，切换到 Cold 后发送的读数仍为 35、样本数 1，且刷新后原始与筛选结果都可复现。

<a id="dev-note"></a>
## 开发备注

无。
