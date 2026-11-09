---
description: "Publish completed Desktop installers and update metadata as a GitHub Release. Build configuration and signing operations have separate owners."
---

# Desktop publication

English | [中文](README.zh.md)

## Summary

Publish completed Desktop installers and their update metadata as a GitHub Release. The packaged application embeds `provider: github` with this repository's coordinates, so `electron-updater` reads the channel metadata from the release assets and needs no download service of its own. Build configuration and signing operations have separate owners.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Publish a release](#publish-a-release)
- [Update channel](#update-channel)
- [Repeat publication](#repeat-publication)

<a id="prerequisites"></a>
## Prerequisites

Publication needs a token with `contents: write` on the repository in `GH_TOKEN` (or `GITHUB_TOKEN`), and a package built by `pnpm run package:<target>`. The repository is public: an installed application downloads update metadata and installers anonymously, so a private repository cannot serve updates without an embedded token.

<a id="publish-a-release"></a>
## Publish a release

```sh
pnpm run package:win:x64
node --import tsx apps/desktop/scripts/publish-github-release.ts .desktop-build/artifacts <version> latest
```

The uploader collects the target's installer, blockmaps, and channel metadata from the artifact directory, then creates the release when absent and attaches each file. Tag names are `desktop-v<version>`, distinct from the `dsh-v*` tags the npm family publishes from.

<a id="update-channel"></a>
## Update channel

`latest` publishes a release; `nightly` publishes a prerelease. The packaged application maps the same two channels onto that release type, so a nightly build never offers a latest build to its users.

<a id="repeat-publication"></a>
## Repeat publication

An asset already present on the release is skipped rather than replaced: a retried publication never swaps bytes a user may already be downloading. Publishing a corrected build therefore needs a new version, which is also what keeps the checksum in the channel metadata truthful.
