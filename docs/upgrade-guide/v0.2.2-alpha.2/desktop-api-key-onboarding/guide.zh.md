---
kind: upgrade-guide
description: "Desktop 启动改为检查已配置的模型 API Key，不再通过原生账号登录进入。"
---

# 为 Desktop 配置模型 API Key

[English](guide.md) | 中文

## 变更

Desktop 引导此前提供官方账号登录。现在，未配置模型密钥时会直接显示单一 Agentrans API Key 表单。此前仅使用账号登录的用户升级后会看到该表单。原生账号回调与过期提示不再决定启动窗口。

现有账号授权保持存储。可选 Web 账号、内嵌 Platform 和强制更新认证能力保持不变。

## 迁移

1. 输入 DeepSeek API Key 并选择**保存并继续**，或选择**稍后配置**，再在设置中配置其他模型。任一受支持模型提供方的已配置密钥均可通过下次启动检查。
2. **前往 DeepSeek 获取 API Key**通过系统浏览器打开[官方密钥页面](https://platform.deepseek.com/api_keys)，获取后返回表单输入。保存失败会保留草稿以供重试；页面打开失败时仍可继续使用表单。
3. 重启 Desktop，确认已配置模型密钥时直接打开工作区。未配置密钥而选择跳过时，下次冷启动会再次显示表单。现有配置与 Session 日志无需迁移。
