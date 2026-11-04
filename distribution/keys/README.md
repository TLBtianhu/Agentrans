# Agentrans update signing public key

English | [中文](README.zh.md)

- **Algorithm:** Ed25519.
- **Fingerprint:** `ed25519-sha256-7ce3dd65bdcf9dafc651b6a68744fdf05d0d3628002fcef0a1c3fa5b4d2044a6`.
- **Public key:** `agentrans-update-ed25519-public.pem`.

This public key verifies Agentrans update manifests and release artifacts through `verifyReleaseManifest()` in `product-layout`. It is not a Windows Authenticode or EV certificate and does not establish Windows SmartScreen trust.

The matching private key is machine-owned outside the repository. Never commit it, print it, place it in fixtures, or copy it into build output. Release signing must use the machine-owned key and record the fingerprint above; verification uses only this public key.

A production key-rotation procedure is not implemented yet. Before rotation is needed, publish a transition process that lets an older updater verify a package carrying the successor public key.
