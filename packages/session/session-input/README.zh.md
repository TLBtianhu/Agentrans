---
description: "重试已确认的 Session 输入，不替换已接受消息，也不重新排入已取消的队列项。"
kind: "package-reference"
---

# @agentrans/session-input

[English](README.md) | 中文

## 概述

响应未确认后，可以核对同一输入而不再次发送。并发相同尝试共享一次结果，内容冲突的已标识消息会被拒绝。已接受身份在本 Session 的队列编辑、取消和重放后仍保留。调用方继续负责源码校验和权限，接受输入不代表模型已执行。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 Session Projection 旁挂载此服务，再接入 Session Controller 等消费者。Web bundle 已包含它。无界面源码创建和旧 Artifact 记录不要求激活它；稳定 Artifact 提交在服务缺席时明确拒绝。

```yaml
- name: '@agentrans/session-input'
```

普通问题在异步准备 Agent 前预约 RPC 身份，在解析上下文或附件前读取接受记录。已经构造完整不可变用户消息的领域，则使用稳定消息 id。首次准入检查只在没有匹配收据时执行，因此已接受重试不依赖当前源码修订。

发送方式只在第一次生效。已接受重试不会移动队列项、复活已取消输入或再次唤醒模型。权限校验和来源归属属于调用方，此服务不授予这些能力。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

唯一私有 Projection 从本 Session 自有 inbox 插入和用户消息恢复普通 RPC 别名及首次来源/内容指纹，排除继承前缀。既有 `session/promptReceipts` 键使用状态版本 3，旧检查点从事件重建。不新增 Session 事件、来源字段或第二份收据日志。同一消息 id 后来的编辑不替换原指纹。

唯一服务拥有的执行中映射区分 RPC 和消息身份。请求在任务开始前脱离原引用，相同并发尝试合并，冲突请求明确失败。卸载拒绝新工作并等待已准入任务；消费者也保留自身资源直到调用结束。不引入 maintenance 锁或 Agent 激活。类型化的分发失败保留未知结果，只有原身份重试才能核对。

收据存储随已接受身份数增长，不静默淘汰。首次消息哈希读取完整来源与内容，保留数组顺序，把文本作为不透明值；消息索引按不透明 id 的哈希分为 256 个稀疏桶，更新时复制外层索引和受影响的桶，不复制全部消息收据。普通 RPC 别名更新保留原字典成本。服务保留哈希与身份，不保留消息正文或事件序号列表。参见[源码](src/index.ts)和[收据归并](src/receipts.ts)。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Session](../../../docs/subsystems/session.zh.md) — 持久输入与发送语义。
- [Session Projection](../session-projection/README.zh.md) — 准备、检查点恢复与私有状态。
- [Session Controller](../../api/session-controller/README.zh.md) — 普通问题、上下文与附件。
- [Artifact](../../artifact/artifact/README.zh.md) — 绑定源码的已确认用户意图。

-----

<a id="model-experience"></a>
## 模型体验

### 请求上下文与条件

#### 模型看到什么

此包不注册工具或提示词。消费者只在首次准入时追加既有普通来源或领域来源的 `UserMessage`。收据不是模型结果或执行证据。

#### Token 影响

重试不会再次追加已接受输入。身份与指纹保持私有，不进入模型请求。

#### KV Cache 影响

准入不改写旧会话。首次接受的输入沿用消费者的正常追加路径。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 普通 RPC 收据保留原有只按身份确认的语义；已完成问题的重试不会新增持久原请求指纹。
- 消息指纹不持久保存发送方式。完成后重试不能改变发送方式，也不能可靠检测只改变 mode 的差异；执行中的冲突请求仍被拒绝。
- 接受遵循 Session inbox 的持久化保证，不证明执行、队列项仍待处理或下游副作用已回滚。
- 执行中任务属于进程内状态。消费者保留冻结请求供重试，不能把丢失本地重试状态描述成取消已接受输入。

<a id="dev-note"></a>
### 开发备注

无。
