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

`artifact` 工具创建或更新快照。创建拒绝已存在 id；更新要求 `baseRevision` 等于当前修订号。只有最终工具结果成功才提交。已准备的快照会占用该 Artifact 直到提交或被丢弃，因此重叠的更新以 `ARTIFACT_BUSY` 失败而不会覆盖日志；不再紧随已提交修订号的提交会被拒绝。失败、取消、过期修订和 post-execute 阻断都不提交。

被准入的操作会创建一条 `source.kind = 'artifact-action'` 的普通 `UserMessage`。唯一文本块装有有界 JSON，包含 `kind: 'artifact_action'`、id、修订号、操作和 payload，`wake` 选择 `agent.steer` 或 `agent.inject`。消息只是输入，绝不构成授权：校验覆盖操作名与完整 UTF-8 消息大小，且受理时修订号必须仍是当前值。

`submitAction` 接受 `ArtifactActionRequest`，其中包含 Client 拥有的 `MessageId`、完整原操作字段与 `wake`。可选的[共用输入准入服务](../../packages/session/session-input/README.zh.md)冻结处理中请求，并按本 Session 自有消息身份对已接受输入去重。相同重试返回原确认，不唤醒 Agent；内容改变则冲突。服务在准入前检查精确 live root Agent 与所有者 principal。已接受请求在源码变化、队列取消和回放后仍可重试。

Artifact 操作是用户意图，不是权限。它不能批准工具、读取文件、打开 socket 或绕过政策。payload 不是新的 LLM 内容块，也不是新的 Session 事件类型。本地消息绑定修订和运行身份，传递已声明的状态与经过确认的命令。这些消息不会唤醒 Agent；只有用户确认的 `comparison.completed` 操作包含两侧独立状态。

`confirmObservationComparison` 通过 Artifact Projection 解析两个已保存引用。已保存源码必须分别属于同组的不同 Artifact，具有 control 和 variant 角色，并使用相同的运行版本、时间步长和步数。不依赖 DOM 的 `observation-comparison` 入口为 Client 核对和 Host 准入提供这些规则，并重新计算双方观察。Host 接受引用，不接受调用方提交的数值。拒绝不会准入输入。

确认通过已保存 control 源码修订发送 `comparison.completed`，payload 为 `saved-particle-observation-comparison`，即使已有更新源码也保持该归属。`ArtifactObservationComparisonResult` 确认解析后的双方。本 Session 自有 Inbox 和用户消息收据对每个有序组合去重，与单条观察发送独立；继承收据不会阻止子 Session 准入。不新增比较事件或单独账本。新的普通实时操作要求当前修订；已接受的稳定请求重试先返回原确认，再考虑修订校验。

### 分支证据回流

可选的 `artifact-branch` Host 插件拥有 `artifactBranchResults.returnResult`。`ArtifactBranchResultRequest` 指定直接父级、子分支、子分支自有结论序号和 `ArtifactBranchEvidenceSelection`。可选择已保存观察引用、有序比较双方，或本分支较早的原生实验追问中的文本块引用。服务声明两个 Session 资源，并从与结论相同的子分支切面解析证据。

父级收到一条普通 `branch-result` 消息，包含可见结论和用户所选证据。证据携带原始源码、检查点或函数图设置，以及重算值。已保存比较复用上方的兼容规则。追问证据按追问时可见的源码校验。[Artifact Client](../../packages/client/ui-artifact/README.zh.md) 可独立于父级 Artifact 复现消息中的源码。共用的[分支准入](branch.zh.md#confirmed-result-return)保留相同请求的重试，并拒绝用不同证据再次回流同一结论。

`artifact-branch/evidence-unavailable` 以 `ArtifactBranchEvidenceFailure` 报告追问读数不可用、观察缺失、投影不可用或比较条件不兼容。`artifact-branch/result-too-large` 报告配置的完整消息上限。两者都在新追加之前拒绝。已发布读取器与 SDK 将证据保留为普通文本块。

`artifactBranchResults.continuePlot` 从回流的函数图读数创建手动分支。`ArtifactBranchContinuePlotRequest` 指定接收 Session、确切通知和重试 UUID。`ArtifactBranchContinuePlotValue` 标明子 Session 及其新 Artifact。子快照保留原始源码与记录中的函数、参数、描点和读数，供对照。

在接收会话的函数图、粒子实验、BFS 或半加器回流卡上点**下载实验 HTML**，即可保存独立的交互文件。已发送的函数图或粒子实验追问，以及从回流继续操作 BFS 或半加器的已发送追问，也可用同一入口下载随追问锁定的状态。打开或重置文件会恢复各自锁定的读数或状态。BFS 和半加器文件在隔离的框架中运行保存的程序修订。下载请求和权限见[证据回流服务](../../packages/artifact/artifact-branch/README.zh.md#use-this-package)。

在 CSV 回流证据上选择 **继续分析**，会调用 `artifactBranchResults.recalculateCsv`，在接收对话中预览另一种聚合方式。Host 用原分支追问校验已采纳的通知，再读取该图表可见的 CSV 引用。`artifactBranchResults.lockCsv` 在父会话的不可变 Artifact 中保存用户核对的分组。两项操作都不启动模型轮次。追问附件读取已保存的分组，并携带完整图表用于复现。

单列精确筛选在分组前匹配 CSV 原始单元格文本，区分大小写和空格。筛选生效后，**继续分析** 的两侧预览使用同一种聚合方式。**查看参与行** 会分页显示原始记录序号和相关单元格，表头是第 1 条记录。读取使用经验证的分支附件。确认时保存筛选条件、图表、分组数值和样本数，可在新追问中复现。

在原 CSV 回流卡或已发送的 CSV 继续分析追问上选择 **复现实验**，即可查看参与记录。Host 定位已采纳的分支读数或追问确认的修订，并按该读数保存的分组与计算条件分页读取获准访问的分支 CSV。展开参与行不会启动模型轮次。源文件不可用时，各自的复现仍会显示已保存的计算条件、数值和样本数，并提供重试入口。

在已发送的 CSV 继续分析追问上选择 **对照原回流**，即可查看同一分组的两份已保存读数，以及各自的聚合方式、筛选条件和样本数。Host 按两边保存的条件核对原始 CSV，并按原始记录号分页展示。每条记录标明保留、排除或新增。仅更改聚合方式时，参与记录保持一致。展开对照不会启动模型轮次。

## 运行就绪与支持的操作

源码接受与运行就绪是不同事实。纯 `capabilities` 入口从 SceneCatalog 读取源码支持的操作：粒子观察、保存、恢复、固定比较和可重算追问上下文使用带版本的粒子语义；HTML 追问上下文明示为 `program-reported`，Scene HTML 导出声明检查点或源码默认条件。这些声明不证明可选插件已挂载、调用者有权限或渲染器正在运行。`currentSnapshot` 从 Artifact 服务已准备的 Projection 读取独立当前源码，不打开历史。

`artifact-runtime` 服务为每个已连接的物理运行持有一份实时报告。双工 `attach` 流显式声明 Session 资源，不解析或激活 Agent。每份报告绑定源码身份、修订与新建的 `ArtifactRuntimeId`；当前查询只接受同一 Session 的精确当前源码及相符渲染器。流取消、断开、源码替换与释放都会撤回报告。历史不会恢复实时 ready；没有报告表示没有活跃报告，不表示执行成功。

原生预览只有在取得 Canvas 上下文且实际绘制完成后才报告 ready，计算初始化本身并不足够。HTML 在程序成功初始化后调用注入的 `window.artifactRuntime.ready`。可选状态和命令回调只声明该程序实际实现的桥接操作。iframe load 事件不能证明就绪。诊断有大小限制，父级接收方检查当前 frame 与完整运行身份。报告始终是 Client/程序声明，不能证明像素正确、观察可复算或因果结论成立。

原生绘制共用一份调色板契约。渲染器接收已解析的 `ScenePalette`，只按其中的角色取色：主文字、次级文字、强调、成功、底色、网格、四个序列色与一个高亮。预览从当前主题解析这些角色，导出物固定自带的两套调色板，而没有提供任何取值的表面会以 `ScenePaletteError` 失败，不会画成透明。`SCENE_STYLE_PALETTES` 说明每种风格跟随哪个所有者：`editorial` 由宿主所有，`transit-map`、`blueprint`、`math-proof-lecture` 与 `particles` 属于 `self-contained`，其固定调色板是显式选择而非意外退出主题。两种情况下卡片、控件与外框都仍由主题控制。

共享 HTML 命令要求双方当前程序都报告 ready 且声明该命令。请求身份将每条命令与回调完成确认关联；缺失或失败的确认保持可见。超时回调可能已有副作用，Client 不自动重试。没有握手的旧 HTML 仍可预览并提供显式用户操作，但不会获得未声明的控制或状态能力。

只读模型工具 `artifact_runtime` 查询一个精确当前修订，也可在请求的上限内等待一次 ready/error 报告。普通 `tool/result` 记录所有匹配运行、等待结果与剩余轮次预算；没有报告、仍在启动的超时与断连保持区分，一个运行的 ready 不掩盖另一个的 error。等待由事件驱动，跟随调用方取消，在源码/Session/服务变化时结束，不启动代码或重复命令。工具策略限制查询次数，以及本轮已读到运行错误的 Artifact 源码更新尝试。临时计数在新轮次重置，不随新修订重置，不新增运行事件、Projection 或动态提示词输入。创建工具在成功结果后提交源码，不等待浏览器确认尚未公布的内容。参见[运行包](../../packages/artifact/artifact-runtime/README.zh.md)与[运行所有权决策](../../.agents/notes/implemented/architecture/2026-11-07-artifact-runtime-reports.zh.md)。

<a id="presentation-and-recovery"></a>
## 呈现与恢复

Client 按 `artifactId` 关联快照，跨修订保持 Conversation 身份。修订变化替换浏览上下文。iframe 使用不透明 origin 和严格内容政策；父页面只接受来自当前 frame、具有当前 id/修订号且有界 JSON 的消息。

SceneHost 支持 `inline`、`beside`、`focus` 和 `pip` 呈现方式。`ViewRequest` 只表达呈现意图，不授予窗口控制权限。Session 级呈现 store 管理并排页签，并允许各一个浮窗和聚焦表面。布局保留修订和待发送操作，但预览在消息流与脱离表面之间移动时会重新挂载。返回内联会定位原始行。卡片标明对话来源；分支使用节点的 anchor sequence。只有 live turn 可以请求初始聚焦。内联函数图缩放需要 Ctrl/Cmd+滚轮。SceneSpec 导出生成独立 HTML；其中的 WebM 按钮通过画布流和 MediaRecorder 录制播放过程。

比较组使用独立 Conversation Node，并排显示 control 和 variant。HTML 和非粒子当前分析比较使用绑定各自当前 Artifact 修订与已挂载运行的报告。共享命令只面向已就绪且双方均声明支持的 iframe 预览，在原生场景中隐藏。原生粒子比较选择已保存观察，并只读显示原始源码；实时源码变化不会替换已选观察。选择属于本地状态，刷新后需要重新选择；已保存观察和已准入操作保持持久化。已保存双方观察的重试保留引用，复用既有准入收据。当前分析确认与原生及 HTML 卡片共用稳定操作提交：异步工作前冻结原请求，跨源码/状态变化保留，并使用原身份重试。放弃只清除本地重试状态，不撤回已接受输入。

SceneCatalog 支持 `function-plot`、`flowchart`、`particle-system`、`timeline`、`network-graph` 和 `map` 原语：函数图使用共享安全表达式解析器原生渲染；流程图呈现节点、有向边和推进路径，确认动作为 `flow.inspected`；粒子系统进行固定步长模拟并显示速度向量，确认动作为 `physics.inspected`；时间轴配合事件详情，确认动作为 `timeline.inspected`；网络图使用确定性力导向布局，确认动作为 `network.inspected`；地图呈现标记与详情，确认动作为 `map.inspected`。六类都可导出独立 HTML 动画和同一播放过程的 WebM 录制。

函数图预览与导出共享有限采样、中心差分求导和从零开始的梯形积分。无定义采样会断开曲线；不可用读数显示为 `—`，并在确认分析中记为 `null`。导出标签是文本，内嵌 SceneSpec JSON 不能终止脚本元素。

对于 `csv-bar-chart`，`attachment_csv` 接收会话附件 ID、分组列、可选数值列和聚合方式。Host 读取获准访问的 CSV，计算分组结果并写入完整的图表修订。确认追问时提供修订和分组键，Host 查出该组已经保存的数值和行数。回流证据恢复原先选中的分组。独立 HTML 保存指定修订的全部分组，用户可离线查看。

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

可选 Web Host 服务 `artifactExports` 在生成 HTML 文件前固定完整 Scene 源码。`ArtifactHtmlExportRequest` 包含稳定 `exportId`、`format: 'html'`，以及当前修订、历史修订或已保存观察的引用。Host 从会话中读取源码、重算粒子条件，并读取继续函数图实验时保存的基线。后续源码更新不能改变已接受的请求。其他 Scene 使用默认条件。

`artifact/export` 保存不可变请求、完整 `frozen` 输入和状态。状态为 `pending`、附内容寻址 `FileAttachmentRef` 的 `ready`，或附机器可读原因的 `failed`。导出器版本 1 使用源码默认值或粒子检查点。版本 2 使用明确的 `function-plot-baseline` 条件，打开和重置时恢复已保存的函数、参数和探针。`artifactExports` Projection 恢复这些记录，HTML 字节仍存于当前实例的附件存储。不认识此必需事件的旧读取器会拒绝恢复，避免丢失输出历史。

`create` 在渲染前 flush 固定请求，在追加就绪状态前保存完整文件，并在返回前 flush 结果。相同请求重试会返回已有回执或明确继续固定输入；同 id 的不同请求被拒绝。重启后没有确认结果的 pending 记录不代表仍有生产者或已经成功。读取失败不会抹去原先生成回执。文件读取只解析本 Session 的导出 id，完整校验存储对象后才返回字节。

独立卡片与比较单元均提供导出和可恢复结果列表。源码变化或刷新后，就绪记录仍能再次下载原始 HTML。生成与下载分别报告结果：Web 表示已请求下载，Desktop 表示文件实际保存或取消。导出不启动模型轮次。Host 视频、批量渲染、自动重试/续跑、删除与自动文件保留暂缓；昂贵生产者将复用 Jobs，不另造执行系统。

## 普通问题中的实验上下文

`artifact-followup` Web 插件在 Session Controller 注册 `artifact` 问题上下文提供者。`ArtifactPromptContextSelection` 可选择当前粒子检查点、当前函数图、保存观察、兼容的固定比较或明确选中的 HTML 运行。Host 从自有源码和检查点重算粒子值。对于函数图，Host 按当前源码修订校验所选函数和参数，在已核对的描点位置重算函数值、数值导数与积分。HTML 捕获包含目标 Session、源码身份、修订、运行身份与 `ArtifactProgramQuestionCapture`：ready 携带实际已收到的 JSON 状态，或 error 携带诊断。Host 读取完整当前 HTML 源码并检查目标 Session 与修订；程序数据始终是未经验证的 `program-reported` 上下文。

提供者将一个文本块与问题放入同一条普通 `user` 消息。`ArtifactQuestionContext` 保留完整源码与所选事实。粒子与程序报告使用不同说明前缀，后者不宣称 Host 重算、可重放性或因果结论。不新增 Session 事件、消息来源、运行账本或独立模型唤醒。识别的文本显示为可展开摘要，复制、历史、已发布读取器与模型输入保留完整原文；展示不授予验证或执行权限。`maxContextBytes` 与通用发送限制约束完整文本块数组，包括源码与报告，不静默截断。

选择回流的原生分支读数时，输入框捕获接收 Session id、通知序号和消息 id。提供者通过私有 Session 投影定位该通知，并从内嵌源码校验记录的条件和读数。追问附件保存通知和原分支追问的身份及完整读数，供复现。选择规则见 [Artifact 追问](../../packages/artifact/artifact-followup/README.zh.md)。

在 CSV 对照中选择 **核对并附到追问** 后，确认会锁定两侧读数、完整的行数统计和用户核对的记录页。Host 将确认页保存为该 Session 的私有草稿。页面刷新或 Host 重启后，浏览器恢复草稿文字，并加载同一份附件。打开另一份对照会保留当前选择。

发送前，Host 在同一 Session 中绑定私有草稿凭据和请求 ID。普通追问按这条绑定读取已确认的对照，并以文本附上。恢复时，Host 在已持久化的队列或消息中核对原请求和对照，确认后清除对应附件。浏览器清除匹配的草稿文字，并保留之后的编辑。请求未经确认时，草稿仍可使用，恢复过程不会发送。已发送的追问可从消息历史复现附带的记录页和行状态。

如果 Host 仍在接收原请求，恢复的草稿会显示 **正在等待宿主确认追问…**。此时发送按钮禁用，用户仍可编辑问题和查看已锁定的对照。输入框会提示上一条追问已发送，或宿主尚未收到。请求持久化后会移除已发送的对照，并保留等待期间的文字修改。如果没有查到已接收或正在处理的请求，发送按钮会重新可用，原草稿仍在。状态检查不会启动模型轮次。

原追问及其已确认的对照进入聊天历史后，输入框会提供 **查看已发送的追问**。点击会定位到原消息，展开已保存的对照，并把焦点移到展开按钮。在这份对照中点击 **返回草稿**，焦点会回到当前输入框，同时恢复光标或选区。追问还在队列中时，入口会等它进入聊天历史后出现。

已发送的对照可以再次核对，并附到同一 Session 的下一条追问。Host 按事件序号和消息 ID 定位原消息，以该草稿绑定发送请求时记录的私有摘要验证对照，再为当前草稿签发同一页的附件凭据，并记录这次直接选中的来源消息。刷新后，草稿和已发送对照中的 **查看这次复用的来源追问** 都可以打开对应消息。再次复用会记录这一次选中的来源，保留最初的计算和参与行。核对、附加和打开来源都不会读取原 CSV 或调用模型。缺少验真记录的旧对照仍可从历史复现。

便携 CSV 对照使用 `agentrans-csv-comparison` 版本 1 JSON 格式，包含已核对的一页。导入请求提交目标 Session ID 和解码后的 JSON。Host 校验页面，标为 **用户导入** 并返回供核对。确认后沿用对照草稿准入和复现流程。读数与记录状态来自文件，独立于原 CSV 和原 Session。

CSV 分步解释引用同一次原回流下的两条已验真追问。Host 从同一 Session 的历史定位两页，核对记录的基线，并按页面呈现的变化排序。第一份提供聚合步骤的无筛选总和，第二份提供筛选后的总和及已核对的记录状态。确认的草稿和已发送追问都保存确切的两页，复现卡可以打开两条来源追问。

导出已发送的两步解释时，Host 用已保存的证据生成一个离线 HTML。文件按计算顺序展示两步，读者可分别展开两张原始页，核对保存的参与行和状态。

`agentrans-csv-comparison-explanation` 版本 1 JSON 可将这两页带入另一个 Session。文件保存聚合页与筛选页的读数和参与行。导入时，Host 校验文件结构和两页的组合关系，标为 **用户导入**，返回完整的两页供用户核对。新对话的预览和已发送追问都能从导入的快照分别打开两页。

**复用整份解释** 可以一起核对已发送的 **用户导入** 卡片中的两页。Host 核验确切的历史追问，再为同一对页面与导入标记签发新的草稿凭据。确认、草稿恢复与历史复现均使用已保存的两页，只有手动发送才调用模型。

从历史复用导入解释时，会保存这次直接选中追问的事件序号和消息 ID。从草稿或已发送追问点击 **查看这次复用的来源追问** 会打开这张确切的导入卡，两份原始页仍可分别展开。导航和刷新使用已保存的历史，无须启动 Agent 或访问 CSV 数据。

复用导入解释的完整来源链会按同样的引用核验每一层。返回路径保存沿途打开的导入卡，刷新后仍能回到确切的草稿或已发送对照。

在当前来源对照继续查看它的来源时，**来源路径** 会增加一层，显示出发位置和沿途追问。点较早的追问会重新展开它保存的对照，路径随之缩短到那一层。点 **草稿** 会直接回到输入框。**返回对照** 仍可逐层返回。两种回草稿的方式都会在草稿和附件仍相同时恢复光标。在同一个标签页刷新会重新展开当前来源并恢复剩余路径。标签页只记录导航位置，草稿路径还会记录附件凭据和校验光标所用的草稿摘要。回到出发位置或收起当前来源对照会清除路径。

复用的草稿附件和展开的已发送对照都提供 **查看完整来源链**，按顺序列出从直接来源到最早对照的已保存追问。查看列表时保留草稿和当前对话位置。选择一条追问会直接打开它保存的对照，途经的追问会加入返回路径。在当前来源上打开列表并选中追问，会接续已有路径。无论从草稿还是已发送追问出发，刷新后都能找回路径。历史暂时读不到时，可以在列表里重试。来源引用失效时，列表会标明断在哪一层，直接来源算第 1 层。两种情况下都能打开已核对的追问。

刷新时若无法恢复整条返回路径，聊天会打开最后一条可核对的对照，返回草稿或已发送追问的路径仍可用。点 **重试** 会重新核对原来保存的路径，历史可读后会回到原位置。重试期间返回草稿或选择另一条来源时，以用户的新操作为准。切换会话会结束这次重试，即使侧栏仍开着旧会话，或者用户在响应到达前切回。迟到的响应到达后，当前对照和返回路径保持原样，刷新会恢复当前会话保存的路径。引用失效时，最后一条已核对的对照会标明断开的层级。若没有任何可核对的对照，提示会出现在输入框旁。收起对照会结束这次恢复。

可移除的输入框标签标明用户选择。核对当前粒子实验时，从唯一计算所有者固定检查点和读数。确认后附上该检查点，后续播放会保留它。HTML 选择持有物理运行身份与已准备的节点/运行源，不把状态复制到选择中；同步提交在异步引用和附件工作前捕获最近收到的状态或当前错误。ready 但没有状态不等于空状态：null、false、零与空字符串都是合法值，缺失数据则不可用。换源码、重新挂载和断线会将实时选择锁定为失效，需要重选或移除。清除选择或按任意顺序释放两个所有者，都会释放订阅，不重新查找正在关闭的服务。

捕获完成后，不要求 frame 继续打开。Host 不查询实时运行注册表，也不替换为后来报告。当前源码变化会在准入前明确拒绝；已接受请求则先返回原确认。未知结果重试保留完整原请求，不受后来状态变化影响。保存引用保持原始证据。选择是瞬态，不从可见内容推断；历史问题文本刷新后仍在，但不会复活运行。其它 Scene 控件与子代理继续输入的上下文仍不支持。Client 根据实际子 agent 通道描述隐藏不支持的问题上下文选择，并说明仍可输入普通文字问题；手动分支继续使用根通道。选择与捕获回调在发送前执行同一限制。参见[程序上下文指南](../upgrade-guide/v0.2.2-alpha.2/program-question-context/guide.zh.md)与[浏览器场景](../../apps/web/tests/artifact-program-question.e2e.ts)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxartifactbranchresults--artifactbranchresults"></a>

### `ctx.artifactBranchResults` — `ArtifactBranchResults`

Artifact-owned API for manually attaching experiment evidence to one branch conclusion.

```ts cordis-catalog
/**
 * Fork a returned function plot into an editable child without waking either Agent.
 * @param request - Receiving Session, exact evidence notice identity and retry UUID.
 * @returns The durable child Session and its initial editable Artifact.
 * @throws {RemoteError} For unavailable evidence or conflicting reuse of the request identity.
 * A durability or workspace error can follow creation. Retry the identical request to recover the child.
 */
@Remote({ resources: { session: (request: ArtifactBranchContinuePlotRequest) => request.sessionId } }) async continuePlot(request: ArtifactBranchContinuePlotRequest): Promise<ArtifactBranchContinuePlotValue>

/**
 * Export the exact locked function plot in an original branch-return notice as offline HTML.
 * @param request - Receiving Session and exact notice sequence and message ID.
 * @returns UTF-8 HTML with the recorded source revision and replay conditions.
 * @throws {RemoteError} For unavailable or unverified evidence.
 */
@Remote({ resources: { session: (request: ArtifactBranchExportReturnedPlotRequest) => request.sessionId } }) async exportReturnedPlot(request: ArtifactBranchExportReturnedPlotRequest): Promise<Uint8Array>

/**
 * Export the exact function plot locked on a sent follow-up as offline HTML.
 * @param request - Owning Session and exact question sequence and message ID.
 * @returns UTF-8 HTML with the recorded source revision and replay conditions.
 * @throws {RemoteError} For unavailable or unverified evidence.
 */
@Remote({ resources: { session: (request: ArtifactBranchExportSentPlotRequest) => request.sessionId } }) async exportSentPlot(request: ArtifactBranchExportSentPlotRequest): Promise<Uint8Array>

/**
 * Export the checkpoint of a returned particle experiment as offline HTML.
 * @param request - Receiving Session and exact notice sequence and message ID.
 * @returns UTF-8 HTML with the original revision and confirmed replay conditions.
 * @throws {RemoteError} For unavailable or unverified evidence.
 */
@Remote({ resources: { session: (request: ArtifactBranchExportReturnedParticleRequest) => request.sessionId } }) async exportReturnedParticle(request: ArtifactBranchExportReturnedParticleRequest): Promise<Uint8Array>

/**
 * Export the particle experiment locked on a sent follow-up as offline HTML.
 * @param request - Owning Session and exact question sequence and message ID.
 * @returns UTF-8 HTML with the recorded revision, effective gravity and confirmed checkpoint.
 * @throws {RemoteError} For unavailable or unverified evidence.
 */
@Remote({ resources: { session: (request: ArtifactBranchExportSentParticleRequest) => request.sessionId } }) async exportSentParticle(request: ArtifactBranchExportSentParticleRequest): Promise<Uint8Array>

/**
 * Read the original program and checkpoint of an exact BFS return for offline download.
 * @param request - Receiving Session and exact notice sequence and message ID.
 * @returns The source revision and the program-reported checkpoint confirmed on that notice.
 * @throws {RemoteError} For unavailable or unverified evidence.
 */
@Remote({ resources: { session: (request: ArtifactBranchExportReturnedBfsRequest) => request.sessionId } }) async exportReturnedBfs(request: ArtifactBranchExportReturnedBfsRequest): Promise<ArtifactBranchExportReturnedBfsValue>

/**
 * Read the exact original program and the step locked on a sent BFS follow-up for offline download.
 * @param request - Owning Session and exact sent question sequence and message ID.
 * @returns The source revision from the verified return and the follow-up's recorded checkpoint.
 * @throws {RemoteError} For unavailable or unverified evidence.
 */
@Remote({ resources: { session: (request: ArtifactBranchExportSentBfsRequest) => request.sessionId } }) async exportSentBfs(request: ArtifactBranchExportSentBfsRequest): Promise<ArtifactBranchExportReturnedBfsValue>

/**
 * Read the original program and checkpoint of an exact half-adder return for offline download.
 * @param request - Receiving Session and exact notice sequence and message ID.
 * @returns The source revision and the program-reported checkpoint confirmed on that notice.
 * @throws {RemoteError} For unavailable or unverified evidence.
 */
@Remote({ resources: { session: (request: ArtifactBranchExportReturnedHalfAdderRequest) => request.sessionId } }) async exportReturnedHalfAdder( request: ArtifactBranchExportReturnedHalfAdderRequest, ): Promise<ArtifactBranchExportReturnedHalfAdderValue>

/**
 * Read the original program and state locked on a sent half-adder follow-up for offline download.
 * @param request - Owning Session and exact sent question sequence and message ID.
 * @returns The source revision from the verified return and the input and output bits recorded on the question.
 * @throws {RemoteError} For unavailable or unverified evidence.
 */
@Remote({ resources: { session: (request: ArtifactBranchExportSentHalfAdderRequest) => request.sessionId } }) async exportSentHalfAdder(request: ArtifactBranchExportSentHalfAdderRequest): Promise<ArtifactBranchExportReturnedHalfAdderValue>

/**
 * Fork returned native particle readings into an editable child without waking either Agent.
 * @param request - Receiving Session, exact evidence notice identity and retry UUID.
 * @returns The durable child Session and its initial editable Artifact at the original checkpoint.
 * @throws {RemoteError} For unavailable evidence or conflicting reuse of the request identity.
 * A durability or workspace error can follow creation. Retry the identical request to recover the child.
 */
@Remote({ resources: { session: (request: ArtifactBranchContinueParticleRequest) => request.sessionId } }) async continueParticle(request: ArtifactBranchContinueParticleRequest): Promise<ArtifactBranchContinueParticleValue>

/**
 * Recalculate the groups from one exact CSV return without mutating the Session.
 * @param request - Receiving Session, exact evidence notice and selected calculation.
 * @returns A chart source computed from the original attachment, grouping column and numeric column.
 * @throws {RemoteError} For unavailable evidence, attachment, or calculation.
 */
@Remote({ resources: { session: (request: ArtifactBranchRecalculateCsvRequest) => request.sessionId } }) async recalculateCsv(request: ArtifactBranchRecalculateCsvRequest): Promise<CsvBarChartSpec>

/**
 * Inspect the CSV columns and a bounded list of distinct values for one column without mutating the Session.
 * @param request - Exact approved return and optional column name.
 * @returns The available columns and the requested column options.
 */
@Remote({ resources: { session: (request: ArtifactBranchCsvFilterOptionsRequest) => request.sessionId } }) async csvFilterOptions(request: ArtifactBranchCsvFilterOptionsRequest): Promise<ArtifactBranchCsvFilterOptionsValue>

/**
 * Inspect a page of original CSV records contributing to a group before confirmation.
 * @param request - Exact approved return, current recipe, group key and optional offset.
 * @returns The matching record range with filter and measure cells only.
 */
@Remote({ resources: { session: (request: ArtifactBranchCsvRowsRequest) => request.sessionId } }) async csvParticipatingRows(request: ArtifactBranchCsvRowsRequest): Promise<ArtifactBranchCsvRowsValue>

/**
 * Inspect the records that contributed to the adopted CSV reading.
 * @param request - Exact receiving Session, return identity and optional record offset.
 * @returns A page from the original branch CSV using the adopted group and recipe.
 */
@Remote({ resources: { session: (request: ArtifactBranchCsvReturnedRowsRequest) => request.sessionId } }) async csvReturnedParticipatingRows(request: ArtifactBranchCsvReturnedRowsRequest): Promise<ArtifactBranchCsvRowsValue>

/**
 * Inspect the records that contributed to a sent CSV question's confirmed reading.
 * @param request - Exact receiving Session, question identity and optional record offset.
 * @returns A page from the original branch CSV using the stored group and filter.
 */
@Remote({ resources: { session: (request: ArtifactBranchCsvQuestionRowsRequest) => request.sessionId } }) async csvQuestionParticipatingRows(request: ArtifactBranchCsvQuestionRowsRequest): Promise<ArtifactBranchCsvQuestionRowsValue>

/**
 * Compare the confirmed CSV readings and their contributing records.
 * @param request - Exact receiving Session, sent question identity and optional record offset.
 * @returns A page of kept, excluded and added records for the same group of the original CSV.
 */
@Remote({ resources: { session: (request: ArtifactBranchCsvQuestionComparisonRequest) => request.sessionId } }) async compareCsvQuestionToReturn(request: ArtifactBranchCsvQuestionComparisonRequest): Promise<ArtifactBranchCsvQuestionComparisonValue>

/**
 * Compare two confirmed CSV returns and their record membership.
 * @param request - Parent Session, exact saved returns in comparison order, and optional page offset.
 * @returns The saved readings, the bounded record page and its confirmation proof when available to the owner.
 */
@Remote({ resources: { session: (request: ArtifactBranchCsvReturnedComparisonRequest) => request.sessionId } }) async compareCsvReturns(request: ArtifactBranchCsvReturnedComparisonRequest): Promise<ArtifactBranchCsvReturnedComparisonValue>

/**
 * Restore the owner's unsent CSV comparison for the receiving Session.
 * @param request - The receiving Session identity.
 * @returns The exact confirmed draft, or null when there is no draft.
 */
@Remote({ resources: { session: (request: ArtifactBranchReadCsvComparisonDraftRequest) => request.sessionId } }) async readCsvComparisonDraft(request: ArtifactBranchReadCsvComparisonDraftRequest): Promise<ArtifactCsvComparisonDraft | null>

/**
 * Durably save an explicitly confirmed CSV comparison before prompt admission.
 * @param request - Receiving Session, sealed reviewed page, and expected current receipt.
 * @returns The private receipt and the exact comparison visible in the draft.
 */
@Remote({ resources: { session: (request: ArtifactBranchSaveCsvComparisonDraftRequest) => request.sessionId } }) async saveCsvComparisonDraft(request: ArtifactBranchSaveCsvComparisonDraftRequest): Promise<ArtifactCsvComparisonDraft>

/**
 * Bind the exact confirmed draft to the next ordinary prompt request.
 * @param request - Owner receiving Session, current draft receipt and prompt request identity.
 * @returns Confirmation that the request identity is durable.
 */
@Remote({ resources: { session: (request: ArtifactBranchBindCsvComparisonDraftRequest) => request.sessionId } }) async bindCsvComparisonDraftRequest( request: ArtifactBranchBindCsvComparisonDraftRequest, ): Promise<ArtifactBranchBindCsvComparisonDraftValue>

/**
 * Check whether the exact identified comparison prompt reached the Session.
 * @param request - The owner receiving Session and original prompt identity.
 * @returns Whether this comparison prompt is durably accepted and its exact chat or inbox identity when available.
 */
@Remote({ resources: { session: (request: ArtifactBranchCheckCsvComparisonDraftRequest) => request.sessionId } }) async checkCsvComparisonDraftRequest( request: ArtifactBranchCheckCsvComparisonDraftRequest, ): Promise<ArtifactBranchCheckCsvComparisonDraftValue>

/**
 * Review the exact single comparison or imported explanation attached to an own sent question.
 * @param request - Receiving Session and exact message coordinates from chat history.
 * @returns The unchanged reviewed pages and transient proof for a fresh explicit draft lock.
 */
@Remote({ resources: { session: (request: ArtifactBranchReviewSentCsvComparisonRequest) => request.sessionId } }) async reviewSentCsvComparison(request: ArtifactBranchReviewSentCsvComparisonRequest): Promise<ArtifactCsvComparisonAttachment>

/**
 * Review two exact sent CSV comparisons as an ordered explanation before confirmation.
 * @param request - Receiving Session and both exact history message addresses in either selection order.
 * @returns The saved pages in recipe order with a transient proof for explicit draft confirmation.
 */
@Remote({ resources: { session: (request: ArtifactBranchReviewCsvComparisonExplanationRequest) => request.sessionId } }) async reviewCsvComparisonExplanation( request: ArtifactBranchReviewCsvComparisonExplanationRequest, ): Promise<ArtifactCsvComparisonAttachment>

/**
 * Export the exact recorded pages of a sent CSV comparison or explanation as offline HTML.
 * @param request - Receiving Session, exact message coordinates, and optional document language.
 * @returns UTF-8 HTML with the saved readings, reviewed records, and original return cards when the comparison records them.
 */
@Remote({ resources: { session: (request: ArtifactBranchExportSentCsvComparisonRequest) => request.sessionId } }) async exportSentCsvComparison(request: ArtifactBranchExportSentCsvComparisonRequest): Promise<Uint8Array>

/**
 * Export the reviewed pages of the exact own sent comparison or explanation as portable JSON.
 * @param request - Receiving Session and exact message coordinates from chat history.
 * @returns Bounded UTF-8 JSON containing the exact reviewed pages and any original return cards without local resource identities.
 */
@Remote({ resources: { session: (request: ArtifactBranchReviewSentCsvComparisonRequest) => request.sessionId } }) async exportSentCsvComparisonJson(request: ArtifactBranchReviewSentCsvComparisonRequest): Promise<Uint8Array>

/**
 * Review a portable comparison or explanation in a destination Session before the user confirms it.
 * @param request - Destination Session and decoded JSON file selected by the caller.
 * @returns Exact imported readings, their explicit source classification and a transient review proof.
 */
@Remote({ resources: { session: (request: ArtifactBranchImportCsvComparisonRequest) => request.sessionId } }) async importCsvComparison(request: ArtifactBranchImportCsvComparisonRequest): Promise<ArtifactCsvComparisonAttachment>

/**
 * Remove the matching draft on explicit discard or after its accepted prompt reaches durability.
 * @param request - Receiving Session, exact receipt, and optional accepted prompt request ID.
 * @returns Whether that matching receipt was removed.
 */
@Remote({ resources: { session: (request: ArtifactBranchClearCsvComparisonDraftRequest) => request.sessionId } }) async clearCsvComparisonDraft( request: ArtifactBranchClearCsvComparisonDraftRequest, ): Promise<ArtifactBranchClearCsvComparisonDraftValue>

/**
 * Confirm and persist one recalculated group in the receiving Session without waking the Agent.
 * @param request - Exact returned evidence, selected aggregation and group.
 * @returns The new immutable source and its confirmed group after the durability checkpoint.
 * @throws {RemoteError} For invalid or unavailable source, group or conflicting result. An identical retry reuses the same source.
 */
@Remote({ resources: { session: (request: ArtifactBranchLockCsvRequest) => request.sessionId } }) async lockCsv(request: ArtifactBranchLockCsvRequest): Promise<ArtifactBranchLockCsvValue>

/**
 * Return one child-owned conclusion with evidence selected by the user, without starting a model turn.
 * @param request - Direct parent, child-owned conclusion and a branch-visible evidence reference.
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
 * @param input - Stable request identity and a Scene revision or saved observation reference.
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
 * @param selection - Current revision, historical revision, or saved observation reference.
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
 * @throws {ArtifactError} `ARTIFACT_BUSY`, `ARTIFACT_EXISTS`, `ARTIFACT_NOT_FOUND`, `STALE_REVISION`,
 * `BAD_SOURCE`, or `BAD_INPUT`; no Session event is appended.
 */
prepare(agent: Agent, input: ArtifactPrepareInput): ArtifactSnapshot

/**
 * Prepare an inline chart from authoritative results computed by a Host attachment operation.
 * @param agent - Agent whose Session supplies the current Artifact revision.
 * @param input - Host-calculated CSV source and compare-and-set revision fields.
 * @returns The pending source to commit after the authoritative tool result succeeds.
 */
prepareCsvBarChart(agent: Agent, input: CsvBarChartPrepareInput): ArtifactSnapshot

/**
 * Append one validated complete snapshot only when it still follows the committed revision.
 * @param agent - Agent owning the Session log.
 * @param snapshot - Prepared complete artifact value.
 * @throws {ArtifactError} `STALE_REVISION` when the log moved past the prepared base, or when the
 * snapshot violates the same persistent validation as `prepare`; no Session event is appended.
 */
commit(agent: Agent, snapshot: ArtifactSnapshot): void

/**
 * Release one prepared snapshot without writing it, so a failed or aborted operation does not block later updates.
 * @param agent - Agent whose Session owns the artifact.
 * @param artifactId - Artifact identity of the discarded preparation.
 */
discard(agent: Agent, artifactId: ArtifactId): void

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
