---
description: "Publish completed Desktop installers and update metadata as a GitHub Release. Build configuration and signing operations have separate owners."
---

# Desktop publication

English | [中文](README.zh.md)

## Summary

Publish completed Desktop installers and their update metadata as a GitHub Release. The packaged application embeds `provider: github` with this repository's coordinates, so `electron-updater` reads the channel metadata from the release assets and needs no download service of its own. Build configuration and signing operations have separate owners.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Prepare a release draft](#publish-a-release)
- [Update channel](#update-channel)
- [Repeat publication](#repeat-publication)

<a id="prerequisites"></a>
## Prerequisites

Publication needs a repository token with `contents: write` in `GH_TOKEN` (or `GITHUB_TOKEN`), complete packaged files, and `AGENTRANS_UPDATE_SIGNING_KEY`. The signing key must match the Ed25519 verification key pinned by Agentrans. Installed applications download updates anonymously, so the release repository must be public.

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
