---
description: "Desktop 在原生应用中运行 Harness 工作区。本参考文档说明应用行为、开发与集成；打包、Windows 签名和发布指南分别维护构建与发布操作。"
---

# DeepSeek Harness 桌面端

[English](README.md) | 中文

## 概述

Desktop 在原生应用中运行 Harness 工作区。本参考文档说明应用行为、开发与集成；打包、Windows 签名和发布指南分别维护构建与发布操作。

## 目录

- [应用概览](#application-overview)
- [终端命令](#terminal-command)
- [关闭窗口与退出](#closing-the-window-and-quitting)
- [关键技术决策](#key-technical-decisions)
- [内置命令运行时](#bundled-command-runtime)
- [安装归属](#installation-ownership)
- [故障恢复与诊断](docs/diagnostics/README.zh.md)
- [开发](#develop)
- [打包](#package)
- [Windows 安装界面](#windows-installer-interface)
- [更新](#updates)
- [底层开发覆盖项](#low-level-development-overrides)
- [已知限制](#known-limitations)
- [开发备注](#dev-note)

<a id="application-overview"></a>

## 应用概览

Electron 在 `userData/desktop/locale-cache` 缓存最近确认的界面语言，使启动恢复弹窗在 Host 设置尚不可用时也能使用该语言。缓存缺失、无效或不可读时回退到系统语言；缓存写入失败不阻断启动。Host 成功启动或界面语言变更时会刷新缓存；在此之前，变更后的系统语言可能与缓存语言不同。

桌面埋点遵循[产品采集策略](../../packages/client/product-analytics/README.zh.md)及其动态应用配置，不包含 Web 使用情况。安装更新会等待该操作的本地埋点接收请求结束，再锁定 API 准入并停止 Host。接收请求的时限为一秒，失败不会阻止安装，也不等待收集端完成发送。

桌面应用是完整 dsh Web 应用外的一层 Electron 壳。Electron RunAsNode 子进程启动共享 profile runner，Electron 立即从 `dsh-app://app/` 加载打包内的 Web 入口。共享加载页等待 Host 启动注入，然后在同一文档中启动客户端。Electron 将应用 HTTP 请求转发给已认证的 Web Host，转发时丢弃描述 Node fetch 连接而非资源本身的响应头（`transfer-encoding`、`connection`、`keep-alive`），并把插件 bundle 响应标记为 `no-store`，因为其每次启动都变化的 revision 只会在 Chromium 磁盘缓存中累积；WebSocket 流连接到该 Host，仅为归属的应用窗口附加凭据。Node IPC 承载启动注入、就绪与关闭。Desktop 默认监听系统分配的端口，因此不会与 Web 的 `3080` 或系统保留端口冲突；可通过 `webserver.config.port` patch 覆盖。

Desktop 绑定 `127.0.0.1`，即 Electron 为就绪 URL 与 WebSocket 凭据过滤器拨号的地址。WebSocket 流按 Host 监听器使用 `ws:` 或 `wss:`；附加凭据要求 authority 与 scheme 均匹配。

应用菜单第一项“**关于 Agentrans**”打开 Electron 原生关于面板，展示应用图标、产品名称和当前安装的发布版本。菜单文案跟随桌面壳的语言。macOS 的隐藏、隐藏其他、显示全部和退出条目使用本地化文案，隐藏和退出条目包含 Agentrans 产品名称。这些条目保留原生动作和快捷键。macOS 从应用包读取图标，因此未打包的开发启动会显示 Electron 图标；Windows 使用随包分发的 PNG。

Desktop 的本地原生目录流程打开绑定应用窗口的 Electron 文件夹对话框，并先恢复、显示和聚焦该窗口。并发请求共用一个对话框；取消不返回路径，失败后可以重试。普通 Web 使用 Host 选择器。浏览模式列出 Host 目录。Linux 缺少 zenity 或 kdialog 时，自动选择使用浏览模式，不使用 Electron 对话框。

Desktop 在 `resources/runtime/primary-runtime/dependencies/pnpm` 中携带一份 pnpm 分发包，不含其他目标平台的原生包。构建时的生产依赖安装、安装版 `dsh` CLI、Creator 和 Web 插件管理器通过 Electron Node 模式执行其中的 `bin/pnpm.mjs`；包操作不要求 PATH 上存在 pnpm。私有 Node 启动器环境仅用于包操作。agent（智能体）的工作区依赖将同一份完整 primary-runtime 复制到 Harness 主目录，并使用其中的独立 Node 执行 pnpm。

Platform 内嵌文档使用持久化 WebContentsView 分区，分区名由 Platform 来源和稳定账号 ID 的哈希决定。localStorage 中的页面偏好（包括已关闭的通知）在关闭视图和重启应用后保留；不同账号和来源使用独立存储。账号 ID 来自 Host 最近一次成功的资料读取；尚无该 ID 时，文档在一次性分区中打开，该分区不跨次保留偏好。打开持久分区会先清理 Cookie、文件系统、IndexedDB、Cache Storage、HTTP 与着色器缓存、Service Worker 及 HTTP 认证状态；一次性分区则清理其全部存储。关闭视图会销毁文档、移除请求拦截器并安排相同的清理，因此异常退出遗留的认证会在下一个文档加载前被清除。下次打开和应用退出都会等待该清理完成，更新安装也会在安装器接管退出前等待。清理失败会使该次打开失败，并在后续清理成功前阻止同一账号打开；其他账号不受影响。退出登录会销毁文档，但保留账号偏好供下次登录使用。同一凭证下账号 ID 迟到时，已以一次性分区打开的文档保持挂载；下次打开使用账号分区。[存储决策](../../.agents/notes/implemented/architecture/2026-09-22-platform-browser-storage.zh.md)说明保留策略。Host 通过私有 Node IPC 发送账号凭证；账号 RPC 和 Harness 渲染进程不接收 token。Platform preload 在页面脚本执行前通过一次同步 IPC 读取主进程中已准备的凭证。它暴露 displayMode、同步的 getAuthToken() 和 getLocale() getter，以及返回取消订阅函数的 onLocaleChange(listener)。两个 getter 都只读取 preload 内存，不再调用 IPC。bootstrap 包含 Desktop 已解析的语言（`zh_CN` 或 `en_US`）；Settings 语言变更会更新 preload 缓存并通知已打开的 Platform 文档，无需重载。Platform 在首屏渲染前应用该语言，且不将其持久化为浏览器偏好。主进程处理器仅校验调用来源并读取内存，不等待 Host、磁盘或网络。可信页面初始化失败时保留内嵌模式，由 getter 抛错，避免回退到浏览器凭证。只有受控 Platform 页面中、位于所配置签发来源的主 frame 能完成初始化。退登、凭证替换、Host 关闭及视图关闭都会销毁文档。跨来源文档导航被阻止。请求新窗口的 HTTPS 链接在系统浏览器中打开，不携带内嵌会话或 token；其他协议及带 URL 凭证的链接被拒绝。原生视图占据 Account 功能返回栏下方的视口。

Desktop Host 的 Platform API 请求与更新策略请求用相同的 Platform 客户端请求头标识已安装客户端：平台、客户端版本、语言、以秒为单位的时区偏移，以及有意保持为空的 bundle id。账号操作按调用逐次传入调用界面的身份。更新策略额外上报架构、更新通道和内置运行时版本。 原生账号状态解析器接受 `no-response` 登录失败，并在供 UI 使用的安全投影中保留该错误码。

原生引导通过模型 API Key 配置独立判断入口，不依赖账号状态，详见[启动引导](#startup-onboarding)。现有账号授权保持存储。可选 Web 账号、内嵌 Platform 和强制更新认证继续由各自的归属方负责。

桌面麦克风访问仅允许主 `dsh-app://app` 页面发起的音频请求。macOS 使用系统麦克风授权、随包用途说明，以及主应用与 Helper 签名中的 `com.apple.security.device.audio-input` 权限。

按 F12（多媒体功能键键盘上为 Fn+F12）、macOS 的 Command+Option+I 或 Windows 的 Ctrl+Shift+I，可切换当前获得焦点的应用页面的 DevTools，打包版本同样支持。应用菜单在隐藏和退出命令之前的独立分组中显示本地化的“开发者工具”命令。Windows 在标题栏的应用弹出菜单中显示开关，通过隐藏的原生应用菜单注册快捷键；macOS 和 Linux 的应用菜单保留隐藏的 F12 快捷键别名。更新遮罩和打包版本的内嵌浏览器禁用 DevTools。

<a id="terminal-command"></a>

## 终端命令

应用菜单中的**管理 dsh 命令…**位于**检查更新…**下方，显示当前命令，并提供安装、修复和移除操作。命令复用 Desktop 已安装的运行时和普通 [dsh CLI](../cli/README.zh.md)，Desktop 应用关闭后也可以使用。安装后打开新终端，运行 `dsh --version`。

macOS 安装会创建 `/usr/local/bin/dsh`；目录权限需要时，系统会请求管理员认证，不会修改 shell 启动文件。Windows 管理对话框将命令注册到当前用户的 PATH。切换已有命令前会要求确认；修复当前已选中的 Desktop 命令不会重复要求切换确认。macOS 链接会保留并恢复被替换的启动器；Windows 会保留其他 PATH 条目，包括注册前就已存在的条目。若其他命令的 PATH 优先级更高，对话框会显示其位置。移动应用后，macOS 使用“修复”，Windows 从新位置使用“安装”。“移除”不会改动无关安装。

命令注册是安装 Desktop 后的可选操作。卸载 Desktop 前，请通过**管理 dsh 命令… → 移除**删除其 CLI 注册；应用卸载程序不会移除该注册。更新或卸载 Desktop 前请结束 CLI 命令。CLI 运行时版本随已安装的 Desktop 版本变化。Desktop 插件命令与运行时限制见[内置命令运行时](#bundled-command-runtime)。

<a id="closing-the-window-and-quitting"></a>

## 关闭窗口与退出

关闭主窗口（macOS 的关闭按钮和 ⌘W；Windows 的 ×、Alt+F4 和任务栏"关闭窗口"）会隐藏窗口；Windows 首次隐藏前需要确认。页面和 Host 继续运行，任务不受影响，下次显示时仍是原来的文档，会话、草稿和滚动位置都保留；macOS 全屏窗口先退出全屏再隐藏。macOS 通过 Dock 图标、再次启动或 `dsh://open` 找回窗口，Windows 通过托盘找回。最小化行为不变。进入工作区前关闭欢迎窗口，Windows 上走退出流程，macOS 上应用留在 Dock 中且没有窗口。

Windows 在整个运行期间常驻托盘图标。悬停提示为产品名，单击显示并聚焦窗口，右键菜单提供壳语言下的"打开 Agentrans"和"退出 Agentrans"。首次隐藏前复用更新弹窗，显示“正在运行的任务不会中断，可在系统托盘中重新打开窗口”和“确认”按钮。确认后隐藏窗口，并在 Electron userData 下写入 `background-close-confirmed`；Esc、关闭弹窗或加载失败均保持主窗口可见，不记录确认。重复关闭请求会聚焦已有壳弹窗。覆盖更新保留标记，卸载删除标记。旧的 `background-notice-shown` 标记不会跳过此确认。关闭窗口不发送系统通知。托盘位图是 `resources/tray-windows.ico`，由 `pnpm run render:tray-icon` 从 `resources/icon.svg` 按 16、20、24、32、40、48、64 像素分别渲染，打包为 `resources/tray.ico`。macOS 不提供菜单栏图标。

所有普通退出入口——⌘Q、应用菜单、Dock 菜单、Windows 托盘和标题栏"应用程序"菜单，以及关闭欢迎窗口引起的退出——都先向 Host 查询退出会中断什么。Host 通过私有 IPC 通道回答两项事实：与更新重启检查同一口径的运行中任务（运行中的 agent，包括子代理和等待审批的回合、排队消息、运行中或停止中的后台任务），以及本次运行中已加载会话里由 `workspace/session-activity` 的 `schedule` family 报告的已挂定时器的提醒。两项都没有时直接退出，不弹框。否则弹出一个没有父窗口的原生消息框——隐藏的窗口保持隐藏——标题为**退出 Agentrans？**，正文为三种本地化说明之一：正在运行的任务将会中断、应用关闭期间定时任务不会运行，或两者兼有。"退出"是默认按钮，Esc 等同"取消"；macOS 上"取消"在"退出"左侧，Windows 上"退出"在"取消"左侧，Windows 任务对话框显示应用图标且不跟随应用主题、始终为浅色。Host 尚未就绪或已失败时不可能有任务在跑，直接退出。查询失败或 Host 超过两秒截止时间未答复，按运行中任务处理。弹框打开期间，再次请求退出只会并入同一弹框而不叠加新弹框（macOS 上还会把它提到前面；Electron 不暴露 Windows 任务对话框的句柄）；任务开始或结束不会改变文案；点"退出"不再重新查询即停止应用；点"取消"不发生任何变化。取消由关闭欢迎窗口引起的退出时，欢迎窗口会重新显示。

安装确认在 Windows 上额外显示等待提示，macOS 只显示简短的重启说明。

以下情况跳过确认：安装更新的重启已确认过任务中断、致命错误恢复对话框中的退出或重启、开发版"重启应用与 Host"命令，以及操作系统关机、重启或注销：Windows 在确定性的会话结束消息上设置该状态；macOS 在关机通知上设置，而其他应用仍可能取消这次关机，因此主窗口下一次获得焦点或显示时会清除它。安装器接管退出时会取消尚未结束的普通退出决策；晚到的查询结果和弹框答复不会再次打开确认框或重复清理。窗口隐藏期间完成的用户主动发起的更新下载，把"安装并重启"确认推迟到窗口再次显示时；强制更新流程沿用其任务栏和 Dock 提醒。Windows 安装程序和卸载程序在应用仍在运行时提示用户先在系统托盘中退出。Desktop 默认未开启定时任务，定时任务的说明只在该功能开启后出现；提醒只在已加载的会话中触发，未加载的会话既不计入，也要等到打开后才会继续。

托盘渲染器以底板中心为基准将鲸鱼放大 20%，保留背景和宽高比；应用和安装器图标保持原有比例。

<a id="key-technical-decisions"></a>

## 关键技术决策

`resources/icon.svg` 是该标记的唯一来源：`tile-background` 矩形铺满 1024×1024 画布，`tile-artwork` 组包含启动器遮罩可能裁掉的全部内容，安装图标与托盘位图都要求这两个角色存在。已提交的 `icon.png`、`icon-windows.png`、`icon-macos.png` 和 `icon-dark.png` 都是该图标的导出位图，目前内容相同。替换时导出透明的 1024×1024 PNG。electron-builder 为 Windows 应用、安装程序和卸载程序生成多尺寸 ICO（[Windows 图标要求](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction)）。安装页面在两种主题下使用匹配的图案；卸载程序的欢迎和完成页共用 `installer/assets/uninstaller-sidebar.png`，准备阶段将其转换为 164×314 BMP。

快捷键覆盖保存在 `app.getPath('userData')/keybindings.json`，位于所选产品实例的 `data/settings/electron` 目录下。主进程校验并串行保存修改后才发布已接受键位。读取失败保留上次接受的键位并阻止编辑，包括全部恢复；不可读和未来版本的文件保持不变。开发模式通过 `AGENTRANS_DEV_ROOT` 选择整个实例；启动器会输出解析后的浏览器数据路径。格式和冲突语义见[快捷键服务](../../packages/client/shortcuts/README.zh.md)。

macOS“文件”菜单显示已接受的单键绑定（包括方向键），并通过 Client 页面 owner 路由“关闭页面或窗口”。Windows 和 macOS 在主文档、内嵌 frame 和浏览器 guest 输入之前拦截所有已接受的完整绑定，包括编辑和终端输入。录制和输入法组合状态仍受保护。更新蒙层从创建到最后一个蒙层关闭期间阻挡父窗口及其浏览器 guest 的产品快捷键和编辑按键递送。每次打开或关闭蒙层都会作废待完成的组合键状态。主进程通过显式的创建能力和输入状态读取能力，让更新对话框与快捷键输入共享同一个蒙层管理实例。双键组合会将首键的初次按下事件交给页面，且不拦截其松开事件；完整组合及其重复事件会被消费。渲染进程将可配置绑定的分发交给原生适配器。双键组合不注册原生菜单快捷键。已接受的命令通过可信 preload 转发一次。Linux 通过 DOM 分发主文档快捷键，并将已接受的内嵌 frame 绑定转发给 Client 解析器。关闭最后一个窗口后 macOS 保留应用生命周期；Windows 退出桌面实例并停止其任务。[关窗决策](../../.agents/notes/implemented/architecture/2026-09-21-desktop-page-close-shortcuts.zh.md)记录了这一生命周期选择。

macOS PNG 使用带留白的圆角底板，供传统 ICNS 打包使用，包含最高 1024 像素的表示。它是扁平图标，并非 Icon Composer 文档。Apple 的[应用图标指南](https://developer.apple.com/design/human-interface-guidelines/app-icons)要求向 Icon Composer 提供未遮罩的图层；这些输入需要在 macOS 上单独导出，不能复用已做圆角的 ICNS 图案。发布前须在支持的 macOS 版本中验收 Finder 和 Dock 的显示效果。

<a id="bundled-workspace-dependencies"></a>

### 内置工作区依赖

electron-builder 只把清单中的 `dependencies` 复制进 `app.asar/node_modules`，因此 Electron 主进程 bundle `lib/main.js` 内联其工作区 devDependencies，裸导入只剩 `electron`、Node 内置模块与这些 `dependencies`；沙箱 preload 只能留下 `electron`、`events`、`timers` 与 `url`，即其 `require` polyfill 能解析的模块。主进程 bundle 从被内联包的 `lib/` 产物解析它们，所以根 `build:lib:host` 在并发的工作区 tsdown 阶段之后才为 `apps/desktop` 打 bundle，并由 [`desktop-bundle-imports`](scripts/desktop-bundle-imports.mjs) 让任何静态、动态或 `require()` 导入无法在打包应用内解析的 Desktop bundle 直接失败。没有这项检查时，rolldown 无法解析的导入会作为外部说明符进入产物，并在启动时以 `ERR_MODULE_NOT_FOUND` 失败。[已归档的bundle 顺序决策](../../.agents/notes/archived/process/2026-09-22-desktop-main-bundle-after-workspace-tsdown.md)记录了备选方案。

Windows 签名打包按 PE 文件内容扫描第一方运行时和应用生产依赖，包括没有常规扩展名的文件。最终扫描覆盖整个解包应用。目录链接、格式错误的 `MZ` 文件以及非 PE 的 `.exe`、`.dll` 或 `.pyd` 文件会使打包停止；以 `MZ` 开头的数据文件也会被拒绝，除非包含有效 PE 头。它保留有效的上游签名，并在记录运行时哈希或执行冒烟检查前为未签名代码补签。公钥验签每个进程处理最多 32 个文件，同时最多运行四个进程；硬件令牌签名仍串行执行，每个新签名必须匹配配置的证书且带时间戳。硬件签名或验签失败会停止本轮执行；独立的时间戳请求遵循[有界重试规则](windows-signing/README.zh.md#windows-ev-signing)。electron-builder 只有在验签和逐字节比对通过后，才保留复制后运行时可执行文件的签名。写入发布完成记录前，必须通过最终 PE 签名检查，以及使用全新缓存的 ASAR 载荷和 Host 冒烟检查。开发、仅准备和未签名构建不使用硬件令牌，可能被 Windows 代码完整性策略阻止；任何构建模式都不会关闭该策略。冒烟检查通过不代表兼容所有企业策略。

Desktop 携带独立的 Python、Node.js 和 pnpm 分发包。Python 包含 numpy、pandas、python-docx、python-pptx、openpyxl、Pillow、lxml、XlsxWriter 及其完整依赖。`load_workspace_dependencies` 工具首次使用时，将该产物离线安装到 所选产品实例内的 `$DSH_HOME/dsh-runtimes/dsh-primary-runtime`，并返回解释器、pnpm 脚本和库目录的绝对路径，以及记录内置分发包名称与版本的 `pythonDistributions`。版本报告不包含用户自行安装的包。Office 任务默认使用这些库，用户或工作区指令指定其他环境时遵循其要求。pnpm 脚本通过返回的 Node 可执行文件运行。返回的 Node 库目录为随包交付的库预留，不是 pnpm 的全局安装目录。

Desktop 展示精简的 `office` 路由及可具名调用的创作／操作子技能。创作使用内置 Python 库；操作技能调用配置的 Node 和 CLI 路径。技能位于 ASAR 外的 `runtime/office-skills`。渐进加载与限制见 [Office 技能包](../../packages/skill/skill-office/README.zh.md)。

该产物随 Desktop 版本发布。`runtime.json` 记录 Desktop 版本、目标平台、顶层解释器和包管理器版本及 Python 分发包版本表，以及所选目标的锁定产物输入与组装格式的摘要。分发包名称按 PEP 503 归一化；名称归一化后重复时，清单会被拒绝。旧 `components` 清单通过归一化继续可读，并保留其原有库版本一致性校验。匹配的安装会被复用；依赖或压缩包变化后，即使 Desktop 版本不变，也会在完整暂存副本完成后替换目录。不含摘要的旧清单会在下次安装时被替换。用户自行添加的 Python 包仅在产物身份一致时保留。目录替换失败时保留之前的安装；解释器仍在运行时，Windows 可能拒绝替换。

Desktop 私有的 `runtime/bin` 目录仅添加到包安装进程，不进入 PTC 和 agent shell 从 Host 继承的 PATH。该工具不修改 PATH、环境变量或用户包管理器配置。pnpm 的全局包、命令入口和 store 保留自身默认值及用户设置，包括环境不支持全局安装时的原生错误。不提供独立依赖更新器。[第一方 Runtime 决策](../../.agents/notes/implemented/feature/2026-09-14-desktop-primary-runtime.zh.md)记录这些选择。

Node 准备内置解释器和 Python 库，无需系统 Python 或 pip。[下载锁](../../scripts/primary-runtime/lock.json)固定解释器压缩包、Python 分发包版本及目标平台 wheel 的 URL 和哈希；共享构建器从根开发依赖中解析 pnpm 固定版本。测试检查根 package-manager 版本和 Desktop 固定版本保持一致。每个目标的 wheel 文件名必须与分发包版本一致。所选目标、wheel 记录及分发包映射内部的键顺序，以及 wheel 条目顺序都会影响产物身份，编辑时须保留；锁文件顶层键的顺序不影响该身份。库 wheel 解压到 site-packages，各 wheel 的 `.data/scripts` 目录保留辅助文件，不生成命令行包装器。其他安装方案会被拒绝。macOS 只对版本化 Python 可执行文件签名一次，在外部资源及安装副本中保留[两个解释器别名](../../packages/skill/tool-workspace-dependencies/README.zh.md)。POSIX 本机目标检查要求解释器别名为相对链接。所有本机目标检查验证命令名、子进程执行及包含 pip 的 venv，并在清理暂存目录后以及 macOS 签名后验证锁定 wheel 的集合与版本，允许解释器自带的 pip，并检查 Python 版本、Office 文档读写和依赖完整性，不写入字节码。独立 Node 可执行文件获得 V8 所需的 JIT 权限；x64 目标还获得 `com.apple.security.cs.allow-unsigned-executable-memory`，允许可执行代码页，包括在 Rosetta 下运行时。ARM64 Node 和 Office 辅助程序保留仅 JIT 权限。跨目标执行和签名安装需要对应的发布主机。`dev:desktop` 和 `start:desktop` 都会在启动 Electron 前准备 `.desktop-build/targets/<target>/runtime/primary-runtime`；首次准备可能需要下载锁定的依赖。准备未完成时，启动命令不能报告成功退出。

Desktop/SDK 共享运行时构建器在复制或签名产物前，裁剪 NumPy 和 pandas 下名为 `tests` 的目录，并移除各分发包 `RECORD` 中对应的记录。它保留 `numpy.testing`、`pandas.testing`、`pandas._testing`、原生扩展和许可证。完整上游测试套件不可用；本机检查验证保留的 testing API、测试目录已移除，以及清单所列文件存在。

| 决策 | 原因 | 直接结果 |
|---|---|---|
| 发布身份 | 桌面壳 API、Web 客户端、后端与插件依赖图作为一个组合完成验证；独立版本会产生未经验证的组合，并让更新可用性含糊不清。 | Electron 与 `@agentrans/dsh` 始终使用同一精确版本。即使桌面壳代码不变，升级 dsh 也必须发布新 Desktop 版本。 |
| 运行时 | 应用必须能够在没有系统 Node.js 或 pnpm 的机器上运行。 | dsh 通过设置 `ELECTRON_RUN_AS_NODE=1` 和 `--expose-internals` 的 Electron 运行，所有包操作都使用内置 pnpm。包管理器配置和 Host 环境遵循用户设置。包脚本通过 `node` shell 启动器转发给 Electron。 |
| 包来源 | 即使离线，启动时安装核心依赖也会增加开销。 | `app.asar/dsh` 携带完整生产依赖树；profile 只安装外部插件。 |
| 状态归属 | 共享可执行依赖图会让 CLI（命令行界面）与 Desktop 相互改变 dsh、Cordis、插件或原生模块版本，而两个桌面进程还可能争用同一个 profile。 | Electron 在访问任何 profile 前获取进程生命周期单实例锁，并独占 `$DSH_HOME/profiles/desktop` 及其包管理器状态。Desktop 及其内置 CLI 使用同一个显式产品实例，与 npm dsh 以及其他开发、验证或用户实例隔离。 |
| 传输 | Web 服务与认证共享一套实现。 | Electron 加载打包的 Web 资源；Host 提供启动注入和经过认证的 API。 |
| 插件变更 | Desktop 与 Web 需要一致的安装和激活行为。 | 主应用使用共享 Web 插件管理器和内置 pnpm。 |
| 更新 | 桌面壳与 dsh 独立更新会重新产生版本分裂，而桌面壳未变化的数据块不应强制完整传输。 | Electron 壳、匹配的 dsh 运行时与 pnpm 组成一个已签名更新单元。平台更新产物可以复用未变化的数据块，但运行时版本选择绝不脱离 Desktop 发布。 |

[薄壳决策](../../.agents/notes/implemented/architecture/2026-09-10-desktop-web-wrapper.zh.md)负责共享 Web 行为与 Desktop 适配。[Electron 打包与更新决策](../../.agents/notes/implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md)负责发布身份、签名及更新验收。

<a id="bundled-command-runtime"></a>

## 内置命令运行时

安装后的 `resources/runtime/cli/bin/dsh` shell 脚本（Windows 为 `dsh.cmd`）使用 Desktop 的 Electron 可执行文件和内置 pnpm 运行普通 CLI 分派入口。Desktop 关闭时也可使用，并保留 Electron 运行时限制。它在加载 CLI 模块前解析与 Desktop 相同的产品实例；继承的 `DSH_HOME` 和 `DSH_AGENTS_HOME` 不能重定向其状态。普通 profile、配置和插件命令与 npm dsh 使用相同实现；该命令不会打开 Desktop。

管理 Desktop 插件前，先启动一次 Desktop 以初始化其 profile，完全退出应用，再运行 `dsh plugin --profile desktop add <package>`、`list` 或 `remove <package>`。重新打开 Desktop 后使用更改。包操作保留共享的 profile 写锁和兼容性检查。内置命令拒绝未初始化的 Desktop profile，不会在其位置创建普通 CLI profile。

更新或卸载 Desktop 前请结束 CLI 命令；安装程序不与运行中的命令协调。CLI 不提供 Office 创作 skill 的资源路径。Desktop 现有 Office 设置与 Web 附件转换保留各自的资源配置。`prepare:runtime` 复制启动脚本，无需编译原生 CLI 启动器。

<a id="installation-ownership"></a>

## 安装归属

Electron 拥有 `$DSH_HOME/profiles/desktop`。其 `dependencies` 包含 pnpm 安装的包；`dsh.profile.bundles` 包含内置 bundle，后接已启用插件。签名应用从 `resources/app.asar/dsh` 提供 dsh、私有 Desktop Host 及其生产依赖。打包应用选择 runtime profile 解析，不创建包链接；开发 profile 使用文件系统链接。宿主与插件在同一个 Electron Node 模式进程中执行；Desktop 不启用 `--preserve-symlinks`。CLI 不能启动此 profile。Desktop 内置命令可在应用退出后管理其插件；npm 安装的 dsh 不能修改它。

应用 preload 只向 `dsh-app://app` 文档暴露启动就绪、致命启动失败上报、原生目录选择、用于 composer 路径引用的 `__DSH_HOST_PATHS__` 桥接和租约范围内的 Browser 桥接。同一个 preload 通过 `dshDesktop.deviceInfo()` 转发主进程采集的机器描述，按 `name=value` 字段以 `; ` 分隔：`platform`、`os`、`app_arch`（应用二进制实际运行的架构，模拟运行时与硬件架构不同）、`cpu` 和 `memory_gib`（物理内存总量，GiB，保留一位小数）。取值不可用时省略对应字段。该描述不包含主机名、用户名或序列号。产品页面还获得 Desktop 标记、更新展示数据和打开原生确认的操作，不能选择安装产物或授权安装。插件管理使用 Web 应用经过认证的 HTTP API；Electron 在 `dsh-app://shell/` 本地提供更新弹窗文档和资源，不依赖 Host 就绪。Electron 不提供插件管理 IPC 或独立管理页面。任何渲染进程都不会获得文件系统访问、原始 Electron IPC、shell 或任意 pnpm 参数。

文件拖放桥接接受所属主应用主框架传入的任意文件字节或 Session 资源地址。Host 通过组合的文件系统授权读取、确认本地映射并返回私有内容摘要；主进程检查内容与统一解析的导出名后借用源文件。原生起拖核对准备时的设备、inode、大小、修改时间和变更时间，不再读取整份字节。借用文件不会被删除。改名、转换、远程或 Blob 内容使用私有临时副本。MIME 数据补全名称，不限制文件类型；`.jpeg` 等兼容后缀保持不变。临时准备、部分写入及保留的导出共享 64 MiB；指针移开释放未使用文件，已交给系统的副本在 60 秒后过期。空间耗尽时显示通用重试提示，容量回收后可重试。调用方取消及退出会中止 Host 读取和主进程验证、打断图标等待并释放未使用文件。退出等待写入和释放，重试失败的删除，但不等待图标服务。更新准备在停止 Host 前尝试清理；清理失败只记录日志，不阻断安装或退出。安装失败后恢复桥接。异步系统文件图标避免主进程解码原图。

只有主应用窗口启用 `<webview>`。guest 挂载必须匹配主进程签发的租约和分区；guest 保持 sandbox、context isolation 和 Web security，不启用 Node integration 或 guest preload。Browser IPC 监听只为应用文档创建。[Sidebar Browser](../../packages/client/ui-sidebar-browser/README.zh.md) 说明存储分组和 guest 限制；Host 鉴权仍独立于 URL 过滤而必需。

`dsh-app://shell/` 无需联系 Host 即可提供打包的更新文档、脚本和样式。静态请求保留 GET/HEAD、路径范围和 MIME 处理；每个更新文档继续使用隔离 preload 和所属窗口的 IPC 校验。

产品 UI 保留 Web 操作，包括通过共享认证 HTTP 路由执行的“打开方式…”。Desktop 使用 Web 的自动目录选择机制，并以共享 Web 模板的 bundle 列表初始化新 profile。

升级文案完整展示版本号（包括预发布后缀），不额外添加 v 或 V。无可用更新时，弹窗标题显示检查结果，正文显示当前版本。

Electron 根据应用语言选择类型化的八种[内置 Client 语言](../../packages/client/locale/README.zh.md)的 shell 文案，并回退到英文。macOS 应用包通过 `CFBundleLocalizations` 声明支持全部八种语言，让 macOS 根据用户的首选语言匹配初始应用语言。主界面仍优先使用已保存的 Client UI 语言偏好。Windows NSIS 安装器在 `installer/locales/` 下按语言保存独立 JSON 资源；打包从这些文件生成 NSIS 文案和安装器语言清单。全部内置语言资源的键、格式占位符和命令示例必须一致，`pnpm run check:i18n` 负责检查。原生安装器测试逐个构建并验证配置中的语言。账户平台页面和引导插图对中文以外的语言使用英文。在 Windows 上，主文档的语言会更新桌面菜单、恢复与更新提示。仓库 Client UI i18n 检查覆盖桌面端源码。

Windows 和 macOS 会在原生全屏切换及每次页面加载后向渲染器同步全屏状态，让浮层调整顶栏避让距离。

Windows 使用 40 DIP 顶栏，保留原生窗口按钮，颜色随应用调色板同步。侧栏开关旁的本地化“应用”和“编辑”入口打开原生弹出菜单。仅当应用框架发布 shell overlay 席位后才挂载菜单，启动加载期间不显示。“应用”提供检查更新和退出；“编辑”向当前编辑器发送对应按键，提供撤销、重做、剪切、复制、粘贴、删除和全选，不受自定义快捷键绑定影响。插件管理使用主应用的“插件”页面。按 Alt 不会出现额外的原生菜单行。其他平台保留原生菜单。可编辑区域保留快捷键和不带快捷键标注的右键菜单；命令可用状态由 Chromium 提供，选中的只读文本提供“复制”命令。

macOS 上自定义菜单保留 Electron 的标准 Window 菜单及应用隐藏命令，包括 Minimize（⌘M）和 Hide（⌘H）。Linux 保留应用菜单和 Edit 菜单。

### 运行时与插件激活

签名资源中的 `resources/app.asar/dsh/desktop-runtime.json` 绑定 shell 版本、Electron 的 Node 版本、平台、架构、共享包版本和最终文件清单。启动读取元数据，并检查共享包记录。发布 schema、shell 版本、目标兼容性和文件完整性在打包时验证。只有出现打包校验与实际 Host 诊断无法充分解释的具体安装故障，才重新引入启动时的发布信息比较。首次启动不会把核心包复制到 profile 存储或通过 pnpm 安装核心包。

1. 主窗口在 profile 准备或后端启动前，从打包静态资源于屏幕外加载共享 Web 加载页。共享 profile 初始化创建缺失的 manifest、空用户 patch 与 pnpm workspace 文件，不覆盖现有文件。
2. 启动 Host 前，Desktop 校验运行时描述符并准备 profile，不改动已安装的包、依赖声明与锁文件；只删除早期 Link 后端启动写下的 `.dsh-module-fallback` 投影，启动从不运行 pnpm。profile 内的包保持原生优先级，本体包名通过 runtime resolution 解析（[查找顺序](../../.agents/notes/implemented/architecture/2026-09-19-profile-resolution-lookup-order.zh.md)；[清理移除](../../.agents/notes/implemented/simplification/2026-09-19-remove-desktop-profile-core-cleanup.zh.md)）。
3. Electron 的 Node 版本、平台或架构变化时保留已安装插件。原生兼容性问题在加载时报错，可通过 pnpm 修复。
4. 主应用的“插件”页面通过共享[插件管理器](../../packages/boot/plugin-manager/README.zh.md)操作 Desktop profile。包操作使用内置 pnpm 及正常的用户和 profile 配置。
5. 共享管理器负责安装错误、激活和重启要求。即使 Host 无法启动，原生恢复仍可禁用第三方 bundle。

[Web 插件 UI](../../packages/client/ui-plugin-manager/README.zh.md)负责管理界面。Desktop profile 初始化和恢复保留已安装插件文件。

Desktop 的致命故障通过原生恢复对话框提供退出、重启、禁用第三方插件并备份 profile patch 后重启，以及获取诊断报告。触发范围、报告位置与内容、近期操作记录和退出限制见[故障恢复与诊断](docs/diagnostics/README.zh.md)。

### Host 环境

macOS 和 Linux 从图形界面启动的程序只继承会话管理器提供的环境，不包含 shell 启动文件导出的变量。第一个 Host 启动之前，Desktop 以 `<shell> -ilc` 运行一次账户的登录 shell（取自用户数据库，不看 `$SHELL`），读取定界符之间的 `env -0` 输出，使 `~/.zprofile` 和 `~/.zshrc`（或该 shell 的对应文件）对 Host、agent shell、终端和 profile 配置生效。读取与 profile 准备并行进行。读取进程没有终端输入，并设置 `DISABLE_AUTO_UPDATE=true`、`ZSH_TMUX_AUTOSTARTED=true` 和 `ZSH_TMUX_AUTOSTART=false`，避免 oh-my-zsh 和 tmux 插件阻塞。shell 的值覆盖继承的值，但 `PWD`、`OLDPWD`、`SHLVL`、`_`、上述读取变量以及启动方自有的 `DSH_*` 和 `ELECTRON_*` 除外；Desktop 在合并后重新应用已解析的产品上下文，因此 shell 不能替换 `DSH_HOME`、`DSH_AGENTS_HOME` 或 `AGENTRANS_LAUNCH_CONTEXT`。读取在结束定界符出现时完成，因此启动文件启动的后台进程可以继续运行，其输出被丢弃。候选 shell 无法启动、以非零状态退出、没有输出定界内容或超过 `DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS`（1000 到 2147483647 的整数毫秒，默认 `10000`；超时会结束其进程组）时，Desktop 记录一条警告，并依次尝试 `/bin/zsh`、`/bin/bash` 和 `/bin/sh`；全部失败时 Host 使用继承的环境。读取命令使用 POSIX 语法，因此 csh、tcsh 或 nushell 等账户 shell 会失败，Host 改为获得第一个系统 shell 的启动文件所设置的环境。读取期间退出 Desktop 会结束正在运行的读取进程组。每个应用进程只读取一次，因此修改 shell 启动文件后需要退出并重新打开 Desktop。Windows 从图形界面启动的程序已经从注册表继承用户和系统环境变量，因此 Windows 跳过这一步。

<a id="develop"></a>

## 开发

开发环境应用菜单提供“刷新页面”（macOS 为 Cmd+R，其他平台为 Ctrl+R）和“重启应用与 Host”。重启会等待 Host 关闭，再重新启动 Electron 和新的 Host；这两项操作都不会重新构建源码。

`dev:desktop` 会构建当前 Host、客户端 bundle、Web 前端和 Electron 壳，把已构建的 CLI 包、私有 Desktop Host 包及其 workspace 依赖投影为一次性桌面 npm 项目，然后直接启动 Electron；这条路径不从 npm 解析 dsh：

```sh
pnpm run dev:desktop
```

开发状态默认写入 `<checkout-parent>/.dev-data/agentrans/dev/<worktree-hash>`，位于规范检出目录之外，每个 worktree 使用独立实例。绝对路径 `AGENTRANS_DEV_ROOT` 会替换整个实例；继承的 `DSH_HOME`、`DSH_AGENTS_HOME` 和 `DSH_DESKTOP_USER_DATA_DIR` 不能单独选择状态目录。一次性 npm 项目仍位于 `apps/desktop/.desktop-build/development/project`。[产品布局](../../packages/boot/product-layout/README.zh.md)定义可写路径，并拒绝与代码重叠或属于其他用途的根目录。Host 和工作区更新验证将独立验证实例及证据保存在 `<checkout-parent>/.dev-data/agentrans/verification` 下。

Renderer DevTools 默认自动打开，Main、Renderer 和 dsh Host 调试端口依次为 9229、9222 和 9230。`DSH_DESKTOP_MAIN_INSPECT_PORT`、`DSH_DESKTOP_RENDERER_DEBUG_PORT` 与 `DSH_DESKTOP_HOST_INSPECT_PORT` 可以替换这些端口，`DSH_DESKTOP_OPEN_DEVTOOLS=0` 则保持 Renderer 调试窗口关闭。

显式构建完成后，`start:desktop` 会重新生成一次性项目，并跳过构建直接启动已有产物：

```sh
pnpm run start:desktop
```

桌面包准备过程按安装包目标的操作系统和架构筛选可选原生包。Windows 的包集合不包含 macOS Computer Use tarball，即使输入包是在 macOS 上打包的。

Web 侧的对应命令是 `pnpm run dev:web` 与 `pnpm run start:web`，见[开发指南](../../docs/development.zh.md)。Workspace 开发使用 Electron RunAsNode 运行当前 CLI 与私有 Desktop Host 包，插件管理和恢复使用 `$DSH_HOME/profiles/desktop`，与一次性工作区运行时分离。Host 在开发与打包构建中都使用 runtime 模块解析，不创建官方包的 fallback 链接；开发者安装的包（包括链接）保留原生优先级。需要验证 Electron RunAsNode、内置 pnpm、内置 dsh 资源、插件安装和修复时，应运行未封装安装器的应用目录。

[原生输入与渲染进程键盘测试](tests/keyboard.spec.ts)直接纳入仓库 Client 类型检查。它只导入不依赖 Cordis 的 Desktop 输入、持久化、IPC、浏览器 guest 和蒙层模块。

安装工作区依赖不会自动运行锁定版本 Electron 提供的独立二进制安装程序。直接运行 [Windows 控制台信号测试](tests/windows-cli-signals.spec.ts)前，在仓库根目录执行 `pnpm --filter @agentrans/desktop exec install-electron`，准备锁定版本的 Electron 二进制。通过代理下载时，为该安装进程启用 `ELECTRON_GET_USE_PROXY=1`。Windows 覆盖率检查要求安装成功后，才启动带覆盖率插桩的单元测试集。

<a id="startup-onboarding"></a>

### 启动引导

API Key 输入框初始为空，并通过 `autocomplete="new-password"` 请求 Chromium 不要自动填入已保存的登录密码。

重复启动与 `dsh://open` 会保持工作区隐藏，直到已配置密钥检查或欢迎页操作允许进入。从 Welcome 进入时，键盘焦点落在文档上，不预先选中侧栏控件；仍可使用 Tab 导航。

Desktop 在 Host 启动后检查各模型 API Key 引用是否已配置。没有已配置的密钥时，Welcome 直接显示 API Key 表单。“保存并继续”通过凭证服务写入 DeepSeek 官方提供方配置的引用，然后打开工作区；保存失败保留草稿以供重试。“稍后配置”打开工作区，但不保存草稿或完成标记；下次冷启动会重新检查密钥。保存、跳过和获取密钥链接共用忙锁。Desktop preload 标记抑制自动 Web 凭证引导；模型设置和显式密钥编辑仍然可用。

欢迎窗口在显示前读取共享的 `locale.preference`。用户明确选择的受支持语言优先；否则 Desktop 按系统语言顺序匹配支持的语言，并以英文兜底。主界面在挂载前通过隔离 preload 读取同一偏好和系统语言顺序。在设置中切换语言会更新桌面壳的当前词典和菜单；自动选择不会写入偏好。欢迎窗口不提供语言切换入口。

“前往 DeepSeek 获取 API Key”通过系统浏览器打开[官方密钥页面](https://platform.deepseek.com/api_keys)。固定地址由主进程持有，渲染器只发送无参 IPC 请求。打开失败时保留表单，并显示本地化的重试提示。

### 欢迎窗口外观

欢迎窗口跟随系统外观，在 600 × 700 的窗口中显示单一 API Key 表单，使用原生控件、可拖动标题区域和纯文本 Agentrans 品牌。非按钮文字使用本地 Montserrat Light 字体，并回退到系统字体。macOS 使用 menu vibrancy，Windows 使用 acrylic；浅色模式叠加 40% 白色，深色模式叠加 50% rgb(24 25 28)。本地 React 包通过隔离 preload 工作，不加载主 Web 插件图。文档禁止网络请求和导航；窗口 IPC 只接受其所属主 frame。开启“减少动态效果”会禁用按钮过渡。操作系统控制模糊强度和外部圆角；macOS 的“降低透明度”抑制半透明效果，“增强对比度”会强制开启该设置。[窗口记录](../../.agents/notes/implemented/architecture/2026-09-08-desktop-welcome-window-material.zh.md)负责这些决策。

<a id="package"></a>

## 打包

<a id="release-versions"></a>
<a id="upload-updates"></a>
<a id="windows-ev-signing"></a>
<a id="desktop-runtime-preparation"></a>
<a id="runtime-file-selection"></a>
<a id="unsigned-windows-test-installer"></a>
<a id="local-macos-dmg-without-release-signing"></a>
<a id="local-official-bundles-from-a-loopback-registry"></a>

构建与发布操作请使用独立指南。共享 Windows runner 存在已接受的凭据和设备隔离限制；签名或执行分支代码前必须阅读。

- [Desktop 打包](packaging/README.zh.md)：本地与 Actions 构建、版本、部署配置、产物、日志和验收。
- [Windows 签名与 runner 运维](windows-signing/README.zh.md)：机器部署、已接受的隔离风险、签名凭据、Token 失败与缓存维护。
- [Desktop 发布](publishing/README.zh.md)：上传凭据、发布标识、固定下载、更新清单和上传恢复。

<a id="windows-uninstall-rules"></a>

<a id="windows-installer-interface"></a>

## Windows 安装界面

Windows 安装程序使用原生 NSIS 页面，提供亮暗配色、系统阴影、可编辑的安装目录，以及默认勾选立即启动的完成页。安装仅面向当前用户。点击安装或按 Enter 均校验当前路径；路径规范化后仍拒绝磁盘根目录，包括带重复末尾分隔符的写法。新安装位置必须为空，非空位置必须是已登记的安装目录。受影响安装路径中的程序运行时显示系统提示，并保持应用运行；其他目录中的同名应用不阻止安装。静默更新最多等待受影响应用退出十秒，若仍在运行则以退出码 2 结束。

主题在启动时跟随 Windows；可用 `/THEME=light`、`/THEME=dark` 和 `/THEME=auto` 显式选择配色。窗口在品牌控件准备完成后显示。欢迎页首次出现时，安装窗口会一次性移到普通窗口前方；若焦点在其他窗口，任务栏按钮会闪烁提示，但安装窗口不会始终置顶。进度读取锁定版本的 7-Zip 解压器百分比；目录替换、注册和清理仍使用有界估算。加权百分比不代表剩余时间。NSIS 报告成功后，进度条用 600 毫秒补满并短暂显示 100%，再显示完成页；切换目标时长为 750 毫秒。完成页保留窗口位置。点击完成后，安装程序先隐藏窗口，再启动已安装的可执行文件；启动失败会恢复页面以供重试。目录替换和失败恢复遵循[安装检查](packaging/README.zh.md#runtime-file-selection)。首次启动的配置档案准备仍属于独立的 Desktop 操作。

Windows 打包使用 Visual C++ Build Tools 和 Windows SDK 编译 x86 Win32/GDI+ 辅助库；签名构建通过已配置的 Windows 签名器对该库签名。进度页在其生命周期内保留一个不透明像素缓冲，只绘制一次静态图像，并通过 GDI 复制重绘的像素。准备钩子在所有平台上均由 electron-builder 继续负责收集生产依赖。

在有交互式桌面的 Windows x64 上，从仓库根目录运行 `pnpm --dir apps/desktop run test:installer`，可将小型原生测试载荷接入正式安装配置并执行验证。每次运行使用独立产品身份，依次验证仅英文和仅中文的安装器变体，并根据实际显示的欢迎页按钮选择测试文案。两个变体均安装到私有目录并在测试后卸载；截图和结果保留在 `.desktop-build/installer-tests/` 下。检查包含末尾带分隔符的已登记路径升级，以及磁盘根目录拒绝。绘制器接收 NSIS 主题传入的标题栏颜色；像素检查绘制到离屏位图，并在隐藏进度子窗口时验证。原生绘制检查覆盖 100% 和 200% 缩放下的浅色/深色配色、绘制到 100% 的完成状态、标题栏按钮的悬停／按下颜色和松开触发与取消、最小化恢复后的窗口位置和尺寸，以及 GDI 资源释放；`render-results.log` 中的重绘耗时仅供诊断，不作为 CI 性能阈值。运行生成的 `ui/render-test.exe <brand.bmp> <dpi> <light|dark> <hover-argb> <pressed-argb> [interactive-title]` 并指定标题，可在不安装载荷的情况下查看真实进度页。可选的 `--signed` 标志使用[Windows EV 配置](windows-signing/README.zh.md#signing-configuration)，在嵌入前对测试程序和辅助库签名；它不会启用更新源。

Windows NSIS 卸载程序删除应用与可重建缓存，默认保留用户数据。生产卸载 CLI 提供原生选项对话框，可选择会话、设置与安装元数据、模型资源、独立运行时和导出，选择全部类别需要确认。静默卸载不打开对话框。范围文件删除与结构化 CLI 错误由 [product-layout](../../packages/boot/product-layout/README.zh.md) 定义，不删除外部 DSH 集成。

原生辅助程序拒绝带链接的选中根或祖先，保护 Windows 目录及与 `DSH_HOME` 重叠的路径，遇到内部重解析点只解除链接，不访问目标。路径被拒绝或文件被占用时，卸载以退出码 2 停止。独立报告记录目标与 Win32 错误；交互失败提供恢复说明和复制操作，静默失败在进程临时目录的 `Agentrans-uninstall` 文件夹下保留报告。已删除的兄弟项不会恢复。清理失败后保留注册、快捷方式与根目录卸载程序供重试。应关闭使用此安装的进程，检查被拒绝的链接而不删除目标，再明确重试；报告写入失败仍保留失败退出与交互兜底。

清理前 NSIS 检查共用卸载注册和快捷方式是否属于此安装。旧卸载器会拒绝已指向其它根目录的入口；缺失注册不授权删除其它安装的快捷方式。新快捷方式指向 `app` 下的可执行文件，清理也识别旧的同根可执行文件位置。注册清理前再次检查，但 Registry 与 COM 操作不是隔离并发替换的原子事务。安装写入 `InstallLocation` 供清单查询。在 Windows 11 上，Win32 应用的开始菜单“卸载”打开已安装应用列表，只有 MSIX 会直接卸载。卸载程序支持 DPI 感知，中文使用微软雅黑 UI。这些原生规则仅适用于 Windows。

使用 `node apps/desktop/scripts/test-windows-installer.mjs --uninstall-only --compile-only` 以每次运行唯一的带作用域包名编译独立的中英文夹具。省略 `--compile-only` 可对预置数据运行原生删除器回归，以及交互、静默、`--updated`、`/KEEP_APP_DATA` 和 `DSH_HOME` 位于 Electron 数据内的检查。编译本身不能证明已安装卸载行为。

使用 `node apps/desktop/scripts/package-agentrans-installer.mjs` 构建 Agentrans 未签名 Windows 候选安装器，输出 `artifacts/agentrans-installer/agentrans-<version>-win-x64-unsigned.exe`。文件名和嵌入元数据采用同一个解析后的构建版本。此入口固定独立的 Agentrans 身份，关闭发布和协议注册，省略远程更新策略，并拒绝继承发布设置。安装包包含真实 Electron 应用、签名发布验签库和生产卸载入口。通用上游发布路径拒绝 Agentrans appId。该构建会内嵌产品自己的 GitHub feed（owner、仓库、通道），因此已安装的 Agentrans 检查的是自己的 Release 而非上游的；元数据文件名跟随版本的预发布标识（`-alpha.N` 发布为 lpha.yml，稳定版本为 latest.yml），这正是 electron-updater 针对该版本请求的文件。构建期间禁止发布，Release 由后续步骤附加产物。参见[分发边界](../../DISTRIBUTION.md)。

<a id="updates"></a>

## 更新

Windows 下载完成后的更新确认说明应用会在安装期间关闭、完成后自动打开，并提示期间不要重复启动。安装器携带 `--updated` 重启应用并直接打开工作区时，壳会将主窗口前置并聚焦一次，不启用永久置顶。启动进入欢迎页时会清除此请求，使后续登录保留正常的激活行为。普通启动和其他平台不执行此前置步骤。

macOS 在安装准备阶段等待产品主窗口退出全屏，再显示重启确认。取消确认后窗口保持普通模式；原生切换期间销毁窗口会在任务停止前取消安装。如果 macOS 未在五秒内报告切换完成，安装准备会报错且不停止 Host；本地化错误提示要求退出全屏后重试。安装失败后的恢复使用普通窗口。

普通更新弹窗使用产品窗口内、隔离的壳静态源 WebContentsView，检查结果加载不会抬升独立的原生窗口。工作区 Host 尚未就绪时，该文档仍可使用。视图挂载期间拦截产品键盘输入，关闭时释放监听和视图。Windows 顶栏位于视图覆盖范围外，其中的原生及产品 Web 控件仍可操作。点击顶栏可切换侧栏、创建或复用空 Session，并改变底层页面。“关于”或 CLI 命令管理等应用菜单操作可替换并取消当前普通提示，但不代表批准安装，也不会清除强更策略。视图挂载期间仍阻断产品键盘快捷键和编辑按键转发。

普通更新弹窗、Windows 首次关闭提示和强更文档共用随壳打包的 UI design token。各文档在显示卡片前通过 `prefers-color-scheme` 解析 Electron 的应用主题，配色变化时同步暗色主题属性。欢迎页与更新文档复用同一初始化脚本。明确选择浅色／暗色及跟随系统共用此路径，隔离文档保持透明背景，仅暗色模式以基于 token 的 1 CSS px 内描边区分卡片，不改变尺寸；浅色模式不描边。

打包应用在启动后异步检查固定 Nightly。常规轮询以十分钟为基础间隔，每次独立采样 ±20% 的随机抖动。每次检查失败将基础延迟翻倍，上限为一小时；成功后重置。随机延迟不超过该上限，并从全部复用调用结算后开始计时。本地化的“检查更新…”菜单项（Windows 可从顶栏的“应用”菜单进入）立即执行，并复用正在进行的检查。回到前台和系统恢复时遵守相同的单调时钟截止时间。新收到的强更策略也会立即请求检查更新清单。自动检查从不弹窗或下载安装包。手动检查显示正在检查、失败或包含已安装版本号的无更新反馈。常规更新弹窗原位渐入渐出；连续弹窗替换卡片内容并重置其滚动位置，保留黑色半透明蒙层，不模糊父页面。

`DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS` 配置常规基础间隔，`DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS` 配置上限；两者均接受 1000 至 2147483647 的整数毫秒数，且上限不能小于间隔。省略上限时取一小时与间隔中的较大值。`DSH_DESKTOP_UPDATE_CHECK_JITTER` 配置 0 至 1 的抖动比例，默认 `0.2`；最终延迟至少一秒，且不超过上限。这些配置不改变强更策略轮询，也不授权下载重试。

左下角账户行显示本地化的更新可用状态、加载图标与下载百分比、验证、就绪状态，或带可访问提示的持久红色重试操作。嵌入 Web 界面的文案跟随应用内当前语言；原生弹窗使用 Desktop 壳语言。侧栏收起时，顶部展开按钮显示圆点。连接状态优先展示。选择可用版本即开始下载。准备成功后自动打开壳拥有的重启确认；关闭后保留就绪状态，不重复弹窗。选择就绪入口可再次打开确认。运行中的 agent、排队输入，以及运行中或停止中的后台任务都会在该确认中触发中断警告。仅有 API 请求不会触发警告。用户批准后，Host 锁定新请求，等待已接收的请求结束，再检查任务，包括已接收写操作创建的工作。等待超过控制请求截止时间时，拒绝安装并解除准入锁。任务状态未知、未获中断授权的新任务，或未成功完成正常收尾，都会阻止安装。Host 确认收尾完成后立即退出，插件遗留的打开句柄不会占用正常收尾期限。常规退出先按"关闭窗口与退出"一节所述询问可中断的工作，再在停止 Host 前隐藏产品窗口，在收尾期间忽略新的聚焦请求，且从不安装更新。下次启动通过已有的启动与恢复流程校准版本绑定的运行时。

若任务收尾失败但已确认 Host 退出，安装会被拒绝，壳会在允许再次确认重启前恢复当前版本的 Host。Host 正常停止后的安装器启动失败使用同一恢复路径。替代 Host 启动并完成认证后，壳重新加载原有应用地址，让 Web 页面获取当前端口、Cookie 和启动注入数据；页面加载失败时打开原生致命故障恢复弹窗。未确认进程退出时，绝不允许启动替代 Host。已下载目标保留以供重试。已知强更策略在恢复过程中继续阻塞；Host 恢复失败打开原生致命故障恢复弹窗。

已确认 Host 退出但任务未成功收尾时，常规与强更弹窗均展示本地化恢复提示。两种语言都根据类型化的准备失败原因选择提示，翻译文案变化不会改变失败分类。“查看技术详情”默认折叠，仅展示退出状态、信号、关闭确认和截止时间事实，不展示插件 stderr。展开详情既不重试，也不授权安装。

<a id="update-channel-and-force-update-policy"></a>

### 更新通道与强制更新策略

打包会写入一个 GitHub Release feed 和该构建服务的通道：`latest` 读取正式 Release，`nightly` 读取预发布。应用在启动时、前台或恢复时（到期才查），以及用户主动请求时检查该 feed。它不查询任何远端策略服务、不强制更新、也不把任何工作挂在服务端决定上：可用版本只在用户逐步确认后才下载、校验并安装，拒绝则继续运行当前版本。

更早的版本会查询托管在服务端的强制更新策略，并可能弹出仅用于测试的登录窗口。两者都属于本产品已不再运营的托管下载服务，且产品不提供任何账号登录。

每个发布的产物都带一份分离式 Ed25519 签名，应用在允许安装前用固定在源码中的公钥校验已下载的安装包。私钥只存在于发布环境，即 DSH_UPDATE_SIGNING_KEY；缺少该密钥时发布会直接失败，而不是产出一个未签名的版本。签名缺失或不匹配会以可见失败结束下载，因为另一种选择是安装无人担保的字节。轮换密钥意味着发布一个携带下一把公钥的构建。

### 本地 updater 验证

常规更新 HTTP 请求具有逐连接的无活动截止时间：`60000` 毫秒内未收到响应头或后续响应字节会使操作失败。`DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS` 接受 `1000` 至 `2147483647` 的整数进行调整；活跃下载没有总时长限制。下载失败保留重试提示，并要求用户再次操作。

在已安装工作区依赖的 Windows 上，从仓库根目录运行：

```sh
node apps/desktop/node_modules/pnpm/bin/pnpm.mjs --dir apps/desktop run test:updates:local
```

此命令构建 Desktop 壳，让其协调器通过真实 Electron HTTP 请求和 `NsisUpdater` 访问私有回环服务器。它验证用户授权的完整下载、SHA-512 拒绝、显式重试、并发请求合并、清单替换和安装交接。它还打开使用沙箱预加载的真实强更页面，检查按钮操作、关闭／Esc 拦截、纯文本内容、策略请求停滞和策略解除。成功时打印 `LOCAL_UPDATER_RESULT` 并以零退出码结束；功能失败时返回非零退出码。每次调用独占随机端口和临时用户数据／缓存目录，关闭监听器、等待 Electron 退出，并移除临时文件。报告和可用截图保存在唯一的 `.desktop-build/qualification/local-updater-*` 目录中。截图失败单独记录，绝不当作视觉验收通过。不需要 COS 或签名凭据。

下载内容是不可执行的测试字节，安装调用仅记录而不执行。测试替换浏览器打开与剪贴板写入，避免外部导航和剪贴板修改。它不启动完整产品工作区，不验证真实安装器或重启，不验证发布者签名，也不覆盖差分更新或 macOS。停滞的策略请求、清单请求和负载传输会执行真实截止时间及恢复。真实常规弹窗验证隔离预加载、卡片尺寸、未施加模糊的父页面、取消、任务警告选项与显式安装批准；账户行组件测试另行提供证据。[本地验证决策](../../.agents/notes/implemented/testing/2026-09-10-desktop-local-updater-qualification.zh.md)和[验证记录](tests/README.zh.md)保留这些限制；生产发布要求保持不变。

原生原始文件操作仅接受可信应用页面。完成后向该页面返回目标路径；显示位置复用现有 Host 路径打开 API，不提供独立 reveal IPC，也不保留已保存文件历史。下载使用 Chromium URL 下载和原生保存对话框 API；`DSH_DESKTOP_FILE_DOWNLOAD_TIMEOUT_MS` 限定 Chromium 创建下载前的启动期限（300000 毫秒），不限制原生保存对话框的停留时间。仅剪贴板使用的远程图片读取不携带凭据，逐次校验重定向，拒绝应用 Host 及其回环别名，在主框架导航时终止，并使用 `DSH_DESKTOP_IMAGE_READ_TIMEOUT_MS`（30000 毫秒）与 `DSH_DESKTOP_IMAGE_READ_MAX_BYTES`（67108864 字节）。图片复制在转换为 PNG 后使用渲染进程的 Clipboard API。其他可达的 HTTP(S) 目标遵循部署侧网络隔离。[文件操作](../../packages/client/ui-file-actions/README.zh.md) 定义保存和剪贴板行为。

<a id="low-level-development-overrides"></a>

## 底层开发覆盖项

未打包的 Electron 进程使用应用目录下的 `.desktop-build/development/project` 作为开发项目。`DSH_DESKTOP_PNPM_ENTRY` 和 `DSH_DESKTOP_DSH_DIR` 是带应用路径默认值的可选覆盖项。每次未打包启动都必须设置 `DSH_DESKTOP_PRIMARY_RUNTIME_DIR`：开发启动器（`dev:desktop`、`start:desktop` 及工作区更新验证运行器）会把它设置为自己已准备目标的 primary-runtime 目录；缺少该变量的启动会以致命启动对话框失败。启动器必须设置它，因为壳无法从 `process.arch` 推导该目录：构建目标将 Windows 固定为 x64，而宿主可能是 arm64。打包应用会忽略这些变量，从 `process.resourcesPath` 解析签名资源，并使用受管 Desktop profile。

<a id="known-limitations"></a>

## 已知限制

- 账号登录尚未接入；登录按钮禁用。Windows 材质效果仍需平台验证。

- 发布签名、公证、更新托管和跨上一版本的已安装产物验证需要生产发布环境。
- 依赖的生命周期脚本遵循 pnpm 的构建权限；Desktop 不提供单独的审批对话框。
- 打包用户启动当前支持 Windows 产品布局。其他平台需要提供各自的安装布局后才能启用用户启动；验证使用显式绑定的私有实例。
- 在 Electron win32-arm64 宿主上，未打包启动现在可以成功，但载荷仍为 x64：`packages/skill/tool-workspace-dependencies/src/index.ts` 的架构校验会把载荷记录的架构与宿主 `process.arch` 比较，因此 `load_workspace_dependencies` 工具仍可能拒绝 primary runtime。

仅向应用提供的 `dshOnboarding.hasApiKey()` preload 方法返回欢迎后端当前的 API Key 存在状态布尔值；原生登录与引导共用凭证发现逻辑，且只有受管理的应用主 frame 可以调用。

登录会在系统浏览器中打开配置的平台页面。Host 负责 PKCE 和临时本机回调，在进入工作区前保存凭证，再将浏览器跳转到平台完成页。打开和复制的授权链接通过 `theme=light` 或 `theme=dark` 携带当前生效的 Desktop 主题；`system` 在执行操作时解析。即使平台页面随后批准，取消仍会撤销本地尝试。设置中的账号页面提供退出；没有独立 API Key 时，退出后返回欢迎窗。浏览器登录成功后，Welcome 切换到工作区但不激活应用。普通启动不会注册 `dsh://` 处理程序。macOS 开发启动器在 `.desktop-build/development` 下准备经临时签名的 `Harness Dev.app`，不声明或注册该协议。它加载当前工作区，并记录选定的开发实例和调试设置，以供冷启动使用。生成的应用包不包含账号 token，依赖工作区和已准备的运行环境继续存在。

账号失效并返回 Welcome 时，主进程保留一次性通知，直到渲染器通过所属窗口的 IPC 领取。重新加载 Welcome 不会重复提示；主动退登和冷启动不会生成该通知。

登录超时后显示超时标题，并提供重新登录和添加 API Key 按钮。打开 API Key 表单会关闭授权视图；后续账号状态通知不会覆盖正在填写的密钥。

内嵌 Platform 视图在文档加载完成前保持隐藏，让渲染层加载图标可见。关闭或替换待加载视图后，该视图不会再次出现。强更策略或普通更新提示阻止打开 Platform 视图；清理存储期间开始阻断时，待打开视图也不会挂载。 所属应用文档刷新或替换、渲染进程终止以及窗口关闭也会销毁原生视图，不依赖 React 清理。

私有 Platform 部署请求头由内嵌浏览器会话注入，仅用于配置来源的文档和 API 请求。Cookie 覆盖按名称合并。跨来源请求移除部署请求头；bootstrap 仅暴露 origin、token 和已解析的语言。

账号提供者的 `embeddedPageDist` 配置为内嵌用量和充值页面 URL 添加 `dist` 查询参数。默认值为空；私有前端分支选择值应写在本地 profile patch 中。此配置不改变 API 地址或凭证传递方式。

<a id="dev-note"></a>

## 开发备注

上线前 CDN 与容量决策见[桌面更新提案](../../.agents/notes/proposed/feature/2026-09-08-desktop-update-policy-and-installation.zh.md#cdn-and-capacity-qualification)。
