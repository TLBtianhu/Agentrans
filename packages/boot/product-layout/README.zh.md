---
description: "Agentrans 单根目录安装布局、安装清单、打包、集成状态、运行时激活、范围卸载与 ReleaseManifest 签名。"
kind: "package-reference"
---

# @deepseek-ai/dsh-product-layout

[English](README.md) | 中文

## 概述

本包负责 Agentrans 分发生命周期切片：一个完整安装根目录，派生 `app`、`data`、`models`、`runtime-envs` 和 `integrations` 子目录，安装清单，四种 App/DSH 集成状态，运行时激活，文件级便携/安装打包，范围卸载执行，以及 ReleaseManifest 签名验证。它不直接修改 DSH profile 或 Windows 注册信息。

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

使用 `planInstall()` 预览安装，再用 `packPortable()` 或 `packInstalled()` 从纯净应用负载执行。负载包含 `data`、`models`、`runtime-envs`、`integrations`、`.env`、凭据或私钥时会被拒绝。升级只替换 `app`，保留已有数据和资产。安装版会单独报告 Windows 注册操作，便携版不报告注册操作。

使用 `planUninstall()` 预览卸载范围，用 `executeUninstallPlan()` 执行。默认只删除 `app` 和可重建 cache。完整删除需要确认。先通过回调移除 DSH 集成，再清理所选路径，最后通过回调处理 Windows 注册。

使用 `signReleaseManifest()` 和调用方持有的 Ed25519 私钥签名，使用 `verifyReleaseManifest()` 和受信任的公钥验签。清单记录文件名、版本、大小、SHA-256、算法、密钥指纹和签名。安装前会拒绝被修改的清单、文件、错误密钥和非法清单。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`inspectIntegrationState()` 区分 `ready`、`app-only`、`empty` 和 `integration-only`。`assertIntegrationUsable()` 拒绝最后一种状态，因为适配器不能脱离主程序工作。

`activateRuntime()` 先校验资产，再把 `pyvenv.cfg` 重写到实际运行时目录，检查 `Scripts/python.exe`，执行调用方提供的解释器自检，最后才写入 `active-runtime.json`。校验、重定位或自检失败都不会激活。资产位置相对于根目录保存，因此便携根目录可以移动。

-----

<a id="model-experience"></a>
## 模型体验

### 分发操作

#### 模型看到什么

没有模型侧内容。`ProductLayout`、`InstallManifest`、`packPortable`、`packInstalled` 和 `planUninstall` 是 Host API，不是模型工具。

#### Token 影响

不增加 prompt 或工具 schema。

#### KV Cache 影响

不创建或改变模型上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 文件级打包、卸载和 ReleaseManifest 签名已实现，但还没有原生注册后端、签名安装器或交互式卸载界面。
- 1.0 前的目录变化不做迁移，不承诺旧结构备份或兼容路径。
- 资产下载和哈希计算由调用方提供；本包负责激活顺序和状态，不提供网络客户端。
- DSH 集成启用和移除必须使用宿主的正式插件管理接口，本切片尚未挂载这些操作。

<a id="dev-note"></a>
### 开发备注

无。
