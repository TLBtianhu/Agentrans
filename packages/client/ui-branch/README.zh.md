---
description: "将普通手动分支中的 durable assistant 结论通过内联预览、确认与重试回流到直接父分支。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-branch

[English](README.md) | 中文

## 概述

`ui-branch` 为普通手动分支提供一个 assistant 详情入口。用户先展开内联预览，查看 Host 将重新读取的准确可见文本，再明确确认回流。取消不会发送请求；失败保留预览以便重试；成功后打开父 Session。

## 目录

- [使用](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用

将插件与 Chat、Session、Workspace、Slot 和 locale 服务一起挂载。它在 `conversation.chat.assistant.details` 下注册 `branch-result` 入口。durable user 和 assistant 行按真实 seq 开岔；streaming 或 synthetic 行不显示分支操作。

确认使用内联预览，不弹对话框。取消不发请求，重复点击会去重，父级忙时保留预览供重试。成功后打开父 Session，但不会启动模型轮次。

-----

<a id="model-experience"></a>
## 模型体验

### 回流分支结论

#### 模型看到什么

本包只提交父 Session id、分支 Session id 和 durable assistant 结果 seq。Host 重新读取选中的 assistant 消息，并向父 Session 追加一条普通的模型可见 user 消息，不会自动调用父模型。此 UI 不提交子对话全文、推理、兄弟结果或父级后续文本。

#### Token 影响

只有获确认的可见文本会增加模型可见内容。预览、取消和确认失败都不会增加。回流文本成为父级本地的一条 user 消息，而不是复制的子对话全文。

#### KV Cache 影响

获确认文本会按普通前缀缓存规则影响父 Session 的下一次模型请求。预览、取消和确认失败不会改变模型历史。

##### 回流边界

```markdown
Only confirmed visible text becomes parent history; preview, cancellation, and failure add nothing.
```

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 只有直接普通手动分支可使用此入口。subagent settlement、自动回流、分支图和浏览器端到端验证不属于本包当前行为与测试证据。

### 开发备注

无。
