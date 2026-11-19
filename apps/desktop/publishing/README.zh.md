---
description: "将已完成的 Desktop 安装包与更新元数据发布为 GitHub Release。构建配置与签名操作有各自的所有者。"
---

# Desktop 发布

[English](README.md) | 中文

## 摘要

把已完成的 Desktop 安装包及其更新元数据发布为 GitHub Release。打包后的应用内嵌 `provider: github` 与本仓库坐标，因此 `electron-updater` 从 Release 资产读取通道元数据，不再需要自建下载服务。构建配置与签名操作有各自的所有者。

## 目录

- [前置条件](#prerequisites)
- [发布一个版本](#publish-a-release)
- [更新通道](#update-channel)
- [重复发布](#repeat-publication)

<a id="prerequisites"></a>
## 前置条件

托管工作流使用仓库密钥 `AGENTRANS_UPDATE_SIGNING_KEY`，并与应用内置的公钥核对。预检和复核使用只读权限。上传草稿需要 `contents: write`。已安装的应用从公开仓库匿名下载更新元数据和安装包。

<a id="publish-a-release"></a>
## 发布一个版本

用[托管打包工作流](../../../.github/workflows/agentrans-hosted-package.yml)构建 Windows x64、macOS arm64 和 macOS x64。可以执行一次 `all`，也可以分别构建三种架构。一次 Windows 构建加一次合并的 Mac 构建也构成完整集合。所有运行须使用相同的提交、版本和更新通道。

在[发布工作流](../../../.github/workflows/desktop-release.yml)中，通过 `package_run_ids` 提供打包运行 ID，通过 `source_sha` 提供完整提交，并填入打包的 `version` 和 `channel`。多个运行 ID 以逗号分隔。同仓库的其他工作流也可以通过 `workflow_call` 提供相同输入和签名密钥。

- `preflight` 核对归档摘要、安装包身份和更新索引。它会合并分别构建的 Mac 索引，用内置公钥验证 Ed25519 签名，并保留签名资产清单。
- `review` 还将可见的 Release 与签名资产清单逐项对照。此操作使用只读权限，可复核已公开的 Release。
- `stage-draft` 显式授权独立的写入任务。该任务重新核对签名资产清单，上传并复核草稿。公开通过复核的草稿是独立操作。

Release 标签为 `v<version>`。npm 发布系列使用 `dsh-v*`。

<a id="update-channel"></a>
## 更新通道

`latest` 发布正式 Release；`nightly` 发布预发布。打包后的应用把同样的两个通道映射到该发布类型，因此 nightly 构建不会把 latest 构建推送给自己的用户。

每份通道索引都必须附带独立的 Ed25519 签名（`*.yml.sig`），并放在同一 Release 标签下。应用先用内置公钥验证签名是否匹配原始 YAML 字节，验签通过后才解析索引、提示更新或下载安装包。

如果 GitHub 返回 HTTP 404 表示找不到 YAML，应用可以尝试较早的兼容版本。缺少签名或验签失败会中止这次更新检查。安装更新前，应用还会验证下载到的安装包本身的签名。

<a id="repeat-publication"></a>
## 重复发布

重试时，只有在大小和摘要核对通过后才复用已有资产。修正后的构建使用新版本号，让通道索引指向准确的新文件。
