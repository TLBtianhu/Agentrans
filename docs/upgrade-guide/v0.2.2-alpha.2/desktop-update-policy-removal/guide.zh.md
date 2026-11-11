---
kind: upgrade-guide
description: "Agentrans 移除托管的强制更新策略、其测试登录窗口，以及允许它的本地设置文件；更新只来自 GitHub Release feed。"
---

# 复核更新策略的移除

[English](guide.md) | 中文

## 变更

打包后的应用不再查询远端策略服务。`AGENTRANS_DESKTOP_MANDATORY_UPDATE_*` 配置、`AGENTRANS_DESKTOP_AUTO_UPDATE_ENV` 以及内嵌的 `dshMandatoryUpdatePolicy` 清单字段一并消失，随之移除的还有强制更新覆盖层、它的 Windows 内嵌框架、macOS 隔离视图，以及仅用于测试的飞书登录窗口。正式打包不再需要策略 origin。

`agent.getPath('userData')/desktop/settings.json` 不再被读取。它唯一承载的 `updates.allowTestAuthPopupWindow` 只用于控制已被移除的登录窗口；shell 不再保留本地设置文件，磁盘上已有的文档原样保留。

更新仍只有一个来源：构建内嵌的 GitHub Release feed，`latest` 读取正式 Release，`nightly` 读取预发布。应用在启动时、前台或恢复时（到期才查），以及用户主动请求时检查它。任何检查都不强制更新、不阻塞产品工作、也不依赖服务端决定；可用版本只在用户逐步确认后才下载、校验并安装。

## 迁移

1. 从打包 dotenv 与 CI 变量中删除 `AGENTRANS_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN`、`AGENTRANS_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN`、`AGENTRANS_DESKTOP_MANDATORY_UPDATE_CONFIG`、`AGENTRANS_DESKTOP_AUTO_UPDATE_ENV` 与 `PACKAGE_TEST_RELEASE_ID`。仍声明它们的 preset 会以"unsupported setting"失败，而不是被静默忽略。
2. 删除 Electron `userData` 目录下的 `desktop/settings.json`，或直接留着：没有任何代码读取它。发布说明不再提供测试登录。
3. 确认已安装的版本检查的是它该检查的 feed：`latest` 安装提供正式 Release，`nightly` 安装提供预发布。上传器仍执行与之前相同的下载、校验与安装流程，只是策略轮询与强制阻断不再存在。
