---
description: "Publish completed Desktop installers and update metadata as a GitHub Release. Build configuration and signing operations have separate owners."
---

# Desktop publication

English | [中文](README.zh.md)

## Summary

Publish completed Desktop installers and their update metadata as a GitHub Release. The packaged application embeds `provider: github` with this repository's coordinates, so `electron-updater` reads the channel metadata from the release assets and needs no download service of its own. Build configuration and signing operations have separate owners.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Review signed installers](#review-signed-installers)
- [Prepare a release draft](#publish-a-release)
- [Update channel](#update-channel)
- [Repeat publication](#repeat-publication)

<a id="prerequisites"></a>
## Prerequisites

Publication needs a repository token with `contents: write` in `GH_TOKEN` (or `GITHUB_TOKEN`), complete packaged files, and `AGENTRANS_UPDATE_SIGNING_KEY`. The signing key must match the Ed25519 verification key pinned by Agentrans. Installed applications download updates anonymously, so the release repository must be public.

<a id="review-signed-installers"></a>
## Review signed installers

Use [Verify signed Desktop artifacts](../../../.github/workflows/desktop-signed-intake.yml) with three successful `production` packaging run IDs for Windows x64, macOS arm64 and macOS x64. Enter the shared source commit, the trusted packaging workflow commit, the version and the update channel. Use runs that include `desktop-signed-build.json`, which records the actual source checkout and the files it produced.

Configure the repository variables `DESKTOP_WINDOWS_CERT_THUMBPRINT` with the Windows signing certificate's 40-digit hexadecimal thumbprint and `DESKTOP_MACOS_TEAM_ID` with the 10-character Apple Team ID. For `DESKTOP_MACOS_SIGNING_IDENTITY`, enter the certificate name after `Developer ID Application:`, for example `Example Company (AB12CD34EF)`. These are public values used to check the installers on native runners. The [packaging guide](../packaging/README.md) covers machine configuration and signing credentials for producing the inputs.

The workflow has read-only repository and Actions permissions. It checks the run, archive, individual file digests and native signatures before merging the two macOS feeds. The `signed-desktop-intake-report` Actions artifact carries the report and the merged feed. This workflow requires three real production builds for an end-to-end signing and notarization check.

<a id="publish-a-release"></a>
## Prepare a release draft

Run the uploader from `apps/desktop` with the directory of a completed package and the channel selected when it was built.

```sh
pnpm run publish:github -- <artifact-directory> <version> latest --draft-only
```

The uploader checks the installer set, update metadata and referenced checksums before signing the files. For a draft run, the GitHub Release for `v<version>` stays a draft after its complete asset and signature inventory matches the local files. The [release workflow](../../../.github/workflows/desktop-release.yml) checks the selected successful hosted packaging run against the requested version, channel and declared targets, then uses its build commit for the release tag. Choose `all` in the packaging workflow for a release with Windows and both macOS architectures. Use a packaging run that records those inputs in its run name.

The release workflow always keeps the Release as a draft. It currently stages artifacts from the hosted packaging workflow. The separate supervised system-signing workflows retain their own Actions artifacts.

<a id="update-channel"></a>
## Update channel

`latest` publishes a stable version as the latest release. `nightly` publishes a prerelease. Hosted packages carry electron-builder feed filenames derived from the build version, such as `alpha-mac.yml` for an alpha build. The hosted run records the selected update channel separately.

<a id="repeat-publication"></a>
## Repeat publication

Retry with the same package files and signing key to resume an interrupted draft. Present assets are reused only after their size and SHA-256 match. An asset with conflicting bytes or a failed upload state stops publication. Draft-only retries stop if the Release is already public. Publish changed package bytes under a new version.
