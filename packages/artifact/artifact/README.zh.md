---
description: "Session 持久化 HTML 和 SceneSpec Artifact、模型创建/更新工具，以及用户确认后的交互消息。"
kind: "package-reference"
---

# @deepseek-ai/dsh-artifact

[English](README.md) | 中文

## 概述

本包负责持久化 HTML 和 SceneSpec Artifact：以稳定 id、compare-and-set 修订号和语义呈现方式保存完整快照，并提供模型侧 `artifact` 和 `scene` 工具。Remote `record` 方法把用户确认的操作转换为普通文本 `UserMessage`；操作不授予文件、网络或批准权限。

## 目录

- [使用](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用

以 `@deepseek-ai/dsh-artifact` 挂载服务，以 `@deepseek-ai/dsh-artifact/tool` 挂载 HTML 工具，以 `@deepseek-ai/dsh-artifact/scene-tool` 挂载 SceneSpec 工具。服务负责校验、读取当前修订号和提交 Session；每个工具先准备快照，只有最终工具结果成功才提交。SceneSpec 使用版本化 SceneCatalog 和安全表达式解析器校验，不使用 `eval`。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `maxSourceBytes` | `262144` | 一份完整 HTML 源码的 UTF-8 字节上限 |
| `maxActionBytes` | `16384` | 完整编码操作消息的 UTF-8 字节上限 |

创建从修订号 1 开始。更新必须提供 `baseRevision`，且只有等于当前持久化修订号才成功。每条 `artifact/upsert` 都携带完整 `ArtifactSnapshot`，不是增量。

-----

<a id="understand-the-implementation"></a>
## 实现说明

Artifact 可以向父页面发送 `{ kind: 'artifact-action', artifactId, revision, action, payload }`。Host 在投递前校验当前修订号和完整消息大小。`wake: false` 使用 `agent.inject`；`wake: true` 使用 `agent.steer`。是否需要人工确认由 UI 政策决定。

Scene 快照使用 `format: 'scene'` 和完整 `spec`。当前 catalog 支持 `function-plot`，包含函数、有界参数、视口和描点设置。未知变量或函数、非法参数范围和非有限表达式结果都会在提交前拒绝。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Artifact 子系统](../../../docs/subsystems/artifact.zh.md)——协议值与持久语义。
- [Artifact Client](../../client/ui-artifact/README.zh.md)——沙箱 HTML 呈现与确认操作。
- [Conversation 装配](../../../docs/subsystems/conversation.zh.md)——稳定事件到节点的关联。

-----

<a id="model-experience"></a>
## 模型体验

### scene

#### 模型看到什么

`scene` 工具接受 `action`、`kind`、`sceneId`、`title`、完整 `spec`、`presentation`，以及仅更新使用的 `baseRevision`。结果只重复 `sceneId`、`revision`、`title`、`kind` 和 `presentation`。SceneSpec JSON 在提交前校验，不是 HTML，也不执行模型生成的 JavaScript。

#### Token 影响

每个启用的 preset 增加一份有界 JSON schema。结果很短，不包含源码。

#### KV Cache 影响

创建或修改 Scene 只追加 log-only 事件，不改写模型前缀。

### artifact

#### 模型看到什么

`artifact` 工具接受 `action`、`artifactId`、`title`、`source`、`presentation`、可选 `comparison`，以及仅更新使用的 `baseRevision`。`comparison` 是可选的 `{ group, role: 'control' | 'variant' }` 关系，不会合并两个快照。结果只重复 `artifactId`、`revision`、`title` 和 `presentation`，不重复 HTML 源码。工具说明包含 iframe 消息格式，以及操作只是输入而非授权的规则。

#### Token 影响

每个启用的 preset 挂载一份工具 schema。创建/更新结果只增加一段短 JSON。操作消息只有一个有界 JSON 文本块，并能作为普通用户输入重建。

#### KV Cache 影响

创建或修改 Artifact 只追加 log-only 事件，不改写旧模型前缀。准入 Artifact 操作会按接收 Agent 的普通缓存规则新增一条用户输入。

##### Artifact 操作

```markdown
A confirmed action becomes one bounded user message; it grants no additional authority.
```

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 当前 SceneCatalog 只支持 `function-plot`；流程图和粒子系统在迁移为原生 SceneSpec 前仍是参考 HTML 模板。
- 持久事实包括源码、修订号和语义操作消息，不包括 iframe JavaScript 堆、Canvas 像素、滚动位置或未确认的待发送操作。
- 修订检查由所属 Agent 操作串行化，不是跨进程事务。
- 服务不执行或清理 HTML。执行由 Client 的不透明 origin iframe 与内容策略负责。

<a id="dev-note"></a>
### 开发备注

无。
