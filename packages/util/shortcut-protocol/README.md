---
description: "Physical-key types, versioned shortcut documents, and the persistence shape the Client UI and the Desktop main process both read."
kind: "package-reference"
---

# @deepseek-ai/dsh-shortcut-protocol

English | [中文](README.zh.md)

## Summary

The Client renders shortcut bindings and the Desktop main process stores them; both must agree on what a binding means, which edits are legal, and how a saved document is versioned. This package carries that agreement as plain functions and types, with no Client UI and no process access, so neither side has to import the other's build output.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Use this package

`parseShortcutDocument` reads a stored document and reports the three outcomes a caller must distinguish: a usable document, `invalid`, or `future` for a version this build does not understand. `effectiveShortcuts` resolves the document against a command catalog for one platform, and `bindingIssue` explains why a binding cannot be used instead of silently dropping it. `parseShortcutEdit` validates one requested change before anything is persisted.

`ShortcutPersistence` and the storage interfaces describe the sequence the Desktop follows: read, apply one edit, save, and report the revision. `normalizeBinding` and `bindingKey` reduce a user-facing binding to its comparable form, so two bindings that produce the same keystroke compare equal.

The package carries no Cordis plugin, service, or configuration.


## Understand the implementation

`binding.ts` owns the binding types and normalization. `configuration.ts` owns the versioned document, its parser, and the effective-shortcut projection. `persistence.ts` owns the storage contracts and the save result types. `native.ts` owns the Desktop keyboard and shortcut IPC shapes. `index.ts` re-exports all four.

Nothing here reads `process`, a DOM, or a Cordis context, so the module evaluates identically in the Electron main process, a sandboxed preload, and the browser.

## Model Experience

None, as physical-key bindings reach the Client key handler and the Desktop store only; no model request carries them.

#### KV Cache effect

No invalidation: nothing here changes a request body.

## Known Limitations and Deferred Work

- The command catalog is a caller-supplied list; this package does not own it, so it cannot report a binding that names a command the product no longer ships.
- `parseShortcutDocument` rejects an unknown version rather than migrating it. A future version bump needs a successor parser here and a migration note in the upgrade guide.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Desktop main process and the Client both read this protocol, so a change here reaches both build outputs at once. When a binding or document field changes, update the Desktop persistence tests and the Client key handler tests in the same change; the split exists so neither side has to import the other's build output.

</details>
