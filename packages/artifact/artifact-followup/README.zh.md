---
description: "将用户明确选择的粒子实验或 HTML 程序自报状态与错误附到普通追问中。"
kind: "package-reference"
---

# @agentrans/artifact-followup

[English](README.md) | 中文

## 概述

将用户选定的准确实验附在普通追问中。输入框捕获当前粒子检查点、已保存观察引用、兼容的已保存比较，或 HTML 程序自报的状态与错误。Host 在目标 Session 中读取源码并重算粒子数值，HTML 报告保留其程序归属。问题与完整上下文进入同一条普通用户消息；仅在本地播放或选择不会增加模型输入。

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

将本插件与 Artifact、Session Controller 一起挂载。它注册 `artifact` 追问上下文提供者，不暴露独立发送操作。普通 `session/prompt` 授权和附件准入规则继续生效。不需要文件系统权限、额外消息来源或新 Session 事件。

```yaml
- name: '@agentrans/artifact-followup'
```

| Config | 默认值 | 含义 |
|---|---|---|
| `maxContextBytes` | `16384` | 完整贡献文本块数组的最大 UTF-8 字节数，包含源码和解释文字 |

`ArtifactPromptContextSelection` 携带一个当前粒子 Artifact 身份、修订与检查点，一条已保存观察引用，比较组与有序的已保存引用，或 `html-runtime` 捕获。不接受调用者提交源码字节或粒子坐标。Host 准入解析时，当前源码修订必须仍然相符。已保存引用可使用旧修订，包括目标 Session 继承的基线，不读取父级之后的状态或兄弟 Session。

HTML 捕获包含采集时的 Session id、Artifact id、准确源码修订、挂载运行 id，以及 `{status:'ready',state}` 或 `{status:'error',error}`。ready 必须有实际 state 字段：`false`、`0`、空字符串与 `null` 都是有效上报值，缺席则不是。error 不携带旧 state。采集的 Session 必须与接收 Session 相符，当前源码也必须仍是该修订的 HTML。源码由 Host 提供；运行身份、状态、state 与错误仍是 Client/程序声明，不是独立验证或重算的观察。

源码缺失、修订过期、采集 Session 不符、检查点/报告无效、来源不支持、组合不兼容或上下文超限都会在上下文准入前拒绝追问。源码变化后重新选择当前实验，或使用已保存观察。结果未知时，通用发送所有者保留完整捕获请求；已接受请求的重试会先找到原回执，再决定是否需要解析选择。Host 解析已捕获的 HTML 报告时，不要求运行流或运行服务仍然活跃，也不替换成之后的实时数值。

-----

<a id="understand-the-implementation"></a>
## 理解实现

插件在注册的提供者处校验排队 JSON，并通过 Artifact 服务的 `resolveSceneSource`、`resolveSavedObservation` 与 `currentSnapshot` 方法读取已准备的源码事实。不进行全日志读取、I/O、源码修改或模型唤醒。当前粒子数值由共享的带版本运行核心计算；已保存比较还使用共享比较校验器。HTML 解析不查询实时运行注册表、不执行代码、不恢复其堆，也不建立因果结论。

提供者输出一个解释性文本块，其中 `artifact-question-context` 记录包含目标 Session 与完整原始源码。粒子事实保留检查点和重算数值；已保存观察保留名称与身份；比较保留双方原始观察和共同运行版本、时间步长与步数。HTML 事实保留提交的捕获、挂载运行 id 与 `attribution:'program-reported'`，并使用独立解释前缀。该块在一次消息准入前附到用户普通内容中，因此重放仍能保留准确的已选数据，不声称可重放、因果或助手先前使用过它。

完整序列化贡献在返回前计算大小，包含原始源码、捕获报告与解释文字，不静默截断。程序捕获复用桥接的有界无损 JSON 校验：深度 32、2,048 个访问值，以及完整编码诊断的 1,024 UTF-8 字节。负零、稀疏数组与访问器会被拒绝，不做归一化。Session Controller 另行执行上下文总数与总字节限制。注册由 effect 所有，卸载插件会撤回提供者；提供者不可用时，不能静默省略已经选择的上下文。

<a id="further-exploration"></a>
## 进一步阅读

- [Artifact 子系统](../../../docs/subsystems/artifact.zh.md) — 源码修订、已保存观察与比较。
- [Session Controller](../../api/session-controller/README.zh.md) — 普通追问准入与投递。

<a id="model-experience"></a>
## 模型体验

### 围绕实验的追问

#### 模型看到什么

同一条普通用户消息包含问题与 `artifact-question-context` 文本块，文本块带有自包含的原始源码和所选事实。粒子事实由 Host 计算，HTML 状态与错误保留明确的程序归属。稳定的粒子解释前缀为：

##### 实验上下文归属

```markdown
The user selected the following experiment context for this question. Particle values are recomputed by the Host from the recorded source and checkpoint; no causal conclusion is inferred.
```

##### 程序报告归属

```markdown
The user selected the following program-reported context for this question. The Host checked the source identity and revision; the runtime identity, status, state and error are Client/program reports, not independently verified or recomputed. This does not establish replayability or a causal conclusion.
```

#### Token 影响

只有已接受的追问会增加上下文 token。完整源码与粒子事实或程序报告可能大于问题本身，因此提供者和通用发送所有者都执行字节限制。播放、选择或清除实验，以及被拒绝的选择都不会增加模型输入。

#### KV Cache 影响

上下文随新用户消息进入普通历史尾部，不改写旧消息，也不改变既有前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 原生检查点上下文支持粒子场景，其它 Scene 控件不受支持；HTML 报告仍是未经验证的程序数据，不是 Host 重算事实。
- 当前源码在准入前变化时会拒绝；提供者不查询任意历史修订。若结果需要在源码改变后继续引用，请保存观察。
- 选择双方比较要求先保存条件兼容的观察。提供者不推断因果，也不合并实验。
- HTML 捕获记录上报数据，不是可恢复的堆、已验证的观察或运行仍在线的证明。当前源码改变后，它不能提供任意旧源码修订。

<a id="dev-note"></a>
### 开发备注

包测试覆盖源码与采集 Session 隔离、已保存原修订、比较条件、报告/状态校验、完整 UTF-8 限制和注册撤回。构建后 Web 重放验证从普通输入框捕获到持久消息的路径。
