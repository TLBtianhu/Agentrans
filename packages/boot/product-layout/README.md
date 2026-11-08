---
description: "Single-root Agentrans installation layout, manifests, packaging, runtime activation, scoped uninstall, ReleaseManifest signing, signed archive installation, and Windows registration."
kind: "package-reference"
---

# @deepseek-ai/dsh-product-layout

English | [中文](README.zh.md)

## Summary

This package owns the distribution-lifecycle slices for Agentrans: one complete installation root, derived `app`, `data`, `models`, and `runtime-envs` subdirectories, install manifests, runtime activation, file-level portable/installed packaging, scoped uninstall execution, signed ReleaseManifest verification, signed archive installation, and user-level Windows registration. It does not modify DSH profiles or require administrator privileges.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Create a layout with `ProductLayout.fromRoot(root, channel)`. The root is the only independent path. Agentrans runtime data lives below `data/dsh/home` and `data/dsh/agents`; these are internal state paths, not an external DSH integration. `ensureProductLayout()` creates missing subdirectories without replacing existing data.

The lightweight `./launch-context` entry resolves code, resources, and writable instance paths before application loading. Source development uses a stable root outside the worktree; Windows packaged GUI and CLI use the same `root/app/resources` anchor. Only an explicitly isolated verification context matching that payload may override its state root. Development and verification roots require an exact purpose marker and reject existing unmarked data or app payloads. Preparation checks physical overlap and existing path links before creating state; it never creates `app`. A preparation failure may leave owned empty directories for retry.

Use `createInstallManifest()`, `writeInstallManifest()`, and `readInstallManifest()` for durable installation state. The manifest belongs at `data/install/manifest.json` and carries `layoutVersion`, product identity, channel, root, app version, timestamps, and asset records.

Use `planInstall()` to preview an install, then `packPortable()` or `packInstalled()` to execute it from a clean application payload. Payloads containing `data`, `models`, `runtime-envs`, `integrations`, `.env`, credentials, or private keys are rejected. Upgrades replace only `app` and preserve existing data and assets. Installed packaging reports Windows registration operations separately; portable packaging reports none.

Use `planUninstall()` to preview removal scope and `executeUninstallPlan()` to execute it. The default removes only `app` and regenerable cache. Full deletion requires confirmation. Execution captures the selected paths and rejects lexical escapes, linked roots or ancestors, and unreadable filesystem entries before deleting anything. It rechecks each target before removal and unlinks nested links without visiting their targets. `assertOwnedPaths()` alone remains a lexical check. Selected paths are removed before the supplied Windows registration callback; a later failure reports `completed`, `failedOperation` and its original cause, with no rollback.

Use `signReleaseManifest()` with a caller-owned Ed25519 private key and `verifyReleaseManifest()` with the trusted public key. The manifest records the filename, version, size, SHA-256, algorithm, key fingerprint, and signature. Verification rejects modified manifests, modified files, wrong keys, and malformed manifests before installation.

Use `planWindowsRegistration()` to preview uninstall and Start Menu registration, `registerWindowsRegistration()` to create them, and `verifyWindowsRegistration()` to inspect them. Call `assertWindowsRegistrationOwnership()` before deleting an installed application, then `removeWindowsRegistration()` after selected-path removal. Both registration resources must match the expected installation or be missing; a missing key does not authorize deleting a foreign shortcut. The removal command rechecks both resources before mutation. Custom command runners supply a matching `WindowsRegistrationReader`. The backend uses HKCU and needs no administrator privileges.

Use `installSignedRelease()` to verify a signed archive, unpack it inside the product root, install it, and optionally register Windows state. Verification failure changes no files. A registration failure returns the completed install and the registration error so partial state remains visible.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

There is no external DSH integration phase. Installation and scoped removal use only the root-owned app, data, models and runtimes. Windows registration has its own ownership checks. A failed update preserves pre-existing registration resources, which may contain partial writes. When both resources were initially missing, creation attempts guarded cleanup and retains any cleanup failure in `WindowsRegistrationError.rollbackError`. Uninstall retains completed removals rather than claiming rollback.

`activateRuntime()` verifies an asset, rewrites `pyvenv.cfg` to the actual runtime root, checks `Scripts/python.exe`, runs the supplied interpreter self-test, and only then writes `active-runtime.json`. Verification, relocation, or self-test failure prevents activation. Asset locations are root-relative so a portable root can move.

-----

<a id="model-experience"></a>
## Model Experience

### Distribution operations

#### What the model sees

Nothing model-facing. `ProductLayout`, `InstallManifest`, `packPortable`, `packInstalled`, and `planUninstall` are Host APIs, not model tools.

#### Token effect

No prompt or tool schema is added.

#### KV Cache effect

No model context is created or changed.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The [Desktop installer](../../../apps/desktop/README.md#windows-uninstall-rules) owns native uninstall UI and Windows cleanup diagnostics; this library supplies scoped file and registration operations.
- Filesystem checks and Node path-based deletion do not isolate against another process concurrently replacing directories. Stop writers before uninstall; these checks are not a handle-relative security primitive. Registry and COM ownership checks are not atomic against concurrent external replacement.
- Automatic user-package anchoring currently covers the Windows layout; other platforms require an explicit adapter. Source development and isolated verification remain independent of that layout.
- Pre-1.0 layout changes are not migrated; no old-structure backup or compatibility path is promised.
- Asset downloads and hash computation are supplied by callers; this package owns activation order and state, not a network client.

<a id="dev-note"></a>
### Dev Note

None.
