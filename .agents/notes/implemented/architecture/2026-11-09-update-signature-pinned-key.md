# Agent Note: A pinned key proves who published an update

Status: implemented

English | [中文](2026-11-09-update-signature-pinned-key.zh.md)

## Problem

The Desktop updater verifies a downloaded file against the SHA-512 its channel metadata lists. That proves the bytes match the metadata and says nothing about who wrote either: a release whose metadata and installer were both replaced verifies cleanly. The GitHub release is a single point that serves both, and the update installs with the user's approval.

A commercial code-signing identity would settle this for the operating system as well, and the repository does not have one for macOS or Windows.

## Decision

Each published artifact carries a detached Ed25519 signature, and an installed build verifies the downloaded installer against a public key compiled into it before the update may install.

- The signature covers the artifact's SHA-256 digest, not the file: Ed25519 hashes its message internally, so signing a digest is a second independent hash and a 150 MB installer streams through one pass instead of a buffer.
- The public key is a constant in [update-signing-key.ts](../../../../apps/desktop/src/update-signing-key.ts). The private key exists only in the release environment as the `DSH_UPDATE_SIGNING_KEY` repository secret.
- Publishing refuses to run without that key, because an unsigned release installs anywhere the key is trusted. A missing or mismatched signature ends the download with a visible failure; the alternative is installing bytes nobody vouched for.
- The signature URL derives from the release tag the updater already resolved and the feed coordinates electron-builder embedded in `app-update.yml`, so the trust anchor and the download come from one release.

[update-signature.ts](../../../../apps/desktop/src/update-signature.ts) owns signing, verification, and the file digest; [update-verification.ts](../../../../apps/desktop/src/update-verification.ts) owns coordinates, URL construction, and which artifacts must verify; [update-coordinator.ts](../../../../apps/desktop/src/update-coordinator.ts) runs it inside the download operation, so an unverified update never reaches the ready state.

## Alternatives considered

**Buy a CA-issued code-signing certificate and an Apple Developer ID.** Still required to remove the operating-system warnings, and it is the only way to notarize a macOS build. Rejected as the *first* step because it changes nothing about update authorship: the updater compares the Authenticode publisher name, which a compromised release also carries.

**Sign only the channel metadata.** Rejected: electron-updater fetches and parses the metadata before application code can inspect the raw bytes, so verification would have to re-fetch and reconcile it, and the installer's own digest would still need checking.

**Sign the whole file with Ed25519.** Rejected: Ed25519 has no pre-hash mode in Node, so verification would load the entire installer into memory.

**Adopt minisign or PGP.** Rejected for the extra dependency; `node:crypto` carries Ed25519 directly.

## Consequences

Windows SmartScreen and macOS Gatekeeper continue to warn on first install, because neither consults this key. Rotating the signing key requires shipping one build that carries the next public key, so a leaked key can only be retired by a build users already trust. A build published without the secret fails at publish time rather than producing an updater-acceptable release.

## Testing

`apps/desktop/tests/update-signature.spec.ts` covers the signature round trip, a file changed after signing, a signature from another key, malformed input, and key material that is not Ed25519. `apps/desktop/tests/update-verification.spec.ts` covers the embedded feed coordinates, the derived signature URL, derived artifacts being skipped, and the three refusals: a mismatched signature, a missing signature, and a release without a tag. `apps/desktop/tests/update-coordinator.spec.ts` proves an update whose verification fails never reaches the ready state and never calls `quitAndInstall`. `apps/desktop/tests/publish-github-release.spec.ts` proves one signature is written per artifact and that unusable key material is refused.
