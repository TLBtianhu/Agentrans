# Agentrans 更新签名公钥

[English](README.md) | 中文

- **算法：** Ed25519。
- **指纹：** `ed25519-sha256-098885a5447f876f616ecd3cbdb156737cc6f4c00601958b1c78088842a81753`。
- **公钥文件：** `agentrans-update-ed25519-public.pem`。

本文件承载 Agentrans 发布物的唯一信任根。应用在 `apps/desktop/src/update-signing-key.ts` 中为自己更新所固定的公钥，与本 PEM 中供 `product-layout` 的 `verifyReleaseManifest()` 使用的公钥是同一把；因此同一个密钥对既为应用验签的产物签名，也为安装器读取的发布清单签名。两份公钥一旦出现差异，`apps/desktop/tests/update-signing-key.spec.ts` 会失败。

匹配的私钥只存在于发布环境，即发布工作流传给签名步骤的 `AGENTRANS_UPDATE_SIGNING_KEY` 密钥（仓库目前仍以改名前的 `DSH_UPDATE_SIGNING_KEY` 名称保存它，工作流两个名称都读）。不得提交、打印、放入 fixture 或复制到构建输出。

此公钥不是 Windows Authenticode 或 EV 证书，也不建立 SmartScreen 信任：未签名的构建在安装和首次打开时仍会给出系统警告。

轮换密钥意味着先发布一个携带后继公钥的构建，再更换密钥；已安装的构建只信任随它一起发布的公钥。
