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

The hosted workflow uses the repository secret `AGENTRANS_UPDATE_SIGNING_KEY` and checks it against the public key pinned in the application. Preflight and review use read permissions. Draft staging requires `contents: write`. The installed application downloads update metadata and installers anonymously from the public repository.

<a id="publish-a-release"></a>
## Publish a release

Build Windows x64, macOS arm64 and macOS x64 with [hosted packaging](../../../.github/workflows/agentrans-hosted-package.yml). Use one `all` run or separate runs for the three architectures. A Windows run and a combined Mac run also form a complete set. Every run must use the same commit, version and channel.

In the [release workflow](../../../.github/workflows/desktop-release.yml), supply the run IDs in `package_run_ids`, the full commit in `source_sha`, and the packaged `version` and `channel`. Separate multiple run IDs with commas. The workflow also accepts these inputs and the signing secret from a caller in the same repository through `workflow_call`.

- `preflight` checks the archive digests, the package identities and the update indexes. It merges the two Mac indexes from separate runs, verifies Ed25519 signatures with the pinned key, and retains a signed inventory report.
- `review` also compares the visible Release with the signed inventory. This operation uses read permissions and can verify a public Release.
- `stage-draft` explicitly authorizes a separate write job. That job rechecks the signed inventory, uploads and reviews the draft. Opening the reviewed draft to the public is a separate action.

The Release tag is `v<version>`. The npm release family uses `dsh-v*`.

<a id="update-channel"></a>
## Update channel

`latest` publishes a release; `nightly` publishes a prerelease. The packaged application maps the same two channels onto that release type, so a nightly build never offers a latest build to its users.

The release must include a detached Ed25519 signature (`*.yml.sig`) beside every channel index under the same tag. The application verifies the raw YAML bytes with that signature and its pinned public key before it parses the index, offers the update, or downloads an installer.

If GitHub returns HTTP 404 for the YAML, the application can try an earlier compatible release. A missing or invalid signature stops the update check. The application also verifies the downloaded installer's own signature before allowing installation.

<a id="repeat-publication"></a>
## Repeat publication

A retry reuses an asset only after verifying its size and digest. Publish a corrected build under a new version so the channel index can identify the exact new bytes.
