---
kind: upgrade-guide
description: "Agentrans 产品启动器使用隔离实例根，不再继承 Harness home 路径。"
---

# Agentrans 产品实例根目录

[English](guide.md) | 中文

## 变更

仓库的 `dsh`、`start:web`、`dev:web` 和 Desktop 开发启动现在会在源码树外建立独立的 worktree 实例。继承的 `DSH_HOME`、`DSH_AGENTS_HOME` 和 `DSH_DESKTOP_USER_DATA_DIR` 不再决定产品状态路径。`AGENTRANS_DEV_ROOT` 是显式开发覆盖项。非空未标识根目录和其它用途拥有的根目录会在状态写入前被拒绝；已有数据不做迁移。

Windows 打包后的 GUI 和内置 CLI 从同一个安装锚点派生状态路径。隔离验收要求与该负载匹配的显式上下文，以及有独立标识的状态根目录。其它平台的打包用户启动需要平台专属适配器，不能把 Windows 布局套进应用包内部。普通启动不再注册上游 `dsh` 协议。

通用 CLI 可执行入口和引擎演示仍由调用方管理 Harness 根目录，不初始化 Agentrans 开发实例。

## 迁移

1. 通过仓库的 `dsh`、`start:web`、`dev:web` 或 `dev:desktop` 命令运行产品开发。从产品启动说明中移除旧路径覆盖项。
2. 不设置 `AGENTRANS_DEV_ROOT` 时使用稳定的 worktree 默认值；也可将其设为绝对路径的空目录。将旧会话和凭据保留在原位置；不要向已有用户目录添加开发标识。
3. 重新构建应用，确认 GUI、CLI 和 Host 解析到同一实例。运行状态写入不得改变源码检出目录及其构建目录。
4. 单独检查已有操作系统协议关联。本次代码变更不会重写已经注册的处理器，也不会修复已安装快捷方式。
