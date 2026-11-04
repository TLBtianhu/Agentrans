---
description: "Single-root Agentrans installation layout, manifests, packaging, integration states, runtime activation, and scoped uninstall."
kind: "package-reference"
---

# @deepseek-ai/dsh-product-layout

English | [中文](README.zh.md)

## Summary

This package owns the distribution-lifecycle slices for Agentrans: one complete installation root, derived `app`, `data`, `models`, `runtime-envs`, and `integrations` subdirectories, install manifests, four App/DSH integration states, runtime activation, file-level portable/installed packaging, and scoped uninstall execution. It does not modify DSH profiles or Windows registration directly.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Create a layout with `ProductLayout.fromRoot(root, channel)`. The root is the only independent path. DSH data lives below `data/dsh/home` and `data/dsh/agents`; the integration package lives at `integrations/dsh-agentrans`. `ensureProductLayout()` creates missing subdirectories without replacing existing data.

Use `createInstallManifest()`, `writeInstallManifest()`, and `readInstallManifest()` for durable installation state. The manifest belongs at `data/install/manifest.json` and carries `layoutVersion`, product identity, channel, root, app version, timestamps, and asset records.

Use `planInstall()` to preview an install, then `packPortable()` or `packInstalled()` to execute it from a clean application payload. Payloads containing `data`, `models`, `runtime-envs`, `integrations`, `.env`, credentials, or private keys are rejected. Upgrades replace only `app` and preserve existing data and assets. Installed packaging reports Windows registration operations separately; portable packaging reports none.

Use `planUninstall()` to preview removal scope and `executeUninstallPlan()` to execute it. The default removes only `app` and regenerable cache. Full deletion requires confirmation. Integration removal happens before selected paths, followed by Windows registration cleanup through supplied callbacks.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`inspectIntegrationState()` distinguishes `ready`, `app-only`, `empty`, and `integration-only`. `assertIntegrationUsable()` rejects the last state because an adapter cannot work without the application.

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

- File-level packaging and uninstall are implemented, but there is no signed installer, native registration backend, or interactive uninstall UI yet.
- Pre-1.0 layout changes are not migrated; no old-structure backup or compatibility path is promised.
- Asset downloads and hash computation are supplied by callers; this package owns activation order and state, not a network client.
- DSH integration enablement and removal use the host's formal plugin-management API and are not mounted by this slice.

<a id="dev-note"></a>
### Dev Note

None.
