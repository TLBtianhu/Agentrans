---
description: "普通手动 Session 分支的直接父关系校验、已确认助手结论选择、父级本地消息构造与幂等查询。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-branch

[English](README.md) | 中文

## 概述

`dsh-session-branch` 提供手动 Session 分支的领域规则：从子分支自有的 durable `assistant/message` 选择可见文本，构造带 `branch-result` 来源的父级本地 `user/message`，并查询同一结论是否已经回流。本包不执行 Session I/O、Agent 调度、Remote 调用或模型调用。

## 目录

- [API](#api)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="api"></a>
## API

- `selectBranchResult(observation, parentSessionId, resultSeq)` 要求普通 seeded 子分支的 `header.parentSession` 精确等于目标父级。所选 seq 必须不早于 `inheritedEventCount`，指向 durable assistant 消息，并含非空白可见文本；只选择文本块。
- `createBranchResultMessage(selection)` 创建新的父级本地消息 id，并在 `source` 中携带子分支 id、结果 seq 和结果消息 id。子事件 seq 不写入父事件的 `sourceEventSeqs`。
- `findBranchResult(events, reference)` 在相同引用已回流时返回已有父事件和消息 id。

-----

<a id="model-experience"></a>
## 模型体验

### 分支结论历史

#### 模型看到什么

只有 Host 将获确认结论追加到父 Session 后，它才成为普通的模型可见 user 历史。回流消息不会复制推理、工具调用、兄弟分支输出、继承的父级内容或父级后续事件。本包自身不发送模型请求。

#### Token 影响

只有选定的可见文本块进入父级消息。回流操作不会加入子对话全文或兄弟文本。同一结论重复回流会复用已有回执，不追加重复文本。

#### KV Cache 影响

回流文本按普通前缀缓存规则参与父 Session 的下一次模型请求；回流操作不会把子对话全文或兄弟文本加入该请求。

##### 选择边界

```markdown
Only selected visible text blocks become parent history; child and sibling transcripts stay out.
```

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 本包只处理直接普通分支。subagent settlement、自动回流、分支图和 UI 导航由各自的运行时与客户端包负责。

### 开发备注

无。
