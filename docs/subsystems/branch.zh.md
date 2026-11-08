# 手动分支

[English](branch.md) | 中文

手动分支是从另一个 Session 的精确前缀创建的独立 Session。它的 `SessionId` 就是分支身份。`header.parentSession` 记录直接来源；`origin` 保持缺省，因此普通手动分支不是 subagent。

## 开岔与谱系

在包含端点的 `atSeq` 开岔会继承该事件之前的源前缀，以 `session/end-seed` 标记继承切口，并用 fork 专用结果闭合未完成的工具、步骤和轮次。源日志不变。嵌套分支指向直接父级，而不是根节点。

`inheritedEventCount` 只计复制的源事件，不计 seed 标记和合成关闭事件。非空分支的源切口为 `inheritedEventCount - 1`，不需要再存一份 `atSeq`。

子分支只从自己的日志派生模型消息。开岔后父级新增的事件和兄弟对话不会进入该子分支。嵌套子分支继承直接父级的前缀，其中已经包含相关祖先。

<a id="confirmed-result-return"></a>
## 确认后的结论回流

`SessionBranchResultRequest` 包含直接父级 `sessionId`、子分支 `branchSessionId` 和子分支自有的持久 `assistant/message` 序号 `resultSeq`。请求不携带结论文本。Host 重新读取精确的子事件，并校验消息 id 和非空可见文本。

`SessionBranchResultValue` 包含 `parentSessionId`、父级本地 `eventSeq` 和父级本地 `messageId`。以相同确认内容重试同一 `(parent, branch, resultSeq)` 会返回已有回执，不重复追加。该结论使用不同内容时报告 `session/branch-result-conflict`，包括纯结论与带证据回流之间的冲突。

接受的结论在父级当前尾部形成新的普通 `user/message`，其 source 为 `branch-result`，包含：

| 字段 | 含义 |
|---|---|
| `branchSessionId` | 拥有该结论的子 Session |
| `resultSeq` | 精确的子事件序号 |
| `resultMessageId` | 子 assistant 消息的稳定 id |
| `form` | `notice` |

子事件序号不写入 `sourceEventSeqs`，后者只接受同一 Session 内更早的事件。确认回流创建父级本地的新消息身份，不改写历史，也不启动模型轮次。

非分支、subagent、错误父级、继承事件、结果不存在或可见文本为空都会被拒绝。空闲父级通过 maintenance 串行化追加并 flush；运行中的父级返回 busy，不隐式 steer。

普通回流和 [Artifact 证据桥接](../../packages/artifact/artifact-branch/README.zh.md)共用 Host 专用的 `session-branch/admission` 操作。它在持有父级 maintenance 时比较已有内容，只对新消息追加并 flush。操作开始后的失败可能留下未知结果；重试同一选择可找回回执。只有未能进入 maintenance 的失败才报告 busy。

证据桥接从同一个不可变子分支切面读取结论和已保存观察。它以额外普通文本附加用户选择的证据，不改变 `branch-result` source 或子分支历史。可以选择继承的基线观察，但不能使用后来的父级事实或兄弟事实。证据选择不表示助手使用过这些事实来撰写先前结论。

<a id="verification"></a>
## 验证

keyless [branch-result 场景](../../apps/web/tests/branch-result.e2e.ts) 通过实际 Web 组合重放父级回答和独立的子级回答。浏览器从父级开岔，打开子级自有结论的预览，先取消一次而不回流，然后再确认。测试检查预览不包含 reasoning、父级只新增一条携带子级引用和可见文本的 `branch-result` 用户消息，并且确认前后都不启动父级模型轮次。

[分支证据场景](../../apps/web/tests/branch-evidence.e2e.ts) 将旧修订观察与子分支结论一同回流，丢弃首次成功响应，再重试冻结请求。它核对父级只新增一条持久输入、更换证据明确冲突、子分支日志不变，以及父级同名 Artifact 保持原样。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->
<a id="cordis-surface"></a>
## Cordis API
<!-- END GENERATED cordis-surface -->

## 限制

- 前缀继承使用现有 Session fork seed，不是零复制的跨 Session overlay。
- 回流只复制选定的可见文本块及其引用，不复制子分支全文、工具、推理或兄弟状态。
- 谱系支持导航与校验，不提供自动语义合并或冲突解决。
