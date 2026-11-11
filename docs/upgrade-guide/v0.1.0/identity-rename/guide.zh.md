---
kind: upgrade-guide
description: "产品、命令、环境变量、home 目录与清单字段统一改用 Agentrans 名称；已有安装把 home 迁移一次即可保住数据。"
---

# 产品改用自己的名字

[English](guide.md) | 中文

## 变更

用户与插件作者会敲到的东西，名称从 `dsh` 全部改为 `agentrans`：

- CLI 是 `agentrans`（`@agentrans/cli`），npm scope 是 `@agentrans/*`；
- 环境变量是 `AGENTRANS_*`，其中包括 `AGENTRANS_HOME`；
- 默认 home 从 `~/.dsh` 改为 `~/.agentrans`；
- 插件清单的作者字段写在 `agentrans` 下，运行时范围写在 `engines.agentrans` 下；
- profile 的层列表写在 `agentrans.profile.bundles` 下。

旧名不会被悄悄接受：仍带 `dsh` 或 `engines.dsh` 的清单会正常加载，同时抛出一条 `DeprecationWarning`，指明文件与对应改名；下一次写回只产出新键。

## 迁移

1. 从未运行过旧版本的话无需操作：`agentrans` 首次使用会创建 `~/.agentrans`。
2. 若 `~/.dsh` 里存着会话与凭据，用 `agentrans home adopt` 迁移一次。该命令直接重命名目录；`~/.agentrans` 已存在、`~/.dsh` 不存在、或 `~/.dsh` 不是目录时都会拒绝，并且从不合并两个 home。
3. 想继续用旧目录，就以 `AGENTRANS_HOME=~/.dsh` 启动。这是临时安排而非迁移：路径里仍带着已退役的名字。
4. 另一个 DeepSeek Harness 安装正在使用 `~/.dsh` 时不要迁移，那个安装会找不到自己的数据。两个安装应各用独立 home。
5. 把脚本、别名、CI 步骤与桌面快捷方式里的 `dsh` 改为 `agentrans`。`DSH_HOME` 对应 `AGENTRANS_HOME`，其余 `DSH_*` 变量同理。
6. 重命名插件清单里的键：`"dsh"` 改为 `"agentrans"`，`engines.dsh` 改为 `engines.agentrans`，`dsh.profile.bundles` 改为 `agentrans.profile.bundles`。清单改用新名后，弃用通知不再出现。
7. 要回到上一版，用它自己的 home 变量指向 `~/.agentrans` 启动。本次改写过的 profile 只带 `agentrans.profile.bundles`，旧版不会读取，所以先从版本控制恢复该 profile 的 `package.json`。
