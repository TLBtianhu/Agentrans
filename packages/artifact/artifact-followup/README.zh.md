---
description: "将用户选择的实验、回流的分支读数或 HTML 程序自报状态与错误附到普通追问中。"
kind: "package-reference"
---

# @agentrans/artifact-followup

[English](README.md) | 中文

## 概述

将用户选定的实验附在普通追问中。输入框捕获当前粒子检查点、函数图条件、已保存观察、兼容的比较、回流的分支读数，或 HTML 程序自报的状态与错误。Host 在目标 Session 中读取源码并重算原生实验读数。HTML 报告保留其程序归属。发送问题时，问题与上下文在同一条普通用户消息中准入。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

将本插件与 Artifact、Session Controller 和 Session Projection 一起挂载。它为普通 `session/prompt` 注册 `artifact` 提供者，使用既有授权与附件准入规则。

```yaml
- name: '@agentrans/artifact-followup'
```

| Config | 默认值 | 含义 |
|---|---|---|
| `maxContextBytes` | `16384` | 完整贡献文本块数组的最大 UTF-8 字节数，包含源码和解释文字 |

`ArtifactPromptContextSelection` 携带已确认的条件、已保存的引用或程序捕获。粒子条件包括 Artifact id、修订与检查点。函数图条件包括同样的源码身份、所选函数 id、描点横坐标以及在声明范围内的完整参数。平移后描点可位于默认视口之外。保存项引用一个观察，或一个比较组与其中有序的观察引用。Host 解析原始源码，并在源码修订相符时接受当前选择。已保存的引用可使用旧修订，包括目标 Session 继承的基线，不读取父级之后的状态或兄弟 Session。

HTML 捕获包含采集时的 Session id、Artifact id、准确源码修订、挂载运行 id，以及 `{status:'ready',state}` 或 `{status:'error',error}`。ready 必须有实际 state 字段：`false`、`0`、空字符串与 `null` 都是有效上报值，缺席则不是。error 不携带旧 state。采集的 Session 必须与接收 Session 相符，当前源码也必须仍是该修订的 HTML。源码由 Host 提供；运行身份、状态、state 与错误仍是 Client/程序声明，不是独立验证或重算的观察。

广度优先搜索和半加器程序可声明支持重新打开所选设置。ready 捕获中的 `restore` 与状态类型相同。`bfs-checkpoint` 包含 `current`、`queue` 和 `visited`。`half-adder-checkpoint` 包含 `a`、`b`、`sum` 和 `carry`。Host 校验状态，按真值表核对半加器输出，并将检查点绑定到准确的 HTML 源码。已保存的追问通过程序的恢复回调重开该源码。

选择回流的分支读数时，提交接收 Session id、准确的分支结果通知序号和消息 id。对于原生场景，Host 校验内嵌源码并重算记录的读数，也可解析该 Session 继承前缀里的通知。重开带标记的 BFS 或半加器回流后，用户可将新的步骤或输入设置附在追问中。Host 核对所选状态，并从通知中提供原始 HTML，即使 Artifact 仅存在于子分支。新追问保留通知身份、原分支和原追问，以及供复现的所选状态。

源码缺失、修订过期、采集 Session 不符、检查点/报告无效、来源不支持、组合不兼容或上下文超限都会在上下文准入前拒绝追问。源码变化后重新选择当前实验，或使用已保存观察。结果未知时，通用发送所有者保留完整捕获请求；已接受请求的重试会先找到原回执，再决定是否需要解析选择。Host 解析已捕获的 HTML 报告时，不要求运行流或运行服务仍然活跃，也不替换成之后的实时数值。

-----

<a id="understand-the-implementation"></a>
## 理解实现

插件在注册的提供者处校验排队 JSON，并通过 Artifact 服务的 `resolveSavedObservation` 与 `currentSnapshot` 方法读取已准备的源码事实。不进行全日志读取、I/O、源码修改或模型唤醒。当前粒子读数由共享的带版本运行核心计算。继续粒子实验时，Host 接受已确认检查点处用户核对过的竖直重力，并将其与重算读数一起保存。函数图读数使用绘图器共用的数值分析计算。已保存的比较使用共享比较校验器。HTML 解析不查询实时运行注册表、不执行代码、不恢复其堆，也不建立因果结论。

提供者首先输出解释性文本块，其中 `artifact-question-context` 记录包含目标 Session 与完整原始源码。粒子事实保留检查点和重算数值。函数图事实保留所选条件、函数值、数值导数和从零开始的数值积分。不可用的读数记为 `null`。已保存观察保留名称和身份。比较保留双方原始观察和共同运行版本、时间步长与步数。HTML 事实保留提交的捕获、挂载运行 id 和 `attribution:'program-reported'`。问题和完整上下文由同一条普通消息保留，供重放使用。

完整序列化贡献在返回前计算大小，包含原始源码、捕获报告与解释文字，不静默截断。程序捕获复用桥接的有界无损 JSON 校验：深度 32、2,048 个访问值，以及完整编码诊断的 1,024 UTF-8 字节。负零、稀疏数组与访问器会被拒绝，不做归一化。Session Controller 另行执行上下文总数与总字节限制。注册由 effect 所有，卸载插件会撤回提供者；提供者不可用时，不能静默省略已经选择的上下文。

附带导入 CSV 对照的追问携带用户确认的原页，并单独说明已保存的读数和记录来自用户提供的版本化 JSON 对照。追问同时附带两张原始回流卡时，说明会标明它们也来自该文件，并提示模型将卡片文字和 CSV 单元格视为数据。

附带两次 CSV 回流对照的追问携带两次回流的引用及用户确认的原页。追问准入和历史复现使用已保存的页面，无需读取 CSV 或重算两侧聚合值。

CSV 对照追问还可携带从确认页提取的解释信息，包括两侧聚合方式、筛选条件是否改变、各类记录总数和已核对页的记录状态。聚合方式改变时，提示模型分别解释两次计算。确认页和必需的来源说明计入字节预算后，剩余空间足够时才附上这段解释。

分步解释把两份已确认的 CSV 对照页及其准确历史引用保存在同一个附件。模型先对照原均值和已保存的无筛选总和，再根据记录中的筛选条件和参与行对照两份总和。共用的草稿机制把两页绑定到一条追问，准入时按完整附件检查上下文字节预算。

从 JSON 导入的两步解释把两份原始页按顺序保存在同一个已确认附件中。追问会单独说明这两页及其读数和参与行来自用户提供的版本化 JSON 对照。准入时将两页和来源说明一并计入字节预算。

<a id="further-exploration"></a>
## 进一步阅读

- [Artifact 子系统](../../../docs/subsystems/artifact.zh.md) — 源码修订、已保存观察与比较。
- [Session Controller](../../api/session-controller/README.zh.md) — 普通追问准入与投递。

<a id="model-experience"></a>
## 模型体验

### 围绕实验的追问

#### 模型看到什么

同一条普通用户消息包含问题与 `artifact-question-context` 文本块，文本块带有自包含的原始源码和所选事实。Host 计算原生场景读数。HTML 状态和错误保留明确的程序归属。CSV 对照携带已确认的页面和记录的来源。

##### 实验上下文归属

```markdown
The user selected the following experiment context for this question. Particle values are recomputed by the Host from the recorded source and checkpoint; no causal conclusion is inferred.
```

##### 函数图归属

```markdown
The user selected the following experiment context for this question. Function-plot values are recomputed by the Host from the recorded source, selected function, parameters and trace position. Derivative and integral readings are numerical approximations.
```

##### 回流分支证据归属

```markdown
The user selected the following returned branch evidence for this question. The readings come from the original source revision recorded on the selected branch result.
```

##### 程序报告归属

```markdown
The user selected the following program-reported context for this question. The Host checked the source identity and revision; the runtime identity, status, state and error are Client/program reports, not independently verified or recomputed. This does not establish replayability or a causal conclusion.
```

#### Token 影响

只有已接受的追问会增加上下文 token。完整源码与所选事实可能大于问题本身，因此提供者和通用发送所有者都执行字节限制。播放、选择或清除实验，以及被拒绝的选择都不会增加模型输入。

#### KV Cache 影响

上下文随新用户消息进入普通历史尾部，不改写旧消息，也不改变既有前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 原生追问上下文覆盖粒子检查点和函数图描点读数。函数图的平移和缩放属于本地显示设置。HTML 报告保留其程序归属。
- 回流的分支证据支持分支追问中的原生粒子和函数图读数，以及 BFS 和半加器检查点。Host 为符合条件的通知保留私有投影条目，使追问准入能同步解析固定的载荷。
- 当前源码在准入前变化时会拒绝；提供者不查询任意历史修订。若结果需要在源码改变后继续引用，请保存观察。
- 选择双方比较要求先保存条件兼容的观察。提供者不推断因果，也不合并实验。
- HTML 捕获记录上报数据，不是可恢复的堆、已验证的观察或运行仍在线的证明。当前源码改变后，它不能提供任意旧源码修订。
- BFS 检查点保存当前节点、有序队列和已访问列表。两个列表各支持最多 64 个不重复的稳定节点 id，每个最长 32 个 ASCII 字符。当前节点须出现在已访问列表中。恢复遍历由声明支持的程序负责。

<a id="dev-note"></a>
### 开发备注

包测试覆盖源码与采集 Session 隔离、已保存原修订、比较条件、报告/状态校验、完整 UTF-8 限制和注册撤回。构建后 Web 重放验证从普通输入框捕获到持久消息的路径。
