---
kind: upgrade-guide
description: "Agentrans 关闭随附 profile 的附加上传，并将 HTTP 归属与 DeepSeek 目录兼容身份分离。"
---

# 检查数据分享默认值

[English](guide.md) | 中文

## 变更

随附基础组合包关闭 `session-log-deepseek`、`plugin-package-inventory-deepseek` 和 `session-telemetry-otel`。独立的 `sdk-minimal` 组合包也在自己的配置树中关闭前两行。Web/桌面组合包关闭 `desktop-product-telemetry`、`product-analytics` 和 `ui-settings-session-log`。反馈与会话历史仍保存在本地。正常模型请求、搜索和其它插件仍可使用网络；自定义 overlay 可以显式启用这些插件行。

提供方 HTTP 默认归属改为 Agentrans，版本取自 manifest，URL 指向本项目。DeepSeek Messages 请求不再添加 `x-deepseek-harness-user-id`、`x-deepseek-harness-session-id` 或 `x-deepseek-harness-compact`。认证与提供方协议请求头保留。DeepSeek 模型目录的 requirements 和 metadata 查找通过 `DEEPSEEK_CLIENT_COMPATIBILITY` 保留稳定的 `deepseek-harness` 兼容键，独立于产品归属。

## 迁移

1. 检查 home patch、profile patch 和命令行 overlay 是否显式启用上述六个插件行，包括独立的 `sdk-minimal` profile。移除覆盖可采用随附默认值。若确需分享，先配置目的地并阅读所属插件的约定；参见[基础组合包](../../../../packages/bundle/base/README.zh.md#included-capabilities)、[极简 SDK 组合包](../../../../packages/bundle/sdk-minimal/README.zh.md)与 [Web 组合包](../../../../packages/bundle/web-app/README.zh.md)。
2. 使用 `APP_IDENTITY.product` 解析 DeepSeek 模型目录的消费者，改用 `@agentrans/llm-deepseek` 的 `DEEPSEEK_CLIENT_COMPATIBILITY.key`，适配器兼容检查采用其 `version`。公开 HTTP 归属继续使用 `APP_IDENTITY`。
3. 检查拦截的模型请求：User-Agent 以 `agentrans/` 开头，三个跟踪头均缺席，默认 body 不含 `dsh_session_log` 或 `dsh_plugin_packages`。确认本地反馈仍写入 Session 历史，且不触发 collector 请求。无需迁移 Session 数据。
