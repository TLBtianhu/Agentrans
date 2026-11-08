---
description: "将手动分支结论连同用户选择的已保存 Artifact 观察或固定比较回流，不启动父级模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-artifact-branch

[English](README.md) | 中文

## 概述

将一条子分支结论与用户明确选择的已保存观察或固定比较一起回流。父级收到结论以及自包含的源码、检查点和计算证据。预览和取消不改变历史，确认不会启动模型轮次。重复相同回流会复用回执；已回流结论再选择不同证据会被拒绝。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web 组合将本插件与 Artifact、Session Query 和 Session Controller 一同挂载。自定义 Web 组合需添加 `@deepseek-ai/dsh-artifact-branch` 插件行。主 Artifact 服务和 headless 组合不依赖这个桥接能力。

```yaml
- name: '@deepseek-ai/dsh-artifact-branch'
```

| 配置 | 默认值 | 含义 |
|---|---|---|
| `maxActionBytes` | `16384` | 完整回流 UserMessage 的 UTF-8 字节上限，包括结论、证据和元数据 |

使用直接父级、子分支结论序号和已保存引用调用 `artifactBranchResults.returnResult`。请求不包含结论文本、坐标或任意证据 Session。观察可以继承自子分支可见前缀。比较双方必须保持相同比较组、互补角色、运行版本、时间步长和步数。

结果未知时可安全重试同一请求。更换选择会与该结论已有回流冲突，包括先前没有证据的回流。打开父级可查看已接受内容。消息过大需要更小实验；观察缺失需要刷新证据。这两种拒绝都不会追加输入。

-----

<a id="understand-the-implementation"></a>
## 实现说明

服务从同一个不可变子分支观察中读取结论和已保存观察。它重算证据，并使用共用的 `session-branch/admission` 操作串行化父级追加与 flush。父级收到带额外证据文本的普通 `branch-result` 用户消息。其 source 字段和 Session 事件种类不变。已保存源码副本保持为消息数据，不替换父级 Artifact。

[准入决策](../../../.agents/notes/implemented/architecture/2026-11-07-evidence-bearing-branch-results.zh.md)解释了已回流结论为何保持不变，以及桥接为何独立于主 Artifact 服务。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [手动分支](../../../docs/subsystems/branch.zh.md)——谱系、结论身份和共用准入。
- [Artifact](../../../docs/subsystems/artifact.zh.md)——已保存源码与固定比较。
- [Artifact Client](../../client/ui-artifact/README.zh.md)——用户选择与确认。

-----

<a id="model-experience"></a>
## 模型体验

### 已确认的带证据结论

#### 模型看到什么

父级只收到选中的可见结论及用户选择的实验证据，包括原始源码快照、检查点和计算值。这不表示助手撰写结论时使用过这些证据。不合并推理、子分支全文、兄弟历史或后来的父级状态。回流操作不会调用子级或父级模型。

#### Token 影响

只有确认会加入有界的结论与证据消息。完整源码副本可能比纯结论占用更多上下文。预览、取消和被拒绝的选择不会加入模型输入；相同重试不会重复加入。

#### KV 缓存影响

新的用户消息按普通缓存规则参与父级下一次请求。操作在当前尾部追加，不改写已有前缀，也不改变子分支历史。

##### 证据归属

```markdown
The user selected the following saved Artifact evidence to accompany this conclusion. This does not state that the assistant used it when producing the conclusion.
```

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 只接受直接普通手动分支及其自有的持久 assistant 结论。
- 一次回流附加一个已保存粒子观察或一对兼容观察，不推断因果、不编辑结论，也不自动合并对话。
- 完整消息上限可能拒绝大源码快照；已有观察继续保留。

<a id="dev-note"></a>
### 开发备注

随产品提供的确认路径见[分支验证](../../../docs/subsystems/branch.zh.md#verification)。
