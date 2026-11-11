# Agent Note：固定公钥证明更新由谁发布

Status: implemented

[English](2026-11-09-update-signature-pinned-key.md) | 中文

## 问题

桌面更新器用通道元数据列出的 SHA-512 校验已下载的文件。这只能证明字节与该元数据一致，完全不能证明两者由谁写出：如果某个版本的元数据与安装包被同时替换，校验依然通过。GitHub Release 是同时提供两者的单一点，而更新会在用户确认后安装。

商业代码签名身份可以顺带解决操作系统层面的问题，但本仓库目前没有 macOS 与 Windows 的签名身份。

## 决定

每个发布的产物都附带一份分离式 Ed25519 签名，已安装的构建在允许安装前用编译进自身的公钥校验已下载的安装包。

- 签名覆盖产物的 SHA-256 摘要而非文件本身：Ed25519 会对消息内部再做哈希，因此对摘要签名等于第二层独立哈希，150 MB 的安装包只需单次流式读取，无需整块载入内存。
- 公钥是 [update-signing-key.ts](../../../../apps/desktop/src/update-signing-key.ts) 中的常量。私钥只存在于发布环境，即仓库 secret `AGENTRANS_UPDATE_SIGNING_KEY`。
- 缺少该密钥时发布拒绝执行，因为未签名的版本会在任何信任该公钥的地方安装。签名缺失或不匹配会以可见失败结束下载；另一种选择是安装无人担保的字节。
- 签名地址由更新器已解析出的 Release tag 与 electron-builder 写入 `app-update.yml` 的 feed 坐标推导，因此信任锚与下载来自同一个 Release。

[update-signature.ts](../../../../apps/desktop/src/update-signature.ts) 负责签名、校验与文件摘要；[update-verification.ts](../../../../apps/desktop/src/update-verification.ts) 负责坐标、地址构造以及哪些产物必须校验；[update-coordinator.ts](../../../../apps/desktop/src/update-coordinator.ts) 在下载操作内部执行校验，因此未通过校验的更新永远不会进入就绪状态。

## 考虑过的替代方案

**购买 CA 签发的代码签名证书与 Apple Developer ID。** 消除操作系统警告仍然需要它，macOS 公证也只能通过它完成。但它不作为*第一步*，因为它对"更新由谁发布"没有改变：更新器比对的是 Authenticode 发布者名称，而被替换的版本同样带有该名称。

**只对通道元数据签名。** 否决：electron-updater 在应用代码能读到原始字节之前就取回并解析了元数据，校验只能重新下载并核对，而安装包自身的摘要仍然需要检查。

**对整份文件签 Ed25519。** 否决：Node 未暴露 Ed25519 的预哈希模式，校验会把整个安装包读入内存。

**引入 minisign 或 PGP。** 否决：多一层依赖，而 `node:crypto` 直接支持 Ed25519。

## 后果

首次安装时 Windows SmartScreen 与 macOS Gatekeeper 仍会警告，因为二者都不查询这把公钥。轮换签名密钥需要发布一个携带下一把公钥的构建，因此泄漏的密钥只能由用户已经信任的构建退役。缺少 secret 的发布会直接失败，而不会产出能被更新器接受的版本。

## 测试

`apps/desktop/tests/update-signature.spec.ts` 覆盖签名往返、签名后被改动的文件、来自另一把密钥的签名、畸形输入以及非 Ed25519 的密钥材料。`apps/desktop/tests/update-verification.spec.ts` 覆盖内嵌 feed 坐标、推导出的签名地址、派生产物被跳过，以及三种拒绝：签名不匹配、签名缺失、Release 没有 tag。`apps/desktop/tests/update-coordinator.spec.ts` 证明校验失败的更新永远不会进入就绪状态，也不会调用 `quitAndInstall`。`apps/desktop/tests/publish-github-release.spec.ts` 证明每个产物写出一份签名，且不可用的密钥材料会被拒绝。
