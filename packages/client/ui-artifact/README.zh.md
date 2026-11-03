---
description: "Web GUI 的沙箱 HTML Artifact 卡片：版本替换、源码查看，以及用户确认后发送给所属 Agent 的操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-artifact

[English](README.md) | 中文

## 概述

在产生 Artifact 的对话旁阅读交互 HTML。每个 checkpoint 都能独立呈现，即使历史里只有最新修订。你可以在行内与展开视图间切换、检查 HTML 源码，并且只在明确确认后发送 Artifact 操作。预览无法访问父应用或远程依赖。

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

在 Web 组合中将本插件与 Conversation、Chat、locale 和 Artifact Remote 服务一起挂载。本包没有配置字段。

### 阅读并操作 Artifact

卡片显示 Artifact 标题和修订号。新修订会替换文档与 iframe 浏览上下文，同时保留 Conversation Node 身份。presentation 字段决定初始行内或展开布局；本地控件可切换布局或改为显示源码。

SceneHost 还支持并排和画中画。它们是 `ViewRequest` 意图，不是任意窗口控制权限。用户可以在行内、并排、聚焦和画中画之间切换，同时保留同一 iframe、当前修订和待发送操作。overlay 祖先会被标记为可见，避免虚拟化历史隐藏场景。场景显示当前对话或父分支来源；“查看对话来源”返回 inline 并定位到原消息，不重置 Artifact。

iframe 操作先进入卡片内的有界待发送队列。点击“发送给 Agent”才会以 `wake: true` 记录第一条待发送操作。iframe 发出消息本身不会唤醒 Agent。失败会保留操作并提供重试；成功只移除已提交项。队列满时，卡片会明确提示，发送释放容量后才继续接受新操作。

### 隔离与输入限制

预览使用 `srcDoc` 和 `sandbox="allow-scripts"`，绝不授予 same-origin 访问。CSP 允许 inline 脚本、样式以及 data/Blob 图片与媒体，同时阻止网络连接、远程依赖、表单、嵌套 frame、插件、worker 和导航。父页面消息处理还要求当前 iframe 的 `contentWindow`；origin 字符串不是身份校验。

操作消息必须匹配当前 Artifact id 和正整数修订号，并符合精确五字段 schema 与 JSON payload。完整序列化消息最多 16,384 个 UTF-8 字节。payload 最多嵌套 32 层、包含 2,048 个值；卡片最多保留 32 条待发送操作。

### 比较组

带 `comparison: { group, role }` 的快照使用独立 Conversation Definition。control 和 variant 并排呈现，同时保留独立参数和修订。共享 `artifact-command` 消息同步播放、暂停、单步和重置。本地 `artifact-state` 报告提供当前参数，但不会唤醒 Agent。“比较结果”通过 control Artifact 准入一条包含两侧当前状态的 `comparison.completed` 操作。

### SceneSpec 原语

[函数绘图模板](../../../.agents/skills/artifact-design/references/function-plot.html) 展示了声明式数学 SceneSpec：两个函数、参数扫掠、视口平移/缩放、描点、导数和积分。它用本地状态支持比较，并且只在用户确认后准入 `plot.inspected`。新增原语应参考这一模板，而不是为每个学科创建独立插件。

-----

<a id="understand-the-implementation"></a>
## 实现说明

Conversation Definition 把每条 `artifact/upsert` 都视为可独立初始化的完整 checkpoint。同一 Artifact id 的后到事件通过 `update` 替换状态，Node 保留 `context.key` 和原始 anchor。keyed `conversation.chat.node` 渲染器通过 Slot injection 获得窄 Session Remote 回调；组件不会接收 Cordis context 或 transport 对象。

修订变化会重挂载卡片，清理旧监听、浏览上下文、待发送队列和瞬态视图状态。消息解析使用迭代 JSON 校验，避免递归调用栈增长。待发送状态是组件本地状态，不是 Host 已准入的持久记录。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-artifact](../../artifact/artifact/README.zh.md)——负责持久快照、操作准入和 Host Remote 方法。
- [Conversation 装配](../../../docs/subsystems/conversation.zh.md)——定义 checkpoint 回放与稳定 Node 身份。
- [Web Client Slots](../../../docs/subsystems/slots.zh.md)——定义 Session 作用域 injection 和 keyed renderer。
- [HTML 文档预览](../ui-sidebar-documentpreview/README.zh.md)——提供相邻的不透明 iframe 隔离范式。

-----

<a id="model-experience"></a>
## 模型体验

### Artifact 呈现与操作

#### 模型看到什么

模型看到 Host 拥有的 Artifact 工具，以及被确认并准入为普通用户输入的操作。这个浏览器包不会另造模型历史通道：`artifact/upsert` 只是 log-only，操作则变成有界 JSON 文本块。

#### Token 影响

渲染 Artifact 不会把源码加入模型请求。只有确认的操作会增加有界 JSON 文本；待发送、取消和拒绝的操作都不会增加。

#### KV Cache 影响

修订和视图变化不会直接改写模型前缀。只有 Host 准入的操作会按普通缓存规则新增模型可见历史。

##### 浏览器边界

```markdown
Rendering does not make Artifact source model-visible; only a Host-admitted action adds history.
```

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **远程依赖不可用**——自包含 HTML 必须使用 inline 代码和样式，只能携带允许的本地 data/Blob 资源。
- **待发送操作是瞬态**——修订变化、页面刷新或卸载会在 Host 准入前丢弃它们，Artifact 必须重新发出操作。
- **focus 只在卡片内**——展开呈现不会创建独立对话框，也不会持久化查看偏好。

<a id="dev-note"></a>
### 开发备注

jsdom 测试验证属性、解析、监听所有权和组件行为；`tests/browser-smoke.mjs` 检查 iframe 隔离和网络拒绝。keyless [Artifact 交互场景](../../../apps/web/tests/artifact-interaction.e2e.ts) 还通过实际 Web 组合验证模型驱动的创建/更新、真实浏览器计数器点击，以及仅在确认后准入操作。[教学型 Artifact 场景](../../../apps/web/tests/teaching-artifact.e2e.ts) 覆盖预测、发射、结果比较和 Agent 反馈，并使用用户声明的 `custom-provider` 模型路由（`Custom Lab Model`）。[artifact-design 技能](../../../.agents/skills/artifact-design/SKILL.md) 提供共享设计 Token、模板、动效原语和截图评审清单。
