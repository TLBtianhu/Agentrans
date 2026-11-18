---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-14-csv-bar-chart

[English](2026-11-14-csv-bar-chart.md) | 中文

## 概述

Artifact 快照和冻结的 HTML 导出输入增加由 Host 计算的 CSV 柱状图类型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-14-csv-bar-chart
baseline: false
changes:
  - root: "event:artifact/export"
    previous: "2026-11-14-artifact-revision-export"
    after: "d4cc994bfeca3a14631cbb72349d7a1f14b297ef419b26118f9c115babd522e8"
    decision: same-version
  - root: "event:artifact/observations"
    previous: "2026-11-12-artifact-particle-continuation"
    after: "56f7e81b2dd31aaab76e7133b91f464f56c0c11134155318b7278bf66aad47f2"
    decision: same-version
  - root: "event:artifact/upsert"
    previous: "2026-11-12-artifact-particle-continuation"
    after: "4275a3b0168940a312597b839ea65ab1738606da3f97bbc9374dd4771c0bb875"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 Scene 类型及其导出记录保留原结构。CSV 快照必须带有 `spec.kind: 'csv-bar-chart'` 判别字段。旧版 Artifact 和导出 Projection 恢复可执行状态时会拒绝未知类型。将事件视作不透明数据的历史读取端会保留记录。Session 信封和分帧保持原样。已保存的粒子观察也引用共用 Scene 类型，其校验仍要求粒子源码。

<a id="verification"></a>
## 验证

专项测试覆盖创建源码、更新同一 Artifact 的聚合方式、拒绝过期和伪造的选择、按原修订校验回流证据，以及在独立 HTML 中切换选择。真实 DeepSeek 与 Edge 测试锁定 Warm 两行数据的原始均值 30，校验新修订的总和 60，刷新回流证据，并离线打开原图表修订。

<a id="dev-note"></a>
## 开发备注

无。
