---
kind: upgrade-guide
description: "SDK 按导入入口选择源码或构建运行时，不再根据文件是否存在自动回退。"
---

# 明确 SDK 的运行时选择

[English](guide.md) | 中文

## 变更

未提供 `dshBin` 时，SDK 此前优先使用已存在的构建 CLI，否则回退源码。因此，旧构建产物可能改变源码测试实际运行的代码和兼容 patch。

工作区 TypeScript SDK 导入现在始终启动同版本源码 CLI 并应用源码兼容 patch。发布的 JavaScript SDK 导入始终启动同版本构建 CLI；缺少可执行文件即报错，即使源码存在也不回退。包版本检查仍必需。显式 `dshBin` 覆盖继续选择 CLI 模块。

## 迁移

1. 从源码运行 SDK 测试时保留仓库的源码 alias。已有 `apps/cli/lib/bin.js` 不再覆盖这些源码导入。
2. 使用发布 SDK 前，准备其同版本 `@agentrans/dsh` 可执行文件。在 checkout 中运行 `pnpm run build`；不完整的已安装负载应修复，不能依赖源码回退。
3. 嵌入方若有意使用另一份已准备的 CLI，显式通过 `dshBin` 传入路径。调用提供方前确认实际 profile 与包版本。参见 [SDK 客户端](../../../../packages/sdk/client/README.zh.md)。
