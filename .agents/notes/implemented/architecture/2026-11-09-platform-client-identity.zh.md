# Agent Note：Platform 客户端身份属于内嵌客户端

Status: implemented

[English](2026-11-09-platform-client-identity.md) | 中文

## 问题

[账号服务定义](../../../../packages/credentials/deepseek-account/README.zh.md)同时生成 Platform 的客户端身份请求头。它唯一的调用方是[桌面 Platform 视图](../../../../apps/desktop/src/platform-view.ts)，而只有那里知道构建版本、当前界面语言与 UTC 偏移。于是需要这些请求头的客户端必须依赖账号包来描述自己的界面，而定义包——本该只命名一项能力——却承载了 DeepSeek 的线上术语。

## 决定

这条 seam 保留三个角色与一个依赖方向：

- [定义包](../../../../packages/credentials/deepseek-account/src/index.ts)声明 `deepseekAccount`、`PlatformSession`、`AccountClientMetadata` 与各操作签名。它不生成任何请求头，也不知道任何请求头名称。
- provider 拥有部署请求头，并通过 `PlatformSession.requestHeaders` 传递，因为部署方才知道自己的 Platform 来源需要哪些请求头。
- 内嵌客户端在 [platform-client-headers.ts](../../../../apps/desktop/src/platform-client-headers.ts) 中组合自身界面的客户端身份：平台、构建版本、线上语言、UTC 偏移，以及对自身来源请求的 Cookie 合并。

[verify-seam-roles](../../../../scripts/verify-seam-roles.ts) 用与[能力 seam 页面](../../../../docs/capability-seams.zh.md)相同的 `SERVICE_ROLES` 表强制这个方向：被声明的消费者或定义包本身不得在运行时 import provider。`import type` 仍然允许，因为声明合并需要 provider 的增强而不加载它；`ctx.get('deepseekAccount')` 是查找而非导入。

## 考虑过的替代方案

**把工具函数迁进 provider。** 否决：桌面不是 provider，这等于把"依赖这条 seam"换成"依赖某一个实现"，而这些被组合的值属于调用方，不属于部署方。

**在服务上新增 `platformRequestHeaders(client)` 方法。** 否决：这是只有一个调用方的公开服务方法，[packages/AGENTS.md](../../../../packages/AGENTS.md) 明确把它列为 seam 的反面；一旦出现第二个访问同一 Platform 的客户端，这就是自然的演进方向。

**把工具函数留在定义包。** 否决：那正是把线上协议塞进 seam 定义的原因。

## 后果

未来访问该 Platform 的客户端会各自组合身份请求头，而不是共享一份实现，因此两处组合可能漂移。shipped-but-off 的 `web-deepseek-api` 不再有共享的线上语言工具；重新启用它时，要么自行组合身份，要么替换这个决定。定义包除抽象服务类外已无运行时行为，因此它现在没有自己的 spec。

## 测试

`apps/desktop/tests/platform-client-headers.spec.ts` 固定平台映射、语言归约与 Cookie 合并。`apps/desktop/tests/platform-view.spec.ts` 保留视图自身的请求头注入与跨源剥离行为。`scripts/verify-seam-roles.spec.ts` 证明该检查会拒绝值导入，并接受与 `ctx.get` 查找并存的 type-only 导入。
