---
kind: upgrade-guide
description: "产品、命令、环境变量、home 目录与清单键全部改用 Agentrans 之名；不读取任何旧名。"
---

# 产品改用自己名字

[English](guide.md) | 中文

## 变更

用户与插件作者输入的一切现在都是 `agentrans`，不再是 `dsh`：

- 命令是 `agentrans`（`@agentrans/cli`），npm scope 是 `@agentrans/*`；
- 环境变量是 `AGENTRANS_*`，包括 `AGENTRANS_HOME`；
- 默认 home 是 `~/.agentrans`，不再是 `~/.dsh`；
- 插件清单在 `agentrans` 下声明作者字段，运行时范围在 `engines.agentrans`；
- profile 在 `agentrans.profile.bundles` 下列出各层。

没有兼容层。仍带 `dsh`、`engines.dsh` 或 `dsh.profile.bundles` 的清单无法加载，也没有任何代码读取被弃用的 home。

## 迁移

1. 从未运行过旧版本则无需操作：`agentrans` 首次使用时会创建 `~/.agentrans`。
2. 若 `~/.dsh` 中有你想保留的 Session 或凭据，请自行移动（`mv ~/.dsh ~/.agentrans`）。产品既不读取也不移动它，也不会合并两个 home。
3. 安装前先改插件清单键：`"dsh"` 改为 `"agentrans"`，`engines.dsh` 改为 `engines.agentrans`，`dsh.profile.bundles` 改为 `agentrans.profile.bundles`。保留旧键的组合包会直接加载失败，而不是以半配置状态启动。
4. 脚本、别名、CI 步骤与桌面快捷方式中的 `dsh` 改为 `agentrans`。`AGENTRANS_HOME` 取代 `DSH_HOME`，其余 `DSH_*` 变量同理。
5. 想继续使用旧目录，就把 `AGENTRANS_HOME` 指向它。这是"数据放哪"的选择，不是迁移：路径本身仍带旧名。
6. 另一个 DeepSeek Harness 安装正在使用 `~/.dsh` 时不要移动它，那个安装会找不到数据。两个安装请使用各自的 home。
7. 没有降级路径：本版本写入 `agentrans.profile.bundles`，更早的构建读不懂它。
