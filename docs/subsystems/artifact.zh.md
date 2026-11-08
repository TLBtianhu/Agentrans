# Artifact

[English](artifact.md) | 中文

Artifact 是带版本号、由代码生成的交互解释对象。持久真源是完整 HTML 或 SceneSpec；frame、截图、视频和下载文件都是投影或导出物。

## 协议值

`ArtifactSnapshot` 包含：

| 字段 | 含义 |
|---|---|
| `artifactId` | 所属 Session 内稳定的 branded id |
| `revision` | 正安全整数，从 1 开始，每次接受更新增加 1 |
| `format` | `html` 或 `scene` |
| `title` | 去首尾空白后 1–120 字符的显示标题 |
| `source` / `spec` | 由 `format` 选择的完整自包含 HTML 或已校验 SceneSpec |
| `presentation` | 语义呈现请求：`inline` 或 `focus` |
| `comparison` | 可选的 `{ group, role: 'control' | 'variant' }` 关系，用于独立比较场景 |

每条 `artifact/upsert` Session 事件都携带完整快照。同一 id 的后到事件取代旧修订。只加载最新 upsert 的尾页也能呈现当前 Artifact。

`SavedParticleObservationRef` 指定当前 Session 中的 Artifact 和已保存观察，也可引用继承的观察。`ParticleObservationComparison` 固定有序的 control/variant 双方，以及各自的引用、名称、源码修订和计算值。共同条件记录运行版本、时间步长、步数和经过时间；它不推断因果结论。

## 修改与操作语义

`artifact` 工具创建或更新快照。创建拒绝已存在 id；更新要求 `baseRevision` 等于当前修订号。只有最终工具结果成功才提交。失败、取消、过期修订和 post-execute 阻断都不提交。

`record` 只接受精确 live root Agent 和当前修订对应的操作。它校验操作名和完整 UTF-8 消息大小，再创建 `source.kind = 'artifact-action'` 的普通 `UserMessage`。唯一文本块装有有界 JSON，包含 `kind: 'artifact_action'`、id、修订号、操作和 payload。`wake` 选择 `agent.steer` 或 `agent.inject`。

`submitAction` 接受 `ArtifactActionRequest`，其中包含 Client 拥有的 `MessageId`、完整原操作字段与 `wake`。可选的[共用输入准入服务](../../packages/session/session-input/README.zh.md)冻结处理中请求，并按本 Session 自有消息身份对已接受输入去重。相同重试返回原确认，不唤醒 Agent；内容改变则冲突。服务在准入前检查精确 live root Agent 与所有者 principal。已接受请求在源码变化、队列取消和回放后仍可重试。旧 `record` 每次生成新身份，不保证安全重试。

Artifact 操作是用户意图，不是权限。它不能批准工具、读取文件、打开 socket 或绕过政策。payload 不是新的 LLM 内容块，也不是新的 Session 事件类型。本地消息绑定修订和运行身份，传递已声明的状态与经过确认的命令。这些消息不会唤醒 Agent；只有用户确认的 `comparison.completed` 操作包含两侧独立状态。

`confirmObservationComparison` 通过 Artifact Projection 解析两个已保存引用。已保存源码必须分别属于同组的不同 Artifact，具有 control 和 variant 角色，并使用相同的运行版本、时间步长和步数。不依赖 DOM 的 `observation-comparison` 入口为 Client 核对和 Host 准入提供这些规则，并重新计算双方观察。Host 接受引用，不接受调用方提交的数值。拒绝不会准入输入。

确认通过已保存 control 源码修订发送 `comparison.completed`，payload 为 `saved-particle-observation-comparison`，即使已有更新源码也保持该归属。`ArtifactObservationComparisonResult` 确认解析后的双方。本 Session 自有 Inbox 和用户消息收据对每个有序组合去重，与单条观察发送独立；继承收据不会阻止子 Session 准入。不新增比较事件或单独账本。新的普通实时操作要求当前修订；已接受的稳定请求重试先返回原确认，再考虑修订校验。

### 分支证据回流

可选的 `artifact-branch` Host 插件拥有 `artifactBranchResults.returnResult`。`ArtifactBranchResultRequest` 指定直接父级、子分支、子分支自有结论序号，以及 `ArtifactBranchEvidenceSelection`：单个观察引用，或比较组与有序 control/variant 引用。它声明两个 Session 资源，并从与结论相同的子分支切面解析全部证据。主 Artifact 服务不依赖这个 Web 桥接能力。

父级收到普通 `branch-result` 消息，包含可见结论和额外的用户选择证据文本。每条观察含完整原始源码、检查点和重算值；比较复用上方的纯兼容规则。源码副本不会更新父级 Artifact 命名空间。这些是用户后附的观察，不声称助手先前使用过哪些事实。共用的[分支准入](branch.zh.md#confirmed-result-return)防止同一结论以不同内容再次回流，并保留未知结果后的相同重试。

`artifact-branch/evidence-unavailable` 以 `ArtifactBranchEvidenceFailure` 报告观察缺失、投影不可用或比较条件不兼容。`artifact-branch/result-too-large` 报告配置的完整消息上限。两者都在新追加之前拒绝。既有 `branch-result` source 字段和 Session 事件类型不变；已发布读取器与 SDK 将证据保留为普通文本块。

## 运行就绪与支持的操作

源码接受与运行就绪是不同事实。纯 `capabilities` 入口从 SceneCatalog 读取源码支持的操作：粒子观察、保存、恢复、固定比较和可重算追问上下文使用带版本的粒子语义；HTML 追问上下文明示为 `program-reported`，Scene HTML 导出声明检查点或源码默认条件。这些声明不证明可选插件已挂载、调用者有权限或渲染器正在运行。`currentSnapshot` 从 Artifact 服务已准备的 Projection 读取独立当前源码，不打开历史。

`artifact-runtime` 服务为每个已连接的物理运行持有一份实时报告。双工 `attach` 流显式声明 Session 资源，不解析或激活 Agent。每份报告绑定源码身份、修订与新建的 `ArtifactRuntimeId`；当前查询只接受同一 Session 的精确当前源码及相符渲染器。流取消、断开、源码替换与释放都会撤回报告。历史不会恢复实时 ready；没有报告表示没有活跃报告，不表示执行成功。

原生预览只有在取得 Canvas 上下文且实际绘制完成后才报告 ready，计算初始化本身并不足够。HTML 在程序成功初始化后调用注入的 `window.artifactRuntime.ready`。可选状态和命令回调只声明该程序实际实现的桥接操作。iframe load 事件不能证明就绪。诊断有大小限制，父级接收方检查当前 frame 与完整运行身份。报告始终是 Client/程序声明，不能证明像素正确、观察可复算或因果结论成立。

共享 HTML 命令要求双方当前程序都报告 ready 且声明该命令。请求身份将每条命令与回调完成确认关联；缺失或失败的确认保持可见。超时回调可能已有副作用，Client 不自动重试。没有握手的旧 HTML 仍可预览并提供显式用户操作，但不会获得未声明的控制或状态能力。

只读模型工具 `artifact_runtime` 查询一个精确当前修订，也可在请求的上限内等待一次 ready/error 报告。普通 `tool/result` 记录所有匹配运行、等待结果与剩余轮次预算；没有报告、仍在启动的超时与断连保持区分，一个运行的 ready 不掩盖另一个的 error。等待由事件驱动，跟随调用方取消，在源码/Session/服务变化时结束，不启动代码或重复命令。工具策略限制查询次数，以及本轮已读到运行错误的 Artifact 源码更新尝试。临时计数在新轮次重置，不随新修订重置，不新增运行事件、Projection 或动态提示词输入。创建工具在成功结果后提交源码，不等待浏览器确认尚未公布的内容。参见[运行包](../../packages/artifact/artifact-runtime/README.zh.md)与[运行所有权决策](../../.agents/notes/implemented/architecture/2026-11-07-artifact-runtime-reports.zh.md)。

<a id="presentation-and-recovery"></a>
## 呈现与恢复

Client 按 `artifactId` 关联快照，跨修订保持 Conversation 身份。修订变化替换浏览上下文。iframe 使用不透明 origin 和严格内容政策；父页面只接受来自当前 frame、具有当前 id/修订号且有界 JSON 的消息。

SceneHost 支持 `inline`、`beside`、`focus` 和 `pip` 呈现方式。`ViewRequest` 只表达呈现意图，不授予窗口控制权限。Session 级呈现 store 管理并排页签，并允许各一个浮窗和聚焦表面。布局保留修订和待发送操作，但预览在消息流与脱离表面之间移动时会重新挂载。返回内联会定位原始行。卡片标明对话来源；分支使用节点的 anchor sequence。只有 live turn 可以请求初始聚焦。内联函数图缩放需要 Ctrl/Cmd+滚轮。SceneSpec 导出生成独立 HTML；其中的 WebM 按钮通过画布流和 MediaRecorder 录制播放过程。

比较组使用独立 Conversation Node，并排显示 control 和 variant。HTML 和非粒子当前分析比较使用绑定各自当前 Artifact 修订与已挂载运行的报告。共享命令只面向已就绪且双方均声明支持的 iframe 预览，在原生场景中隐藏。原生粒子比较选择已保存观察，并只读显示原始源码；实时源码变化不会替换已选观察。选择属于本地状态，刷新后需要重新选择；已保存观察和已准入操作保持持久化。已保存双方观察的重试保留引用，复用既有准入收据。当前分析确认与原生及 HTML 卡片共用稳定操作提交：异步工作前冻结原请求，跨源码/状态变化保留，并使用原身份重试。放弃只清除本地重试状态，不撤回已接受输入。

SceneCatalog 支持 `function-plot`、`flowchart`、`particle-system`、`timeline`、`network-graph` 和 `map` 原语：函数图使用共享安全表达式解析器原生渲染；流程图呈现节点、有向边和推进路径，确认动作为 `flow.inspected`；粒子系统进行固定步长模拟并显示速度向量，确认动作为 `physics.inspected`；时间轴配合事件详情，确认动作为 `timeline.inspected`；网络图使用确定性力导向布局，确认动作为 `network.inspected`；地图呈现标记与详情，确认动作为 `map.inspected`。六类都可导出独立 HTML 动画和同一播放过程的 WebM 录制。

函数图预览与导出共享有限采样、中心差分求导和从零开始的梯形积分。无定义采样会断开曲线；不可用读数显示为 `—`，并在确认分析中记为 `null`。导出标签是文本，内嵌 SceneSpec JSON 不能终止脚本元素。

原生粒子运行归属单个卡片修订。查看源码和切换布局会保留步数；隐藏预览会暂停，新修订或卡片卸载会释放该次运行。预览和 HTML 导出使用同一份显式 Euler 计算及有界轨迹。导出捕获当前步数并从该处重放。未保存的运行仍是瞬态。

独立粒子卡片可以保存有名称的观察。每条 `SavedParticleObservation` 包含 `ArtifactObservationId`、完整原始场景修订、带版本号的 `ParticleCheckpoint` 和 Host 计算值。`artifact/observations` 携带单个 Artifact 的完整保存列表；Session Projection 恢复它时不会触发模型或运行副作用。该列表不进入紧凑 Session 摘要。每个 Artifact 默认上限为 32 条；满额会拒绝新保存，不替换已有实验。

恢复会选择已保存源码和检查点的只读预览，即使最新源码已改变修订或格式。返回最新源码不会覆盖任一修订。保存和恢复不会创建 Agent 输入。明确发送时从持久观察读取数值，通过正常 Inbox 准入 `physics.inspected`；同一 Session 自有 Inbox 或用户消息收据会防止重试重复准入。父分支收据不会阻止子 Session 发送继承的观察。新的普通实时操作要求当前修订；已接受的稳定请求重试先返回原确认，再考虑修订校验。

持久恢复覆盖源码快照、已保存观察和已准入操作消息。iframe JavaScript 堆、未保存运行、Canvas 像素、滚动位置和源码查看状态仍为瞬态。已挂载卡片跨源码修订保留结果未知的已确认请求，但完整卸载或刷新不会恢复本地重试状态，离开前应重试或核对历史。Client 只在根通道（含普通手动分支）提供仅支持 Host 根 Agent 的保存、发送、比较和 HTML 导出；子 agent continuation 保留本地探索。通道可用性与源码能力、Host 授权分别判断。不认识必需观察事件的旧读取器会拒绝 Session；见[升级指南](../upgrade-guide/v0.2.2-alpha.2/saved-artifact-observations/guide.zh.md)。

## 验证

keyless [Artifact 交互场景](../../apps/web/tests/artifact-interaction.e2e.ts) 使用 [session.v4.jsonl](../../apps/web/tests/fixtures/replay/artifact-interaction/session.v4.jsonl) 中的模型回放输入驱动实际 Web 组合。它创建并更新一个交互计数器，展开已完成的过程组，在真实浏览器中点击计数器，然后确认待发送操作。测试检查修订号 1 和 2、确认前没有 Artifact 操作或第二轮，以及确认后出现一条父级本地 `artifact-action` 和第二轮。

[教学型 Artifact 场景](../../apps/web/tests/teaching-artifact.e2e.ts) 将同一路径用于预测实验。用户选择角度、预测命中、发射并比较实际结果，再确认语义操作。Agent 随后把 Artifact 更新为带预测反馈的 revision 2。这验证了观察、预测、操作和反馈，而不只是可视化。回放还挂载了用户声明的 `custom-provider` 模型路由，因此模型选择器显示 `Custom Lab Model`，而不是内置 DeepSeek 路由。

[旧比较场景](../../apps/web/tests/comparison-artifacts.e2e.ts)将 control 和 variant 参数探索器归入 `damping-study`。两个旧程序仍可本地交互，但未限定作用域的消息不能建立共享控制或状态能力；明确输入的普通问题仍是普通用户文本。[运行场景](../../apps/web/tests/artifact-runtime.e2e.ts)验证已声明共享命令、执行确认、模型读取失败、修复同一 Artifact、新预览身份，以及关闭浏览器后撤回报告。

[学习主线场景](../../apps/web/tests/artifact-learning-journey.e2e.ts) 在同一对话中串联操作、保存基线、带上下文的普通追问、修订替换、恢复和固定来源导出。[比较未确认场景](../../apps/web/tests/artifact-current-comparison-unknown.e2e.ts) 在 Host 接受后丢失响应，本地状态变化时保留原组合，并要求明确放弃本地确认后才能发送新比较。

[函数绘图场景](../../apps/web/tests/function-plot.e2e.ts) 验证 SceneSpec 驱动的数学场景：两个函数、参数扫掠、缩放、导数、积分，以及一条带数值容差的确认 `plot.inspected` 操作。

[函数域场景](../../apps/web/tests/scene-function-domain.e2e.ts) 重放平方根边界，确认可为空的导数，并打开下载的动画，检查模型标签仍是文本且定义域缺口不妨碍使用。

[流程图场景](../../apps/web/tests/flowchart.e2e.ts) 验证 SceneSpec 驱动的概念图：节点选择、路径推进、缩放，以及一条包含所选概念和当前步骤的确认 `flow.inspected` 操作。

[粒子系统场景](../../apps/web/tests/particle-system.e2e.ts) 验证确定性物理场景：两个粒子、固定 1/30 秒步长、重力、轨迹、速度向量，以及一条包含位置和速度的确认 `physics.inspected` 操作。

[原生粒子运行场景](../../apps/web/tests/scene-particle-runtime.e2e.ts) 验证源码和布局切换后的状态保留，导出当前六步检查点，并核对导出程序与明确确认的观察值一致。切换视图和导出不会发送 Agent 消息。

[保存观察场景](../../apps/web/tests/scene-saved-observations.e2e.ts) 保存两个有名称的检查点，刷新并重开 Session，恢复两者并导出已保存的检查点。源码修订变化后，它恢复原始源码并返回最新修订。保存和恢复不产生 Agent 输入；明确发送一条观察只准入一条操作。

[保存观察比较场景](../../apps/web/tests/saved-observation-comparison.e2e.ts) 核对固定的 control/variant 证据，拒绝不同步数，在双方源码推进后保留旧源码修订，并在刷新后重新选择已保存观察。明确确认比较只产生一条操作；再次刷新后重发同一组合不会产生重复输入。

## 固定来源的 HTML 导出

可选 Web Host 服务 `artifactExports` 在生成 HTML 文件前固定完整 Scene 源码。`ArtifactHtmlExportRequest` 包含稳定 `exportId`、`format: 'html'`，以及当前 Artifact 身份/修订/检查点或已保存观察引用。Host 解析源码并重算已保存粒子条件。后续源码更新不能改变已接受请求。非粒子导出按源码默认条件生成，不捕获未保存局部参数、选择、视口或 iframe 堆。

`artifact/export` 保存完整不可变请求与 `frozen` 输入，包括 `exporterVersion: 1` 和明确的 `parameters`，随后记录 `pending`、附内容寻址 `FileAttachmentRef` 的 `ready`，或附机器可读失败原因的 `failed`。`artifactExports` Projection 恢复这些记录；HTML 字节仍存于当前实例的附件存储。不认识此必需事件的旧读取器会拒绝恢复，避免丢失输出历史。

`create` 在渲染前 flush 固定请求，在追加就绪状态前保存完整文件，并在返回前 flush 结果。相同请求重试会返回已有回执或明确继续固定输入；同 id 的不同请求被拒绝。重启后没有确认结果的 pending 记录不代表仍有生产者或已经成功。读取失败不会抹去原先生成回执。文件读取只解析本 Session 的导出 id，完整校验存储对象后才返回字节。

独立卡片与比较单元均提供导出和可恢复结果列表。源码变化或刷新后，就绪记录仍能再次下载原始 HTML。生成与下载分别报告结果：Web 表示已请求下载，Desktop 表示文件实际保存或取消。导出不启动模型轮次。Host 视频、批量渲染、自动重试/续跑、删除与自动文件保留暂缓；昂贵生产者将复用 Jobs，不另造执行系统。

## 普通问题中的实验上下文

`artifact-followup` Web 插件在 Session Controller 注册 `artifact` 问题上下文提供者。`ArtifactPromptContextSelection` 可选择当前粒子检查点、保存观察、兼容的固定比较或明确选中的 HTML 运行。粒子值由 Host 自有源码与已记录条件重算。HTML 捕获包含目标 Session、源码身份、修订、运行身份与 `ArtifactProgramQuestionCapture`：ready 携带实际已收到的 JSON 状态，或 error 携带诊断。Host 读取完整当前 HTML 源码并检查目标 Session 与修订；程序数据始终是未经验证的 `program-reported` 上下文。

提供者将一个文本块与问题放入同一条普通 `user` 消息。`ArtifactQuestionContext` 保留完整源码与所选事实。粒子与程序报告使用不同说明前缀，后者不宣称 Host 重算、可重放性或因果结论。不新增 Session 事件、消息来源、运行账本或独立模型唤醒。识别的文本显示为可展开摘要，复制、历史、已发布读取器与模型输入保留完整原文；展示不授予验证或执行权限。`maxContextBytes` 与通用发送限制约束完整文本块数组，包括源码与报告，不静默截断。

可移除的输入框标签标明用户选择。粒子捕获读取唯一计算所有者。HTML 选择持有物理运行身份与已准备的节点/运行源，不把状态复制到选择中；同步提交在异步引用和附件工作前捕获最近收到的状态或当前错误。ready 但没有状态不等于空状态：null、false、零与空字符串都是合法值，缺失数据则不可用。换源码、重新挂载和断线会将实时选择锁定为失效，需要重选或移除。清除选择或按任意顺序释放两个所有者，都会释放订阅，不重新查找正在关闭的服务。

捕获完成后，不要求 frame 继续打开。Host 不查询实时运行注册表，也不替换为后来报告。当前源码变化会在准入前明确拒绝；已接受请求则先返回原确认。未知结果重试保留完整原请求，不受后来状态变化影响。保存引用保持原始证据。选择是瞬态，不从可见内容推断；历史问题文本刷新后仍在，但不会复活运行。其它 Scene 控件与子代理继续输入的上下文仍不支持。Client 根据实际子 agent 通道描述隐藏不支持的问题上下文选择，并说明仍可输入普通文字问题；手动分支继续使用根通道。选择与捕获回调在发送前执行同一限制。参见[程序上下文指南](../upgrade-guide/v0.2.2-alpha.2/program-question-context/guide.zh.md)与[浏览器场景](../../apps/web/tests/artifact-program-question.e2e.ts)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxartifactbranchresults--artifactbranchresults"></a>

### `ctx.artifactBranchResults` — `ArtifactBranchResults`

Artifact-owned API for manually attaching saved evidence to one branch conclusion.

```ts cordis-catalog
/**
 * Return one child-owned conclusion with evidence selected by the user, without starting a model turn.
 * @param request - Direct parent, branch conclusion and branch-visible saved references; no text or coordinates are accepted.
 * @returns Parent-local event and message ids after the durability checkpoint; identical retries reuse the receipt.
 * @throws {RemoteError} For invalid lineage, unavailable evidence, oversized content, a busy parent or different earlier content.
 * Other failures preserve an unknown outcome after append; retry the identical request to recover its receipt.
 */
@Remote({ resources: { session: (request: ArtifactBranchResultRequest) => [request.sessionId, request.branchSessionId] } }) async returnResult(request: ArtifactBranchResultRequest): Promise<SessionBranchResultValue>
```

Types: [SessionBranchResultValue](branch.zh.md)

Source: [`packages/artifact/artifact-branch/src/index.ts`](../../packages/artifact/artifact-branch/src/index.ts)

<a id="ctxartifactexports--artifactexports"></a>

### `ctx.artifactExports` — `ArtifactExports`

Owns fixed HTML export inputs, explicit continuation, and verified result reads.

```ts cordis-catalog
/**
 * Capture and generate one Scene HTML export without adding model input.
 * @param agent - Exact live root owning the result record.
 * @param input - Stable request identity and current-revision or saved-observation reference.
 * @returns The settled record after flush; generation failures return a durable failed record.
 * @throws {RemoteError} Before admission for invalid, conflicting, missing, stale, or over-limit requests.
 * Append or flush failures retain an unknown outcome; retry the identical request to recover or explicitly continue it.
 */
@Remote async create(agent: Agent, input: ArtifactHtmlExportRequest): Promise<ArtifactHtmlExportRecord>

/**
 * Read the exact stored file after the attachment provider verifies all bytes.
 * @param agent - Exact live root whose result records authorize the read.
 * @param exportId - Ready export identity, never an arbitrary file reference or path.
 * @returns Complete verified HTML bytes; a partial read never reaches the caller.
 * @throws {RemoteError} When the export is not ready or its stored bytes are missing or corrupt.
 */
@Remote async read(agent: Agent, exportId: ArtifactExportId): Promise<Uint8Array>
```

Types: [Agent](core.zh.md)

Source: [`packages/artifact/artifact-export/src/index.ts`](../../packages/artifact/artifact-export/src/index.ts)

<a id="ctxartifactruntime--artifactruntime"></a>

### `ctx.artifactRuntime` — `ArtifactRuntime`

Owns only currently attached report streams; inspection reads authoritative source identity separately.

```ts cordis-catalog
/**
 * Attach one stream-owned runtime report without opening a Session or activating an Agent.
 * Registration records a Client claim, not proof that the named source exists or rendered successfully.
 * @param sessionId - Session resource whose rendered source the Client names.
 * @param identity - Exact source revision and unique mounted runtime identity.
 * @param signal - Carrier generation; cancellation, disconnect and disposal remove its live report.
 * @returns Registration followed by a monotonic acknowledgement for each accepted replacement report.
 * @throws {RemoteError} Invalid, duplicate, over-budget or unavailable streams retain no rejected report.
 */
@Remote({ mode: 'stream', resources: { session: (sessionId: SessionId) => sessionId } }) async *attach(sessionId: SessionId, identity: ArtifactRuntimeIdentity, signal: AbortSignal): RemoteStream<RuntimeAck, RuntimeReport>

/**
 * Inspect one exact current source and its connected matching runtime reports without adding input.
 * @param agent - Agent whose own Session supplies the authoritative current source.
 * @param artifactId - Artifact to inspect in that Session.
 * @param revision - Exact current source revision expected by the caller.
 * @returns Detached source capabilities and active Client reports at this read; no report is a rendering proof.
 * @throws {RemoteError} For absent or changed source revisions.
 */
inspect(agent: Agent, artifactId: ArtifactId, revision: number): ArtifactRuntimeInspection

/**
 * Wait once for any matching current run to report ready or error, including a not-yet-attached view.
 * Reports remain independent Client assertions; this never executes code or wakes an Agent.
 * @param agent - Agent whose own Session supplies the authoritative current source.
 * @param artifactId - Artifact to inspect in that Session.
 * @param revision - Exact current source revision; replacement rejects instead of following the new source.
 * @param waitMs - Positive integer duration within the configured maximum; it is never silently shortened.
 * @param signal - Invocation cancellation; rejection preserves its reason and releases all wait resources.
 * @returns All matching reports at settlement; expiration with starting reports, no reports, and disconnect are distinct.
 * @throws {RemoteError} For unavailable source, invalid or over-capacity waits, and Session/service disposal.
 */
async wait( agent: Agent, artifactId: ArtifactId, revision: number, waitMs: number, signal: AbortSignal, ): Promise<ArtifactRuntimeWaitResult>
```

Types: [Agent](core.zh.md) · [RemoteStream](typert.zh.md) · [SessionId](core.zh.md)

Source: [`packages/artifact/artifact-runtime/src/index.ts`](../../packages/artifact/artifact-runtime/src/index.ts)

<a id="ctxartifacts--artifactservice"></a>

### `ctx.artifacts` — `ArtifactService`

`ctx.artifacts`: validated artifact snapshots and user-action routing.

```ts cordis-catalog
/**
 * Read one source revision visible in an already prepared Session.
 * @param agent - Agent whose Session defines the visible source prefix.
 * @param artifactId - Artifact identity within that Session.
 * @returns An independent snapshot, or undefined when the source is not visible; no activation or I/O occurs.
 */
currentSnapshot(agent: Agent, artifactId: ArtifactId): ArtifactSnapshot | undefined

/**
 * Read an original saved observation visible in one prepared Session.
 * @param agent - Agent whose Session owns the visible source prefix.
 * @param ref - Artifact and saved-observation identity in that Session.
 * @returns Independent saved source, checkpoint and recomputed particle values.
 * @throws {ArtifactError} When the saved observation is not visible.
 */
resolveSavedObservation(agent: Agent, ref: SavedParticleObservationRef): SavedParticleObservation

/**
 * Resolve a Scene selection to a complete original source and validated replay point.
 * @param agent - Agent whose prepared Session owns the source and saved observations.
 * @param selection - Current source revision or a previously saved observation reference.
 * @returns Independent complete source values; particle coordinates are recomputed.
 * @throws {ArtifactError} For missing, stale, or unsupported sources.
 * @throws {ParticleRuntimeError} For invalid replay conditions.
 */
resolveSceneSource(agent: Agent, selection: ArtifactExportSourceSelection): ArtifactExportSource

/**
 * Validate and normalize one complete create or update without committing it.
 * @param agent - Agent whose Session supplies the current artifact revision.
 * @param input - Complete new values and, for update, the observed base revision.
 * @returns The snapshot to commit after the enclosing operation succeeds.
 * @throws {ArtifactError} `ARTIFACT_EXISTS`, `ARTIFACT_NOT_FOUND`, `STALE_REVISION`,
 * `BAD_SOURCE`, or `BAD_INPUT`; no Session event is appended.
 */
prepare(agent: Agent, input: ArtifactPrepareInput): ArtifactSnapshot

/**
 * Append one validated complete snapshot and perform no other operation.
 * @param agent - Agent owning the Session log.
 * @param snapshot - Prepared complete artifact value.
 * @throws {ArtifactError} when the snapshot violates the same persistent validation as `prepare`.
 */
commit(agent: Agent, snapshot: ArtifactSnapshot): void

/**
 * Save a named particle observation without adding input or waking the Agent.
 * @param agent - Exact live root Agent owning the Session.
 * @param artifactId - Particle Artifact to inspect.
 * @param revision - Current source revision that produced the checkpoint.
 * @param observationId - Client-generated retry identity, stable until the request succeeds.
 * @param label - User label containing 1-80 characters after trimming.
 * @param checkpoint - Runtime version and step count; coordinates are recomputed by the Host.
 * @returns The immutable saved value; an identical retry returns the existing observation.
 * @throws {RemoteError} `artifact/stale-revision` or `artifact/observation-limit`; no observation is appended.
 * @throws {ArtifactError} For conflicting retry identities, unsupported sources, or invalid caller input.
 * @throws {ParticleRuntimeError} For an invalid checkpoint or non-finite derived state; no event is appended.
 */
@Remote saveObservation( agent: Agent, artifactId: ArtifactId, revision: number, observationId: ArtifactObservationId, label: string, checkpoint: ParticleCheckpoint, ): SavedParticleObservation

/**
 * Send an explicitly selected saved observation, including one from an older source revision.
 * @param agent - Exact live root Agent owning the saved observation.
 * @param artifactId - Artifact under which the observation was saved.
 * @param observationId - Durable observation identity; caller-supplied values are never used.
 * @param wake - Whether to steer the Agent or inject without waking.
 * @returns Inbox admission and the saved source revision; retries do not enqueue a second message.
 * @throws {ArtifactError} For an unknown observation, invalid caller or oversized action; no source revision is changed.
 */
@Remote sendObservation(agent: Agent, artifactId: ArtifactId, observationId: ArtifactObservationId, wake: boolean): ArtifactRecordResult

/**
 * Confirm one fixed control/variant observation pair as ordinary user input.
 * @param agent - Exact live root Agent whose Session resolves both saved references.
 * @param group - Comparison group on the saved source revisions, independent of current revisions.
 * @param controlRef - Saved control observation; Client coordinates are never accepted.
 * @param variantRef - Saved variant observation with equal runtime, time step and step count.
 * @param wake - Whether to steer the Agent or inject without waking.
 * @returns The recomputed comparison; the same ordered pair is admitted at most once per Session.
 * @throws {RemoteError} `artifact/comparison-rejected` for incompatible, missing or oversized observations; no input is added.
 * @throws {ArtifactError} For invalid references, group or caller. An admission failure may have committed input; retry the same pair.
 */
@Remote confirmObservationComparison( agent: Agent, group: string, controlRef: SavedParticleObservationRef, variantRef: SavedParticleObservationRef, wake: boolean, ): ArtifactObservationComparisonResult

/**
 * Encode one user-reviewed artifact intent as a single-text-block UserMessage.
 * The message is input, never an authorization to perform the named action.
 * @param agent - Exact live root Agent owning the artifact Session.
 * @param artifactId - Existing artifact identity.
 * @param revision - Current artifact revision reviewed by the user.
 * @param action - Trimmed 1-64 character action name matching `[A-Za-z][A-Za-z0-9._-]*`.
 * @param payload - Lossless JSON payload included in the bounded text message.
 * @param wake - `false` injects without waking; `true` steers the Agent.
 * @returns Acceptance and the revision carried by the message.
 * @throws {ArtifactError} for a non-root caller, unknown or stale artifact,
 * invalid action/payload, or an oversized complete message; no message is routed on validation failure.
 */
@Remote record( agent: Agent, artifactId: ArtifactId, revision: number, action: string, payload: JsonValue, wake: boolean, ): ArtifactRecordResult

/**
 * Admit one identified user action, or acknowledge the exact message accepted earlier in this Session.
 * @param agent - Exact live root Agent owning the action and receipt.
 * @param request - Original request identity, reviewed source, action, payload and first-admission delivery policy.
 * @returns Acceptance of that original message; retries do not dispatch or wake again.
 * @throws {RemoteError} A known refusal, conflicting identity, unavailable admission service, or unknown dispatch outcome.
 */
@Remote async submitAction(agent: Agent, request: ArtifactActionRequest): Promise<ArtifactRecordResult>
```

Types: [Agent](core.zh.md)

Source: [`packages/artifact/artifact/src/index.ts`](../../packages/artifact/artifact/src/index.ts)
<!-- END GENERATED cordis-surface -->

## 限制

- 只接受自包含 HTML，没有外部依赖加载器。
- 修订检查依赖所属 Agent 的操作顺序，不是分布式事务。
- 消息来源记录保留用户输入，不保存任意 iframe 运行态，也不证明视觉结果正确。
