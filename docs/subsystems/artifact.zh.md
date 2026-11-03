# Artifact

[English](artifact.md) | 中文

Artifact 是带版本号、由代码生成的交互解释对象。它不是文件交付、生成图片或纯浏览器卡片。持久真源是完整 HTML；frame、截图、视频和下载文件都是投影或导出物。

## 协议值

`ArtifactSnapshot` 包含：

| 字段 | 含义 |
|---|---|
| `artifactId` | 所属 Session 内稳定的 branded id |
| `revision` | 正安全整数，从 1 开始，每次接受更新增加 1 |
| `format` | 当前为 `html` |
| `title` | 去首尾空白后 1–120 字符的显示标题 |
| `source` | 完整自包含 HTML 文档 |
| `presentation` | 语义呈现请求：`inline` 或 `focus` |
| `comparison` | 可选的 `{ group, role: 'control' | 'variant' }` 关系，用于独立比较场景 |

每条 `artifact/upsert` Session 事件都携带完整快照。同一 id 的后到事件取代旧修订。只加载最新 upsert 的尾页也能呈现当前 Artifact。

## 修改与操作语义

`artifact` 工具创建或更新快照。创建拒绝已存在 id；更新要求 `baseRevision` 等于当前修订号。只有最终工具结果成功才提交。失败、取消、过期修订和 post-execute 阻断都不提交。

`record` 只接受精确 live root Agent 和当前修订对应的操作。它校验操作名和完整 UTF-8 消息大小，再创建 `source.kind = 'artifact-action'` 的普通 `UserMessage`。唯一文本块装有有界 JSON，包含 `kind: 'artifact_action'`、id、修订号、操作和 payload。`wake` 选择 `agent.steer` 或 `agent.inject`。

Artifact 操作是用户意图，不是权限。它不能批准工具、读取文件、打开 socket 或绕过政策。payload 不是新的 LLM 内容块，也不是新的 Session 事件类型。比较宿主可用本地 `artifact-command` 消息同步播放/暂停/单步/重置，用本地 `artifact-state` 报告当前参数。这些消息不会唤醒 Agent；只有用户确认的 `comparison.completed` 操作包含两侧独立状态。

## 呈现与恢复

Client 按 `artifactId` 关联快照，跨修订保持 Conversation 身份。修订变化替换浏览上下文。iframe 使用不透明 origin 和严格内容政策；父页面只接受来自当前 frame、具有当前 id/修订号且有界 JSON 的消息。

SceneHost 支持 `inline`、`beside`、`focus` 和 `pip` 呈现方式。`ViewRequest` 只表达呈现意图，不授予窗口控制权限。用户切换布局时保留同一浏览上下文和待发送操作。overlay 祖先会被标记为可见，避免虚拟化历史隐藏固定场景。场景来源显示当前对话或父分支标题；“查看对话来源”返回 inline 并定位到原消息，不重置 Artifact。

比较组使用独立 Conversation Node，并排显示 control 和 variant。每个 Artifact 保留自己的参数和修订；共享命令只同步行为。比较结果通过 control Artifact 的当前修订准入，并包含两侧本地状态。

持久恢复覆盖快照和已准入操作消息。iframe JavaScript 堆、Canvas 像素、滚动位置、源码查看状态和未确认的待发送操作都是瞬态。

## 验证

keyless [Artifact 交互场景](../../apps/web/tests/artifact-interaction.e2e.ts) 使用 [session.v4.jsonl](../../snapshots/web/artifact-interaction/session.v4.jsonl) 中记录的模型流驱动实际 Web 组合。它创建并更新一个交互计数器，展开已完成的过程组，在真实浏览器中点击计数器，然后确认待发送操作。测试检查修订号 1 和 2、确认前没有 Artifact 操作或第二轮，以及确认后出现一条父级本地 `artifact-action` 和第二轮。

[教学型 Artifact 场景](../../apps/web/tests/teaching-artifact.e2e.ts) 将同一路径用于预测实验。用户选择角度、预测命中、发射并比较实际结果，再确认语义操作。Agent 随后把 Artifact 更新为带预测反馈的 revision 2。这验证了观察、预测、操作和反馈，而不只是可视化。回放还挂载了用户声明的 `custom-provider` 模型路由，因此模型选择器显示 `Custom Lab Model`，而不是内置 DeepSeek 路由。

[比较型 Artifact 场景](../../apps/web/tests/comparison-artifacts.e2e.ts) 将 control 和 variant 参数探索器归入 `damping-study`。它验证两个 iframe、同步单步/播放/暂停/重置、独立 damping 值，以及一条包含两侧当前状态的确认 `comparison.completed` 操作。

[函数绘图场景](../../apps/web/tests/function-plot.e2e.ts) 验证 SceneSpec 驱动的数学场景：两个函数、参数扫掠、缩放、导数、积分，以及一条带数值容差的确认 `plot.inspected` 操作。

[流程图场景](../../apps/web/tests/flowchart.e2e.ts) 验证 SceneSpec 驱动的概念图：节点选择、路径推进、缩放，以及一条包含所选概念和当前步骤的确认 `flow.inspected` 操作。

[粒子系统场景](../../apps/web/tests/particle-system.e2e.ts) 验证确定性物理场景：两个粒子、固定 1/30 秒步长、重力、轨迹、速度向量，以及一条包含位置和速度的确认 `physics.inspected` 操作。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxartifacts--artifactservice"></a>

### `ctx.artifacts` — `ArtifactService`

`ctx.artifacts`: validated artifact snapshots and user-action routing.

```ts cordis-catalog
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
```

Types: [Agent](core.zh.md)

Source: [`packages/artifact/artifact/src/index.ts`](../../packages/artifact/artifact/src/index.ts)
<!-- END GENERATED cordis-surface -->

## 限制

- 只接受自包含 HTML，没有外部依赖加载器。
- 修订检查依赖所属 Agent 的操作顺序，不是分布式事务。
- 消息来源记录保留用户输入，不保存任意 iframe 运行态，也不证明视觉结果正确。
