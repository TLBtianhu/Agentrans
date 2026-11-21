---
description: "固定原始 Scene 源码与重放条件，生成不可变 HTML 文件并保存结果记录，不启动模型。"
kind: "package-reference"
---

# @agentrans/artifact-export

[English](README.md) | 中文

## 概述

将一个原始 Scene 修订或已保存粒子观察导出为独立 HTML。Host 根据引用读取源码，固定完整源码与重放检查点，再通过附件提供者保存精确输出。Session 保留请求、输出条件以及待完成、已生成或失败结果。后续源码更新不能改变已接受的导出。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

将本插件与 Artifact、Agent 注册表、Session 投影，以及支持原样文件存储和完整性验证流读取的附件提供者一起挂载。Web 组合为独立卡片和比较单元挂载此能力。主 Artifact 服务继续独立于文件存储。

```yaml
- name: '@agentrans/artifact-export'
```

| 配置 | 默认值 | 含义 |
|---|---|---|
| `maxExportsPerSession` | `32` | 一个 Session 保留的导出身份上限，不自动淘汰 |
| `maxInputBytes` | `262144` | 完整待完成记录的 UTF-8 字节上限，包含原始源码、Session 身份和请求 |
| `maxOutputBytes` | `2097152` | 完整 HTML 的 UTF-8 字节上限，包含内嵌渲染器和来源身份 |

调用 `artifactExports.create`，传入固定 `exportId`、`format: 'html'`，以及当前修订、历史修订或已保存观察的引用。导出当前粒子实验需要提供检查点。旧粒子修订使用原始初始状态或接续检查点。从回流读数继续的函数图会固定已保存的函数、参数、探针位置和读数，文件打开和重置时会恢复这些条件。其他 Scene 源码使用默认条件。浏览器提供引用，并在导出当前粒子实验时提供检查点。

响应结果未知时保持完整请求不变。重复已生成或失败请求会在耐久性 flush 后返回已有回执；重复待完成请求会明确继续其已固定输入。已有身份不受之后调低的输入字节或保留数量上限影响。失败请求需要新的导出身份才能再次尝试。即使首次请求失败，也拒绝同一身份对应不同意图。新输入超限会在追加记录和存储文件前拒绝；应缩减源码后发起新请求。

调用 `artifactExports.read`，传入所属 Session 和已生成的导出身份，读取通过完整性验证的精确字节。该操作不接受文件系统路径或任意附件引用。文件缺失或损坏时明确读取失败，同时保留已生成的历史事实。文件生成、请求浏览器下载和用户实际保存文件是分别成立的事实。

-----

<a id="understand-the-implementation"></a>
## 理解实现

Artifact 所有者按引用从 Session 及其继承的历史中读取精确的源码。粒子检查点针对原始源码重算。导出所有者追加完整的待完成 `artifact/export` 记录，先 flush 再生成文件。生成器 `artifact/scene-export` 可在浏览器运行，并在输出中嵌入版本、原始 Session 身份和来源身份。继承记录保留首次接纳导出的 Session。附件存储完整提交不可变文件后，才追加并 flush 已生成记录。生成或存储失败会保留失败记录与原始输入。追加或 flush 失败时结果未知。

私有且完成等待注册的 `artifactExports` Projection 恢复完整当前记录，不执行文件 I/O、渲染或 Agent 输入。可能较大的源码副本不进入 Session 摘要。重启后的待完成记录表示工作未完成或结果未知，恢复记录不会启动生产者；明确继续才能完成该精确输入。进程内相同请求并发调用共享一次操作，插件卸载会等待已接纳操作结算。

本地附件提供者将文件保存在所选实例的 `AGENTRANS_HOME/attachments/v1`，因此开发、验证和用户实例沿用现有文件系统隔离。导出不写入源码文件，也不接受任意用户指定的 Host 路径。

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Artifact](../../../docs/subsystems/artifact.zh.md) — 源码修订与已保存观察。
- [附件服务](../../attachment/attachment/README.zh.md) — 不可变文件引用与验证读取。
- [Artifact Client](../../client/ui-artifact/README.zh.md) — 导出控件、冻结重试与下载请求。

-----

<a id="model-experience"></a>
## 模型体验

### 用户请求的 HTML 生成

#### 模型看到什么

`artifact/export` 记录导出事实；导出或下载不增加模型输入，也不启动模型轮次。请求、固定输入与结果作为耐久 Session 事实，供支持它们的 Session 读取器使用；它们不会自动成为助手证据，也不表示浏览器已保存文件。

#### Token 影响

生成、继续、读取或下载都不增加请求 token。之后明确编写的消息可以依普通消息规则描述结果。

#### KV Cache 影响

导出记录不改写模型历史，也不使现有前缀失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 只支持原生 Scene HTML。自由 HTML 运行状态、视频和批量渲染不属于本操作。
- 粒子导出保留选定固定步。从回流读数继续的函数图保留已保存的基线，此后在视图内的调整属于临时状态。
- 待完成工作不自动恢复。未来昂贵生产者应使用现有 Jobs 能力，并将结果文件与进程内任务状态分开。
- 不提供结果删除、保留期清理和附件垃圾回收。结果索引达到上限时拒绝新身份，不淘汰已有事实。

<a id="dev-note"></a>
### 开发备注

重点测试覆盖存储期间源码更新、已保存的历史源码、重试回执、flush 未知结果、精确输出上限、文件完整性、检查点后缀恢复和卸载。构建后 Web 重放负责验证实际分发的用户控件。
