---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-07-fixed-source-artifact-export

[English](2026-11-07-fixed-source-artifact-export.md) | 中文

## 概述

新增必需的 artifact/export 事实，保存不可变请求身份、完整原始 Scene 输入、明确导出器/运行条件，以及 pending、ready 或 failed 生成状态。就绪结果引用内容寻址附件字节，不在 Session 日志内嵌 HTML。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-fixed-source-artifact-export
baseline: false
changes:
  - root: "event:artifact/export"
    previous: null
    after: "a211f1c23f6644a71f8a487deea922b5f61be86197e450ab425a8c50e34d39b9"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

事件判别值为新增项，读取时仍为必需事实。没有导出的既有 v4 Session 不变。已发布 v4 编解码器保留完整事件，不认识 artifact/export 的读取器以 SessionFormatUnsupportedMigrationError 明确拒绝恢复，且不修改原始数据。认识事件的读取器保留原始源码、检查点、生成状态和文件引用。不修改冻结编解码器、旧 schema 代际或格式版本。

<a id="verification"></a>
## 验证

packages/artifact/artifact-export/tests/reader-compat.spec.ts 经已发布 v4 编解码器验证旧读取器无修改拒绝与新读取器完整往返相等（2 项通过）。packages/sdk/client/tests/artifact-export-projection.spec.ts 验证事件与通知保留完整事实且助手输出不变；Python SDK 参数化导出投影场景也通过。Host 行为测试覆盖固定来源重试与结果文件恢复。

<a id="dev-note"></a>
## 开发备注

无。
