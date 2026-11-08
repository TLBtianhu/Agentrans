---
kind: upgrade-guide
description: "自定义 Session Controller 组合需要共用输入准入，Artifact 适配器必须保留稳定操作身份。"
---

# 共用 Session 输入准入

[English](guide.md) | 中文

## 变更

Session Controller 现在要求 `@deepseek-ai/dsh-session-input`。随产品提供的 Web bundle 已挂载，自定义组合需要添加。此服务拥有既有私有问题收据恢复与并发准入。状态版本 3 重建旧私有检查点，Session 日志字段和消息来源不变。

Artifact 新增 `submitAction(agent, request)`，`requestId` 使用既有 `MessageId`，由可信 Client 生成，与作品身份、源码修订、action、payload 和 wake 选择一起保留。相同消息已接受时，在当前源码校验前返回原确认；队列取消不释放身份。同一消息 id 的来源/内容不同会冲突。来源/内容指纹不持久保存发送方式；接受后重试不能改变发送方式或再次唤醒模型。

旧同步 `record` 不要求新服务，仍可调用，但每次创建新身份，不提供安全重试。当前 Web 卡片为原生确认、经过用户审阅的 HTML 操作和当前比较使用稳定提交。子 agent 继续输入聊天保留本地探索，不提供尚不支持的仅根会话保存、发送或已存文件导出操作。

## 迁移

1. 使用 Session Controller 或稳定 Artifact 提交前，在 `@deepseek-ai/dsh-session-projection` 旁挂载 `@deepseek-ai/dsh-session-input`。自定义包清单必须声明挂载插件。无界面源码创建和旧 `record` 不需要激活它。
2. 自定义操作适配器将捕获的消息 id 传给 `remote.artifacts.submitAction`，不在每次重试时生成新 id。保留完整原始载荷及其编码文本顺序。UI `RecordArtifactAction` 回调可选的第六参数携带此身份，提供时适配器必须遵守。
3. 区分明确拒绝/冲突与分发未确认。源码变化或服务暂不可用时仍保留未知请求，重试原请求。放弃本地重试不撤回已接受输入。关闭或刷新前先重试或检查历史，浏览器本地捕获不是持久收据。
4. 验证队列取消后的普通问题重试，以及源码替换后的已接受操作重试，两者都只能返回确认，不能新增 inbox 插入或模型轮次。同一操作 id 改变内容应产生冲突，子 agent 本地控件仍可操作且不调用仅根会话操作。
