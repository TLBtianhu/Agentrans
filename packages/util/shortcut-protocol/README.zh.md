---
description: "客户端界面与桌面主进程共同读取的物理按键类型、带版本的快捷键文档与持久化形状。"
kind: "package-reference"
---

# @deepseek-ai/dsh-shortcut-protocol

[English](README.md) | 中文

## 概述

客户端负责渲染快捷键绑定，桌面主进程负责保存它们；两边必须对"一个绑定意味着什么""哪些编辑合法""保存的文档如何带版本"达成一致。本包把这份一致意见表达为纯函数与类型，不含客户端界面，也不访问进程，因此任何一侧都不必导入另一侧的构建产物。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## 使用本包

<a id="use-this-package"></a>

`parseShortcutDocument` 读取已保存的文档并区分三种结果：可用的文档、`invalid`，以及当前构建不认识的 `future` 版本。`effectiveShortcuts` 依据某个平台的命令目录解析出实际生效的快捷键，`bindingIssue` 说明一个绑定为何不可用，而不是静默丢弃。`parseShortcutEdit` 在写入之前校验一次修改请求。

`ShortcutPersistence` 与各存储接口描述桌面遵循的顺序：读取、应用单次修改、保存、回报修订号。`normalizeBinding` 与 `bindingKey` 把面向用户的绑定归约为可比较的形式，使产生同一次按键的两个绑定判定相等。

本包不含 Cordis 插件、服务或配置。


## 理解实现

<a id="understand-the-implementation"></a>

`binding.ts` 拥有绑定类型与归一化；`configuration.ts` 拥有带版本的文档、其解析器与生效投影；`persistence.ts` 拥有存储契约与保存结果类型；`native.ts` 拥有桌面键盘与快捷键的 IPC 形状；`index.ts` 重新导出这四者。

这里不读取 `process`、DOM 或 Cordis 上下文，因此模块在 Electron 主进程、沙箱化 preload 与浏览器中的求值结果一致。

## 模型体验

None, as physical-key bindings reach the Client key handler and the Desktop store only; no model request carries them.

#### KV 缓存影响

无失效：这里没有任何东西改变请求正文。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 命令目录由调用方提供，本包不拥有它，因此无法报告"绑定指向产品已不再提供的命令"。
- `parseShortcutDocument` 对未知版本直接拒绝，不做迁移。将来升版本需要在这里新增后继解析器，并在升级指南中记录迁移。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

桌面主进程与客户端都读取这份协议，因此这里的改动会同时影响两份构建产物。绑定或文档字段变化时，请在同一次改动中更新桌面持久化测试与客户端按键处理测试；这次拆分的目的正是让任何一侧都不必导入另一侧的构建产物。

</details>
