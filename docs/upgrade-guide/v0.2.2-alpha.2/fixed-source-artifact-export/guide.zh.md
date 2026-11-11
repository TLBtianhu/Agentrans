---
kind: upgrade-guide
description: "持久 Artifact HTML 导出需要认识导出事件的 Session 读取器和 Web 导出服务。"
---

# 恢复固定来源的 Artifact HTML 导出

[English](guide.md) | 中文

## 变更

原生 Scene HTML 导出现在通过可选的 `dsh-artifact-export` Web Host 插件持久保存原始源码、重放条件和文件回执。预置 Web 组合已挂载此插件。自定义 Web 组合需要提供该服务、附件文件存储和已有的 file-actions Client 服务，才能使用导出控件。无界面 Artifact 使用不要求此插件。

导出会写入必需的 `artifact/export` 事件。没有导出的既有 Session 仍可读取；不认识该事件的读取器会拒绝受影响的 Session。不提升格式版本，也不自动降级。导出 HTML 包含固定来源身份；非粒子场景仍按源码默认条件生成，不捕获局部 UI 参数。

## 迁移

1. 打开包含导出的 Session 前先升级读取器。遇到旧读取器拒绝时保留原始数据。
2. 自定义 Web 组合添加 `@agentrans/artifact-export`，并挂载 `attachments`、`sessionProjections`、`artifacts` 和 Client `fileActions`。附件存储应与 Session 日志处于同一隔离实例。
3. 导出一条已保存粒子观察，更新源码，刷新后下载已有结果，核对原始修订和步数。pending 记录没有确认结果，需要明确继续其固定请求。Web 请求下载不证明文件已保存。
