---
description: "Agentrans 单根目录安装布局、安装清单、打包、运行时激活、范围卸载、ReleaseManifest 签名、签名压缩包安装与 Windows 注册。"
kind: "package-reference"
---

# @agentrans/product-layout

[English](README.md) | 中文

## 概述

本包负责 Agentrans 分发生命周期切片：一个完整安装根目录，派生 `app`、`data`、`models` 和 `runtime-envs` 子目录，安装清单，运行时激活，文件级便携/安装打包，范围卸载执行，ReleaseManifest 签名验证，签名压缩包安装，以及用户级 Windows 注册。它不修改 DSH profile，也不要求管理员权限。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

使用 `ProductLayout.fromRoot(root, channel)` 创建布局。根目录是唯一独立路径。Agentrans 运行数据位于 `data/dsh/home` 和 `data/dsh/agents`，它们只是内部状态路径，不是外部 DSH 集成。`ensureProductLayout()` 只创建缺失子目录，不替换已有数据。

轻量的 `./launch-context` 入口在加载应用前解析代码、资源及可写实例路径。源码开发使用 worktree 外的稳定根目录；Windows 打包后的 GUI 和 CLI 使用同一个 `root/app/resources` 锚点。只有与该负载匹配的显式隔离验收上下文可以覆盖状态根目录。开发和验收根要求精确的用途标识，并拒绝已有未标识数据或 app 负载。准备阶段在创建状态前检查物理重叠与已有路径联接，绝不创建 `app`。准备失败可能留下可供重试的自有空目录。

使用 `createInstallManifest()`、`writeInstallManifest()` 和 `readInstallManifest()` 管理持久安装状态。清单位于 `data/install/manifest.json`，包含 `layoutVersion`、产品身份、运行形态、根目录、应用版本、时间戳和资产记录。

使用 `planInstall()` 预览安装，再用 `packPortable()` 或 `packInstalled()` 从纯净应用负载执行。负载包含 `data`、`models`、`runtime-envs`、`integrations`、`.env`、凭据或私钥时会被拒绝。升级只替换 `app`，保留已有数据和资产。安装版会单独报告 Windows 注册操作，便携版不报告注册操作。

使用 `planUninstall()` 预览卸载范围，用 `executeUninstallPlan()` 执行。默认只删除 `app` 和可重建 cache，完整删除需要确认。执行时先捕获所选路径，在删除任何内容前拒绝词法越界、带链接的根或祖先及不可读取的文件系统项；每个目标临删前再次检查，内部链接只解除链接，不访问目标。`assertOwnedPaths()` 单独使用仍只做词法检查。先删除所选路径，再调用 Windows 注册清理回调；后续失败报告 `completed`、`failedOperation` 和原始原因，不回滚已完成删除。

使用 `signReleaseManifest()` 和调用方持有的 Ed25519 私钥签名，使用 `verifyReleaseManifest()` 和受信任的公钥验签。清单记录文件名、版本、大小、SHA-256、算法、密钥指纹和签名。安装前会拒绝被修改的清单、文件、错误密钥和非法清单。

使用 `planWindowsRegistration()` 预览卸载项和开始菜单注册，用 `registerWindowsRegistration()` 创建，用 `verifyWindowsRegistration()` 检查。删除已安装应用前先调用 `assertWindowsRegistrationOwnership()`，所选路径删除后再调用 `removeWindowsRegistration()`。两个注册资源都必须属于预期安装或缺失，缺失注册键不授权删除其它安装的快捷方式；执行删除的命令会在修改前再次检查两项。自定义命令 runner 提供配套的 `WindowsRegistrationReader`。后端使用 HKCU，不需要管理员权限。

使用 `installSignedRelease()` 验证签名压缩包，在根目录内解包、安装，并按需注册 Windows 状态。验签失败不会改变文件。注册失败会返回已完成的安装和注册错误，明确保留部分状态。

-----

<a id="understand-the-implementation"></a>
## 理解实现

没有外部 DSH 集成阶段。安装与范围删除只处理根目录所属的 app、data、models 和 runtimes，Windows 注册另行检查所有权。更新失败时保留原先存在的注册资源，其中可能已有部分写入；只有两项资源最初都缺失时，创建失败才尝试带归属检查的清理，并将清理失败保存在 `WindowsRegistrationError.rollbackError`。卸载保留已完成删除，不声称回滚。

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

- [Desktop 安装程序](../../../apps/desktop/README.zh.md#windows-uninstall-rules)拥有原生卸载界面与 Windows 清理诊断，本库提供范围文件操作与注册操作。
- 文件系统检查与 Node 按路径删除不能隔离其它进程并发替换目录；卸载前应停止写入进程，这些检查不是基于句柄相对操作的安全原语。 Registry 与 COM 归属检查也不隔离外部进程的并发替换。
- 自动推导用户包锚点目前只覆盖 Windows 布局；其它平台需要显式适配器。源码开发与隔离验收不依赖该布局。
- 1.0 前的目录变化不做迁移，不承诺旧结构备份或兼容路径。
- 资产下载和哈希计算由调用方提供；本包负责激活顺序和状态，不提供网络客户端。

<a id="dev-note"></a>
### 开发备注

无。
