---
kind: upgrade-guide
description: "HTML 程序通过注入的 Artifact API 声明实际运行支持并确认命令。"
---

# 声明 Artifact 运行支持

[English](guide.md) | 中文

## 变更

共享 HTML 控制要求双方当前运行都报告 ready 并显式注册已实现的回调。不带作用域的 `artifact-command` 和 `artifact-state` 消息不再建立控制或状态支持。已有 HTML 仍可预览，经过用户确认的 `artifact-action` 路径保持不变。源码创建只确认源码接受，不确认渲染器执行。

使用当前 Artifact Client 的自定义 Web 组合需要在 Artifact 旁挂载 `@deepseek-ai/dsh-artifact-runtime`，并提供其生成的 Remote contribution。Agent preset 可挂载 `/tool` 入口，提供精确修订的 `artifact_runtime` 查询。随产品提供的 Web 组合同时包含两者。不需要 Session 迁移；旧工具结果不会恢复实时就绪。参见[所有权决策](../../../../.agents/notes/implemented/architecture/2026-11-07-artifact-runtime-reports.zh.md)。

运行查询结果新增 `wait` 和 `budget`。可选 `waitMs` 在 Host 上限内等待一次 ready/error 报告；零或缺省仍立即返回快照。读取所有运行与等待结果：超时或空报告列表不表示执行失败或成功。工具限制每轮查询与修复尝试，不自动调度修复。

当前分析比较冻结完整请求，并保留稳定身份供未知结果重试。已保存比较继续使用既有引用收据。自定义操作适配器见[输入准入](../session-input-admission/guide.zh.md)。

## 迁移

1. 程序成功初始化后调用 `window.artifactRuntime.ready({ state: () => ({ count }), commands: { step: () => advance() } })`。状态和 play、pause、step、reset 都是可选回调，只注册实际实现的操作。
2. 后续有界 JSON 状态使用 `window.artifactRuntime.reportState(value)`，程序无法继续时使用 `window.artifactRuntime.error(message)`。命令回调可返回 Promise，桥接层会确认其完成。失败后需要显式重新声明 ready，或创建新的预览/源码。
3. 使用注入 API，不自行构造运行身份。宿主为每个物理预览创建新身份，同一修订从源码视图返回时也是如此。不能把 load 事件、已保存报告或旧回调确认当作当前就绪。
4. `runtimeCommandTimeoutMs` 限制等待确认时间，不能证明失败或回滚。重复命令前先检查结果。运行报告不授予 Host 权限，也不提供确定性的保存/恢复能力。

5. 严格读取结果的调用方需支持 `wait` 和 `budget`。默认值不适合时，在服务配置 `maxWaitMs`、`maxWaitsPerSession` 与 `maxWaitsTotal`，在 `/tool` 配置 `maxQueriesPerTurn` / `maxRepairAttemptsPerTurn`。新修订不续订修复次数；预算耗尽后说明未解决的失败。
6. 验证已声明命令只在双方程序就绪后启用，回调完成前保持待确认，并明确显示失败。用 `artifact_runtime` 读取精确错误，更新同一 Artifact，确认新运行报告替换后的源码。关闭浏览器后应没有实时报告，历史工具结果仍可读取。
7. 重试未确认的当前比较时使用原始冻结请求。放弃只清除本地重试状态，不撤回已接受输入；之后明确发送时采集新比较。
