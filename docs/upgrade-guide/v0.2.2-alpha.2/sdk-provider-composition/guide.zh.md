---
kind: upgrade-guide
description: "SDK 初始化要求外围 profile 注册模型适配器，不再隐式挂载官方 DeepSeek 适配器。"
---

# 在 profile 中注册 SDK 模型适配器

[English](guide.md) | 中文

## 变更

当 `initialize.provider` 为 `deepseek-official` 且尚无适配器负责该路由时，`@agentrans/sdk-jsonrpc-server` 不再挂载官方 DeepSeek 适配器。所有提供方都必须已由外围组合注册。缺少路由时，初始化以 `no adapter registered for provider "<id>"` 拒绝；初始化不会启用其他提供方。

随附的 `sdk` 与 `sdk-minimal` profile 已注册官方适配器。依赖隐式挂载的自定义 profile 和直接使用 `HarnessSdkJsonRpcServer` 的调用方须显式提供它。现有自定义与回放适配器保留其注册路由。

## 迁移

1. 在自定义 profile 的 `cordis.patch.yml` 中启用已有的官方适配器行；缺少时插入 `@agentrans/llm-deepseek-api-key`。使用其他提供方时，改为装配该提供方的适配器。参见 [SDK 服务器装配](../../../../packages/sdk/server/README.zh.md)。
2. 令 `initialize.provider` 和 `initialize.model` 匹配已装配的适配器。所选适配器仍在握手成功前校验模型、推理强度和输出上限。不要用握手安装提供方。
3. 确认目标 profile 能初始化并完成一次提示词。禁用其适配器后，确认初始化报告缺失路由，且未注册替代适配器。自定义与回放 profile 必须继续使用自己的适配器。无需迁移 Session 数据或协议格式。
