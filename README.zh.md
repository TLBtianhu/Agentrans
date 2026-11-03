# Agentrans

[English](README.md) | 中文

Agent + Trans：一个通用编程 Agent 工作台，把解释转化为可执行 Artifact，并支持可审计的探究分支。Agentrans 是基于 DeepSeek Harness 的独立下游项目，不是 DeepSeek 官方产品。

## 当前垂直切片

- **可执行 Artifact**——自包含 HTML、完整快照、compare-and-set 修订号、不透明 origin 的沙箱 iframe，以及用户确认的语义操作。Agent 更新 Artifact 时不必把源码重复粘贴进对话。
- **确认的交互**——浏览器操作先保持待发送，只有用户发送后才成为普通用户输入；不授予文件、网络或批准权限。
- **探究分支**——从 assistant 结论开岔为独立 Session，再预览并确认可见结论回流到直接父级。不复制子对话全文或 reasoning，也不隐式启动父级模型轮次。

随仓库提供的重放场景通过真实 Web 组合和真实浏览器验证这些流程，而不只是测试孤立组件。

## 开发态与用户态分离

编译产物只是产生分发物的中间结果，不是用户数据根。开发运行使用独立数据根，绝不复用上游 DSH profile。不要把本源码目录安装或运行覆盖到已有 DSH 上。

```powershell
pnpm install
pnpm run build
$env:DSH_HOME = 'C:\agent制作\.dev-data\harness'
$env:DSH_AGENTS_HOME = 'C:\agent制作\.dev-data\agents'
pnpm dsh web --no-open --port 58910
```

便携版与安装版的程序路径和数据路径必须彼此分离，并与上游 DSH 分离。打包前必须完成的外部身份审计见 [DISTRIBUTION.md](DISTRIBUTION.md)。

## 验证

```sh
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/artifact-interaction.e2e.ts apps/web/tests/branch-result.e2e.ts
```

浏览器场景重放已记录的模型流，不需要模型供应商凭证。需要使用本机已安装浏览器时设置 `DSH_PLAYWRIGHT_EXECUTABLE_PATH`。Artifact 场景覆盖创建/更新、计数器交互和仅确认后准入操作；分支场景覆盖开岔、预览、取消、确认回流，以及不隐式启动父级轮次。

## 上游与许可证

[UPSTREAM.md](UPSTREAM.md) 记录精确的上游 commit、归档哈希和源码同步角色。`upstream` 不是本产品的更新、账号、签名或遥测端点。

许可证为 [MIT](LICENSE)。第三方声明保留在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
