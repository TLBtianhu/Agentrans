# Agentrans 当前进度与待办（2026-11-06）

本文件记录 0.1.0 发布时的实际状态、已完成工作和待解决问题，供后续继续推进时对照。

## 一、发布状态

- **产品版本**：0.1.0（工作区内部版本沿用 `0.2.2-alpha.2`，因为 release 工具要求所有 dsh 包同版本；产品版本体现在安装包文件名 `agentrans-0.1.0-win-x64.exe`）。
- **仓库**：`https://github.com/TLBtianhu/Agentrans`，分支 `feat/first-slice`，发布走 `main`。
- **Release**：`v0.1.0`，资产 `agentrans-0.1.0-win-x64.exe`（约 290 MB，sha256 `aee30dad2e3568df7b71fbdb1e4b8d1390e027f60ad29b73888bd62b94e67034`）。
- **主分支最新提交**：`2626ff31`（侧栏品牌替换为 Agentrans）。
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
