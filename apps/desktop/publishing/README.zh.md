---
description: "将已完成的 Desktop 安装包与更新元数据发布为 GitHub Release。构建配置与签名操作有各自的所有者。"
---

# Desktop 发布

[English](README.md) | 中文

## 摘要

把已完成的 Desktop 安装包及其更新元数据发布为 GitHub Release。打包后的应用内嵌 `provider: github` 与本仓库坐标，因此 `electron-updater` 从 Release 资产读取通道元数据，不再需要自建下载服务。构建配置与签名操作有各自的所有者。

## 目录

- [前置条件](#prerequisites)
- [验收系统签名安装包](#review-signed-installers)
- [准备 Release 草稿](#publish-a-release)
- [更新通道](#update-channel)
- [重复发布](#repeat-publication)

<a id="prerequisites"></a>
## 前置条件

发布需要在 `GH_TOKEN`（或 `GITHUB_TOKEN`）中提供拥有本仓库 `contents: write` 权限的令牌，同时准备完整的打包文件和 `AGENTRANS_UPDATE_SIGNING_KEY`。签名密钥必须与 Agentrans 内置的 Ed25519 验证密钥匹配。已安装的应用会匿名下载更新，因此发布仓库必须公开。

<a id="review-signed-installers"></a>
## 验收系统签名安装包

在 [Verify signed Desktop artifacts](../../../.github/workflows/desktop-signed-intake.yml) 中填入 Windows x64、macOS arm64 和 macOS x64 的三个成功 `production` 打包运行 ID，以及共用的源码提交、可信的打包工作流提交、版本和更新通道。选择含有 `desktop-signed-build.json` 的运行，该文件记录实际检出的源码和生成的产物。

在仓库变量 `DESKTOP_WINDOWS_CERT_THUMBPRINT` 中填写 Windows 签名证书的 40 位十六进制指纹，在 `DESKTOP_MACOS_TEAM_ID` 中填写 10 位 Apple Team ID。在 `DESKTOP_MACOS_SIGNING_IDENTITY` 中填写证书名称里 `Developer ID Application:` 之后的内容，例如 `Example Company (AB12CD34EF)`。预检在对应平台的 runner 上使用这些公开值验证安装包。[打包指南](../packaging/README.zh.md)说明了生成产物需要的机器配置和签名凭据。

工作流只有仓库内容和 Actions 的读取权限。它先校验打包运行、归档、文件摘要和系统签名，再合并两种 macOS 架构的更新元数据。验收报告和合并后的元数据保存在 `signed-desktop-intake-report` Actions 产物中。签名和公证的端到端验收需要三套真实的生产打包产物。

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
