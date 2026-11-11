---
kind: upgrade-guide
description: "The SDK chooses source or built runtime from its imported entry instead of falling back according to file presence."
---

# Keep SDK runtime selection explicit

English | [中文](guide.zh.md)

## Change

Without `dshBin`, the SDK previously preferred an existing built CLI and otherwise fell back to source. An old build could therefore change a source test's runtime and compatibility patches.

Workspace TypeScript SDK imports now always launch the matching source CLI with its source compatibility patch. Published JavaScript SDK imports always launch the matching built CLI; a missing executable is an error, even if source files exist. Package-version checks remain required. The explicit `dshBin` override still selects a CLI module.

## Migration

1. Keep repository source aliases when running SDK tests from source. Existing `apps/cli/lib/bin.js` no longer overrides those source imports.
2. Before using the published SDK, prepare its same-version `@agentrans/cli` executable. In a checkout, run `pnpm run build`; an incomplete installed payload must be repaired rather than relying on source fallback.
3. If your embedding intentionally uses a separately prepared CLI, pass its path as `dshBin`. Confirm the launched profile and package versions before exercising a provider. See the [SDK client](../../../../packages/sdk/client/README.md).
