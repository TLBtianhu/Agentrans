---
description: "Artifact 包组导航：持久化可执行解释、模型操作与浏览器呈现。"
kind: "package-group"
---

# packages/artifact

[English](README.md) | 中文

## 概述

Artifact 家族保存代码生成的交互解释，不把它们与文件、工具卡或纯浏览器状态混淆。Host 包负责完整 Session 快照、修订号和操作消息；Client 包在隔离 HTML frame 中呈现，并回传用户确认的意图。

## 包

| 包 | 职责 |
|---|---|
| [`artifact`](artifact/README.zh.md) | 校验并提交 Artifact 快照，提供模型工具与操作 Remote |
| [`artifact-branch`](artifact-branch/README.zh.md) | 回流结论与用户选择的已保存证据 |
| [`artifact-export`](artifact-export/README.zh.md) | 固定 Scene 输入并保存 HTML 导出结果 |
| [`artifact-followup`](artifact-followup/README.zh.md) | 在普通问题中解析用户选择的实验事实 |
| [`artifact-runtime`](artifact-runtime/README.zh.md) | 持有实时渲染器报告，并提供精确修订的模型查询 |
| [`ui-artifact`](../client/ui-artifact/README.zh.md) | 将 Artifact 事件折叠为稳定 Chat 节点，并渲染受限 iframe |

## 相关文档

- [Artifact 子系统](../../docs/subsystems/artifact.zh.md)——协议值、持久事件与操作语义。
- [Conversation 装配](../../docs/subsystems/conversation.zh.md)——稳定事件到节点的关联与回放。
- [分发](../../DISTRIBUTION.md)——产品身份与数据根隔离。

## 开发备注

无。
