---
kind: upgrade-guide
description: "DeepSeek web provider 不再接受配置里的字面 apiKey；密钥改由 apiKeyEnv 凭据引用提供。"
---

# 把 DeepSeek web 密钥移出配置

[English](guide.md) | 中文

## 变更

`web-search-deepseek` 与 `web-deepseek-api` 移除了 `apiKey` 配置字段。写在配置文件里的密钥会被任何能读该文件的人读到，也极容易被误提交；而这两个 provider 本来就能通过凭据服务或启动环境解析 `apiKeyEnv` 引用。

仍在配置里带 `apiKey` 的条目会导致加载失败，而不是被静默忽略。Web 设置页本来就把密钥写入凭据服务，因此在那里设置的密钥无需改动。

密钥不可用时，现在会通过 `ctx.web.searchCapabilityState()` 与 `fetchCapabilityState()` 报告 `missing`、`invalid`、`unentitled` 或 `unreachable` 之一；`searchReady()` 与 `fetchReady()` 仍是工具读取的布尔投影。

## 迁移

1. 从 `cordis.yml` 中 `web-search-deepseek` 或 `web-deepseek-api` 的条目里删除 `apiKey`。
2. 通过 Web 设置页、`dsh` 凭据存储写入密钥，或在启动环境中导出 `DEEPSEEK_API_KEY`。要换引用名就改 `apiKeyEnv`。
3. 如果某个部署依赖字面密钥覆盖过期的已存密钥，请轮换已存值，而不是保留第二个来源：provider 现在每次请求只读一把密钥。
