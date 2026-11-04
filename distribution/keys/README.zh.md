# Agentrans 更新签名公钥

[English](README.md) | 中文

- **算法：** Ed25519。
- **指纹：** `ed25519-sha256-7ce3dd65bdcf9dafc651b6a68744fdf05d0d3628002fcef0a1c3fa5b4d2044a6`。
- **公钥文件：** `agentrans-update-ed25519-public.pem`。

此公钥用于验证 Agentrans 更新清单和发布物。它不是 Windows Authenticode 或 EV 证书，也不代表 Windows SmartScreen 信任。

匹配的私钥由本机在仓库之外保管。不得提交、打印、放入 fixture 或复制到构建输出。发布签名必须使用本机保管的私钥并记录上述指纹；验签只使用此公钥。

正式密钥轮换流程尚未实现。需要轮换前，必须提供过渡流程，让旧版更新器能够验证携带后继公钥的包。
