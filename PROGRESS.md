# Agentrans 当前进度与待办（2026-11-08）

本文件记录当前开发工作区状态和 0.1.0 发布基线，供后续继续推进时对照。工作区完成项不代表已进入用户安装或发布物。

## 已完成：单通道发布、五个门禁与自签更新链（2026-11-10）

- 发布管线从 COS/EdgeOne/CDN 收敛为只走 GitHub Releases：删掉 generic provider、bucket/凭据/CDN purge/资格脚本与相关测试、npm scripts 与 CI 工作流；electron-updater 只保留 provider: 'github'。
- 强制更新线整条删除：策略服务、测试登录窗口、desktop/settings.json、DSH_DESKTOP_MANDATORY_UPDATE_* 与 DSH_DESKTOP_AUTO_UPDATE_ENV（79 文件，+112/−4452），并补了升级指南；旧 .env.windows 里残留的键现在会让打包**响亮失败**而不是被静默忽略。
- eat/first-slice 快进合并到 main（41 提交）。仓库第一次真正有默认分支内容；gh run list 的首条运行即由此产生。
- 新增四个仓库级门禁并注册进 un-gates（doc-sync 43 → 47）：erify-config-keys（87 行配置与其声明的 schema 键比对）、erify-bundle-overrides（6 处 bundle 覆盖必须重述全部键）、erify-disabled-package-imports（372 个包不得运行时依赖 8 个 shipped-but-off 包）、erify-seam-roles（33 条 seam 的 definition/consumer 不得 import provider）。
- deepseekAccount seam 重构：线协议工具（platformClientHeaders/mergePlatformCookies/platformWireLocale/desktopClientHeaders）从定义包迁到唯一调用方 pps/desktop/src/platform-client-headers.ts，定义包只剩接口/类型（167 → 112 行，无运行时函数）；决策记录在 .agents/notes/implemented/architecture/2026-11-09-platform-client-identity.md。
- 更新可信链（方案 B）：发布时为每个产物生成 Ed25519 detached 签名（覆盖 SHA-256 摘要，避免整包进内存），应用在 download() 内用固定公钥验签，失败即 error 且不进入可安装状态；私钥只在仓库 secret DSH_UPDATE_SIGNING_KEY，缺密钥时发布拒绝执行。
- 给产品自己的 feed：createAgentransInstallerBuilderConfig 现在内嵌 owner/repo/channel，安装器产出 lpha.yml（而不是 latest.yml）并把 channel: alpha 写进 pp-update.yml；Release tag 由 desktop-v<version> 改为 <version>，因为 electron-updater 会跳过 semver 解析失败的 tag。
- 新增托管 runner 打包通道 .github/workflows/agentrans-unsigned-package.yml（windows-latest，未签名），用于在没有签名硬件的前提下把打包→发布→更新整条链跑通一次。
- 验证：	ypecheck 6/6、doc-sync 47/47、pps/desktop/tests 1452 通过、签名相关 64 条。已知既有问题：lint 70 条（27 文件，均为本会话之前存在）；desktop 与 scripts 套件同进程混跑时偶发并行争用失败，单跑通过。
## 已完成切片：场景调色板契约（主题概念第一步，2026-11-08）

- 七个原生渲染器原本各自 `getComputedStyle(canvas)` 读 4–5 个 `--dsw-alias-*`。导出程序的 `:root` 从未声明这些变量，所以导出的 `editorial` 场景一直在用空字符串画线；多序列画面也只有 `accent` 一个颜色可选。这是“主题只是单文档调色板开关”的直接后果，不是一个配色瑕疵。
- 新增 DOM-free 的 `packages/artifact/artifact/src/scene-palette.ts`：角色表 `ink / inkMuted / accent / success / surface / grid / highlight / series1..4` 与各自对应的 token 名；`resolveScenePalette(read)` 缺角色时抛 `ScenePaletteError` 点名角色与 token；`SCENE_STYLE_PALETTES` 声明每种风格的调色板所有者（`editorial` 为 `host`，`transit-map`/`blueprint`/`math-proof-lecture`/`particles` 为 `self-contained`）；`SCENE_STYLES` 成为类型、校验器与归属表共同的唯一列表。
- 两端投递都接上：客户端视图用 `scenePaletteFor(canvas)` 从实时主题解析；导出物自带明暗两套 palette 并按 `prefers-color-scheme` 选一套交给同一批渲染器，导出因此顺带修好。渲染器不再读取文档。
- 新增 ui-theme 样式表 `scene-palette.css`（第 9 张），`--dsw-alias-data-series-1..4` 与 `--dsw-alias-data-highlight` 映射到静态色阶，两套调色板下含义一致。粒子 `editorial` 分支改用 series 角色，多个粒子不再同色（唯一一处有意的视觉变化）。
- 门禁：`scene-renderer-palette.spec.ts` 读取渲染器源码，禁止 `getComputedStyle`、`--dsw-` 与（已声明自足集合之外的）字面色，并校验归属表覆盖全部风格。反向证明：删掉某个角色的 CSS 值即抛 `ScenePaletteError`，视图报 error 而非静默绘制。
- jsdom 没有 ui-theme，故新增 `scripts/test-scene-theme.ts` 注册进三个 vitest project 的 `setupFiles`，把角色值写到 `documentElement`；视图测试因此验证产品契约，而不是无主题表面。
- 验证：`typecheck` 6/6；`doc-sync` 43/43（含此前长期红的 symlink 项）；`test:gui` 12808 通过、1 失败且唯一项为既有 `present-open.host.spec.ts` 的 Windows symlink `EPERM`；`ui-artifact` 357/357，`artifact` 与相关 546/546，`ui-theme` 全绿。`gen-cordis-catalog` 与 `gen-persistence-catalog` 因 `scene.ts` 行号变动已重新生成。
- 尚未做：完整 `ResolvedTheme`（scheme/typography/motion/elevation 与 revision 一起发布）；iframe、欢迎窗、PWA 的主题通道；`data.axis`/`data.annotation` 等更多内容角色；默认主题改深色；应用深/系统浅与应用浅/系统深两向错配的真实截图验收。下一步是 iframe 与欢迎窗的通道统一，默认值最后再动。

## 已完成只读审计：架构一致性与主题契约（2026-11-08，未整改）

- 本轮只读：阅读 MEMORY/PROGRESS/源码，并实跑 `apps/desktop/tests`、`apps/web/tests` 与 `verify-product-use`。未改源码、未提交、未联网、未调用模型、未读凭据。证据在 `C:\agent制作\.dev-data\qa\2026-11-08-architecture-theme-audit`（AUDIT.txt、THEME_CONTRACT_PLAN.txt）。
- 交付状态实测：最后提交停在 2026-11-06 21:51（`Record the 0.1.0 progress and open issues`），HEAD 与 `origin/main` 相同；其后两天工作全未提交（408 文件 +13,801/−5,037，144 个未跟踪文件 + 24 个目录，5 个整包在 git 里 0 文件）。无 stash。这是当前最大风险：工作区是唯一副本。
- 测试实测与既有记录不符：`apps/desktop/tests` 180 文件、4 文件 9 失败 + 2 个 unhandled（2022 通过、76 跳过）；`apps/web/tests` 35 用例 1 失败。根因三类：改名漏改断言（windows-update-publisher 2、macos-signature 3）、代码硬编码 `'DeepSeek Harness.app'`（package-macos.ts:81、package-target.ts:548/554、verify-retained-desktop.ts:42，macOS 打包必 ENOENT）、夹具清单缺 `desktop-release-environment.mjs`（purge-command）。默认 vitest `testIncludes` 含 `apps/*/tests`，而文档引用的全绿数字出自 `test:gui`（仅 packages/client+host），故“只剩 Windows symlink EPERM”只对该子集成立。
- 门禁实测：`verify-product-use` 12 项红。2 项为 `product-layout/launch-context` 子路径缺 tsconfig.base.json paths 映射（该子路径被 14 个文件引用，exports 指向 lib，源码平面落到产物，违反 source/artifact 分离）；10 项为无产品用途包（本轮关闭分享/遥测后的副作用）。记忆第 881 行“两条源映射 + 四个休眠账号包”已过期。
- 品牌与身份实测：4 份桌面 PNG 同哈希（各 967,051 B）、3 份 SVG 同哈希（各 511 B）；PWA 四图标与 favicon 仍旧；`welcome-brand.svg` 已无源码引用；`render-app-icons.ts:109` 与 `render-tray-icon.ts:102` 对现 `icon.svg` 必抛（生成链已断）；`harness-dev-context` 仍挂 web-app 并自述上游；`index.html` 与八语言 `brand.localBuild` 仍 DSH；PE CompanyName 仍上游；版本三套（0.2.2-alpha.2 / 0.1.0 / Release v0.1.0）。
- 主题审计（本轮主要产出，方案见 THEME_CONTRACT_PLAN.txt）：主题目前是“单文档调色板开关”而非概念。108 个 alias 全为界面族、chart/series/plot 角色为 0；`ThemeTokens` 是开集且只校验值形状；5 种 SceneStyle 中 4 种固定色板，根因是缺 `data.series` 一类角色；iframe（document.ts 只注入 CSP+bridge）、导出（自带 `:root` + `prefers-color-scheme`）、欢迎窗（私有重声明 + `prefers-color-scheme`）三个出文档表面没有任何通道；加 PWA/安装器共六份色权。首屏 pre-paint 只读 cordis Config 且全仓无写回，故改默认值会给存过 system/light 的用户制造错误首帧；现有明暗验收用 `emulateMedia`，等价于“偏好=system”，恰好让断点隐形。
- 方案要点：轴化 → 角色表闭集（补 data.series/grid/axis/highlight）→ `ResolvedTheme(revision)` 可投递 → surface 声明（host/self-contained）→ 陈旧语义；风格与主题切开；验收改用 app/OS 两向错配并加“关通道必红”。建议第一个切片做 `flowchart`。默认主题最后再定，它是触发器不是病因。
- 文档冲突需先修：本文件顶部与 §四 P1–P5、记忆第 817 行与第 881 行、以及“只剩 symlink EPERM”的范围表述。
- 下一步顺序建议：① 先提交/备份工作区（含 5 个新包）；② 修 10 个红测试（macOS 包名属代码 bug，先改代码再改断言）；③ 补 launch-context paths 映射并处理 10 个无用途包；④ 按 THEME_CONTRACT_PLAN 做 flowchart 最小切片；⑤ 统一品牌单一源与生成器；⑥ 重建隔离安装候选。默认主题、UV_HANDLE_CLOSING、导出附件 GC、卸载 TOCTOU 仍单列。
- 提交拆分（同日晚，已落地）：工作区按子系统拆成 7 个提交，依次为构建门禁 → 共享准入 → 文档 → 作品能力 → 桌面 → 产品装配 → 回放/SDK，`origin/main` 未快进（未推送分支前 `main` 仍指向旧基线）。拆分前快照保留在本地分支 `backup/2026-11-08-pre-split`，确认无误后可删。文档必须先于代码提交，因为配对校验器在部分索引上会因跨文件存在性检查误报。
- 为过 pre-commit 钩子修了 4 处真实问题：`launch-context.ts` 两处超长行与一处 `delete` 改 `Reflect.deleteProperty`、`launch-context.spec.ts` 一处超长行；另为 `snapshots/sdk/*/workspace.expected/**` 增加 `whitespace=-blank-at-eof`，因为该 fixture 必须逐字节保留工具写出的尾随空行。提交后 `pnpm run typecheck` 6/6（18.86 s）、`product-layout` 7 文件 86/86；工作区与拆分前快照逐字节一致，仅上述 3 个文件加上 `.gitattributes` 不同。
- 已于同日推送 `feat/first-slice` 到 origin（pre-push typecheck 6/6 通过）；`origin/main` 未快进、未发布安装包。工作区除仓库根的 `PkgExplorerPlugin.dll.log`（0 字节外部工具残留）外干净。

## 已完成切片：原生欢迎页改为无账号 API Key 配置（2026-11-08）

- 默认组合未挂 DeepSeek 账号后端，但原生欢迎页仍展示登录按钮的问题已修复。现在首启直接显示 API Key 表单，以可见的 Agentrans 文字标识产品，提供保存并继续、稍后配置、前往官方获取 Key 三项操作；不再经过入口选择、账号状态、浏览器登录、复制授权链接、取消或过期通知页面。八语言文案同步；不再加载旧 `welcome-brand.svg`，其资产文件留待完整品牌整理，本轮没有修改图片。
- 删除 Welcome 账号 IPC、订阅与主进程自动打开授权页/账号过期重开窗口逻辑，并删除无独立消费者的私有 `account-backend.ts` 及其测试。配置事实只读取已配置模型引用的 credential metadata，保存仍经已有鉴权 Host RPC 的 write-only `credentials/set`，保留自定义 Provider 的 Key 检测；不读取或删除旧账号 grant。官方获取页由主进程以固定 `https://platform.deepseek.com/api_keys` 打开，renderer 只有无参操作，不能指定任意 URL。窗口所有者/主 frame 校验、导航禁止和无网络 CSP 保留；保存或打开失败保留表单与安全错误，忙状态防重入，卸载后完成不会更新 UI。稍后配置只进入本次工作区，不写持久完成标记。
- 移除无账号后端的后台 WS 重连，同时保留独立收集策略：原生事件每次通过捕获的同一 backend 读取既有 policy 后再 report，Host 保留自己的执行检查；Key 保存事件只有原有空属性，任何统计失败不影响保存。可选 Web 账号 Provider、嵌入 Platform 页面与强制更新认证仍有独立消费者，未连带删除；通用凭据、模型、反馈与 Session 功能不变。
- 最终相关 unit/组件 7 文件 218/218；真实 built Desktop Host 与 sandboxed preload 3/3（Host 主体 13.64 s），五次规范隔离的 verification 启动逐次核对真实 child PID、0 外网请求、无账号 RPC 和无 credential value getter。无 Key 重启仍需配置，write-only 保存后跨重启 metadata 持续存在；本轮仅用合成 Key，无真实模型请求。首轮旧测试未传必需产品上下文而失败，已保留证据并使用正式 resolve/prepare/environment 函数生成 code/resources/state 分离的 fixture，未放宽生产边界。首启单测也补齐隔离 mock，避免调用真实开发引导。
- 完整构建 11/11（47.91 s）、最新测试夹具后的 build:check 2/2（18.68 s）、doc-sync 43/43（53.71 s）、定向类型感知 lint、source-artifact 与差异检查通过。首轮残留 clipboard import 编译失败与两项测试 mock 方法绑定 lint 失败均保留并修正。八语言×明暗主题的 16 组实际 built renderer 在隔离 headless Edge 中检查了布局、无溢出/重叠、三项操作及 0 外网；中文浅色和英文深色截图已目视核对。这是 renderer 验收，IPC 边界由测试替代，不冒称完整 Electron 原生材质或新安装包验收。
- 删除 8 份已退役的纯 UI 文本预期，保留并更新两份当前英中表单预期，没有修改历史 Session。另按 source map、路径和原源文件缺席确认，给已删除私有 backend 的 4 个孤立编译输出留可恢复备份后移除；这些位于 `lib/types`，正式 installer 白名单原本也不包含该目录。README、既有欢迎窗口说明和新增 `desktop-api-key-onboarding` 升级指南英中成对同步。主证据 `C:\agent制作\.dev-data\qa\2026-11-08-native-welcome-api-key`，renderer 分项在 `2026-11-08-desktop-welcome-key`；真实 Host 的已关闭本地鉴权 URL 在最终日志中脱敏。记忆第 42 节同步。没有读取真实凭据、提交、发布或修改用户安装/系统入口；下一步继续统一品牌主资产与派生产物，再进行最新完整候选的隔离安装、升级与卸载验收。

## 已完成切片：Windows SDK 回放的平台归属与 fixture 写入（2026-11-08）

- 三项原失败已分别确认原因并完成对应 Windows 验收。`command-attachments` 的 Windows ACL 诊断技能来自正常产品注册，并非个人安装残留；只在该场景的 Agent scope 将真实技能声明为 user-invocable、非 model-invocable，保留全局能力、真实内容/资源和 skill 工具，通过真实加载与全字段比较确认没有误改。使用既有 registry effect 所有权，没有过滤 Session 事件或禁用生产沙箱。该场景新增独立 Windows schema/prompt sidecar，保留原 Session、通用 schema、prompt 字节。
- `minimal-image-compaction` 自己拥有 Windows persistent-pwsh schema 变体；从生产工具定义导出并先与原 Bash 对象逐组对照，只替换三组中的平台 shell 对象，保留图片/工作目录工具与原压缩预算。完整 Session、压缩与图片 offload、header、SDK 通知和工作区断言均通过；原录制和通用 header 预期不变。
- 历史 `persistent-tools` 实际依赖 `/bin/bash`、`/tmp`、POSIX 管道和重置提示，只补 `platform: posix`，不翻译旧记录或在 Windows 假跑。SDK scaffold 现在消费既有 `platform` 契约，并使用生产 PowerShell resolver 探测可用性。新增独立 `persistent-tools-pwsh` owner，通过真实 `sdk-minimal` 默认 provider/policy/subprocess 链执行 8 次工具调用：同目录 COUNT 1→2、延迟管道、文件创建/查看/替换、exit 9 与会话重建；独立工作区预期验证 14 字节 `note.txt` 和空目录。未改变其 danger-full-access 默认策略，也不将这组测试冒称 ACL confinement 验收。固定模型响应只决定调用，所有结果均来自真实工具，生成前已有窄断言拒收工具错误。
- 新 owner 首次 refresh 在已完成真实工具后暴露 SDK 写入次序问题：先稳定 header 会丢失真实 cwd，导致深层 JSON 中残留 Windows 路径。现先用真实 header 将 cwd token 化，再稳定身份；writer-only tokenizer 对完整嵌入 JSON 的值字符串逐层处理，保留 key、空白、数字原拼写、外部路径和其它文本，含待替换路径的不完整 JSON 明确拒绝。比较用 normalizer 未修改，writer 区域外 SHA 由独立审阅确认不变。新增本地/UNC SDK 回归先稳定 2 fail，再新实现 2 pass；临时恢复旧 writer 的反向对照再次 2 fail、精确恢复后 2 pass。相关 unit 102/102。首次失败日志与写出的新草稿保留，只有新未跟踪 owner 从 authored seed 重新生成；历史文件没有 refresh 或 record。
- 最终完整 build 11/11（86.11 s）之后，本机 Node 24.15.0 的源码 SDK 定向验收 12/12（3 个真实 Windows 场景 + 9 项边界/写入回归）；原 POSIX 场景明确不适用于 Windows，另 35 项未选，不能报整套 SDK snapshots 全绿。另通过 QA 显式选择发布态 SDK 在锁定 Node 24.21.0 上跑同三场景 3/3；只读 spawn 观察记录 3 个真实 child PID，全部为 `apps/cli/lib/bin.js`、无 tsx、无 source-compat patch，网络守卫均为 0 外部请求。没有增加产品启动参数或按产物存在与否隐式切换。完整 corpus 3/3、doc-sync 43/43（54.98 s）、所改 TS 类型感知 lint 与差异检查通过；场景 MJS 被仓库 lint 配置忽略，单独 `node --check` 与真实 Loader 执行通过，不假报 MJS lint。
- 初始 26 个场景文件中，仅 4 个明确的 manifest/overlay 文件改动；旧 Session、通知/result、普通 schema/prompt 和工作区预期全保持原 SHA，锁文件逐字不变，无新依赖。证据主目录 `C:\agent制作\.dev-data\qa\2026-11-08-windows-sdk-replay`，另有 `2026-11-08-sdk-command-attachments` 与 `2026-11-08-sdk-replay-portability` 的分项报告；记忆第 42 节同步。本轮没有读取凭据或调用真实 API，没有提交、发布、用户安装或修改系统入口/ACL。下一步回到品牌资产单一来源、派生产物与旧入口收敛，再构建独立安装/升级/卸载候选；当前工作区修复不代表用户已安装负载更新。

## 已完成切片：SDK 退出统一交给启动器（2026-11-08）

- 已复现上一切片的 Windows 图片退出崩溃：原 built SDK 两图片用例重复 8 轮，16 次中 2 次触发 `UV_HANDLE_CLOSING`；加诊断探针后另 16 次中 6 次失败。独立 Sharp/Koffi/组合与自然/强制退出矩阵 80/80、本地 HTTP fetch 对照 20/20 均通过，不能据此指认某个原生依赖。相同旧产物在项目已缓存的 Node 24.21.0 上 16/16 通过；旧系统 Node 24.15.0 只把 SDK 完成路径改为自然退出的诊断实验也 16/16 通过。调试器下竞态未再复现，没有取得实际 SDK 崩溃的原生调用栈；受控 fast-fail 只验证捕获工具，不算实际故障栈。以上实验与最终生产回归分别保存。
- SDK stdio 插件不再自己 dispose root 或调用 `process.exit`，改用既有 `appExit` 请求，由公共启动器统一释放 profile、代理与整个运行环境后自然退出。仍先完成 SDK-owned teardown，再返回原 shutdown 成功响应；错误保留 JSON-RPC error，响应 flush 失败同样请求 exit 1，成功不能降级失败码。只在协议终止时暂停默认 stdin；调用方传入流与单插件 HMR 卸载保留原所有权。插件缺 `appExit`/既有 exit-request hook 立即拒绝装配，直接使用 server 类不受影响；跨包消费者已核查。没有新增退出控制器、sleep、协议字段或 Session 类型。启动器的 5 秒 deadline 从 exit request 才开始，不覆盖之前 SDK drain/响应 flush，客户端时限仍独立。
- 补确定性真实子进程回归：两图片场景保持父 stdin 管道打开，验证完整 shutdown 成功 frame、实际 child PID 的 `beforeExit(0)→exit(0)`、无超时/信号且 exit 0；观察器仅同步记录，不替换退出。旧产物已验证预期失败。修复后 SDK server unit 15 文件 280/280；最新 built keyless 完整文件在 Node 24.15.0 与 24.21.0 各 21/21；旧 Node 再无重试重复 20 轮、40 图片用例全过、0 原生断言。额外 built scope/public CLI shutdown 2/2，5 个真实 guarded PID、0 blocked 外部请求。不是只复跑原失败用例便报整批通过。
- 完整串行 build 11/11（53.74 s）；最终 doc-sync 43/43（52.38 s），首轮生成配置目录过期造成的 42/43 证据保留并已用生成器修正；依赖策略 97 包、所改文件类型感知 lint、source-artifact 与差异空白检查通过。仅增加 SDK server 的 cmdline 工作区依赖/引用，锁文件相对本轮备份只改该 importer，1728 个第三方 package 与 snapshots 均不变；固定 pnpm 11.28.5 离线 frozen lockfile-only 通过，未更新系统 Node 或原生依赖版本。英中 README、配置目录、模块图和 `sdk-launcher-exit` 升级指南同步。
- 最新产物另用系统 Node 24.15.0 跑真实官方 `deepseek-flash`：`sdk` 与 `sdk-minimal` 各一轮、总 2/2。nonce 精确、单 completed turn、无工具/attempt、持久 Session 路由与普通输入正确、无分享 accepted，两次 `harness.close()` 成功。本轮两个 Temp 根经绝对父路径、专用前缀和全树无 reparse 预检后已删除；QA 仅留脱敏 Session。密钥字面量审计 501 文件、0 匹配，未打印或复制凭据。
- 证据在 `C:\agent制作\.dev-data\qa\2026-11-08-native-image-exit`，记忆第 42 节同步。此切片解决 SDK 正常完成仍强制退出的生命周期分叉，不能据此声称某个原生库内部缺陷已定位。下一步处理三类已知 Windows SDK 回放的平台输入与明确归属：额外 ACL skill、Bash/Pwsh header、POSIX persistent shell，保留历史 Session/预期字节并增加有归属的平台场景；随后回到品牌资产源与隔离安装/升级/卸载候选。没有提交、安装用户负载、修改用户 ACL/系统入口或发布。

## 已完成切片：SDK Provider 显式装配与最小组合数据默认值（2026-11-08）

- SDK server 的 `initialize` 只取得外围已装配的 LLM 服务、检查目标 Provider 并调用 `resolveCallConfig`，成功后才提交就绪状态。官方与自定义路由缺失均使用既有 `no adapter registered for provider "<id>"` 错误拒绝，不再按官方 ID 导入或补挂原生适配器；删除专属 fiber、shutdown 释放分支、旧查询 helper，以及原生适配器的生产 peer 和编译引用。开发依赖仅供显式测试 fixture 保留。普通 `sdk` 与独立 `sdk-minimal` 已自行装配原生 adapter；SDK 参数仍选择路由、模型、effort 和输出上限，不改由 profile 默认模型替换。没有引入新配置开关、协议字段或持久类型。
- `sdk-minimal` 的两项附加分享现在也默认 `disabled:true`，补上其不继承 base 的遗漏；保留扩展注册表、正常原生推理及显式 overlay 启用能力。新本机 HTTP 真实 SDK→dsh profile 测试 2/2：默认行禁用、服务未挂载、请求无 `dsh_session_log`/`dsh_plugin_packages`；显式启用后服务与两字段存在、包清单与 Session 内容真实且记录 accepted。两模式普通推理均 completed，自有扩展 probe 正常；每个实际 SDK 子进程安装既有网络 guard，0 外网尝试。静态组合 1/1、相关 type-aware lint 与资源清理通过，无新增依赖。
- SDK server 全部 unit 15 文件 272/272，缺官方/custom、缺 LLM 服务、已有其它 Provider、模型参数失败、同官方 ID replacement/custom owner 的真实使用和 shutdown 所有权均覆盖。新公开 SDK 缺 Provider 跨进程负例对 `sdk`/`sdk-minimal` 2/2：只 patch 禁用原生行，握手明确拒绝；清理后 audit 有真实非父进程 PID，0 blocked 请求。既有回放 JSON/cwd、独占 owner、错误终态、未绑定引用和 PID 六项边界 6/6；同步删除一条仍描述已移除 fallback 的过时注释，没有修改历史 JSONL。
- 最终完整串行 build 11/11（53.06 s），doc-sync 43/43（54.90 s），依赖策略 97 包通过；所改生产/测试定向 lint、source-artifact 与差异空白检查通过。锁文件与本轮开始备份 SHA256 完全相同，固定 pnpm 11.28.5 frozen lockfile-only 校验通过；沙箱离线供应链元数据缺失后，只用正常主机 registry 校验缓存，不更新版本、不运行安装脚本或放宽策略。SDK server 构建产物已不含原生适配器运行时 import。
- 最新产物之后，用发布态 SDK 的默认同版本 built CLI 分别启动 `sdk` 与 `sdk-minimal`，真实官方 `deepseek-flash` 两轮 2/2：回复逐字匹配各自 nonce，只有一个 completed 轮次、无工具调用/失败 attempt，普通输入与精确 Provider/model 记录在实际持久 Session 中，未记录分享 accepted；两个 SDK 都成功关闭。仅用压缩配置 patch 便于外部读取 JSONL，不改提供商装配。按 Temp 绝对父路径、专用前缀与无链接预检清理两个自建根，脱敏 Session 与结果保存在 QA，凭据未输出或写入仓库。
- 额外回归保留红项：built keyless-smoke 首轮 19/21，两个 read_image/offload 场景在任务与内容断言后、shutdown 退出时触发 `UV_HANDLE_CLOSING` 原生断言（3221226505）；相同产物只定向复跑一次 2/2 通过，没有修复或假称原整批全绿。只读代码路径确认这些 profile 原先就有 adapter，旧 fallback fiber 不会被创建，删除分支不改变该清理顺序；仍须原生调用栈进一步定位，尚不能归因于 Sharp 或 Koffi。三项历史 SDK 回放仍未过：command-attachments 多 Windows ACL skill-catalog，minimal-image-compaction 为 Bash/Pwsh header 差异，persistent-tools 的 POSIX Bash 调用返回 FileNotFound。均为显式 replay/custom owner、0 外网；已对照实际差异和源码归因，未做旧 revision A/B。三项目录与全部历史预期未改，未过滤、归一化或跳过失败来凑绿。
- 已支持 Windows sidecar 的 `session-title-after-turn` 完整回放 1/1（2.36 s tests），严格持久 Session、header、prompt 与后续 workspace 校验通过，实际独占官方 ID replay 与自定义标题 owner，无原生 fallback。它验证本轮路由所有权，不能代替上述三个未过的业务场景。README、现有数据默认值升级说明与新增 `sdk-provider-composition` 升级指南英中成对更新，模块图由生成器刷新。
- 证据在 `C:\agent制作\.dev-data\qa\2026-11-08-sdk-provider-ownership`，记忆第 42 节同步。没有提交、安装用户负载、修改用户 ACL/系统入口或发布。下一步先单独定位 Windows 图片任务退出竞态，使用最小原生复现与调用栈区分图像任务、FFI 清理和显式退出；不加 sleep 或忽略退出码。再分别补齐三类 Windows 快照的明确归属与平台输入，保持原历史字节，之后回到品牌资产与隔离发行候选。

## 已完成切片：真实 DeepSeek API 与作品闭环验收（2026-11-08）

- 本轮已安全读取项目专用凭据并实际请求官方服务；`GET https://api.deepseek.com/models` 返回 HTTP 200，模型为 `deepseek-flash` 与 `deepseek-v4-pro`。密钥未打印、未写入仓库或 QA。此前条目中的“真实 Edge”表示真实浏览器运行，其中模型回放场景不等同于真实 API 推理；本轮另行记录在线证据。
- 真实 Messages 定向验收 3/3：关闭思考的流式文本、JSON 持久化思考/工具历史与错误结果后续答、中途取消。现有测试请求旧别名 `deepseek-v4-flash`，官方实际接受。未运行显式 Files、Session 日志或包清单上传场景，也未更新历史录制。
- 真实 headless Agent/工具组合先完成临时文件外部读取核对，随后发现旧 oracle 只断言副作用和 stdout 非空，可能漏掉写完后模型失败。本轮只补强该测试，要求同 Session 的整轮结束均为 completed、最终助手文本非空并与 driver 结果一致；补强后真实重跑 1/1（5.43 s），原外部精确文件断言保留。该测试通过测试 driver 启动随附组合，尚不能称为公共 CLI 入口验收；也不逐条证明再次读取或摘要措辞。
- 新增独立 `artifact-live.e2e.ts`，显式 live 开关、record 模式与非空 key 控制实际模型调用，另要求指定证据目录；缺 key 的独立检查为 1 通过/1 跳过，没有启动 app/browser。使用真实 API-key adapter，拒绝 replay owner；固定随附默认模型 `deepseek-flash`，不会把无产品消费者的 `DEEPSEEK_MODEL` 环境变量冒称实际配置。Host include/Client exclude 同步，README 英中及 sidecar 明确入口与证据归属，不录制或改写任何历史 fixture。
- 真实 headless Edge 两轮闭环 2/2（含模式检查；主体 18.31 s）：模型创建同一粒子作品 r1，用户本地步进三次不增加模型请求/轮次；普通问题带 Host 重算的 step 3、time/x=0.3、原始源码身份，模型以 `baseRevision:1` 更新原对象到 r2、vx=2；新运行 step 1 的 Host 保存观察验证 time=0.1、x=0.2。两轮 completed，两个 scene 调用结果成功，无模型错误，六次真实 Messages POST 全部来自官方 origin 且 HTTP 200。源码/普通用户上下文、实际运行、持久 Session、截图和完整资源清理都已验证，summary 仅在正文、证据保存和清理全部成功时为 passed。首轮新测试漏传 flush 的 Session 对象，走到修订后运行才失败；已修正并保留失败证据，完整类型检查后重新真实运行通过，不能把首轮计 pass。
- 额外从现有 built `apps/cli/lib/bin.js --profile headless --json` 公共入口验证：新临时 home/profile/workspace 中真实模型读、写、再读文件，外部精确检查 `value=after\n`、相邻文件不变、cwd/Session 一致、最终文本有效、completed/exit 0。首个 QA 根下额外 pwsh 验证报 Win32 5；只读有效权限检查证实宿主缺 `WRITE_OWNER`，不能为 Low integrity label 执行准备。用同一公共入口在宿主 `%TEMP%` 新私有目录复核，真实原生 pwsh 输出 Length=12、LastByte=10、`NATIVE_PWSH_OK`，上述外部断言全部通过；按绝对路径、父目录和无链接预检后已删除这次自建 Temp 根。未修改原 QA、项目或用户目录的 ACL，不把文件工具成功冒称 shell 成功，也未禁用产品沙箱。
- 当前证据在 `C:\agent制作\.dev-data\qa\2026-11-08-live-deepseek`，成功浏览器子目录为 `artifact-live-5KgzWn`。45 个现有 QA 文件的完整密钥字面量审计 0 命中、0 跳过链接；密钥未显示或写入仓库。结果仅覆盖官方链，未测试自定义网关、真实 HTML 生成、自动标题或安装包 GUI；公共 headless 正常标题功能仍可能额外调用模型。没有安装用户负载、修改系统入口、提交或发布。
- 最新现有产物之后的完整 `build:check` 2/2（10.91 s）、完整 doc-sync 43/43（52.06 s）、两个所改测试的最终 type-aware lint、差异空白与 source-artifact 检查均通过。独立默认 4 GB 的临时 Host 检查先因 heap OOM 结束，最终使用项目原有 8 GB 检查策略，未改产品内存配置。没有重复重建未改的 runtime 产物，也不声称前轮七个旧测试的 19 条 lint 基线已修。下一步回到显式 Provider 装配：审查 SDK server 原生适配器自动补挂，防止回放/自定义组合失效后意外启用联网提供商；Windows 沙箱权限准备的结构化错误另列，不自动修 ACL。随后按既有计划统一品牌资产、清理已确认旧入口并构建隔离发行候选。

## 已完成切片：回放输入归属与标题因果同步（2026-11-08）

- 21 组仅作输入的 Web 回放、23 个 V4 JSONL 原字节迁至 `apps/web/tests/fixtures/replay/<scenario>/`，21 个 e2e 只修改路径常量；8 组/9 文件原先 tracked，13 组/14 文件原先 untracked。23 个 SHA256 与迁移前计划全部一致，版本文件名、两个分支组的父子关系、header 与模型脚本均保留。移动前核对词法/物理路径、无 reparse、目标不存在和原 hash，逐文件 LiteralPath 移动，只非递归移除已确认的空旧目录；没有录制、刷新、改写历史 JSONL 或补假 manifest。这是已审阅的 source-tree curation，不是 Session 格式迁移。独立审阅还确认 21 个 owner 逆替换路径后逐字等于原备份。
- Web scaffold 新增只读 `assertCorpusReplayFixtureOwner`，选定 parent/children 后、计算 `compareReplaySession` 和启动 runtime 前无条件校验：顶层 corpus 中的 canonical Session 文件须有匹配目录的真实 owner manifest，且 profile、composition、recording、header 完整，借用方不能私放 Session 文件。`compareReplaySession:false` 不能绕过；app 本地 input-only 无须伪造 metadata，e2e 仍可借有效 corpus owner。21 项独立临时 fixture 测试通过，没有在真实 corpus 创建测试目录。浏览器 README 英中明确 input-only 与完整持久化 oracle 的边界，Artifact 文档链接和措辞同步改成真实模型回放输入。
- `session-title-stability` 的测试组合挂载局部 latch：主流先同步 `next()` 推进原有标题调度，再等当前 human 输入对应的真实 title-request 与同 Session、provider、model、完整 messageSeqs 的已提交标题，才开始迭代主模型流。辅助流自由运行，早到标题不丢；旧/foreign/fallback/不完整水位不放行，aux error/abort、supersede、Session/fixture 释放均终结等待。必填 5,000 ms 仅用于缺提交的失败诊断，不释放成功流，不靠 pacing/sleep。四轮完整历史 oracle、header 与 prompt 逐项比较通过；未排序/过滤事件、修改历史日志、生产标题/LLM/Session 或既有网络保护。18 项局部测试覆盖异步 metadata、早提交、错身份、失败和资源释放。
- 验证：迁移的 21 个真实 headless Edge e2e 全部通过（148.22 s，总 tests 135.11 s），含两个父子分支、作品学习/观察/比较/普通追问/运行等待/导出路径。完整 corpus 3/3，原先被缺 manifest 阻断的 Windows variant 检查已真正执行；首轮 sandbox 扫描 Python 缓存 EPERM 后原样窄 host 复核通过，未忽略目录或改权限。最新既有产物之后的 `build:check` 2/2（45.83 s）、完整 doc-sync 43/43（52.68 s）通过；本轮无产品 runtime 源码改动，未重复重建相同产物。
- 23 份固定点、版本/role/script 读取检查通过；新 Web owner guard 21/21、latch unit 18/18 和真实四轮 SDK replay 1/1（2.51 s tests）通过，guard/latch 定向 lint 通过。测试支持包补齐 `dsh-session-title` 与 `dsh-session-title-llm` 两项 `workspace:*` devDependencies，pnpm 11.28.5 同步锁文件、97 包依赖策略通过；offline 缓存缺失后使用正常公开 registry 元数据解析，未放宽策略或更新工具。完整锁目录仍 1,728 项，与解析前备份无额外差异。独立 reviewer 核对迁移、latch、生产 owner/网络 guard 未变和所有结果。
- 迁移的 21 个旧 e2e 做整文件 named lint 时仍有 7 文件/19 条既有错误（FrameLocator.last 弃用、JSON.parse any 与 screenshot Buffer 泛型）。每条位于未改正文，beforeLine==afterLine；迁移时完整逆替换字节证明也已保存。没有把这批正文改写混进 path-only curation，不能声称这些文件全量 lint 已绿。详见 QA `RESULTS.txt` 与 `lint-baseline-lines.json`。
- 已同步 `C:\agent制作\MEMORY.md` 第 42 节。两项前轮欠账现已完成：Web 输入不再混入 Session corpus，标题跨流顺序由明确测试条件控制。下一步优先把 SDK initialize 的隐式真实 Provider 补挂收敛到明确装配与可用性准入，再统一品牌 owner/tile/small-mark 与生成器；旧 e2e lint 可独立小切片清理。随后按归属修本机旧入口、重建隔离 Windows 候选验收。证据与迁移前备份在 `C:\agent制作\.dev-data\qa\2026-11-08-fixture-ownership`。未启动桌面应用或安装器、修改系统注册/协议/权限、安装用户负载、提交或发布。

## 已完成切片：Windows 回放、SDK 运行层与离线隔离（2026-11-08）

- 主 header 的 schema/prompt 增加显式 `header.toolSchemasVariants: [win32]`、`header.systemPromptVariants: [win32]`，分别选择 `tool-schemas.win32.expected.json`、`system-prompt.win32.expected.md`。Headless/SDK/ACP 共用 manifest owner 解析，支持 profile 内与跨 profile 引用、既有 self-owner、循环/错误借用拒绝；缺少声明的文件不回退，record/refresh owner 写入同一变体。完整 header 与提示词逐字比较保留，child sidecar 不变。仅共享 `session/text-turn` owner 声明本轮 Windows 变体；schema 只用既有独立 Pwsh schema 替换 Bash，其余 23 个工具/changes 不变；prompt 仅替换既有 Pwsh 退出说明，原共享文件与历史 Session JSONL 未改。不能据此声称全部 Windows corpus 已支持。
- 文档站点越界 fixture 的真实目标是“图片 realpath 越出仓库”，不是获取文件符号链接权限。Windows 使用临时目录 junction 再访问其中普通图片，POSIX 保留文件 symlink；同一生产拒绝断言、真实 realpath 相等、外部文件不变与先 unlink 后清理均通过。生产发布判断与系统权限未改；Windows 文件 symlink 本身仍未在此 case 验证。
- 追加 SDK 验证暴露独立的运行层缺陷：客户端以前按 `lib/bin.js` 是否存在决定源码或产物。本轮去掉隐式切换：TypeScript SDK 源码固定启动同版本源码 CLI 与兼容 patch，发布 JavaScript SDK 固定启动同版本产物，缺失即拒绝；显式 `dshBin` 保留。同版本校验在两分支前统一执行，无新公共 raw argv、全局 env 开关或业务账本。SDK README 与 `sdk-launch-plane` 升级指南英中同步。
- SDK HTTP 认证失败的实际根因另经纯 parser 与短调用栈证实：旧 `hydrateReplayFixtures` 将 Windows cwd 裸插到 JSONL，反斜杠令输入无效，replay 插件加载失败后 SDK initialize 补挂真实适配器并触发模型目录 HTTP。本轮 `materializeSessionFixtureCwd` 在 JSON 字符串自己的编码层替换；完整内嵌 JSON 只改字符串 literal，保留空白、数字拼写、keys 与关系 token，不猜分片语义。SDK 在启动前实际 parse/derive，坏输入直接拒绝；SDKserver 的生产补挂策略未在本轮修改，另列架构审查。
- SDK replay/refresh 的 Node 子进程使用 test-owned 网络预载器，URL 与 socket 两层在发送前拒绝外部目的地、允许本机 fixture。非 record 模式不继承未知 Node 预载，强制保护字段在场景覆盖后应用；record 模式保留原行为。现有 dump-config 预检与实际 SDK 都走源码层，只输出所需路由事实，预检 PID 不能代替实际 SDK 的安装证明；异常 error 终态在等待辅助事件前失败。负例带原生边界 trap，测试自身即使回归也不拨外网。临时根在创建后立即登记关闭/清理，覆盖 bootstrap 解析失败；不清理其它历史 temp，也不把测试约束冒称产品防火墙。
- 两个 title 回放组合显式使用已有的确定性 fixture sandbox runner，与其历史 oracle 和共享 headless 组合对齐；只改两份 replay patch，不改通用 legacy context、生产 sandbox 或 skill，不删除额外事件来通过。这两条回放不承担 Windows 原生 ACL 验收。`session-title-after-turn` 的主回复、辅助标题、完整持久记录与 Windows header/prompt 均已通过，两个独立受保护 Node 进程、0 次外部请求尝试。另一个 `session-title-stability` 的标题内容/关系相同，但两条并行 LLM 的 title 与 assistant 事件先后不同；此旧 golden 的顺序欠账保留，未改历史日志、排序/过滤事件或增加 sleep。
- 验证：最终串行 build 11/11（57.23 s）→受保护 SDK after-turn 与六边界 7/7（2.44 s tests）→完整 doc-sync 43/43（52.40 s）。构建后的发布 SDK constructor/close 在禁 spawn 的 Node 下通过，没有启动子进程。SDK 客户端全 unit 10 文件 158/158（含 launch 16）；头部支持 211 通过/1 跳过，Headless 完整 fs-read/真实 Pwsh/读写拒绝回归 5/5，ACP cancel 1/1，物化 normalizer+网络约束 97/97；相关定向 lint、差异空白与构建后 source-artifact 检查通过。未重跑无关完整 GUI/模型 API。最初追加 SDK 与构建并行是无效的隔离安排，已改为串行；HTTP 失败不能只归因于旧 bin 或这次并行，真正的坏 JSON→replay 失效→native fallback 链已经单独验证并修复测试入口。
- 全语料 guard 仍 1 通过/2 失败：21 个 Web 目录缺 manifest，共 23 个 V4 JSONL（8 目录/9 文件 tracked，13 目录/14 文件 untracked）。逐 owner 审计确认它们全部 `compareReplaySession:false`，只作为模型回放输入，没有完整持久 Session oracle；不能草率补 `recording`、composition 或 header pin，亦不能改 gate 忽略。准确归属方案与 23 个 SHA256 在 `WEB_FIXTURE_OWNERSHIP_PLAN.txt`；新 variant corpus 检查因 collector 提前失败尚未执行，不能报整个 corpus 通过。
- 品牌只读复核已形成 `BRAND_SOURCE_PLAN.txt`：现有四份立体 PNG 完全相同；三份青绿 SVG 也相同，但与 PNG、侧栏路径不是同一几何。PWA/tray 仍依赖旧 Figma 分组与坐标。下一切片采用一个 owner、显式 tile/small-mark 角色与输出清单，保留已选 PNG，先做匹配的小轮廓与视觉验证，不给旧 SVG 补假 ID。现有 sharp/ICO 工具够用；重复源须随引用迁移删除，必要派生图保留；本轮未改任何图像或欢迎页。
- 已同步 `C:\agent制作\MEMORY.md` 第 42 节。下一步先按真实用途整理 Web input-only fixture 与 Session corpus 的归属，审阅原字节/世代/父子路径迁移；再给 title-stability 建立显式并发顺序控制，审查协议层 native provider 自动补挂，随后统一品牌资产和生成器。证据位于 `C:\agent制作\.dev-data\qa\2026-11-08-platform-fixtures`。没有运行新安装器、修改注册表/协议/系统权限、安装到用户环境、提交或发布。

## 已完成切片：默认数据出口、请求身份与构建防混用（2026-11-08）

- 随附 base 显式禁用 `session-log-deepseek`、`plugin-package-inventory-deepseek`、`session-telemetry-otel`；Web/Desktop 显式禁用产品埋点、其 exporter 和日志上传设置 UI。普通模型、搜索、自定义提供商和本地反馈保留，不把组合默认值冒称全局断网；通用插件实现保留，显式自定义 overlay 仍可启用并承担其策略。
- 默认 HTTP User-Agent 标识 Agentrans、manifest 版本与本项目 URL；DeepSeek 模型目录单独使用 `DEEPSEEK_CLIENT_COMPATIBILITY` 的稳定协议键及适配器版本，requirements/metadata/badge 不随产品改名丢失。Messages 移除三个 `x-deepseek-harness-*` 跟踪头，并删除仅为该头读取匿名用户文件的依赖；认证、Anthropic/Files/tool 协议和本地 request extension identity 保留。未修改 Session 类型或持久格式。
- Agentrans 安装包入口改为纯产品配置 helper + 薄 wrapper，文件名与嵌入 manifest 共用实际构建版本，输出 `agentrans-<version>-win-x64-unsigned.exe`。新增具名 unsigned Windows 无 policy 模式，删除占位测试域名；普通签名配置仍要求原策略。产品入口拒绝冲突目标与远程 release 设置，上游 builder/feed/upload/purge 拒绝 Agentrans appId，保持 publish never、无 feed、protocols 空。Windows 环境名大小写归一、冲突别名拒绝，签名变量按大小写无关规则剔除；保留工具和代理环境。正式 Agentrans 签名发布、更新交付与 macOS 仍待独立建设。
- 实际复现源码/产物混用：`session-snapshot/src/index.js` 优先于 TS 入口并加载旧 normalizer，导致 TS 单测通过而 profile 跑旧逻辑。核对 56 个 source-adjacent 编译残留的 Git 归属、相邻 TS/source map、旧 SHA256 和物理路径后，将它们可恢复地移出源码树，保留完整字节与清单；没有永久删除或触及用户数据。涉及 session-snapshot 36 项、loader-smoke 8 项、llm-replay 4 项、DeepSeek request extensions 8 项。两个有明确生成器所有者的 Scene JS/TS 资产对保留。
- 新增只读 `verify-source-artifact-boundaries`，所有 build scope 在生成/编译前执行，hygiene 和 CI 共用同一检查；复用 workspace 目录发现，不跟随链接，覆盖嵌套 `src/lib`。只允许两个明确的 Scene `.generated.js`，其声明/map 不豁免；发现冲突时列路径并拒绝，不执行旧 JS、不自动清理。Windows cwd normalizer 同时处理物理和嵌入 JSON 的路径拼写，保留 drive/UNC、原生/规范模式及非路径正文语义，未重录历史 fixture。
- 最终完整构建 11/11（53.47 s）。Provider 离线 33 文件 844/844；安装器配置 5 文件 101/101，真实 wrapper 仅 stub builder 接线通过，未执行 builder/hooks。真实 Loader/本机 HTTP/持久反馈 7/7（干净源码再过），显式 opt-in 5/5，normalizer 91/91。构建/workspace/边界综合 197/197，最后嵌套目录调整另经边界 9/9；所有相关 owned lint 通过。锁文件通过 pnpm 11.28.5 frozen 校验及 supply-chain 检查；最初 offline 缓存缺失后未放宽策略，正常公开包元数据校验通过。
- 真实 headless Edge 两条路径均通过：默认 Host 六项关闭的插件条目存在但无运行实例，Client 不含日志上传设置模块；原作品创建、修订、点击与确认回流保持正常，无浏览器异常。新增断言首轮误要求 IPC 保留 undefined 属性，已按实际序列化语义修正并定向通过；作品场景在干净源码复核中通过。未改产品行为来迁就测试。
- 文档完整首轮 40/43：本轮锚点配对和摘要超长已修并定向通过，1,190 组配对一致、436 包摘要符合预算，链接/升级指南/篇幅/换行通过；只剩已有 `scripts/project-doc-site.spec.ts:160` 的 Windows 文件 symlink EPERM，未改权限或跳过断言。随后补开发防混用说明并记录配对。另新定位 headless fs-read 的平台 fixture 限制：干净源码下模型文本、stderr、会话数量及持久记录已匹配，但 `verifyHeaders:977` 将固定 Linux Bash schema 与 Windows 正确的 Pwsh 比较而失败；其后 workspace 断言未执行，不能记为完整 snapshot 通过，未覆盖历史 golden。
- 已同步 `C:\agent制作\MEMORY.md` 第 42 节。证据、隔离文件和 SHA256 清单在 `C:\agent制作\.dev-data\qa\2026-11-08-product-defaults`。没有生成新安装器、安装到用户环境、修改注册表/协议/快捷方式、提交或发布。本轮不代表旧 11/6 负载已更新。
- 下一步先补 snapshot harness 的显式 Windows header/场景适配，再统一品牌资产所有者与生成器、修图标/欢迎页/无效登录入口和产品模型上下文；随后按已核实归属修机器旧入口，并重建独立 Windows 候选做安装/升级/卸载验收。保留上游合法来源、引擎接口与历史数据，不做全文机械替换。

## 已完成只读审计：DeepSeek Harness 上游残留（2026-11-08，整改前快照）

- 全文结论位于 `C:\agent制作\.dev-data\qa\2026-11-07-upstream-residue-audit\AUDIT.txt`，分组 19 项；另有 18 项品牌/资产引用链 JSON 与 OS 公开安装元数据 JSON。核对源码默认装配、发送器/开关、现有资产、纯生成器校验、PE/ASAR 版本及公开系统入口；本轮没有启动应用或安装器、联网请求、读取 dotenv/凭据/会话内容，也没有修改产品源码、图片或系统设置。
- 首要上游行为残留：base 默认挂载且开启 `session-log-deepseek`，通过 DeepSeek 专用 adapter 向当前 baseURL 附 `dsh_session_log`，含 cwd 与原始事件 data，默认每请求 8 MiB；默认 `dsh_plugin_packages` 另带活跃包/preset 名称和版本。`DSH_TELEMETRY_DISABLED` 只禁用反馈 OTel，General 的日志开关只控制 API 日志贡献，不是统一分享开关。反馈 OTel 默认 FEEDBACK_ONLY，评价/删除评价等才捕获历史前缀并送上游 collector，不能说普通活动默认持续上报。请求 User-Agent/部分关联头仍为上游身份。以上是默认配置及触达条件，不证明本机此前实际发送过数据。
- Desktop analytics row 和上游 collector 配置还在，但默认 consumer 严格依赖缺席的 deepseekAccount、Main 也回退 analyticsEnabled=false，不能宣称已启用发送。账号包、Feishu 联系表单等休眠代码保留，而原生 onboarding 仍显示不可用登录入口。正常 DeepSeek 推理/搜索/凭据门控模型发现是可保留 Provider 能力，与额外日志/反馈出口分开处理。
- 用户可见残留：NSIS 欢迎/进度/卸载图、首次欢迎 SVG、Windows tray、PWA 全套图标、明暗 favicon、空聊天 Hero 仍为鲸鱼/旧字标；iOS meta 标题仍 DSH。旧 PWA 生成器依赖已不存在的 filter0/filter1 tile group，托盘生成器依赖已不存在的 tray-glyph group，已通过纯校验复现失败。主 PNG、简化 SVG、侧栏及派生图各有不同来源，需要先统一资产所有者和生成规则。默认 system 主题、白色 PWA 背景、部分欢迎 Harness 文案仍未对齐先前需求。
- 产品模型上下文仍默认挂 `harness-dev-context`，描述 DeepSeek Harness 源码和 GUI；persona 仍为 coding agent。发行链保留上游 production 下载域名/命名、通用样例 appId、mac `.app` 后处理旧路径；专用 unsigned Agentrans wrapper 已覆盖 appId、protocols 和 metadata，不能把占位 test.example.com 或上游 feed 字符串当作当前活跃出口。更新排程缺 feed 时会本地拒绝，仍可能空转。文件名 0.1.0 的旧安装包实际 PE 版本为 0.2.2-alpha.2；CompanyName/Publisher 仍来自上游 author，需明确发行主体，不能靠删 LICENSE 处理。网站标题/编辑链接、贡献指南和部分可选 CI 仍是上游配置。
- 本机旧入口：User/当前 Process 的 DSH_BASE 指向 npx 内 0.1.5-rc.2，当前源码无消费者；dsh:// 仍指 style-test/app 的 Agentrans；Desktop/Start Menu 两个 Agentrans 快捷方式仍指不存在的根级 exe。源码已修不代表 11/6 的旧负载被替换。独立 DeepSeek Harness 0.2.1-rc.2 负载和有效快捷方式、用户 `.dsh` 数据另列保留；未检出其卸载登记，不能推断完整安装状态，也不能据此删除。上一轮点名两项测试 GUID/链接复核均不存在，不扩称整机无历史残留。
- 审计建议顺序：先明确 Agentrans 附加数据分享/身份策略，再收敛发行入口/版本/更新源，修品牌资产源与生成器并统一可见入口，然后有归属地修旧环境变量/协议/快捷方式，最后裁剪休眠包与维护工作流。包作用域、SDK/CLI/DSH_* 引擎接口、历史日志/fixtures、版权与字体授权不机械替换。之后再重建完整 Windows 候选做独立安装/GUI/CLI/Host/升级/卸载验收。本节是发现与建议，不表示已做这些整改；本次无生产改动，未重复构建/测试。记忆第 42 节已同步。

## 已完成切片：卸载归属保护与真实失败反馈

- `product-layout` 删除执行前捕获所选路径，重做完整词法与物理路径预检；安装根、祖先和选中目标有 junction/symlink、非目录祖先或读取失败时，在任何删除前拒绝。每个目标临删复核，内部链接只解除链接，不访问目标，缺失路径幂等。删除实现不再使用递归 `rm`；Node 按路径检查仍不能隔离其它进程并发替换，明确保留这一限制。
- 路径预检失败直接报告 `UninstallFilesystemError` 的 path/reason/cause；后续失败通过 `UninstallExecutionError` 保留 completed、failedOperation 和原始原因。CLI 输出这些结构化字段与安全重试说明，不报告假成功、不承诺回滚。scope parser 改为自有字段判断，拒绝 `constructor` 等原型名；测试消除本机硬编码路径，全量删除 fixture 先真正写入文件。
- 新发现并修复外部注册的环境混用：archive CLI 默认注册名与 NSIS GUID 不同，但同名快捷方式可指向现有其它安装；旧根的卸载器也可能删除新根共享的入口。共享 Windows backend 检查实际 InstallLocation、COM TargetPath/WorkingDirectory 和空参数，foreign/unreadable 任一项先拒绝，缺失 key 不授权删除 foreign shortcut。CLI 在删 app 前预检，backend 执行时复核；NSIS 同样先检查实际注册与入口。未猜改 CLI 默认 key 或给旧数据加迁移标记。真实 style-test 的注册路径、shortcut target 与 working directory 只读初末一致，报告已保存。
- 注册更新失败保留已有 owned 入口，不删除以前有效的注册；只有两项最初都缺失时才尝试归属受控的清理，并保留 rollbackError。签名安装在验签后、创建目录/替换 app 前预检，执行时复核；安装后归属变化的错误仍通过带 install 的 SignedReleaseInstallError 说明已发生的副作用。
- NSIS 捕获 native DWORD，失败 exit 2，停止后续注册/shortcut 清理并保留重试入口；通过既有报告 UI 提供部分影响、目标、Win32 错误和恢复说明，静默也保留独立 UTF-8 报告。真实重装复现旧延迟清理脚本删掉下一次安装的 root uninstaller，唯一临时脚本名无法阻止；现整段 cmd/ping/后台删除已移除，改为原生同步精确文件删除与父链 Pin。没有新增后台任务或清理账本。
- 生产 NSIS 的 appExe 改为实际 app 子目录，快捷方式和完成页启动使用同一入口；卸载归属检查兼容旧同根 root-exe 入口，同时拒绝跨根、不同工作目录与额外参数。metadata 检查不提供跨进程原子事务。原生测试曾故意锁缓存显示“卸载未完成”，测试驱动查错 TaskDialog 控件导致弹窗短时留在用户桌面；已自动清理唯一 fixture 进程，改为原生按钮 ID 自动确认，无需用户操作。
- 验证已完成：最终完整 build 11/11（43.59 s）；物理路径 20/20，注册/签名安装 17/17（含真实 Windows/COM 独立资源隔离），CLI 10/10（79.81 s，真实签名测试包安装/升级、junction、双根拒绝、文件锁 partial 与解锁重试），NSIS adapter/locale 定向 29/29。定向 type-aware lint、公开 JSDoc 与差异空白检查通过；doc quick 21/21，完整 doc-sync 42/43，仅既有 `project-doc-site.spec.ts:160` 的 Windows 文件 symlink `EPERM`。未修改权限或跳过此断言。
- 原生验收：最终八语种每种 13 个卸载场景，共 104/104。含普通交互、静默、升级/替换保留数据、DSH_HOME 位于内侧、缓存/app 文件占用、目标/祖先 junction 拒绝、旧安装注册已指向新根、foreign shortcut 与 working directory，以及解除故障后的明确重试。首轮自动按钮未生效的问题用 WM_COMMAND/原生 ID 修正，中文沿用原产物单独 13/13 补过，没有修改产品语言或放宽业务断言。报告最后一行布局调整另以最新英语产物 13/13、真实 UIA 展开文本/截图验证，目视可见 Win32 32、目标、partial effects、Copy/Hide details 和报告位置；关闭后 exit 2，解除锁后恢复卸载成功。
- 完成页启动最后用精确 Button 的短验收通过：安装到唯一空根、快捷方式 target 与实际 app 子目录 exe 相同、点击 Finish 产生真实 native payload 的 launch marker，结束 stub 后通过标准 bootstrap 卸载清理。正常安装器 16-case 旧驱动另一次卡在 Browse 原生选择器，root 按精确 fixture executable/PID 121120 结束，仅关闭本轮测试；该整组未完成，不计通过。之后没有再次跑 Browse，只补本轮必要启动步骤；第一次短启动匹配到“Finishing installation…”的进度文本，修为精确按钮后通过，原失败日志保留。所有本轮运行范围无残留测试进程/窗口，旧固定 TEMP 清理脚本也不存在。
- 本轮无 Session 类型/事件、Client UI 或包依赖修改，不重复无关全 GUI、SDK 与 lockfile；持久类型仍 68 roots/23 records。尚未重建、安装或发布完整 Agentrans 候选，旧 11/6 安装包不作为当前源码证据；104 个 native 场景和启动 marker 验证安装器/卸载器载体，不代表真实 Electron GUI/CLI/Host 的完整产品验收。
- 记忆第 42 节已同步。证据在 `C:\agent制作\.dev-data\qa\2026-11-07-uninstall-boundaries`；未提交或修改用户真实安装。下一步使用绑定最新完整负载的独立空验收根，走真实安装、GUI/CLI/Host 同根启动、升级、失败恢复与卸载，再处理品牌/主题等收尾。所有历史“下一步”以本文件顶部为准。

## 已完成切片：共用输入准入与作品操作的稳定重试

- 新增下层 `session-input` 服务，统一拥有原 `session/promptReceipts` 私有 Projection 和一份执行中预约。普通 Session Controller 删除自有收据实现，Artifact 新 `submitAction` 复用服务；两个真实消费者没有反向 API 依赖。Web 默认挂载，headless 源码创建与 legacy `record` 无需激活；新入口缺服务时明确拒绝。消费者仍拥有权限、源码校验、消息构造和自身操作结束前的资源。
- 普通 RPC 收据保持原身份优先的旧语义；已标识消息使用既有 `UserMessage.id` 与首次来源/内容 SHA-256。相同已接受重试先返回确认，源码升级或队列编辑、取消、消费不使身份失效，不重新入队或唤醒模型；不同内容冲突，继承前缀不占用子 Session 身份。未新增 Session 事件、来源字段或第二份收据日志。发送方式只作用一次，不属于持久指纹，不能声称重启后能检测 mode-only 冲突。legacy `record` 每次仍生成新 ID，不保证安全重试。
- 原生六种 Scene 的确认、已审阅 HTML 操作及当前分析比较共用 `action-submission` owner，异步前冻结完整请求与 trusted Client 生成的稳定身份。未知结果保留原请求供查看与原样重试，跨源码修订、状态和呈现变化不重新采集。HTML 有界提案队列仅移除成功匹配项，不吞掉后续操作；iframe 不能提供请求 ID。已保存比较继续使用原引用和既有收据。Dismiss 不撤回已接受输入；完整卡片卸载或刷新不恢复本地重试状态，应先重试或核对历史。
- 所有仅支持根 Agent 的保存、发送、比较与 Host HTML 文件导出入口，按真实 `Session.subagent` 统一显示及回调检查。根聊天与普通手动分支可用；三种 subagent continuation 隐藏对应入口，保留本地预览、滑杆、播放、历史观察浏览及纯本地函数图 WebM。源码能力、通道可用性与 Host 授权分别判断，没有放宽 Host owner/live root 校验。
- 私有缓存升级 v3，使用消息 ID 哈希选择的 256 个稀疏桶保留全部首次摘要；旧缓存从事件重建。真实释放测试覆盖 Projection 已注销后 retained handle 仍读取原及后续收据；不依赖 Cordis disposer 串行执行。5000 条混合事件单样本分桶约 294 ms，中间平铺实现约 2426 ms；采样峰值 heap 增量 11.9 MB 对比 69.3 MB、RSS 增量 12.9 MB 对比 100.2 MB，稳态 1.47 MB 对比 1.12 MB。原只记录 RPC 的实现约 102 ms/52.9 KB，完整内容恢复确有额外成本；不是零开销优化。
- 最终产物构建 9/9、聚合 `build:check` 2/2。首轮聚合发现三处新增测试夹具类型错误，已补合法 uplink/完整 Agent/精确 typed callback，未增加 unknown 断言。准入、API、Artifact、LiveShare 与 TS SDK 回归 74 文件、1495 通过、1 跳过，仅既有 `media-references.host.spec.ts:205` 的 Windows 文件 symlink `EPERM` 失败；完整 GUI 759 文件、12808 通过、2 跳过，仅既有 `present-open.host.spec.ts:140` 同类失败。Projection 底层另 58/58，Python SDK 6/6；所改源码、测试、locale 和生成脚本定向 type-aware lint 通过。
- 真实 Edge 四条路径最终均通过：新 native/HTML 稳定提交、新当前比较未知结果，以及旧 HTML interaction 和普通程序追问。新提交实际 Host 接受后丢响应，r1 原生请求跨 r2 用同 ID 重试；HTML A 重试只清 A，B 独立发送，5 个 HTTP 请求只形成 3 个 Artifact 输入/4 轮；比较原 A 重试后明确新发 B，3 个 HTTP 请求只形成 2 个输入/3 轮。刷新不增加输入或轮次。首次新测试将队列总数误写成额外项数，已修断言；旧程序追问首次点击未前进，临时观测后及移除观测的原样单跑均通过，保留失败日志，没有无依据扩大 timeout 或改生产。原请求展开截图已目视检查，当前 r2 与原 r1 请求及 Retry/Dismiss 同屏，fixture 固定点和 console 检查通过。
- 完整 `doc-sync` 42/43，唯一失败是既有 `project-doc-site.spec.ts:160` 的 Windows symlink 权限；未改权限或跳过断言。README、两个子系统、新决策 Note、新升级指南及关联指南英中同步，生成目录已刷新，持久类型仍 68 roots/23 records。quick 首轮 19/21，补模型条目示例与生成图配对后由完整检查覆盖通过。新包普通 Node ESM 两出口/3 断言通过，targeted publication-view publint 1 包无 error（1 条源码通配导出未发布的常规 warning），Client 规则 71 包与依赖 policy 既有覆盖范围 97 包通过。原外部 NodeNext 工具在首个 vendor 目录 symlink 的 Windows EPERM 处停止；仅 QA 副本将目录 link 改为 junction 后，同一外部类型检查 391 包通过，未修改生产工具。全库 `product-use` 仍有既有两条 launch-context 源映射和四个休眠账号包问题，单列后续，不假报全绿。
- 记忆第 42 节已同步。未提交、安装到用户环境或发布；证据在 `C:\agent制作\.dev-data\qa\2026-11-07-stable-artifact-actions`。下一切片先加固卸载 junction/symlink 物理路径归属与 NSIS 删除失败反馈，再用绑定当前候选负载的独立空验收根走安装、启动、升级和卸载。HTML inline/portal 稳定 DOM 与运行堆保留另列，不能将请求 owner 保留误当运行堆保留；原生统一桥接控制、观察删除/改名、自动保存和附件垃圾回收仍未实现。

## 已完成切片：交互主线验收与未确认比较的反馈收敛

- 新增一条贯穿多个能力的真实学习主线：自然问题创建粒子作品，操作至 step 6 保存 A；普通追问明确附上同一组完整源码/检查点/重算数值，模型更新同一作品到 r2；原实时选择明确失效并需移除；r2 step 3 保存 B，再恢复 A，导出仍固定 r1 与旧检查点。返回最新保留 r2 step 3；刷新后 A/B、原追问原文和旧导出字节不变，临时选择清除。全程两条普通用户输入、两轮和两次 scene 调用，本地操作不生成 Artifact 输入。
- 修复子 agent continuation 明确不支持问题上下文、作品却仍显示选择入口的断点。UI 读取已有 Session.subagent 通道描述，隐藏 HTML/粒子/保存观察/比较的追问选择并显示本地说明；根聊天与普通手动分支保留入口，不能按 parentId 误判。四类选择回调对不支持通道拒绝变更后返回，避免路由切换旧按钮的事件异常；已有选择仍显示说明与移除操作，捕获明确拒绝而不静默丢数据。使用真实 Session 绑定验证三种子 agent mode、切回根通道、旧选择保留及清除后的普通发送。
- 修复当前分析比较发送未确认后“重试”重新读取 B 状态的问题。一个 tagged pending 区分保存引用与当前报告；当前比较在发送前克隆并冻结双方事实，未确认时显示中性原请求与明确提示，阻止再次提交。状态、修订或自动切换保存模式均不替换这份原始提交。用户需先核对对话并明确放弃本地确认，之后发送的是重新采集的新比较；放弃不会撤回 Host 已接受的输入，新发仍可能重复此前已接受内容。保存比较保留原引用和既有安全重试，不假称旧 current-action 已有幂等身份。
- 最新产物构建 9/9，完整 build 的 Host 检查通过；Client 聚合首轮只因新增测试使用未品牌化字典键失败，修正测试后最新 build:check 2/2。末轮子 agent 入口/捕获等六文件 93/93，当前/保存比较 17/17；所改源码、locale 与测试 type-aware lint 通过，Client 目录已重新生成。没有新增包依赖、Remote、Session 类型、Projection 或运行账本，持久化仍 68 roots/23 records。
- 新真实 Edge 学习主线 1/1（11.68 s），未确认比较 1/1（12.14 s）。后者真实 Host 接受 A(1/10) 后丢 HTTP 响应；画面推进 B(2/11) 后原详情仍是 A，无 Retry、无第二请求；放弃本地确认不撤回 A，明确再次比较才发送 B。刷新后无额外请求或轮次，原事实保留。另四条保存比较、HTML 普通追问、有界等待和导出旧路径 4/4（73.33 s），共六条真实路径通过，console clean；新 fixture 为规范化固定点，测试不含本机 Windows 路径。
- 完整 GUI 首轮 757 文件，12,768 项通过、2 跳过、2 失败：一项因本轮启动测试漏给固定 pnpm 入口，补 npm_execpath 后许可证打包测试定向 1/1；另一项为既有 present-open.host.spec.ts:140 的 Windows symlink EPERM。该全量早于最后的“旧按钮不抛异常”微调，这项已由末轮 93 项覆盖；没有为抹去基线重复全量。完整 doc-sync 42/43，仅已有 project-doc-site.spec.ts:160 的同类权限失败；未改权限或跳过断言。README、子系统与两个已有升级指南英中同步，已查看真实截图，差异空白检查通过。
- 已更新记忆第 42 节。未提交、安装到用户环境或发布；证据位于 `C:\agent制作\.dev-data\qa\2026-11-07-interaction-journey`。下一步先统一其余仅支持根会话的作品保存/发送/比较/导出入口与实际通道能力，再设计旧 Artifact action 的稳定准入身份与未知结果处理，复用普通输入的既有语义，避免各卡片另建账本；之后推进发布前卸载物理路径和隔离安装/升级/卸载。HTML 布局切换仍会重挂 iframe，保持 DOM/堆的呈现调整另列，不在本轮夹带。

## 已完成切片：模型就绪等待与修复预算

- 在现有 `artifact-runtime` 增加只读 `wait`，保留即时 `inspect`；`artifact_runtime` 的 `waitMs` 缺省/零仍立即查询，正数只做一次有界等待，也覆盖源码已提交、预览尚未附加的窗口。沿用同一报告集合，由附加、报告、源码与生命周期变化触发，不增加轮询、心跳、Jobs、发送端点、Session 事件或 Projection。
- 默认单次最多 5,000 ms、每 Session 4 个/Host 32 个待完成等待，均由服务配置且超限明确拒绝，不静默缩短。结果区分 `reported`、仍有 starting 的 `timeout`、到期无报告的 `no-active-report`，以及此前见过实例后全部消失的 `disconnected`；返回全部独立运行，不用一个 ready 掩盖另一个 error，也不推断整体成功。源码更新先按过期修订拒绝；取消保留原始 reason，Session/服务结束明确拒绝，每条结束路径清理定时器、监听器和容量。
- 工具通过既有单调 `tools.guard` 在执行前同步预约次数，默认每 Agent 轮次共享 4 次查询、2 次修复尝试，独立配置且可设零。修复限制仅针对本轮成功的最终 `artifact_runtime` 结果已暴露错误的对象，覆盖 `artifact` 与 `scene` 更新，正常未读错误的编辑不受限。不解析用户追问正文，不自动改源码、重发命令或唤醒模型。源码换修订或后来 ready 不续订次数，新轮次才重置；取消、无效输入或后续拒绝不退还已预约次数。
- 预算属于工具实例，按 Agent 与已有 `openTurnStartSeq` 准备态 Projection 读取分隔，不扫描历史或复制消息账本。原生与嵌套工具调用都经过同一守卫；旧轮次迟到结果只持有旧预算，不污染新轮次。这是进程内循环控制，不是持久安全配额；工具重新加载或 Agent 重建会重置，轮次间的直接调用共享临时作用域，也不保证所有工具或模型总步骤数有上限。普通工具结果记录等待分类与剩余额度，模型所见继续可由日志重建。
- 验证：最终完整构建 11/11（81.58 s），聚合检查另行 2/2；Host 等待 36/36、工具 27/27，合计 63/63。覆盖首次附加、混合实例、超时/无报告/断开、源码优先、取消原 reason、释放与容量回收、父子隔离、并发预约、最终结果资格、跨修订/ready 不重置、正常编辑和守卫卸载。所改源码、测试与生成脚本定向 type-aware lint 通过。
- 新真实 Edge 场景 1/1（17.20 s），旧运行查询、HTML 普通追问和原生实验追问三路径 3/3。真实场景先确认等待尚未返回，再由用户点击 iframe 初始化触发错误，随后同一对象 r1 error→r2 error→r3 ready；第三次修复和第五次查询被拒绝且没有 r4。新用户轮次可更新到 r4 并报告 ready，旧无握手 HTML 保持 starting 并明确超时。刷新保留原始查询结果，无额外工具调用或轮次；两条普通用户输入之外的三个既有上下文分别为 runtime-context、skill-catalog、time-context，未新增 artifact-action。
- 文档快速检查 21/21。完整 doc-sync 首轮 41/43：事件图生成新鲜度已重新生成并定向通过，仅剩既有 `scripts/project-doc-site.spec.ts:160` 的 Windows 文件 symlink `EPERM`；未改权限或跳过断言。运行包、子系统、所有权 Note 与原升级指南英中配对更新，源码/配置/工具/持久化目录已刷新；无新依赖或持久类型，仍为 68 persistence roots/23 records。未重跑完整 GUI、SDK 或锁文件检查，本轮未改变这些数据或依赖入口；采用 Host/工具测试与真实浏览器回归。
- 记忆第 42 节已同步，未提交、安装到用户环境或发布。证据在 `C:\agent制作\.dev-data\qa\2026-11-07-runtime-wait-budget`，首轮浏览器仅因把既有系统上下文计入普通用户消息而失败，修正来源断言后通过；末轮只移除临时诊断并通过 lint。核心学习主线验收与两处反馈修复已由上方切片完成；下一步以本文件顶部和记忆第 42 节为准。

## 已完成切片：自由 HTML 的程序报告随普通问题发送

- 扩展已有 `artifact-followup` 与普通 prompt context，不新增发送端点、Session 事件、消息来源或运行账本。用户可明确选择 HTML 实例，在普通问题里附上最近收到的状态或当前错误。`ArtifactProgramQuestionCapture` 严格区分 ready/state 与 error/diagnostic；null、false、零和空字符串有效，缺失状态不是 null，错误不拼接旧状态。
- 选择只持有实例身份、展示分类和两个准备好的数据源引用，不复制运行 payload；发送入口同步克隆并冻结当前数据。换源码、同修订重挂、断线会锁定为失效，需要重选或移除。捕获完成后的画面变化、关闭预览和未知结果重试，都不替换原请求；选择、清除与播放不唤醒模型。
- Host 校验目标 Session、当前源码身份/修订与 HTML 格式，从准备态 Projection 读取完整源码；不查询实时运行注册表，也不要求 frame 继续在线。程序值明确标记 `program-reported`，不声称 Host 重算、可恢复堆或因果验证。旧粒子前缀逐字保留，新程序报告使用独立前缀、文本分类与中性折叠摘要，完整原文/复制/日志保留。完整源码与报告共用既有上下文总字节限制，超限明确拒绝，不截断。
- 将唯一有界 JSON 遍历下沉为 Artifact 纯 `/runtime-values`，父级 parser、iframe bridge 与 Host 准入共用，删除旧 UI helper。无损纯数据规则拒绝负零、稀疏数组、undefined、访问器、非有限数值与丢弃属性，不调用 getter 或悄悄归一化。初态通过后才宣布 ready，后续非法状态成为可见错误；维持深度 32、节点 2,048、完整诊断 1,024 UTF-8 字节。HTML 的源码 `questionContext` 支持明确为 `program-reported`，不升级其它 Host 计算能力。
- 清理复核实际复现并修复了逆序释放缺陷：运行 owner 先释放会触发选择回调重新定位关闭中的服务。选择 lease 现直接持有已准备的 node/runtime observable，刷新与捕获不再查服务，先清 lease 再撤订阅。正反释放、切换选择与清除的真实 owner 回归通过，未引入运行状态镜像。
- 验证：最终构建 11/11；新真实 Edge 场景 1/1，另八条旧浏览器路径 8/8。新场景覆盖选择计数 1→发送捕获 2→画面变 3/关闭，成功后丢 HTTP 响应、跨源码升级原身份重试不重复、错误无 state 随普通问题修复同一 Artifact、准入前源码升级拒绝且保留草稿，以及刷新保留历史/清除选择。
- Host 上下文 33/33；源码能力、共享校验与 Runtime 工具定向 47/47；最终全部 Artifact UI 31 文件 308/308（最后捕获/清理 23/23另行复核）。已发布 user-message 读取器与 TypeScript SDK 六例、纯入口规则 50 例合计 56/56，Python SDK 六例通过。最新真实 bundle 在独立 VM 验证序列化校验器自包含、非法状态不转成合法数据；新发布入口在普通 Node 无 DOM 可导入，publint 无错误，仅惯用 `./src/*` 提示。
- 文档完整检查 42/43，仅既有 Windows 文件 symlink `EPERM` 未过；未改系统权限或跳过断言。依赖策略 97 包、Client 规则 71 包、定向 lint、差异空白与 frozen lockfile 检查通过，仍为 405 workspaces、68 persistence roots/23 records。本轮未重跑完整 GUI，采用完整 Artifact UI 与真实浏览器回归。
- 已同步 `C:\agent制作\MEMORY.md` 第 42 节、运行所有权 Note 与升级指南；未提交、安装到用户环境或发布。证据位于 `C:\agent制作\.dev-data\qa\2026-11-07-program-question-context`。有界模型等待与修复预算已由上方切片完成；后续任务以本文件顶部和记忆第 42 节为准。

## 已完成切片：运行就绪、能力声明与模型修复查询

- 新增独立 `artifact-runtime` Host 服务和只读模型工具 `artifact_runtime`，接入 Web Host、三种带 Artifact 工具的 preset 与生成 Remote。工具查询精确当前修订的源码能力和活跃运行报告，通过普通 `tool/result` 记录模型所见快照；不新增 Session 事件、Projection、任务系统或动态提示词注入，也不自动唤醒模型。源码创建仍先提交，不能等待尚未公布作品的渲染器。
- 每个物理预览都有新运行身份。已有双工流持有实时报告，显式声明 Session 资源，不经 Agent lookup 激活冷会话；断开、源码替换、预览/服务释放即撤回报告。登记只是 Client 声明，不证明源码存在；模型查询另由主 Artifact 的准备态 `currentSnapshot` 读取真实当前源码，并过滤 Session、修订和渲染器。父级运行报告不会随源码继承给子 Session，无浏览器时不恢复历史 ready。
- 原生 Scene 取得实际 Canvas 上下文并完成绘制后才报告就绪；计算初始化、iframe load 和源码验证都不能代替它。粒子保留稳定错误码和有界诊断。HTML 使用注入的 `window.artifactRuntime.ready` 注册真实状态/命令回调；失败有有界报告。窗口、完整身份与大小校验拒绝旧实例消息，程序声明不能升级成 Host 可复算事实或权限。
- 共享 HTML 控制只显示双方就绪能力的交集，等待实际回调完成确认；失败、超时和部分执行明确可见，不自动重发。原生本地按钮不冒充消息桥接命令。删除比较组件第二套状态监听、按 HTML 格式盲发控制和无身份状态 parser；旧 HTML 仍可预览和使用内部控件/显式用户操作，但没有未声明的共享能力。
- SceneCatalog 统一声明观察、保存、恢复、固定比较、追问和 HTML 导出的源码支持条件；`/capabilities` 为纯入口，不代表插件已启用、用户有权限或结果已验证。修复 `constructor`、`__proto__`、`toString` 误命中目录原型的输入缺陷。没有修改 Scene 持久字段、Session 格式或既有保存/比较/导出事实，持久化仍为 68 roots/23 records。
- 验证：最终完整构建 11/11；真实 Edge 八场景 8/8，覆盖错误→模型读取→修复同一 Artifact→新运行就绪、同修订重建、刷新/关浏览器撤报告，以及旧无握手 HTML、显式操作、粒子、普通追问、保存观察、固定比较与导出。Host 20/20、源码能力/目录 19/19、Artifact UI 30 文件 268/268，最后生命周期 18/18另行复核；源码读取/打包纯度 100/100。依赖策略 97 包、Client 规则 71 包、LiveShare 47/47、发布入口与 405 workspace frozen lockfile 检查通过。
- 文档首轮 39/43：配对、公开 JSDoc 与升级指南格式三项修复后，定向复核全部通过，1,183 组配对一致，Client/Cordis inspect 目录新鲜度通过；剩余一项为既有 Windows 文件 symlink `EPERM`，未改系统权限或跳过断言。本轮未重跑完整 GUI，采用全部 Artifact UI、Host 定向与真实浏览器路径验证。所改新源码/测试定向 lint 通过；整份旧工具与 Scene 输入文件仍有既有 async 无 await、冗余断言/转换及对象转字符串的 lint 基线，未为消除告警改写旧输入语义。
- 已同步 `C:\agent制作\MEMORY.md` 第 42 节与运行所有权 Agent Note；尚未提交、安装到用户环境或发布。验收记录位于 `C:\agent制作\.dev-data\qa\2026-11-07-artifact-runtime`，早期定向记录另有同名前缀文件。自由 HTML 状态/错误随普通问题发送已由上方切片完成；后续任务以本文件顶部和记忆第 42 节为准。

## 已完成切片：普通问题绑定所选实验上下文

- 新增独立 function 插件 `artifact-followup`，注册到 Session Controller 的通用上下文入口。用户可明确选择当前粒子、已保存观察或条件兼容的固定比较，在普通输入框继续提问；问题、完整原始源码、检查点与 Host 重算值进入同一条普通用户消息。复用 `session/prompt`、权限、附件、队列和 steering，无新 Session 事件、消息来源或独立发送端点。
- 发送入口同步捕获并冻结选择；Host 准入时拒绝已过期的当前修订，保存引用则保持原修订并遵守分支可见范围。播放、选择、移除标签不产生模型输入，也不把屏幕可见等同于用户已观察。当前实时追问仅支持原生粒子，不能将自由 HTML 或其它 Scene 的局部状态冒充 Host 已验证事实。
- 已知拒绝保留草稿并给出八语种反馈。未知结果保留原请求身份、正文、附件、上下文与时区，明确重试原消息；重试不会采集后来变化的画面。相同身份的并发调用共用一次准入，冲突的处理中请求明确拒绝。未知重试成功后释放本地乐观回显，由 Host inbox/历史继续展示，避免窗口外的旧接受回执制造永久假排队；已进入持久消息的交接不会被提前撤下。重试状态限于当前 SessionBinding，刷新/关闭前需先重试或核对历史；释放回显或放弃本地重试都不会撤回 Host 已接受的输入。
- 将普通提示词的接受身份查询迁为 Host 私有 Projection，删除发送时的全历史扫描。接受身份从本 Session 自有 inbox 插入和用户消息恢复，父级继承收据不阻止子级发送；取消排队输入后仍保留接受身份，同身份重试只返回旧回执，不会重新排队。只缓存身份，不另建消息账本或 Client wire 数据；缓存成本随已接受身份数线性增长。
- 粒子运行收敛到每 SessionBinding 的唯一 owner，使用既有节点源码订阅和 keyedHook；删除生产组件内第二份运行 reducer。输入框展示明确的实验标签；源码升级或运行释放后重建不会悄悄使用旧绑定。聊天将完整实验块默认折叠为中性摘要，展开与复制保留原文；展示不充当来源认证或因果证明。
- 已补真实 Edge 普通输入框验收，覆盖发送时固定 step 6、画面随后到 step 7、成功提交后丢 HTTP 响应，以及准入前源码升级后保留草稿并明确拒绝；刷新后实验事实保留、临时选择消失。旧粒子、保存观察、固定导出和固定比较四条路径一同复核，五场景均通过。读取器和 TypeScript SDK 保持普通用户消息语义，Python SDK 四场景通过。
- 最终验证：完整构建 11/11，真实 Edge 五场景 5/5。新接受收据与队列/附件 Host 测试 55/55，既有投影与分支回归 36/36；最后的未知重试回显、附件释放和持久消息交接回归 96/96。领域追问与既有观察/导出 45/45，Artifact UI 225/225，末轮相邻文本折叠 16/16、Session/Toast 182/182 分别复核通过；已发布读取器/TypeScript SDK 两项与 Python SDK 四场景通过。
- 完整 GUI 750 文件、12,673 项通过，2 跳过，仅 1 项既有 Windows 文件 symlink `EPERM`；该全量运行早于最后的消息拼接、迟到接受与重试回显修复，这些改动已由上述定向测试和最终浏览器复核覆盖。最终完整 doc-sync 42 项通过，仅 1 项同类权限失败；最后 1,180 组文档配对一致。没有改系统权限或跳过断言。持久化仍为 68 roots/23 records，包依赖、Client 包规则、公开入口、frozen lockfile、定向 lint 与差异空白检查通过。
- 规划与实现约束已同步到 `C:\agent制作\MEMORY.md` 第 42 节。未提交、安装到用户环境或发布。验证记录位于 `C:\agent制作\.dev-data\qa\2026-11-07-artifact-question-context`。ready/error 握手、逐项能力声明与模型修复查询已由上方切片完成；后续任务以本文件顶部和记忆第 42 节为准，耗时视频/批量导出按需复用既有 Jobs。

## 已完成切片：固定来源的 HTML 导出与持久结果

- 新增独立 Web Host 插件 `artifact-export`。请求只携带当前身份/修订/检查点或已保存观察引用，Host 固定完整原始 Scene、创建导出的 Session、修订、运行检查点、导出器版本和输出条件。非粒子场景明确按源码默认条件导出，不冒称捕获局部滑块、选择或自由 HTML 的运行状态。
- 复用当前实例的附件存储与 `fileActions`，不新增导出目录、文件写入器或任务系统。固定输入先写 `artifact/export` 并 flush，完整文件提交后才写 ready 并 flush；失败保留原因，未确认的 pending 不代表仍有生产者或已经成功。相同请求找回旧回执或明确继续原输入，失败新尝试需要新身份，未知结果后的服务暂不可用不会丢失原请求。
- 独立卡片与比较单元共用导出入口与结果列表。刷新或源码从 A 改到 B 后仍能下载 A 的原始文件；生成就绪、Web 请求下载、Desktop 实际保存和下载取消分别报告。create/read 分别执行权限检查，不自动启动模型。默认每 Session 32 个身份、完整固定输入 262,144 字节、完整输出 2,097,152 字节；不自动淘汰或清理附件。
- 纯 `scene-renderers` 与 `scene-export` 下沉至 Artifact，共用计算与安全 HTML 生成，Host 干净构建不再反向依赖 UI。删除两个废弃 UI 生成脚本和四个已替代生成文件；旧 UI 内部路径保留薄转发，纯入口允许范围未放宽。修复合法 `constructor` 等身份的字典查询，Artifact Projection 缓存升至 3；必需导出事件保持 Session v4，旧读取器明确拒绝，新增持久类型同版本确认记录。
- 真实浏览器验收发现并修复 Gateway 的根级二进制编码错误：合法的 `null` 附件占位此前被 `?? value` 替换为原始字节。修复通用编码分派，无需修改 Artifact API 或包裹二进制结果；真实 Gateway 与 Connection 二进制回归 94 项通过。
- 验证：最终完整构建 11/11；Host 导出与观察 31 项、共享导出/渲染/构建等定向 150 项、UI 8 文件 104 项、读取器/TypeScript SDK/访问策略 50 项通过，Python SDK 3/3。真实 Edge 新导出、旧粒子运行与已保存观察三个场景 3/3，覆盖成功后丢响应重试、固定旧修订、刷新后字节完全相同、离线重放与不增加模型轮次，console 和 fixture 校验通过。
- 完整 GUI 首轮 746 文件、12,643 项通过，2 跳过，2 失败：旧粒子导出测试仍依赖浏览器本地生成，已改为验证固定请求与文件传输，并在上述 104 项中复核通过；另一项为既有 Windows 文件 symlink `EPERM`。完整 doc-sync 修复本轮文档问题后 42 项通过，仅剩既有同类 symlink 失败；末轮 README 的配对、模型体验与换行另行复核。未修改系统权限或跳过断言。包规则、发布入口、定向 lint、持久化 68 roots/23 records 和 frozen lockfile 检查通过。
- 已同步 `C:\agent制作\MEMORY.md` 第 42 节。尚未提交、安装到用户环境或发布。验证记录位于 `C:\agent制作\.dev-data\qa\2026-11-07-artifact-export`。当前轻量 HTML 不需要 Jobs；耗时视频/批量生产接入既有 Jobs 时复用这份固定输入和结果记录，并明确进程内任务状态不等于持久完成事实。普通追问绑定当前实验已由上方切片完成，能力 ready/error 握手仍是下一阶段的重要交互基础。

## 已完成切片：带证据的分支结论回流

- 新增独立 Web Host 插件 `artifact-branch`，不增加主 Artifact 服务的 GUI 依赖。用户可在一条子分支持久结论上选择已保存观察或固定比较，预览后明确回流；请求只含父子 Session、结论序号和证据引用，不信任浏览器提交的文本或坐标。
- Host 从同一个不可变子分支切面读取结论与观察，附上完整原始源码、检查点和重算数值。允许分支可见的继承基线，拒绝兄弟和分叉后父级新增事实。证据明确标为用户后选，不冒称助手原推理使用过它。
- 普通与带证据回流共用 `session-branch/admission`：持有父级 maintenance 后查已有内容、追加并 flush。同一结论的相同内容返回旧回执；纯结论与带证据互换、或更换证据都会明确冲突。只有未进入 maintenance 才是 busy；提交后存储或响应失败保留未知结果，冻结原请求重试可找回回执。
- 回流仅追加一条父级普通 `branch-result` 用户消息，不替换父级同名 Artifact，不修改子分支日志，不自动启动模型。没有新增 Session 事件或 source 字段；完整消息默认限制 16,384 UTF-8 字节。冲突、缺失、超限、服务未就绪和未知结果均有八语种反馈。
- 验证：完整构建 11/11；Host 重点测试 39/39；UI 重点测试 44/44（含旧无证据入口 9 项）；已发布读取器、双 TypeScript SDK 场景及访问策略共 52 项通过，Python SDK 两场景 2/2。真实 Edge 新证据回流、旧回流、固定比较三个场景全部通过，覆盖成功提交后丢响应、刷新重选去重、换证据冲突及父子同名对象隔离，console 与 fixture 检查通过。
- GUI 回归 746 文件、12,612 项通过，2 跳过；末轮移除旧 UI 跨 feature 运行时错误类导入后，旧入口 9 项复核通过，未放宽打包纯度规则。完整 doc-sync 42 项通过；两者仍各有 1 项既有 Windows 文件 symlink `EPERM`。包依赖、Client 包规则、定向 lint、发布包入口和 frozen lockfile 验证通过；`publint` 仅有仓库惯用 `./src/*` 未打包源码的提示。
- 当前规划与结果已同步至 `C:\agent制作\MEMORY.md` 第 42 节。尚未提交、安装到用户环境或发布。验证记录在 `C:\agent制作\.dev-data\qa\2026-11-07-branch-evidence`。下一切片为固定输入的导出请求、复用 Jobs 的执行与结果索引；自动合并聊天、原生共享控制、观察删除/改名和自动保存仍未实现。

## 已完成切片：固定双方观察的比较

- 比较使用已保存观察的身份和原始源码修订；两侧角色、比较组、运行版本、时间步长与步数必须匹配。共享纯 `observation-comparison` 入口提供规则和重算，Host 从持久事实生成结果，不接受客户端提交的比较数值。
- 复用现有 Session Projection 与 `artifact-action` 准入，不新增比较账本或 Session 事件。私有缓存版本升为 2，wire 仍只有已保存观察。选择和恢复是本地操作；明确发送才进入 Agent，同一有序组合按本 Session 自有准入收据去重，父分支收据不阻止子 Session 发送。
- 选择会只读显示原始源码，跨修订和源码类型变化保持固定证据；返回最新会清除对应侧选择。刷新后观察仍在，但需重新选择双方，不能将本地选择当作持久记录。
- 保留 HTML 与非粒子当前分析比较，并给实时报告绑定 Artifact 身份和修订；原生粒子改用固定观察。原生画面不显示无效的 iframe 共享播放按钮。新写端点仅所有者可用。
- 超大内容、引用缺失和不兼容组合明确拒绝并提供八语种说明；结果未知则保留原组合重试。观察输出统一将 `-0` 规范为 `0`，不改内部积分；真实 Host 的符号零源码原先即由 Session 边界拒绝，没有绕过其校验。
- 验证：最终完整构建 11/11；Host/计算/恢复重点测试 121/121；UI 重点测试 56/56；打包与访问策略 99/99；既有 TypeScript/Python SDK 投影各 1/1。真实 Edge 四场景 4/4，覆盖旧修订固定、步数不等拒绝、刷新重选、同组合重发去重和旧 HTML 路径，console 与 fixture 检查通过。新公开入口可在普通 Node 无 DOM 环境导入。
- GUI 回归 745 文件、12,583 项通过，2 跳过；末轮拒绝原因提示另经 21 项定向测试复核。完整 doc-sync 42 项通过。两者仍各有 1 项既有 Windows 文件 symlink `EPERM`；没有改系统权限或跳过断言。持久化历史校验、JSDoc、定向 lint 和差异空白检查通过。
- 当前计划与结果已同步至 `C:\agent制作\MEMORY.md` 第 42 节。尚未提交、安装到用户环境或发布。验证记录位于 `C:\agent制作\.dev-data\qa\2026-11-07-observation-comparisons`。带证据的分支回流已由上方切片完成；原生共享控制、观察删除/改名、自动保存与导出 Jobs 尚未实现。

## 已完成切片：保存观察与准确恢复

- 已实现粒子观察的持久保存、命名、恢复和显式发送；每条观察固定原始完整场景修订、运行版本、步数和 Host 重算的观察值。
- 复用 Session Projection；保存和恢复不产生 Agent 输入，明确发送才准入。保存重试使用同一身份；发送通过既有持久 Inbox/用户消息收据去重，不额外记录容易与投递脱节的成功标志。
- 新增必需事件 `artifact/observations`，每次携带单个 Artifact 的完整已保存列表。默认每个 Artifact 最多 32 条，满额明确拒绝；旧版本读取器不能静默丢弃这些事实。
- 保存失败通过 Remote 保留机器错误码：已满和旧修订明确拒绝，不引导无效重试；网络结果未知时保留原请求身份。提示覆盖八语种。删除手写 Remote 接口，直接使用生成契约；两个新写端点均归属 LiveShare `owner-only`。
- 真实浏览器已验证 A/B 保存、刷新和重开 Session、分别恢复、导出、源码升级后恢复旧修订与返回最新源码，以及单次明确发送；保存与恢复没有产生 Agent 输入。
- 验证：最终完整构建 11/11；重点 Host、SDK 与 UI 测试 137/137；LiveShare 分类与准入策略 52/52；Python SDK 投影测试 1/1；最终真实 Edge 回放 3/3。持久化声明与历史记录一致，公开 JSDoc、定向 lint、依赖规则和差异空白检查通过。
- 文档 quick 21/21；完整 doc-sync 42 项通过，仍有 1 项 Windows 文件 symlink `EPERM`。本轮 GUI 回归 744 文件、12,568 项通过，2 跳过，仍有 1 项同类权限失败；没有把这两项记作通过，也没有修改系统权限或跳过断言。
- 观察删除/改名和自动保存尚未实现；双方固定观察比较与带证据的分支回流已由上方切片完成。
- 当前计划与结果已同步至 `C:\agent制作\MEMORY.md` 第 42 节。代码尚未提交，未安装到用户环境或发布。验证记录在源码树外的 `C:\agent制作\.dev-data\qa\2026-11-07-observations`。

## 已完成切片：粒子运行与导出一致性

- 已将当前架构优化计划写入 `C:\agent制作\MEMORY.md` 第 42 节，历史“下一步”不再作为当前任务队列。
- 已完成第一切片：新增纯 `particle-runtime` 计算入口，卡片按修订持有运行状态；源码和布局切换保留当前实验，隐藏时暂停，新修订和卸载释放运行；HTML 导出从当前步数开始并复用同一计算。
- 保留原生预览既有的显式 Euler 积分语义，修正导出重复积分；不修改 Session durable 类型，不将瞬态参数自动送入模型。
- 保存观察已由上方切片实现；后续为检查点比较 → 带证据的分支回流 → 复用 Jobs 的导出与结果索引。产品装配裁剪与发布前卸载安全分别推进。
- 已删除预览与导出各自的粒子推进算法；绝对步数避免时间累计漂移，单步复用轨迹、seek 最多计算每粒子 121 个轨迹点，计算量不随经过步数增加。检查点仅含运行版本与步数，必须配合同一规格/修订；保存观察将两者一同持久化。
- 数值失败会保留最后有效状态并暂停，显示提示，支持 Reset；导出录制失败时不下载不完整视频，并释放轨道。
- 验证：完整构建 11/11；重点计算、导出、UI 和打包规则测试 105/105；真实 Edge 新原生粒子、旧 HTML 粒子和函数域回放 3/3；GUI 743 文件通过、12,558 项通过、2 跳过，仍有 1 项 Windows 文件 symlink `EPERM`。普通 Node 可导入构建后的计算入口，无 DOM 依赖。
- 文档 quick 检查 21/21、Client 包装载规则和定向 lint 通过。全局 UI i18n 检查仍发现既有 `ui-brand-official/Brand.tsx` 的 Agentrans 字面量，本轮新增提示已走八语种字典。
- 该切片未提交、安装或发布；原生比较共享控制及导出 Jobs 尚未实现。已明确保存的观察可刷新恢复，未保存的运行仍为瞬态。

## 本轮工作区状态：启动实例隔离与 Scene 修复（2026-11-06—07，未发布）

- 本轮修改尚未提交、打包或发布；下面的 0.1.0 Release 信息仍指此前发布物，不能当作已包含这些修复。
- 新增轻量 `product-layout/launch-context`：显式区分 development、verification、user，由 code/resources/instance 三个根一次派生 DSH、Electron、缓存、日志、崩溃转储、导出和更新日志等路径。源码产品入口、Desktop、打包 CLI、Host 和验收启动使用同一契约。
- 默认开发状态位于源码树外的 `<源码父目录>/.dev-data/agentrans/dev/<worktree标识>`；只允许 `AGENTRANS_DEV_ROOT` 显式覆盖。启动不再继承上游 `DSH_HOME`、`DSH_AGENTS_HOME` 或旧 Electron userData，普通启动不自动注册 `dsh` 协议。
- 开发与验收实例首次使用必须为空，并写入用途标识；拒绝未标识非空目录、用途不匹配、安装负载、状态与代码重叠、路径中的 symlink/junction 和非目录。验收上下文必须绑定当前负载。已有用户安装不增加迁移流程。
- Windows 打包 GUI/CLI 共用安装根。macOS 源码开发支持自定义根和 Finder 冷启动；macOS 普通用户包尚无单根布局适配，启动前明确拒绝，不能声称已支持。
- 独立 Scene HTML 导出转义脚本内 JSON，并使用 DOM 文本节点显示模型标签；恶意标签不会变成脚本或图片。
- 原生函数图和导出共用数值分析。`sqrt`、`log` 等定义域边界返回不可用值，界面显示 `—`、确认动作记录 `null`，曲线断开；缺失变量等编程错误仍抛出。采样不能证明两个采样点之间连续。
- Scene 表达式与渲染器生成纳入构建、类型检查和 dev-web watch，防止源码修复后导出仍使用旧 bundle。
- 已完成：完整构建 11/11；最终启动链重点测试分两组共 13 文件、266 通过、6 个 POSIX shell 用例在 Windows 跳过；两条真实 Edge Web 回放通过（原生确认分析、定义域边界和恶意标签导出）；依赖策略、导出 JSDoc、入口检查、8 组文档配对、文档预算及换行检查通过。
- GUI 全量回归初次 12,543 通过、2 跳过、3 失败。补足 pnpm 入口并修正既有 hover 条件后，两项相关文件重跑通过，合计已通过 12,545 项；剩余 `present-open.host.spec.ts` 的文件 symlink 创建因 Windows 权限 `EPERM` 未通过。不是全绿。
- 真实 Host 更新任务验收通过 12 个场景，证据在 `C:\agent制作\.dev-data\agentrans\verification\host-updates-Jgc6YT\result.json`；未执行安装器。两个旧更新 runner 已迁到源码树外的独立 verification 根，关闭遥测并与当前任务 API 对齐。Electron 更新 GUI runner 本轮只验证启动接线，未声称完整 GUI 更新流程通过。
- 本机测试安装残留上一轮已清理约 4.87 GiB、13 个测试卸载项和 26 个测试快捷方式，证据在 `C:\agent制作\.dev-data\cleanup-audit\install-residue-2026-11-06\result.json`。保留 style-test、workflow、用户数据、凭据和验收材料；本轮没有安装或修改真实上游 DSH。
- 另有 56 个本轮误生成在源码旁的 TypeScript 输出（约 547 KiB），原始 TS 未变。两次精确删除均被自动审批以 `blocked by policy` 拒绝，文件仍保留；清单与哈希在 `C:\agent制作\.dev-data\cleanup-audit\source-adjacent-build-output-20261106.json`，提交前须排除这些产物。

## 一、发布状态

- **产品版本**：0.1.0（工作区内部版本沿用 `0.2.2-alpha.2`，因为 release 工具要求所有 dsh 包同版本；产品版本体现在安装包文件名 `agentrans-0.1.0-win-x64.exe`）。
- **仓库**：`https://github.com/TLBtianhu/Agentrans`，分支 `feat/first-slice`，发布走 `main`。
- **Release**：`v0.1.0`，资产 `agentrans-0.1.0-win-x64.exe`（约 290 MB，sha256 `aee30dad2e3568df7b71fbdb1e4b8d1390e027f60ad29b73888bd62b94e67034`）。
- **安装包内容**：深色 Agentrans 图标、Agentrans 安装器/卸载器文案、Agentrans 菜单/欢迎/托盘/退出/更新文案、Agentrans 侧栏品牌、Agentrans PWA manifest 名称与 Web 标题、CLI 启动器指向 `Agentrans.exe`。

## 二、已完成的核心功能

1. **SceneSpec 六类原语**：`function-plot`、`flowchart`、`particle-system`、`timeline`、`network-graph`、`map`，每类都有确认动作和 `style` 字段（editorial / transit-map / blueprint / math-proof-lecture / particles）。
2. **呈现系统**：内联、并排、展开、浮窗；比较组；探究分支（forkAt）。
3. **导出中心**：独立 HTML 动画程序 + WebM 视频导出（canvas captureStream + MediaRecorder，无 ffmpeg）。
4. **共享渲染器 + 注册表**：预览与导出共用框架无关渲染器。
5. **默认入口规则**：交互解释默认走 Artifact，工作区只承接代码/项目/交付物。
6. **显示层规则**：纯文本和结构化格式化代码文本（SceneSpec / HTML / SVG），不用像素图片。

## 三、已完成的分发与品牌清理

- 单安装根（`app/`、`data/`、`models/`、`runtime-envs/`）；NSIS 安装/卸载；scope-aware 卸载；`assertOwnedPaths()` 防越界删除。
- 安装器 8 个语言包、桌面端 locale（菜单/欢迎/恢复/托盘/退出/更新）、CLI 描述、Web PWA manifest 名称、Web 文档标题、侧栏品牌、安装器 productName/artifactName、CLI 启动器 exe 名，全部改为 Agentrans。
- 图标：深色版作为应用图标（`apps/desktop/resources/icon.png` / `icon-windows.png` / `icon-macos.png`）；浅色版保留为 `icon-dark.png`（命名待整理）。
- 测试修复：欢迎页 fixture、`installer-packaging`、`cli-launcher`、`main-startup` 的 `app.setPath` mock、PowerShell 7 缺失时跳过。
- 当前测试状态：主启动 150/150、欢迎渲染 30/30、主题套件 173/174、typecheck 5/5。
- 已知的既有环境失败（非产品代码）：`upload-with-credentials`（需 `pwsh`，已跳过）、`windows-token-identity` 原生 CSP（需 `pwsh`，已跳过）、`macos-signature`、`windows-signature-batch`、`windows-update-publisher`、`hover-styles`（CSS hover 测试）、`dev-web` 重建测试。

## 四、待解决的问题（按优先级）

### 发布前：完成生命周期边界与状态正确性

- 卸载的 `assertOwnedPaths()` 目前只检查词法归属；中间目录 junction/symlink 的物理边界仍需单独加固。NSIS 删除失败的错误反馈也需补齐，不能由启动预检替代卸载安全。
- 比较组 revision 处理、参数同步和控件显示一致性需要修复；粒子系统预览与导出积分行为也需统一。
- 然后再处理下列品牌、默认主题、启动账号和无更新源轮询问题。重新打包前，使用独立空验收根走安装、启动、升级、卸载，并验证正式数据与上游产品未变化。

### P1：PWA 图标仍是旧鲸鱼（用户可见）
- `apps/web/public/` 的 `icon-192.png`、`icon-512.png`、`icon-maskable-512.png`、`apple-touch-icon.png` 仍从旧 `apps/desktop/resources/icon.svg`（鲸鱼）渲染。
- 需要：用深色 PNG 重新生成这四个图标；放宽 `apps/web/tests/pwa-manifest.e2e.ts` 中“图标必须与 SVG 渲染一致”的断言（图标源已改为 PNG）。

### P2：默认主题不是深色（用户要求过）
- `packages/client/ui-theme/src/theme-settings.ts` 的 `DEFAULT_PREFERENCE` 仍是 `system`（跟随系统）。
- 改 `dark` 会牵动约 10 个主题测试（`theme.client.spec.ts`、`apply.client.spec.ts`、`boot-theme.client.spec.ts`、`settings-store.client.spec.ts`、`config.host.spec.ts`、`appearance-row`）。
- 已尝试并回退，需一次性改默认值 + 同步测试。

### P3：更新排程空转（非用户可见）
- “检查更新”菜单项已移除，但 `DesktopUpdateSchedule` 仍每 10 分钟轮询；打包 `publish: 'never'` 没有 feed，检查失败并打 `console.error`。
- 建议关掉排程（`apps/desktop/src/main.ts` 中 `updateSchedule` 的创建/检查路径）。

### P4：欢迎页登录按钮是死路径（首启体验）
- 欢迎页有“登录”和“API key”两个入口；`deepseek-account` 不在产品 bundle，点登录会失败再提示改用 API key。
- 不阻塞；建议只保留 API key 入口（改 `packages/client` 的 WelcomePage 或桌面 welcome 渲染器，需同步欢迎测试）。

### P5：账号/额度设置页休眠
- `ui-settings-account`、`deepseek-account`、`deepseek-account-platform`、`llm-deepseek-account` 等不在产品 bundle，属休眠死代码。
- 彻底删除是较大范围清理，收益低（不用户可达）。

### 内部残留（不影响用户）
- `ui-brand-official` 的 JSDoc/package description（已改部分）。
- `code-file-icon-artwork.manifest.json` 的 `owner: "DeepSeek Harness product design"`。
- e2e 录制 fixture 里的上游文案（`apps/web/tests/fixtures/assembled-remote.fixture.json` 等）。
- `apps/desktop/package.json` 的 `author` 公司名（Hangzhou DeepSeek Artificial Intelligence Co., Ltd.）：fork 的法律归属，可能有意保留。
- 包名/目录名 `@deepseek-ai/dsh-*`、`deepseek-harness`：内部身份，改名成本高、收益低。

## 五、关键操作命令

```powershell
# 构建 + 类型检查
node <pnpm> run typecheck
node <pnpm> exec vitest run apps/desktop/tests packages/client/ui-theme ...

# 打包安装包
node <pnpm> --dir apps/desktop run prepare:package
node apps/desktop/scripts/package-agentrans-installer.mjs
# 输出：artifacts/agentrans-installer/agentrans-0.1.0-win-x64.exe

# 发布
git checkout main && git merge --ff-only feat/first-slice && git push origin main
gh release upload v0.1.0 <installer> --repo TLBtianhu/Agentrans --clobber
```

## 六、环境注意

- 本机没有 PowerShell 7（`pwsh`），只有 Windows PowerShell 5.1；依赖 `pwsh` 的测试已改为检测跳过。
- 真实 DSH 安装只读：`C:\Users\30680\AppData\Local\Programs\DeepSeek Harness`、`C:\Users\30680\.dsh`。
- Agentrans 专用路径：`C:\agent制作\deepseek-harness`、`C:\agent制作\.dev-data`（测试安装根 `agentrans-style-test`）。
- 包装/上传走代理 `HTTP(S)_PROXY=http://127.0.0.1:7897`。
- 真实模型 key 只在环境变量中使用，不写入仓库。
