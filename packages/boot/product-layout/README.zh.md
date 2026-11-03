---
description: "Agentrans 单根目录安装布局、安装清单、集成状态与运行时激活。"
kind: "package-library"
---

# @deepseek-ai/dsh-product-layout

[English](README.md) | 中文

## 概述

本包负责 Agentrans 分发生命周期的第一个切片：一个完整安装根目录，派生 `app`、`data`、`models`、`runtime-envs` 和 `integrations` 子目录，安装清单，四种 App/DSH 集成状态，以及运行时激活门槛。它不修改 DSH profile，也不负责安装应用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

使用 `ProductLayout.fromRoot(root, channel)` 创建布局。根目录是唯一独立路径。DSH 数据位于 `data/dsh/home` 和 `data/dsh/agents`，集成包位于 `integrations/dsh-agentrans`。`ensureProductLayout()` 只创建缺失子目录，不替换已有数据。

使用 `createInstallManifest()`、`writeInstallManifest()` 和 `readInstallManifest()` 管理持久安装状态。清单位于 `data/install/manifest.json`，包含 `layoutVersion`、产品身份、运行形态、根目录、应用版本、时间戳和资产记录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`inspectIntegrationState()` 区分 `ready`、`app-only`、`empty` 和 `integration-only`。`assertIntegrationUsable()` 拒绝最后一种状态，因为适配器不能脱离主程序工作。

`activateRuntime()` 先校验资产，再把 `pyvenv.cfg` 重写到实际运行时目录，检查 `Scripts/python.exe`，执行调用方提供的解释器自检，最后才写入 `active-runtime.json`。校验、重定位或自检失败都不会激活。资产位置相对于根目录保存，因此便携根目录可以移动。

-----

<a id="model-experience"></a>
## 模型体验

这是 Host 库，不是模型侧工具。它不提供 prompt section 或工具 schema，不增加 token 成本，也不进入 KV cache。安装和集成状态属于本地应用状态，不是模型输入。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 尚未实现完整安装器、便携打包、签名更新器或交互式卸载器。
- 1.0 前的目录变化不做迁移，不承诺旧结构备份或兼容路径。
- 资产下载和哈希计算由调用方提供；本包负责激活顺序和状态，不提供网络客户端。
- DSH 集成启用和移除必须使用宿主的正式插件管理接口，本切片尚未挂载这些操作。

<a id="dev-note"></a>
### 开发备注

无。
