---
kind: upgrade-guide
description: "自定义输入框集成必须保留已采集的问题上下文，并处理发送结果未确认状态。"
---

# 处理带上下文的问题发送

[English](guide.md) | 中文

## 变更

普通输入框在异步处理前采集可选的 `{kind, value}` 问题上下文，通过 `SessionPromptRequest.contexts` 交给注册的 Host 解析器。问题与解析后的事实仍是一条普通用户消息，不新增 Session 事件或来源。已有消息和不带上下文的请求保持原有行为。

公开输入阶段联合新增 `uncertain`，默认发送可能返回 `kind: 'unknown'` 的 `DefaultSubmitOutcome`。把所有非 sending 阶段视为可编辑状态的自定义输入框，必须处理该阶段。命令的 `SubmitOutcome` 仍只有成功或失败。上下文重试在 Session binding 存活期间保留原始正文、附件、请求 id、实验条件和时区。

## 迁移

1. 自定义输入框将 `uncertain` 显示为冻结的原始发送，提供 `InputActions.retrySubmission` 与 `InputActions.dismissSubmission`。说明放弃重试不会撤回已准入的问题。离开或刷新前先重试或检查历史；binding 释放后不恢复本地重试记录。
2. 自定义普通发送适配器传递已经采集的可选上下文，不在异步处理后重新读取画面。优先使用已有 Conversation 发送路径，由它拥有请求身份、附件与迟到的接受回执。未知结果的重试成功后，释放该次本地乐观回显，由 Host inbox/历史负责展示：历史接受回执可能对应后来已被移除的队列项。释放回显不会取消 Host 输入。不带上下文的普通调用不需要新增参数。
3. 自定义 Session Controller 组合挂载 `@agentrans/session-input`，见[输入准入](../session-input-admission/guide.zh.md)。Artifact 问题上下文另外要求 `@agentrans/artifact-followup` 与 Artifact。缺失或被拒绝的上下文必须可见，不得悄悄改变问题条件。
4. 只在根 Session 问题通道提供上下文选择。子 agent 继续输入支持普通文字，不支持问题上下文；使用实际子 agent 描述判断，不能凭父 Session 身份判定，因为手动分支仍支持上下文。保留可见说明，在本地明确拒绝不支持的捕获，不静默丢弃已选事实。
5. 验证六步问题在场景继续推进、Host 随后准入时仍包含六步事实。结果未知后的重试必须使用同一请求 id；命令仍走原来的路径。
