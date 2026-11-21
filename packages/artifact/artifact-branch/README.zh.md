---
description: "将手动分支结论连同用户选择的 Artifact 读数带回父对话核对。"
kind: "package-reference"
---

# @agentrans/artifact-branch

[English](README.md) | 中文

## 概述

将一条子分支结论与用户选中的追问读数、已保存观察或固定比较一起回流。父级收到结论和复现证据所需的源码及读数。确认后保存结果，供日后核对。重复相同回流会复用回执，已回流结论再选择不同证据会被拒绝。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web 组合将本插件与 Artifact、Session Query 和 Session Controller 一同挂载。自定义 Web 组合需添加 `@agentrans/artifact-branch` 插件行。主 Artifact 服务和 headless 组合不依赖这个桥接能力。

```yaml
- name: '@agentrans/artifact-branch'
```

| 配置 | 默认值 | 含义 |
|---|---|---|
| `maxActionBytes` | `16384` | 完整回流 UserMessage 的 UTF-8 字节上限，包括结论、证据和元数据 |

使用直接父级、子分支结论序号和一项证据选择调用 `artifactBranchResults.returnResult`。已保存观察可以来自子分支继承的前缀。比较双方必须具有相同比较组、互补角色、运行版本、时间步长和步数。选择原生实验读数或声明可恢复的 HTML 检查点时，提交本分支在结论前发出的普通追问序号和文本块索引。

结果未知时可安全重试同一请求。更换选择会与该结论已有回流冲突，包括先前没有证据的回流。打开父级可查看已接受内容。消息过大时需要更小的实验，证据不可用时需要重新选择。

函数图调用 `artifactBranchResults.continuePlot`，粒子实验调用 `artifactBranchResults.continueParticle`。请求提交接收 Session、回流通知序号和消息 id，以及用于重试的 UUID。Host 校验原追问读数，在通知处创建分支，并在子 Artifact 的首个修订记录固定基线。响应返回子 Session 和 Artifact 身份。结果未知时，重试同一请求会找回具有匹配初始 Artifact 的子分支。故障后若子分支只保存了继承前缀，重试会报告继续实验冲突。

调用 `artifactBranchResults.exportReturnedPlot` 时，提供接收 Session、回流事件序号和消息 ID。Host 核对这条函数图回流通知确实属于该 Session，并返回含锁定函数、参数和探针的独立 HTML。文件保留原 Artifact 修订及回流消息地址，打开或重置即可恢复读数。下载不会写入会话事件。

粒子实验回流调用 `artifactBranchResults.exportReturnedParticle`，提交同样的地址字段。HTML 显示确认的重力、步数、粒子位置和速度。播放从锁定的那一步开始，重置回到同一步。下载不会写入会话事件。

BFS 和半加器回流分别调用 `artifactBranchResults.exportReturnedBfs` 和 `artifactBranchResults.exportReturnedHalfAdder`。Host 核对同样的地址，并返回原 HTML 修订和锁定读数。BFS 记录当前节点、队列和已访问节点。半加器记录两个输入位、和与进位。客户端将其打包成独立 HTML，程序在隔离的框架中运行，点击**重置到锁定步骤**恢复锁定状态。下载不会写入会话事件。

接收 Session 的所有者发送附有后续 BFS 或半加器状态的追问后，可用该追问的事件序号和消息 ID 调用 `artifactBranchResults.exportSentBfs` 或 `artifactBranchResults.exportSentHalfAdder`。Host 与更早的回流核对程序修订，并使用随已发送追问保存的程序上报状态。独立文件重置到追问锁定的状态。下载不会写入会话事件。

已发送的函数图追问使用同样的地址字段调用 `artifactBranchResults.exportSentPlot`。Host 从追问历史核对原修订以及锁定的函数、参数和探针。独立文件打开和重置时恢复这些条件。下载只读取追问，不写入会话事件。

已发送的粒子实验追问使用同样的地址字段调用 `artifactBranchResults.exportSentParticle`。Host 核对原修订和随问题记录的重力、固定步、位置和速度。独立文件从该检查点开始，重置也回到该处。下载不会写入会话事件。

同一证据和计算条件下，如果新旧锁定只有求和或均值读数不同，`artifactBranchResults.lockCsv` 可将更正后的读数保存到独立的不可变来源。重试会复用这份更正后的来源。已有追问保留当时的读数。

`artifactBranchResults.compareCsvReturns` 对照同一探究分支中源 CSV 和分组相同的两次回流。读数来自已保存的回流，参与行从源附件核对。会话所有者可按回流顺序确认一页作为草稿附件。草稿保存两次回流的身份及核对的原页。

调用 `artifactBranchResults.exportSentCsvComparison` 时提交接收 Session，以及已发送对照或两步解释的准确事件序号和消息 ID。Host 根据追问的接纳记录核验已保存的证据，返回一个独立 HTML。每页均包含原读数、锁定读数、各类记录总数和已核对的记录范围。两次探究回流的对照可在同一文件里分别展开两张原始卡片。两步解释按计算顺序展示读数，两份原始页可分别展开。对用户导入的内容，HTML 会说明来源是单页 JSON 对照、含两份原始锁定页的 JSON 两步解释，还是含两张原始回流卡的 JSON 对照。可选字段 `locale` 指定报告语言。Web 客户端在用户下载时发送当前界面语言，文件离线打开时仍用该语言显示。未指定语言或缺少对应报告译文时，Host 使用英文。生成时只使用已保存的历史，无须读取原 CSV、重算或调用模型。

`artifactBranchResults.exportSentCsvComparisonJson` 可将已核对页、含两张原回流卡的对照或两步解释导出为带版本的 JSON。`agentrans-csv-return-comparison` 版本 1 保存锁定页和两张卡的原结论、图表修订。`agentrans-csv-comparison-explanation` 版本 1 保存聚合与筛选的原始页。文件不携带本地 Session 和消息地址。`artifactBranchResults.importCsvComparison` 在用户核对前校验文件。草稿将已确认的内容和「用户导入」标记一起附到追问。

`artifactBranchResults.reviewCsvComparisonExplanation` 接收目标 Session 和两份已发送对照的准确引用。Host 对照已保存的消息核验两页，并确认它们来自同一次原回流。两页分别记录同一批记录从无筛选均值改为总和，以及用筛选排除记录后的总和。核对过程只使用已保存的页面。

`artifactBranchResults.reviewSentCsvComparison` 核验同一 Session 中选定的已发送用户导入解释或回流对照，供再次附加。核对凭据覆盖已保存的页面或回流卡、导入标记和本次选中的确切追问。用户确认一次即可把这些内容保存到当前草稿。

-----

<a id="understand-the-implementation"></a>
## 实现说明

服务从同一个不可变子分支观察中解析结论和证据，并将附件源码与日志中更早的 Artifact 修订比对。原生场景会重算并核对读数。对于 HTML，服务核对检查点并保存 `artifactEvidence` 标记，供父级重开已核验的修订。共用的 `session-branch/admission` 操作串行化父级追加和 flush。父级收到一条包含结论和自包含证据的普通 `branch-result` 用户消息。消息中的源码副本支持独立于父级 Artifact 状态的复现。

继续实验使用普通分支的生命周期。子 Artifact 的初始快照随原生源码记录通知身份和原 Artifact 修订。函数图保存所选函数、描点、参数和基线读数。粒子实验保存准确的固定步检查点，追问时可在同一步改变竖直重力并确认读数。再次继续时会采用所选追问中确认的重力。初始快照在返回成功前完成持久化，随后核对的读数沿用普通追问与证据回流机制。

[准入决策](../../../.agents/notes/implemented/architecture/2026-11-07-evidence-bearing-branch-results.zh.md)解释了已回流结论为何保持不变，以及桥接为何独立于主 Artifact 服务。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [手动分支](../../../docs/subsystems/branch.zh.md)——谱系、结论身份和共用准入。
- [Artifact](../../../docs/subsystems/artifact.zh.md)——已保存源码与固定比较。
- [Artifact Client](../../client/ui-artifact/README.zh.md)——用户选择与确认。

-----

<a id="model-experience"></a>
## 模型体验

### 已确认的带证据结论

#### 模型看到什么

父级收到选中的可见结论和实验证据，包括原始源码快照和所选条件。原生观察携带重算值。HTML 检查点保留程序上报的 BFS 遍历状态或半加器的输入与输出位。归属说明标明证据由用户选中并附在结论上。回流保存结果供父级下次请求使用。

#### Token 影响

只有确认会加入有界的结论与证据消息。完整源码副本可能比纯结论占用更多上下文。预览、取消和被拒绝的选择不会加入模型输入；相同重试不会重复加入。

#### KV 缓存影响

新的用户消息按普通缓存规则参与父级下一次请求。操作在当前尾部追加，不改写已有前缀，也不改变子分支历史。

##### 证据归属

```markdown
The user selected the following saved Artifact evidence to accompany this conclusion. This does not state that the assistant used it when producing the conclusion.
```

##### 分支追问归属

```markdown
The user selected the following Artifact readings from a branch question to accompany this conclusion. This does not state that the assistant used them when producing the conclusion.
```

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 只接受直接普通手动分支及其自有的持久 assistant 结论。
- 一次回流附加一个已保存粒子观察、一对兼容观察或一项追问附件。追问证据支持函数图、粒子系统和声明可恢复的 BFS 与半加器检查点。通过回流证据新建实验分支支持函数图和粒子系统。
- 完整消息上限可能拒绝大源码快照；已有观察继续保留。

<a id="dev-note"></a>
### 开发备注

随产品提供的确认路径见[分支验证](../../../docs/subsystems/branch.zh.md#verification)。
