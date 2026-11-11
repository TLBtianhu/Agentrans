---
kind: upgrade-guide
description: "Artifact 恢复现在依赖 Session Projection，旧读取器会拒绝包含已保存观察的 Session。"
---

# 通过 Session Projection 恢复已保存 Artifact 观察

[English](guide.md) | 中文

## 变更

`@agentrans/artifact` 依赖 `dsh-session-projection`，并在开放同步源码读取前等待注册完成。随产品提供的 base 组合已包含该服务。此前单独挂载 Artifact 的自定义组合需要补上依赖。

保存粒子观察会写入必需的 `artifact/observations` 事件，包含单个 Artifact 的完整已保存列表，以及各自的源码修订、运行检查点和计算观察值。不含这些事件的已有 Session 仍可读取。不认识该事件的旧读取器会明确拒绝 Session；跳过它会丢失已保存实验。保存或恢复不会创建模型输入。

原生粒子比较使用两条明确选中的已保存观察，不再使用瞬态实时读数。两者必须属于同一比较组，分别具有 control 和 variant 角色，并使用相同的运行版本、时间步长和步数。已有 HTML 和非粒子当前分析比较保留实时路径。

## 迁移

1. 在自定义 `cordis.yml` 中，与 `@agentrans/artifact` 一同挂载 `@agentrans/session-projection`。编程调用方在调用同步方法前等待 Artifact 插件就绪。
2. 打开含已保存实验的 Session 时，使用认识 `artifact/observations` 的读取器。不要删除事件或改写日志来让旧构建接受它们。
3. 保存一个有名称的粒子观察，重新加载 Session 后恢复。核对显示的源码修订与导出数值。只有“发送给 Agent”会将已保存观察准入为输入；重试不会在同一 Session 重复准入。
4. 原生粒子比较需要在两侧各保存并选择一条观察，再明确发送比较。核对两侧源码修订和检查点。重新加载后，已保存观察仍可使用，但需要重新选择比较双方；选择本身属于本地状态。同一 Session 再次发送同一有序组合不会重复输入。
