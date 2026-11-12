# Agentrans update signing public key

English | [中文](README.zh.md)

- **Algorithm:** Ed25519.
- **Fingerprint:** `ed25519-sha256-098885a5447f876f616ecd3cbdb156737cc6f4c00601958b1c78088842a81753`.
- **Public key:** `agentrans-update-ed25519-public.pem`.

This file carries the single trust root for Agentrans releases. The key the application pins in `apps/desktop/src/update-signing-key.ts` for its own updates is the same key this PEM holds for `verifyReleaseManifest()` in `product-layout`, so one keypair signs both the artifacts the application verifies and the release manifests the installer reads. `apps/desktop/tests/update-signing-key.spec.ts` fails when the two public copies drift apart.

The matching private key lives only in the release environment, as the `AGENTRANS_UPDATE_SIGNING_KEY` secret that the publish workflow passes to the signing step (the repository still stores that secret under its pre-rename name, `DSH_UPDATE_SIGNING_KEY`, and the workflow reads either). Never commit it, print it, place it in fixtures, or copy it into build output.

This key is not a Windows Authenticode or EV certificate and establishes no SmartScreen trust: an unsigned build still warns on install and on first open.

Rotating the key means publishing one build that carries the successor public key before the secret changes, because an installed build trusts only the key that shipped inside it.
