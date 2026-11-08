---
description: "检查源码支持的操作与当前连接的渲染器或程序报告，不把代码已生成当作运行成功。"
kind: "package-reference"
---

# @deepseek-ai/dsh-artifact-runtime

[English](README.md) | 中文

## 概述

区分源码能力与运行报告。一个物理 Remote 流拥有一条绑定源码的运行报告；断连、卸载、源码替换或服务释放会移除它。`artifact_runtime` 工具读取准确的当前源码修订，也可在有界预算内等待一次匹配的就绪或错误报告。普通工具结果记录一次查询事实，不是程序持续就绪的持久证明。

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

在 Artifact 旁挂载此服务，在提供交互作品的 Agent preset 中挂载 `@deepseek-ai/dsh-artifact-runtime/tool`。Remote 命名空间与 Context 服务键均为 `artifactRuntime`。报告登记显式标识 Session 资源，不解析 Agent、不打开冷 Session、不追加输入或执行作者代码。Web 组合仅允许所有者附加报告流。

```yaml
- name: '@deepseek-ai/dsh-artifact-runtime'
```

| Config | 默认值 | 含义 |
|---|---|---|
| `maxViewsPerSession` | `16` | 一个 Session 同时附加的物理运行报告上限 |
| `maxViewsTotal` | `128` | 此 Host 同时附加的物理运行报告上限 |
| `maxErrorBytes` | `2048` | 一个完整 JSON 编码诊断对象的最大 UTF-8 字节数 |
| `maxWaitMs` | `5000` | 单次就绪等待可请求的最长时间 |
| `maxWaitsPerSession` | `4` | 一个 Session 的待完成等待上限 |
| `maxWaitsTotal` | `32` | 此 Host 的待完成等待上限 |

`attach(sessionId, identity, signal)` 返回双工 Remote 流。身份固定 Artifact id、源码修订、唯一挂载运行 id 与原生/HTML 渲染器。初始确认为 `{kind:'attached'}`；每个已接受的替换报告收到从一开始的 `{kind:'accepted',sequence}`。报告为 `starting`、带所声明状态/命令支持的 `ready`，或带稳定错误码与信息的 `error`。重复运行身份不能替换另一个流。无效、超大或超出容量的登记以 `artifact-runtime/rejected` 结束，不保留被拒绝的报告。

登记记录 Client 声明，不证明所指源码存在。检查通过已准备的 Projection 读取权威当前 Artifact，仅选取 Session、Artifact、修订与渲染器均相符的报告。源码缺失或修订变化会明确失败。多个物理运行保持独立，一个标签页的 ready 不覆盖另一个标签页的 error。没有活跃报告表示缺少证据，不证明所有浏览器均已关闭。

`wait(agent, artifactId, revision, waitMs, signal)` 等待当前匹配的 ready/error 报告，包含源码提交后的首次附加。返回所有匹配运行，不推导整体成功。到期区分仍在启动的报告（`timeout`）与没有活跃报告（`no-active-report`）；此前观察到的匹配报告全部消失则返回 `disconnected`。源码替换按过期修订拒绝，Session/服务关闭与容量失败均为明确的等待错误。调用方取消保留原始原因。等待不运行代码、不发送命令或重试操作。

`/tool` 入口另有策略配置：

| Config | 默认值 | 含义 |
|---|---|---|
| `maxQueriesPerTurn` | `4` | 每个 Agent 轮次共享的查询/等待尝试上限 |
| `maxRepairAttemptsPerTurn` | `2` | 本轮已读到错误的 Artifact 共享的源码更新尝试上限 |

两个策略上限都允许零。最终成功的运行查询结果暴露错误后，通过 `artifact` 或 `scene` 更新该对象，会在执行前消耗共享修复预算；未暴露错误的普通编辑不受影响。取消或后续拒绝不退还次数。新源码修订或后来的 ready 报告不会重置预算，新轮次才会重置。预算拒绝要求模型说明未解决的结果，不继续重试。

-----

<a id="understand-the-implementation"></a>
## 理解实现

服务只保留由报告流拥有的有界实时状态。复用 Gateway 上行校验、容量与取消，不另建心跳或输入队列。源码替换会使旧修订失效；流结束与 Session/服务释放会移除其报告。Host 等待输入时的源码变化或断连也会结束报告流。历史工具结果不恢复这些实时状态。

源码能力来自 Artifact 的纯 `getArtifactSourceCapabilities` 声明，描述源码支持哪些观察、保存条件、比较、问题上下文与 HTML 导出语义，不证明插件可用、权限、渲染器就绪或正确性。ready 报告中的程序命令与状态报告声明，不授予 Host 保存、文件访问或 Agent 权限。

模型工具读取准确的当前修订，默认立即返回，也可显式指定 `waitMs`。等待订阅附加、报告和生命周期变化，不进行轮询；每项操作结束时释放定时器与监听器。源码创建仍独立于渲染器完成提交。普通 `tool/result` 事件提供模型可见持久事实，不新增运行 Session 事件或 Projection。上报与检查都不唤醒 Agent 或发送用户消息，源码生成与 CAS 更新保留原有行为。

<a id="further-exploration"></a>
## 进一步阅读

- [Artifact](../artifact/README.zh.md) — 持久源码修订与源码支持的操作。
- [Artifact Client](../../client/ui-artifact/README.zh.md) — 渲染器所有权、HTML 握手与可见失败反馈。
- [Gateway](../../api/gateway/README.zh.md) — 双工 Remote 流的校验与取消。

<a id="model-experience"></a>
## 模型体验

### artifact_runtime

#### 模型看到什么

工具接受 Artifact id、准确的当前源码修订和可选的 `waitMs`（零或缺省表示快照）。结果包含紧凑源码元数据、源码能力、`reportAuthority: 'client-reported'`、匹配的已连接运行、等待结果/上限，以及剩余查询/修复次数。每个运行标识挂载运行与渲染器，包含 `starting`、声明 `ready` 的能力或有界 `error`。源码缺失或修订过期是错误，不重复源码字节或本地高频状态。

#### Token 影响

参与的 preset 增加一份 schema。检查只贡献有界元数据、当前报告与策略计数，单 Session 视图和单报告诊断限制共同约束结果。上报本身不增加模型输入，空运行列表不得描述成渲染成功。

#### KV Cache 影响

检查追加普通工具结果，不改写源码、旧会话或模型前缀。记录的 ready 结果描述当时检查，不能证明当前可用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Client 和程序报告是声明，不是 Host 对像素、观察或因果结论的验证。
- 源码能力表示实现支持，不确认相关插件已挂载或调用者已授权。
- 报告仅在物理流保持连接时存在。断连运行必须附加新一代并再次上报，不恢复旧 ready/error 报告。
- 命令与状态支持描述当前桥接协议，不证明任意 seek、确定性重放或执行确认。
- 轮次预算是进程内循环限制，不是持久配额。工具重新加载或 Agent 重建会重置；轮次之间的调用共享一个临时作用域。它不停止无关工具，也不保证最终渲染或模型总步骤数固定。
- 登记不进行冷源码读取。缺失、过期或不兼容源码身份的声明不能进入成功检查。

<a id="dev-note"></a>
### 开发备注

Host 测试覆盖准确源码过滤、并发运行、资源声明、容量、诊断限制、源码失效，以及 Gateway 输入阻塞时的清理。模型工具测试通过执行器验证规范输出与拒绝，正式 Web 回放覆盖运行到检查的完整路径。
