# Agentrans

[English](README.md) | 中文

Agent + Trans：一个通用编程 Agent 工作台，把解释转化为可执行 Artifact，并支持可审计的探究分支。Agentrans 是基于 DeepSeek Harness 的独立下游项目，不是 DeepSeek 官方产品。

## 当前垂直切片

- **可执行 Artifact**——自包含 HTML、完整快照、compare-and-set 修订号、不透明 origin 的沙箱 iframe，以及用户确认的语义操作。Agent 更新 Artifact 时不必把源码重复粘贴进对话。
- **Artifact 设计系统**——按需加载的 [artifact-design 技能](.agents/skills/artifact-design/SKILL.md) 提供设计 Token、精美的预测实验和参数探索模板、克制的动效原语，以及真实浏览器截图评审。
- **SceneHost 与比较**——内联、并排、聚焦和画中画保留 Artifact 状态与对话来源。独立的 control/variant 场景可以同步命令，并回流一条确认的比较结果。
- **原生 SceneSpec 生成**——`scene` 工具接受模型生成的 SceneSpec，通过版本化 SceneCatalog 校验，持久化 `format: 'scene'` 快照，并用安全表达式解析器原生渲染函数图。本地真实模型已通过这条路径生成新的阻尼振荡场景；回放 fixture 仍不需要密钥。
- **SceneSpec 原语**——[函数绘图](.agents/skills/artifact-design/references/function-plot.html)、[流程图](.agents/skills/artifact-design/references/flowchart.html)和[粒子系统](.agents/skills/artifact-design/references/particle-system.html)模板展示声明式函数、参数、描点、导数、积分、节点、边和确定性物理模拟。支持六类原语：`function-plot`、`flowchart`、`particle-system`、`timeline`、`network-graph` 和 `map`，每类都有确认动作和可选风格字段。
- **SceneSpec 风格**——可选的 `style` 字段为每类原语选择视觉风格（editorial、transit-map、blueprint、math-proof-lecture 或 particles），同一份声明式规格可以呈现为数学证明、地铁图、蓝图或粒子模拟。
- **导出中心**——导出操作会下载一个自包含 HTML 动画程序，内嵌解析器和共享渲染器；同一段重放也能通过画布流和 MediaRecorder 录成 WebM 视频，不需要 ffmpeg 或外部编码器。
- **共享渲染器与注册表**——对话预览和动画导出器对每类原语使用同一份框架无关的渲染实现，`scenePrimitives` 注册表通过一处注册点为预览和导出器解析渲染器。
- **默认入口与显示规则**——交互解释默认走 Artifact 系统（对话中的 SceneSpec 或 HTML 卡片），而不是工作区文件；只有用户明确要求独立 HTML 文件或程序时才写工作区文件。显示层是纯文本和结构化格式化代码文本（SceneSpec、HTML 或 SVG），不是照片或搜索到的图片；插图用结构化标记而不是像素。
- **确认的交互**——浏览器操作先保持待发送，只有用户发送后才成为普通用户输入；不授予文件、网络或批准权限。
- **探究分支**——从 assistant 结论开岔为独立 Session，再预览并确认可见结论回流到直接父级。不复制子对话全文或 reasoning，也不隐式启动父级模型轮次。

随仓库提供的重放场景通过真实 Web 组合和真实浏览器验证这些流程，而不只是测试孤立组件。

<a id="run-from-source"></a>
## 开发态与用户态分离

编译产物只是产生分发物的中间结果，不是用户数据根。开发运行使用独立数据根，绝不复用上游 DSH profile。不要把本源码目录安装或运行覆盖到已有 DSH 上。

源码的 `dsh`、`start:web` 和 `dev:web` 命令会在源码树外初始化独立的 worktree 开发实例。`AGENTRANS_DEV_ROOT` 可显式选择空目录或已有开发标识的根目录；继承的 Harness home 变量不决定产品状态路径。已有未标识数据会被拒绝，不做迁移。

```powershell
pnpm install
pnpm run build
pnpm dsh web --no-open --port 58910
```

便携版与安装版的程序路径和数据路径必须彼此分离，并与上游 DSH 分离。打包前必须完成的外部身份审计见 [DISTRIBUTION.md](DISTRIBUTION.md)。

<a id="run"></a>
## 模型配置

Agentrans 不提供 DeepSeek 账号登录或服务端账号绑定。用户自行配置提供商与凭据：端点 URL、协议格式、模型 id 和模型元数据。自定义提供商可使用 `openai-completions`、`openai-responses` 或 `anthropic-messages`；新增模型不需要更新上游源码。参见 [custom-provider.cordis.yml](apps/cli/config/examples/custom-provider.cordis.yml) 和[提供商指南](docs/user/guide/providers.zh.md)。凭据只保存在本地凭据存储或环境变量中，绝不写入仓库。

## 默认数据分享

Agentrans 随附组合关闭会话日志附加字段、插件清单附加字段、反馈触发的会话上传和桌面产品埋点。反馈与会话历史仍保存在本地。正常模型请求、搜索和用户配置的插件仍可使用网络。组合设置见[基础组合包](packages/bundle/base/README.zh.md#included-capabilities)与 [Web 组合包](packages/bundle/web-app/README.zh.md)；自定义 overlay 可以显式更改这些设置。

## 验证

```sh
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/artifact-interaction.e2e.ts apps/web/tests/branch-result.e2e.ts
```

浏览器场景重放已记录的模型流，不需要模型供应商凭证。需要使用本机已安装浏览器时设置 `DSH_PLAYWRIGHT_EXECUTABLE_PATH`。Artifact 场景覆盖创建/更新、计数器交互和仅确认后准入操作；分支场景覆盖开岔、预览、取消、确认回流，以及不隐式启动父级轮次。

## 上游与许可证

[UPSTREAM.md](UPSTREAM.md) 记录精确的上游 commit、归档哈希和源码同步角色。`upstream` 不是本产品的更新、账号、签名或遥测端点。

许可证为 [MIT](LICENSE)。第三方声明保留在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
