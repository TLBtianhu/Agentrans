---
kind: upgrade-guide
description: "Uninstall refuses linked removal roots or ancestors and stops reporting success when selected files remain."
---

# Handle incomplete uninstall

English | [中文](guide.zh.md)

## Change

The production uninstall CLI checks the installation root, its ancestors and every selected removal path before deletion. A symbolic link or junction in those paths is refused with `UNINSTALL_PATH_UNSAFE`; no selected path is removed during this preflight. Links inside an ordinary selected subtree are unlinked without visiting their targets. Missing selected paths remain safe to retry.

Windows NSIS uninstall now stops with a nonzero exit code when native cleanup reports a refusal or deletion failure. It retains the uninstall registration and retry entry instead of showing successful completion. Earlier removals can already have taken effect. Interactive errors explain recovery; silent failures retain a separate diagnostic report.

Shared registry entries and shortcuts must also belong to the requested installation. A foreign `InstallLocation`, shortcut target, working directory or arguments refuses cleanup before application removal. Missing metadata does not authorize removing another installation's shortcut.

The CLI preserves completed operations, the failed operation and available cause code in its error JSON. Neither interface rolls back completed removals. See the [library](../../../../packages/boot/product-layout/README.md) and [Windows uninstall rules](../../../../apps/desktop/README.md#windows-uninstall-rules).

## Migration

1. Before uninstalling, stop this installation's application and CLI processes. Keep the installation root and selected category roots as ordinary directories; inspect a reported linked path without deleting its target or redirecting cleanup there.
2. Automation must treat nonzero exit as incomplete uninstall. Preserve the report or CLI error JSON and check `completed` and `failedOperation` when present; do not equate a missing app executable with completed cleanup.
3. Resolve the reported path or file-use problem and explicitly retry the same scope. Missing paths are allowed, and registration cleanup follows successful selected-path removal. Retained sessions, settings, models, runtimes and exports follow the chosen scope.
4. Verify failure handling in a disposable installation: retain an external sentinel behind a junction, confirm the refusal leaves registration available, remove only the test link, and confirm an explicit retry completes. Use the isolated native runner linked from the Desktop README; existing user or development data is not a test fixture.
