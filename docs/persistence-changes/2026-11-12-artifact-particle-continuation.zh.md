---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-12-artifact-particle-continuation

[English](2026-11-12-artifact-particle-continuation.md) | 中文

## 概述

为从回流证据创建的粒子实验首个修订添加可选的来源引用和粒子检查点。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-artifact-particle-continuation
baseline: false
changes:
  - root: "event:artifact/export"
    previous: "2026-11-12-artifact-plot-continuation"
    after: "301da286ed765b427bb3ac2f6a1d2d1c8f97f34a7ea4814ce09a1d3e85618bc0"
    decision: same-version
  - root: "event:artifact/observations"
    previous: "2026-11-12-artifact-plot-continuation"
    after: "a807875423a864f3f21a9a74fc5f566acb5cfcaad436e3c22091833e40bfe83c"
    decision: same-version
  - root: "event:artifact/upsert"
    previous: "2026-11-12-artifact-plot-continuation"
    after: "9b80d2db5883cdf4834535260f2061ff4441032958fc4412f062cb4cab56324e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有记录可省略该字段，仍按 SceneSpec 呈现。较早的读取器按 SceneSpec 初始条件呈现新的粒子实验。新的读取器通过检查点和原生源码恢复准确的基线。当前 Session 格式继续识别既有 Artifact 事件。

<a id="verification"></a>
## 验证

Artifact、分支证据和追问测试共 233 项通过。粒子继续实验用例核对来源更新后的原始修订、重新打开后重试同一请求、拒绝在其他步数修改重力，以及用用户确认的重力创建下一次实验。

<a id="dev-note"></a>
## 开发备注

无。
