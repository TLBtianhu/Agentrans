# 分发与产品身份

## 三种环境

### 编译产物

编译产物只用于产生分发物，属于开发环境。输出目录必须保持纯净，不写设置、缓存、索引、会话或用户数据。它不是一种分发形态，不直接交给用户使用。

开发运行若需保存状态，使用独立开发数据根。编译输出、开发状态、便携状态、安装状态不得混用。

### 便携版

便携版由打包步骤生成，拷到任意位置都能自包含运行。数据保存在程序旁的专用数据目录，不写注册表，不读写正式安装版或上游产品的状态。

### 安装版

安装版进入一个用户选择的安装根目录，拥有本项目自己的注册表、文件关联和卸载能力。根目录内部固定为 `app/`、`data/`、`models/` 和 `runtime-envs/`；数据保存在 `<root>/data`，卸载默认保留用户数据。解耦通过子目录的更新策略完成，不通过物理分散完成。

安装、升级、卸载不得操作上游 DSH 或其他项目的目录、注册表、文件关联、凭证、插件、账号和更新记录。

## 同机并存

编译产物、便携版、安装版和上游 DSH 的程序路径与数据路径互不相同，可以同机并存。开发时使用编译产物，日常使用时用安装版；程序员和用户两种角色不得共享测试状态。

## 单根目录实现

[product-layout](packages/boot/product-layout/README.md) 提供 `ProductLayout.fromRoot()`、安装清单、运行时激活、文件级便携/安装打包、范围卸载和用户级 Windows 注册。所有应用、数据、模型和运行时路径都从同一个根目录派生；DSH_HOME 与 DSH_AGENTS_HOME 位于 `data/dsh/` 下，它们只是 Agentrans 内部运行数据路径，不是外部 DSH 集成。打包只替换 `app`，默认保留 `data`、`models` 和 `runtime-envs`；卸载默认只删除 `app` 和可重建 cache，完整删除需要确认，Windows 注册最后处理。1.0 前不做旧结构迁移，也不跨实例共享资产。

Windows 注册后端使用 HKCU 写入卸载项和开始菜单快捷方式，支持注册、验证和删除，不需要管理员权限；真实临时注册项 smoke 已通过。

更新签名公钥位于 [distribution/keys](distribution/keys/README.md)，算法为 Ed25519。私钥只保存在仓库之外的当前用户受限目录，绝不进入源码、构建产物、fixture 或日志。`signReleaseManifest()` 用本机私钥签署规范化清单，`verifyReleaseManifest()` 在安装前检查 keyId、签名和实际文件字节，任何篡改都拒绝安装。该密钥用于更新清单和发布物验签，不替代 Windows Authenticode/EV 证书。

`installSignedRelease()` 先验签，再在根目录内解包并安装，安装版随后执行 Windows 注册。验签失败不复制文件，注册失败保留已安装结果和注册错误；真实签名压缩包与真实 Windows 注册 smoke 已通过。

[agentrans-installer.mjs](apps/desktop/installer/agentrans-installer.mjs) 是生产安装/卸载入口：安装使用验签后的签名安装，卸载复用同一个 `UninstallScope`，支持静默 app-only 和全量清理。原生卸载选项窗体位于 [uninstall-dialog.ps1](apps/desktop/installer/uninstall-dialog.ps1)，默认只删 app，支持全选、二次确认和取消；静默模式不会打开窗体。NSIS 保持默认 app-only，生产 CLI 的对话框负责可选范围。

卸载范围已在真实 CLI 上验证：静默 app-only 保留 `data/dsh` 下的会话、profiles、凭据、storages 和 agents；`--all` 删除这些路径；`--scope sessions` 只删会话目录；交互窗体已走通 app-only 和取消两条路径，全量交互确认（Select all + Yes/No）仍需要手动过一遍。

[package-agentrans-installer.mjs](apps/desktop/scripts/package-agentrans-installer.mjs) 构建真实 Agentrans Windows 安装器，输出 `artifacts/agentrans-installer/agentrans-<version>-win-x64.exe`。安装后的 Electron 数据和 DSH 数据都位于安装根目录内；升级 staging 只替换 `app`，不移动或删除 data。真实安装、应用启动、同版本升级、静默卸载和 junction 目标保护已通过本地未签名验证，不代表 Authenticode 发布授权。

模型通过设置里的提供商配置注入，用户填写提供商、协议、模型名和 API 密钥后可直接使用，不需要 DeepSeek 账号登录或服务器绑定通道。密钥只写入安装根的 `data/dsh/home/.credentials.yaml`，不进入仓库、构建产物或日志。

## 身份审计

不能只改产品标题和图标。每项外部身份都必须进入替换表并有行为验证：

- 产品名、可执行文件名、包名、安装目录、用户数据、缓存、日志和临时目录；
- 注册表、卸载项、文件关联、ProgID、URL 和内部页面 scheme；
- 更新源、下载地址、对象前缀、频道、签名和验签信任根；
- 浏览器 profile、服务、计划任务、互斥体、命名管道和默认端口；
- CLI 命令与 PATH 注册；
- 崩溃报告、遥测、账号、更新政策和第三方品牌入口；
- 安装器 AppId、版本资源、图标和产物名称。

不得复制上游私钥，不得让上游公钥成为本项目更新信任根。上游地址仅用于源码同步和明确标注的参考，不进入本项目的更新或下载链路。

内部包名可以为了跟随上游暂时保留，但不能因此对外冒充 DeepSeek 官方产品。保留 MIT 许可证、第三方声明和上游来源记录。

## 验证要求

- 构建后运行编译产物，输出目录不产生运行状态；
- 便携目录移动后继续运行，不碰注册表和正式用户目录；
- 安装、覆盖升级、卸载后用户数据保持；
- 与上游 DSH 同机运行，互不认领设置、会话、凭证、插件、协议和更新；
- 更新包由本项目身份验签，篡改必须拒绝；
- 每项检查都有负例，不能只靠搜索字符串或人工审阅宣布通过。

打包、安装、签名和发布是不同授权动作。源码构建不授权安装，安装测试不授权发布。
