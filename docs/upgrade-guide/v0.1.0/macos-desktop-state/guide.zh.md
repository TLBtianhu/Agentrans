---
kind: upgrade-guide
description: "macOS Desktop 应用和终端命令共享 Application Support 中的产品数据目录。"
---

# macOS Desktop 数据目录

[English](guide.md) | 中文

## 变更

此前的 Agentrans 安装包会拒绝 macOS 普通启动。macOS 应用和其内置终端命令现在使用操作系统账号主目录下的 `~/Library/Application Support/com.agentrans.app`。移动或替换应用包后，仍使用这个位置。

## 迁移

1. 从 DMG 复制或从 ZIP 解压 `Agentrans.app`，然后打开应用。保留以前测试启动时产生的数据及其原位置。
2. 确认 Agentrans 首次启动时打开欢迎页，并创建 `~/Library/Application Support/com.agentrans.app/data`。
