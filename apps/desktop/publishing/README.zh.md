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

发布需要 `GH_TOKEN`（或 `GITHUB_TOKEN`）中带有本仓库 `contents: write` 权限的令牌，以及由 `pnpm run package:<target>` 产出的安装包。仓库必须公开：已安装的应用会匿名下载更新元数据与安装包，私有仓库无法在不内嵌令牌的情况下提供更新。

<a id="publish-a-release"></a>
## 发布一个版本

```sh
pnpm run package:win:x64
node --import tsx apps/desktop/scripts/publish-github-release.ts .desktop-build/artifacts <version> latest
```

上传器会从产物目录收集该目标的安装包、blockmap 与通道元数据，Release 不存在时创建，然后逐个附加。标签名为 `desktop-v<version>`，与 npm 系列使用的 `dsh-v*` 区分。

<a id="update-channel"></a>
## 更新通道

`latest` 发布正式 Release；`nightly` 发布预发布。打包后的应用把同样的两个通道映射到该发布类型，因此 nightly 构建不会把 latest 构建推送给自己的用户。

<a id="repeat-publication"></a>
## 重复发布

Release 上已存在的同名资产会被跳过而非替换：重试发布绝不会换掉用户可能正在下载的字节。因此修正后的构建需要新版本号，这也是让通道元数据里的校验和保持真实的前提。
