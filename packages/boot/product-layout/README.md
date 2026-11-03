---
description: "Single-root Agentrans installation layout, manifests, integration states, and runtime activation."
kind: "package-library"
---

# @deepseek-ai/dsh-product-layout

English | [中文](README.zh.md)

## Summary

This package owns the first distribution-lifecycle slice for Agentrans: one complete installation root, derived `app`, `data`, `models`, `runtime-envs`, and `integrations` subdirectories, an install manifest, four App/DSH integration states, and a runtime activation gate. It does not modify DSH profiles or install the application.

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

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`inspectIntegrationState()` distinguishes `ready`, `app-only`, `empty`, and `integration-only`. `assertIntegrationUsable()` rejects the last state because an adapter cannot work without the application.

`activateRuntime()` verifies an asset, rewrites `pyvenv.cfg` to the actual runtime root, checks `Scripts/python.exe`, runs the supplied interpreter self-test, and only then writes `active-runtime.json`. Verification, relocation, or self-test failure prevents activation. Asset locations are root-relative so a portable root can move.

-----

<a id="model-experience"></a>
## Model Experience

This is a Host library, not a model-facing tool. It adds no prompt section, tool schema, token cost, or KV-cache content. Install and integration state is local application state, not model input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- No full installer, portable packager, signed updater, or interactive uninstaller is implemented yet.
- Pre-1.0 layout changes are not migrated; no old-structure backup or compatibility path is promised.
- Asset downloads and hash computation are supplied by callers; this package owns activation order and state, not a network client.
- DSH integration enablement and removal use the host's formal plugin-management API and are not mounted by this slice.

<a id="dev-note"></a>
### Dev Note

None.
