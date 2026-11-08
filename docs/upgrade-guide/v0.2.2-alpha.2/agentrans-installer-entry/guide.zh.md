---
kind: upgrade-guide
description: "Agentrans Windows 打包使用带版本的未签名入口，并拒绝通用上游发布路径。"
---

# 使用 Agentrans 安装包入口

[English](guide.md) | 中文

## 变更

Agentrans Windows 安装包入口不再提供占位远程更新策略。它仅接受未签名 Windows x64 打包，不发布，也不注册上游协议。输出为 `agentrans-<version>-win-x64-unsigned.exe`，文件名与嵌入元数据共用解析后的构建版本，取代写死的文件名版本。通用上游配置和发布路径拒绝 Agentrans 应用 ID。

## 迁移

1. 使用 `node apps/desktop/scripts/package-agentrans-installer.mjs` 构建 Agentrans 候选包，不再使用通用上游发布命令。为此入口移除继承的 `DSH_DESKTOP_AUTO_UPDATE_ENV`、更新频道与强制更新策略设置。冲突的发布配置会被拒绝，不会静默挪用。
2. 调整产物收集规则，匹配 `artifacts/agentrans-installer/agentrans-<version>-win-x64-unsigned.exe`。安装前检查解析后的版本与产品身份。
3. 此产物是未签名候选包。Agentrans 签名发布与更新交付需要另行配置发布路径，不应替换成上游 feed 或签名身份。参见[分发边界](../../../../DISTRIBUTION.md)。
