---
kind: upgrade-guide
description: "The product, its command, its environment variables, its home directory, and its manifest keys all take the Agentrans name; an existing installation keeps its data by moving the home once."
---

# The product takes its own name

English | [中文](guide.zh.md)

## Change

Everything a user or a plugin author types now says `agentrans` instead of `dsh`:

- the CLI is `agentrans` (`@agentrans/cli`), and the npm scope is `@agentrans/*`;
- environment variables are `AGENTRANS_*`, including `AGENTRANS_HOME`;
- the default home is `~/.agentrans` instead of `~/.dsh`;
- plugin manifests declare their author fields under `agentrans`, and their runtime range under `engines.agentrans`;
- a profile lists its layers under `agentrans.profile.bundles`.

Nothing reads the old names silently: a manifest that still carries `dsh` or `engines.dsh` loads with a `DeprecationWarning` naming the file and the rename, and the next write emits only the new key.

## Migration

1. If you never ran an earlier build, nothing to do: `agentrans` creates `~/.agentrans` on first use.
2. If `~/.dsh` holds your sessions and credentials, move it once with `agentrans home adopt`. The command renames the directory; it refuses when `~/.agentrans` already exists, when `~/.dsh` is missing, or when `~/.dsh` is not a directory, and it never merges two homes.
3. To keep using the old directory instead, start with `AGENTRANS_HOME=~/.dsh`. That is a temporary arrangement, not a migration: the path still carries the retired name.
4. Do not move `~/.dsh` while another DeepSeek Harness installation runs from it. That installation would stop finding its data. Keep the two installations on separate homes.
5. Rename `dsh` to `agentrans` in scripts, aliases, CI steps, and desktop shortcuts. `AGENTRANS_HOME` replaces `DSH_HOME`, and the remaining `DSH_*` variables follow the same pattern.
6. Rename the plugin manifest keys: `"dsh"` becomes `"agentrans"`, `engines.dsh` becomes `engines.agentrans`, and `dsh.profile.bundles` becomes `agentrans.profile.bundles`. The deprecation warning disappears once a manifest carries the new names.
7. To go back to the previous build, start it against the same directory with its own home variable pointing at `~/.agentrans`. A profile this release rewrote carries only `agentrans.profile.bundles`, which an earlier build does not read, so restore that profile's `package.json` from version control first.
