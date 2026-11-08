---
kind: upgrade-guide
description: "普通问题可将明确选择的 HTML 状态或错误捕获为未经验证的程序报告。"
---

# 将程序报告附到问题中

[English](guide.md) | 中文

## 变更

Artifact 上下文提供者在已有粒子和保存证据选择之外接受 `html-runtime`。提交时捕获所选实例最近收到的状态或当前错误。Host 准入检查目标 Session 与精确当前 HTML 源码，不查询实时运行注册表。完整原始源码与明确归属为 `program-reported` 的捕获进入一条普通用户消息。旧粒子前缀和用户消息格式不变，历史不会恢复活跃运行。参见[所有权决策](../../../../.agents/notes/implemented/architecture/2026-11-07-artifact-runtime-reports.zh.md)。

纯源码能力 `questionContext` 为 HTML 增加 `program-reported`。它只描述问题数据类型，不授予 Host 重算、可重放性、插件可用性或权限。独立的 `artifact-program-context` 文本 variation 显示中性可展开摘要，已有粒子摘要字段保持不变。

程序 JSON 使用有界、无损的纯数据子集。稀疏数组、负零（`-0`）、访问器、undefined、非有限数值及会被丢弃的对象属性，都在状态转发前拒绝。校验器不调用 getter，也不归一化数值。桥接层只有在初态通过校验后才宣布 ready；后续非法报告产生可见的程序错误。

## 迁移

1. 程序作者从状态回调同步返回纯 JSON 数据。Null、false、零和空字符串都是合法上报值。必要时在应用中明确转换，不依靠 JSON 序列化丢弃值或将数组空位改成 null。
2. 自定义输入框通过已有普通 prompt context 路径传递已捕获的 `ArtifactPromptContextSelection`。HTML 捕获包含 `capturedSessionId`、Artifact id、修订、运行 id，以及 ready/状态或 error/诊断。缺失状态不是 null，错误捕获不包含旧状态。
3. 选择绑定物理实例，在异步工作前同步捕获；未知结果重试保留同一不可变请求。换源码、重挂和断线要求重选或移除。只要源码修订仍是当前值，捕获后的问题可在 frame 关闭后准入。
4. 处理 `program-reported` 源码支持和新增可选文本 variation，不把它们当成验证。保留完整原文供复制与旧读取器使用。原粒子文本仍是 Host 重算上下文。
5. 验证在计数 1 时选择、随后变为 2，提交捕获 2，而后来变为 3 或关闭 frame 不替换数据。确认只有错误的问题也能修复同一 Artifact，源码变化会拒绝准入并保留草稿，刷新保留历史消息数据而丢弃临时选择。
