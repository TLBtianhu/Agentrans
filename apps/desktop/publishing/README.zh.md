---
description: "将已完成的 Desktop 安装包与更新元数据发布为 GitHub Release。构建配置与签名操作有各自的所有者。"
---

# Desktop 发布

[English](README.md) | 中文

## 摘要

把已完成的 Desktop 安装包及其更新元数据发布为 GitHub Release。打包后的应用内嵌 `provider: github` 与本仓库坐标，因此 `electron-updater` 从 Release 资产读取通道元数据，不再需要自建下载服务。构建配置与签名操作有各自的所有者。

## 目录

- [前置条件](#prerequisites)
- [准备 Release 草稿](#publish-a-release)
- [更新通道](#update-channel)
- [重复发布](#repeat-publication)

<a id="prerequisites"></a>
## 前置条件

发布需要在 `GH_TOKEN`（或 `GITHUB_TOKEN`）中提供拥有本仓库 `contents: write` 权限的令牌，同时准备完整的打包文件和 `AGENTRANS_UPDATE_SIGNING_KEY`。签名密钥必须与 Agentrans 内置的 Ed25519 验证密钥匹配。已安装的应用会匿名下载更新，因此发布仓库必须公开。

<a id="publish-a-release"></a>
## 准备 Release 草稿

在 `apps/desktop` 目录运行上传器，传入已完成的产物目录，并选用打包时的更新通道。

```sh
pnpm run publish:github -- <artifact-directory> <version> latest --draft-only
```

上传器检查安装包、更新元数据和元数据引用的校验和，再为文件签名。草稿模式下，平台上的完整资产清单及签名与本地文件核验一致后，`v<version>` 对应的 GitHub Release 仍为草稿。[发布工作流](../../../.github/workflows/desktop-release.yml)会核对选中的托管打包运行是否成功、是否对应请求的版本、通道和声明的目标，再将发布标签绑定到打包提交。需要同时发布 Windows 和两种 macOS 架构时，在打包工作流中选择 `all`。选择运行名称中已记录这些输入的打包运行。

发布工作流始终让 Release 保持草稿状态，目前接收托管打包工作流的产物。独立的受监督系统签名工作流保留各自的 Actions 产物。

<a id="update-channel"></a>
## 更新通道

`latest` 将稳定版本发布为最新正式 Release。`nightly` 发布预发布。托管打包的更新元数据文件名由 electron-builder 根据构建版本生成，例如 alpha 版本的 macOS 文件名为 `alpha-mac.yml`。托管运行另行记录所选更新通道。

<a id="repeat-publication"></a>
## 重复发布

使用相同的打包文件和签名密钥重试，可继续未完成的草稿。已有资产只有在文件大小和 SHA-256 一致时才会复用。资产内容冲突或仍处于上传失败状态时，发布会停止。草稿模式遇到已经公开的 Release 会停止。修改过的打包文件应使用新版本号发布。
