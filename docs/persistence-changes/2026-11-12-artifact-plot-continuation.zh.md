---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-12-artifact-plot-continuation

[English](2026-11-12-artifact-plot-continuation.md) | 中文

## 概述

为从回流证据创建的函数图首个修订添加可选的继续实验数据。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-artifact-plot-continuation
baseline: false
changes:
  - root: "event:artifact/export"
    previous: "2026-11-07-fixed-source-artifact-export"
    after: "325d2dd05d1d215613bcc3d3f921f146f403984886f20c9d43ac3d50f5763507"
    decision: same-version
  - root: "event:artifact/observations"
    previous: "2026-11-07-saved-artifact-observations"
    after: "48dc82198a32db07999f8f5b23da7a24434d5c0e23f0a7588c54735a0b7647de"
    decision: same-version
  - root: "event:artifact/upsert"
    previous: "2026-11-07-saved-artifact-observations"
    after: "a55bc45ef821d6d8d422030bb0bb65f642ed22c573c812bfe3e9f6975e86c52b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有记录可省略该字段，仍能独立呈现。较早的读取器按 SceneSpec 默认条件呈现原生函数图。新的读取器通过可选数据恢复固定的函数、参数、描点与基线读数。当前 Session 格式继续识别既有 Artifact 事件。

<a id="verification"></a>
## 验证

Artifact、分支证据、追问与 Session 分支测试共 244 项通过。继续实验用例核对原始 SceneSpec、默认视口以外的描点、固定的来源身份，以及重新打开后恢复同一个子分支。

<a id="dev-note"></a>
## 开发备注

无。
