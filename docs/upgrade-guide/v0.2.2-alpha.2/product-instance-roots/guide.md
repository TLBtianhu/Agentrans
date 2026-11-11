---
kind: upgrade-guide
description: "Agentrans product launchers use isolated instance roots instead of inherited Harness homes."
---

# Agentrans product instance roots

English | [中文](guide.zh.md)

## Change

Repository `dsh`, `start:web`, `dev:web`, and Desktop development now establish a per-worktree instance outside the source tree. Inherited `AGENTRANS_HOME`, `AGENTRANS_AGENTS_HOME`, and `AGENTRANS_DESKTOP_USER_DATA_DIR` no longer select product state. `AGENTRANS_DEV_ROOT` is the explicit development override. Nonempty unmarked roots and roots owned by another purpose are rejected before state writes; existing data is not migrated.

The Windows packaged GUI and bundled CLI derive state from the same installation anchor. Isolated verification requires an explicit context matching that payload and its own marked state root. Packaged user startup on another platform requires a platform-specific adapter rather than applying the Windows layout inside an application bundle. Ordinary startup no longer registers the upstream `dsh` protocol.

The generic CLI executable and engine demos retain caller-managed Harness roots; they do not initialize an Agentrans development instance.

## Migration

1. Run product development through the repository `dsh`, `start:web`, `dev:web`, or `dev:desktop` commands. Remove old path overrides from product-launch instructions.
2. Omit `AGENTRANS_DEV_ROOT` for the stable per-worktree default, or set it to an absolute empty directory. Keep prior sessions and credentials at their original locations; do not add a development marker to an existing user directory.
3. Rebuild the application and verify that GUI, CLI, and Host resolve the same instance. A source checkout and its build directories must remain unchanged by runtime state writes.
4. Inspect existing operating-system protocol associations separately. This code change does not rewrite an already registered handler or repair installed shortcuts.
