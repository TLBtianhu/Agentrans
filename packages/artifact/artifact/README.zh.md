---
description: "Session 持久化 HTML 和 SceneSpec Artifact、模型创建/更新工具，以及用户确认后的交互消息。"
kind: "package-reference"
---

# @agentrans/artifact

[English](README.md) | 中文

## 概述

本包负责持久化 HTML 和 SceneSpec Artifact：以稳定 id、compare-and-set 修订号和语义呈现方式保存完整快照，并提供模型侧 `artifact` 和 `scene` 工具。稳定 Remote `submitAction` 把用户确认的操作转换为文本 `UserMessage`；操作不授予文件、网络或批准权限。

## 目录

- [使用](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用

以 `@agentrans/artifact` 挂载服务，以 `@agentrans/artifact/tool` 挂载 HTML 工具，以 `@agentrans/artifact/scene-tool` 挂载 SceneSpec 工具。服务依赖 Session Projection，并在同步读取前等待注册完成。它负责校验、读取当前修订号和提交 Session；每个工具先准备快照，只有最终工具结果成功才提交；失败或中止的调用改为丢弃这次准备。SceneSpec 使用版本化 SceneCatalog 和安全表达式解析器校验，不使用 `eval`。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `maxSourceBytes` | `262144` | 一份完整 HTML 源码的 UTF-8 字节上限 |
| `maxActionBytes` | `16384` | 完整编码操作消息的 UTF-8 字节上限 |
| `maxSavedObservationsPerArtifact` | `32` | 命名观察数量上限；超出后拒绝新增保存 |

创建从修订号 1 开始。更新必须提供 `baseRevision`，且只有等于当前持久化修订号才成功。已准备的快照会占用该 Artifact 直到提交或被丢弃：同一 Artifact 的第二次 `prepare` 以 `ARTIFACT_BUSY` 失败，`commit` 只在快照仍紧随已提交修订号时追加（否则 `STALE_REVISION`）。每条 `artifact/upsert` 都携带完整 `ArtifactSnapshot`，不是增量。

Web 和 Desktop 的 Chat 预设挂载 `@agentrans/artifact/attachment-csv-tool`，用于查看 UTF-8 CSV、按组计算统计量和创建原生柱状图。调用 `create_chart` 或 `update_chart` 时，模型提供上传 ID、计算条件和 Artifact 身份。Host 在当前会话及其继承的历史中查找已提交的用户上传记录，并将计算出的分组保存为图表修订。更新时须提供当前 `baseRevision`。

分组求和与均值使用解析后的 binary64 数值精确计算，只对最终结果舍入一次。较大数值相抵后仍保留较小数值的贡献，即使总和会溢出，也能返回可表示的有限均值。

-----

<a id="understand-the-implementation"></a>
## 实现说明

Artifact 可以向父页面发送 `{ kind: 'artifact-action', artifactId, revision, action, payload }`。它只提出用户意图，是否需要人工确认由 UI 政策决定。`wake: false` 使用 `agent.inject`；`wake: true` 使用 `agent.steer`。

`submitAction(agent, request)` 接受可信 Client 生成的 `requestId` 与完整冻结操作，该 id 成为既有用户消息 id，来源类型和完整操作文本保持原义。[Session 输入](../../session/session-input/README.zh.md)先检查原接受事实，再检查当前修订和大小。相同已接受重试不再次发送，源码替换或队列取消后也是如此；同一 id 的来源/内容冲突会被拒绝。发送方式只在首次接受时生效，不在后续重试时改变。必须保留准确的冻结载荷，包括其编码文本顺序。

稳定提交要求 Session 输入服务和准确的实时根 Agent；Remote 调用要求所有者 principal，请求不能提供调用者归属。明确拒绝、身份冲突、服务不可用与分发未确认分别报告。源码创建不激活 Session 输入服务；所有操作提交都走准入路径。

Scene 快照使用 `format: 'scene'` 和完整的 `spec`。目录校验函数图、流程图、粒子系统、时间轴、网络图和地图。非法表达式、参数范围和引用会在提交前被拒绝。新建或更新函数图时，每个函数都须使用唯一 ID。已保存的函数图及其续做保留原始源码和 ID 解析方式。

不依赖 DOM 的 `capabilities` 入口提供 `getArtifactSourceCapabilities(snapshot)`。SceneCatalog 声明每种原语的源码能力。粒子支持 Host 重算观察、保存、恢复、固定已保存双方的比较和追问上下文。函数图支持由 Host 重算读数的追问上下文。原生场景支持按源码默认条件导出 HTML，粒子导出也可以保留检查点。HTML 追问上下文保留程序自报的状态或错误。每项操作由服务校验可用性、权限、就绪状态和输入。

`runtime-values` 入口提供共用 JSON 遍历与诊断上限。其有界无损普通数据子集拒绝负零、稀疏数组、访问器、symbol、数组额外属性与非普通对象，不修改或丢弃报告数据。浏览器解析、不透明程序桥接和 Host 问题准入共用此校验器；它不执行 getter，也不验证程序所报数值的真实性。

不依赖 DOM 的 `@agentrans/artifact/particle-runtime` 入口为预览和独立导出提供同一份固定步长粒子计算。带版本号的检查点记录步数，恢复时必须使用同一 SceneSpec 和修订。观察输出将 `-0` 规范为 `0` 以便写入 JSON，内部积分状态不变。它不持久化状态，也不授予执行权限。

浏览器安全入口 `scene-renderers` 与 `scene-export` 拥有共用画布计算和独立 HTML 生成器。每个渲染器接收已解析的 `ScenePalette`，只按其中的角色取色——主文字、次级文字、强调、成功、底色、网格、四个序列色与一个高亮——因此它从不读取文档，一张样式表即可为所有原生场景换色。`resolveScenePalette(read)` 把这些角色映射到 `--dsw-alias-*` 自定义属性，缺少某个角色时抛出指名该角色的 `ScenePaletteError`，而不是画成透明。`SCENE_STYLE_PALETTES` 声明每种风格的调色板归属：`editorial` 跟随宿主调色板，`transit-map`、`blueprint`、`math-proof-lecture` 与 `particles` 属于 `self-contained` 风格，保留各自刻意的调色板。`buildSceneAnimationHtml(spec, title, checkpoint?, origin?)` 可将固定来源身份与重放条件作为转义 JSON 嵌入文件。导出物没有宿主主题，因此自带两套调色板并把匹配的一套交给同一批渲染器。非粒子场景按源码默认条件导出，不捕获浏览器局部滑块、选择或 iframe 状态。持久文件生成和重试回执归独立的 [Artifact 导出服务](../artifact-export/README.zh.md) 所有。

已保存粒子观察保留完整源码修订和 Host 重新计算的数值。保存会追加完整列表事件，不唤醒 Agent。已打开 Session 的投影提供这些观察；紧凑摘要省略它们。明确发送可引用旧修订，并从持久 Inbox 和用户消息收据中对已准入重试去重。Live 操作首次准入仍校验当前修订，已接受的稳定重试在该校验前返回原确认。见[已保存观察语义](../../../docs/subsystems/artifact.zh.md#presentation-and-recovery)。

浏览器安全的 `observation-comparison` 入口在共同运行版本、时间步长和步数下解析固定 control/variant 双方。`confirmObservationComparison` 在当前 Session 中读取两个已保存引用，为该有序组合准入一条 `comparison.completed` 输入。它使用已保存源码修订，拒绝不兼容条件，不接受 Client 计算值。单条观察发送与比较发送使用独立的准入收据。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Artifact 子系统](../../../docs/subsystems/artifact.zh.md)——协议值与持久语义。
- [Artifact Client](../../client/ui-artifact/README.zh.md)——沙箱 HTML 呈现与确认操作。
- [Conversation 装配](../../../docs/subsystems/conversation.zh.md)——稳定事件到节点的关联。

-----

<a id="model-experience"></a>
## 模型体验

### scene

#### 模型看到什么

`scene` 的系统指引要求模型在文字足够时直接回答，在改变输入、验证预测或比较结果有助于用户验证解释时主动提供内联实验。函数图用于探索数学关系，粒子系统用于观察运动，工作区工具用于处理文件或实现请求。工具提供示例，并接受 `action`、`kind`、`sceneId`、`title`、完整 `spec`、`presentation`，以及仅更新使用的 `baseRevision`。省略的 `spec.kind` 采用外层 `kind`，显式值须与外层一致。追问要求修改实验时，使用已确认的读数和当前 `baseRevision` 更新原 `sceneId`。结果只包含 `sceneId`、`revision`、`title`、`kind` 和 `presentation`。Host 在提交前校验 SceneSpec，Client 渲染声明式场景。

#### Token 影响

`scene` 可用时增加一份有界 JSON schema 和一段固定的系统提示。结果很短，不包含源码。

#### KV Cache 影响

创建或修改 Scene 只追加 log-only 事件，不改写模型前缀。

### artifact

#### 模型看到什么

`artifact` 工具以自包含 HTML 表达 `scene` 无法覆盖的交互。它接受 `action`、`artifactId`、`title`、`source`、`presentation`、可选 `comparison`，以及仅更新使用的 `baseRevision`。`comparison` 为独立快照分别设置 `{ group, role: 'control' | 'variant' }`。结果只包含 `artifactId`、`revision`、`title` 和 `presentation`。工具说明包含 iframe 消息格式，并将交互操作限定为用户输入。技能注册表可用时，HTML 工具在自己的作用域提供随产品分发的 `artifact-design` 技能。加载技能会同时返回指引和一个完整的参数探索模板，包含键盘输入和可拖动探针。模型可以直接改写返回的 HTML。生成可锁定的 BFS 或半加器实验时，工具要求初始 `ready` 和每次单步或切换输入后的 `reportState` 共用同一个状态读取函数。BFS 状态包含 `kind: "bfs-checkpoint"`、`current`、`queue` 和 `visited`。半加器状态包含 `kind: "half-adder-checkpoint"`，以及数值位 `a`、`b`、`sum` 和 `carry`。恢复并重绘已保存的状态后，同一个函数会读出锁定状态。

#### Token 影响

每个启用的 preset 挂载一份工具 schema。创建/更新结果只增加一段短 JSON。操作消息只有一个有界 JSON 文本块，并能作为普通用户输入重建。技能目录包含适用场景说明，加载技能时才会在当前轮加入完整模板。

#### KV Cache 影响

创建或修改 Artifact 只追加 log-only 事件，不改写旧模型前缀。准入 Artifact 操作会按接收 Agent 的普通缓存规则新增一条用户输入。

##### Artifact 操作

```markdown
A confirmed action becomes one bounded user message; it grants no additional authority.
```

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 持久事实包括源码、修订号和语义操作消息，不包括 iframe JavaScript 堆、Canvas 像素、滚动位置或未确认的待发送操作。
- 修订检查由所属 Agent 操作串行化，不是跨进程事务。
- 服务不执行或清理 HTML。执行由 Client 的不透明 origin iframe 与内容策略负责。

<a id="dev-note"></a>

### 开发备注

无。
