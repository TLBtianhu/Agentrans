---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-07-saved-artifact-observations

[English](2026-11-07-saved-artifact-observations.md) | 中文

## 概述

新增持久粒子观察，并确认其源码快照引用的既有六类 SceneSpec 联合类型扩展。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-saved-artifact-observations
baseline: false
changes:
  - root: "event:artifact/observations"
    previous: null
    after: "0fd31cb885dfc6296db96b70902c0a23d94629258804a98816fb614a9d3133b9"
    decision: same-version
  - root: "event:artifact/upsert"
    previous: "2026-11-04-artifact-scene-spec"
    after: "b6041b5f5ce15b87913b3f6bef7313572fb4dc4abc4f1a52fe02d617c38d2e52"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 HTML 与 function-plot 快照保留原有判别字段及必需源码字段。此前确认的 SceneSpec schema 只包含 function-plot；另外五类原生场景使用不同 kind 字面量，function-only 校验路径会明确拒绝它们。本记录确认该既有目录扩展，不声称已运行旧发布二进制。已保存观察使用新的必需 artifact/observations 判别字段、完整源码修订和带运行版本的检查点。已发布 V4 读取器的已知词汇不包含新事件时会拒绝 Session，而不是丢弃已保存实验；当前读取器保留这些事实。新读取器恢复旧日志时得到空保存列表。陌生分支可被安全拒绝，因此 writer 保持 V4，不承诺降级支持。不修改冻结 schema 或迁移代际。

<a id="verification"></a>
## 验证

Artifact、已保存观察、已发布读取器兼容、SceneSpec 兼容与 TypeScript SDK 定向测试共 81 项通过。必需事件测试通过已发布 V4 codec 往返真实 Session，核对未知词汇拒绝及已知词汇保留。SceneSpec 测试读取冻结确认记录，保留已有函数图计算字段，并在 function-only 校验器中逐一拒绝新增类型。Python SDK 已保存观察投影测试通过。

<a id="dev-note"></a>
## 开发备注

无。
