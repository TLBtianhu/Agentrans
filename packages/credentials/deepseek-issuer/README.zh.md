---
description: "在一个地方持有 DeepSeek 平台身份：各能力类共享的凭据引用、能力类本身，以及每个能力类追加自身路径所用的端点默认值。"
kind: "package-reference"
---

# @agentrans/deepseek-issuer

[English](README.md) | 中文

## 概述

一枚 DeepSeek key 可鉴权多个能力类，而每个能力类调用的是不同端点。`@agentrans/deepseek-issuer` 持有这份共享身份：`DEEPSEEK_API_KEY_REF` 是唯一的默认凭据引用，`DEEPSEEK_CAPABILITIES` 命名该签发方服务的能力类，`DEEPSEEK_ENDPOINTS` 为每个能力类配上端点默认值及其覆盖用环境变量。各 provider 导入这些值而不是各自重述，因此模型路由、搜索 provider 及其设置卡片不会各自漂移出两个不同的默认 key。本模块不发请求、不持有 secret，也没有 Cordis 接口。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

以 DeepSeek 平台鉴权的 provider 导入凭据引用，以及它自身能力类对应的端点默认值。设置界面导入同一个引用，使它渲染的卡片与它所配置的 provider 指向同一凭据。

```ts
import { credentialRef } from '@agentrans/credentials'
import { DEEPSEEK_API_KEY_REF, DEEPSEEK_ENDPOINTS } from '@agentrans/deepseek-issuer'

const credential = credentialRef(DEEPSEEK_API_KEY_REF)
const baseURL = DEEPSEEK_ENDPOINTS.models.url
```

<a id="understand-the-implementation"></a>
## 实现说明

能力类为 `models`、`search` 与 `search-tools`。`models` 覆盖 Messages API 及其清单；`search` 覆盖提供原生网页搜索的 Anthropic 兼容端点；`search-tools` 覆盖搜索与抓取工具 API。

端点刻意保持分开：`models` 读 `DEEPSEEK_BASE_URL`，`search` 读 `DEEPSEEK_SEARCH_BASE_URL`，`search-tools` 读 `DEEPSEEK_SEARCH_TOOLS_BASE_URL`，因此把模型路由指向网关不会移动搜索，覆盖搜索也不会移动模型路由。

共享的是凭据引用，不是端点：一枚 secret、三个能力类、三个可独立配置的地址。需要另一枚 secret 的能力类在自己的配置上覆盖引用；本模块只保留一个默认值。

<a id="further-exploration"></a>
## 延伸阅读

- [凭据](../credentials/README.zh.md)——存储并解析该引用的接缝。
- [DeepSeek API-key provider](../../llm/llm-deepseek-api-key/README.zh.md)——`models` 消费方。
- [DeepSeek 搜索 provider](../../web/web-search-deepseek/README.zh.md)——`search` 消费方。

<a id="model-experience"></a>
## 模型体验

间接地，经消费适配器生效：它解析每个凭据引用，并拥有该值所授权的全部模型侧用途。

#### KV 缓存影响

无直接失效；端点与凭据默认值从不进入请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **签发方目前是常量，不是服务。** 能力发现、授权与就绪状态都不在这里建模；provider 仍然各自报告就绪。把这些收敛成一个 `IssuerBinding` 是下一步，它改变的是 provider 配置而不是这张表。
- **只描述了 DeepSeek 这一个签发方。** 其他厂商的身份在需要同样的形状之前，随其自身的 provider 一起保存。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>给维护者的工作上下文——点击展开</summary>

这里的表被三个 provider 及其设置界面读取。某个默认值要改时，只在这里改一次，让类型检查找出消费方；已经自行重述默认值的 provider 就已经违反了本包存在的理由。

环境变量名保持扁平且带厂商前缀（`DEEPSEEK_*`），因为它们同时就是部署在启动进程前编辑的启动环境覆盖项。

</details>
