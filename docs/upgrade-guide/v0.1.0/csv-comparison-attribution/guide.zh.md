---
kind: upgrade-guide
description: "导入的 CSV 对照事实改用 `attribution: 'user-imported'` 记录，不再使用已退役的字段名。"
---

# 用 `attribution` 记录导入的 CSV 对照

[English](guide.md) | 中文

## 变更

从 JSON 文件导入的 CSV 对照及其每次复用，现在都在已发送问题和 Host 草稿的对照事实中记录 `attribution: 'user-imported'`。同一字段已用 `attribution: 'program-reported'` 记录 HTML 读数。导出的对照 HTML 用 `data-csv-compare-attribution` 标记导入说明，Web 卡片使用 `data-csv-comparison-attribution`。

在 `0.1.0-test.20261119.1` 中发送的、带导入对照的问题仍使用已退役的字段名。读取器不再识别这些对照块：消息仍以文本留在对话中，但没有对照卡片、回放、下载和复用操作。同一 Session 内计算的对照和可携带的 JSON 对照文件不受影响。用已退役字段保存的对照草稿会在 Host 打开草稿存储时被移到一旁，不会恢复到输入框。

## 迁移

1. 在 Session 中重新导入原来的对照 JSON 文件，并把审阅后的页面附到新问题。新消息记录 `attribution`，并重新提供卡片操作。
2. 把读取导出 HTML 或 Web 卡片的脚本和选择器改为 `data-csv-compare-attribution` 与 `data-csv-comparison-attribution`。
3. 在新消息上用 **复现附加对照** 确认：回放显示 **用户导入** 说明。
