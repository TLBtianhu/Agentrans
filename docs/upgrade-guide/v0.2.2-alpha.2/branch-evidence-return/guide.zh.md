---
kind: upgrade-guide
description: "分支结论回流现在拒绝改变已确认内容，并区分准入繁忙和存储结果未知。"
---

# 使用不变内容重试分支结论回流

[English](guide.md) | 中文

## 变更

普通与带证据回流共用同一个父级提交操作。只有确认内容匹配时，同一 `(parent, branch, resultSeq)` 才复用回执。普通回流与带证据回流互换，或成功回流后更换证据，都会报告 `session/branch-result-conflict`，不再静默确认不同内容。

只有未能进入父级 maintenance 才报告 busy。后续存储或响应失败可能掩盖已接受消息，不能据此认定没有提交。Session source 字段和事件类型不变。

Web 组合挂载 `@deepseek-ai/dsh-artifact-branch` 提供证据回流。主 Artifact 服务和 headless profile 继续独立于这个桥接能力。

## 迁移

1. 结果未知时，保持结论和证据引用不变再重试。相同重试会找回已有回执，不增加输入或启动模型轮次。
2. 将 `session/branch-result-conflict` 视为当前未变请求的终态。打开父级查看已接受内容；如需不同回流，使用一条新的子分支结论。
3. 自定义 Web 组合需要证据回流时，在已有 Artifact、Session Query 和 Session Controller 服务旁添加 `@deepseek-ai/dsh-artifact-branch` 插件行。按需配置其完整消息预算 `maxActionBytes`。
4. 确认分支结论后丢弃或中断响应，再重试同一选择。核对父级只有一条消息、结论和证据文本块都在、子历史不变，且父级没有自动开始轮次。见[分支验证](../../../subsystems/branch.zh.md#verification)。
