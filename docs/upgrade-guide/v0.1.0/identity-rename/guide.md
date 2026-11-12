---
kind: upgrade-guide
description: "The product, its command, its environment variables, its home directory, and its manifest keys all take the Agentrans name; nothing reads the retired names."
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

There is no compatibility layer. A manifest that still carries `dsh`, `engines.dsh`, or `dsh.profile.bundles` does not load, and no code reads the retired home.

## Migration

1. If you never ran an earlier build, nothing to do: `agentrans` creates `~/.agentrans` on first use.
2. If `~/.dsh` holds sessions or credentials you want, move it yourself (`mv ~/.dsh ~/.agentrans`). The product neither reads nor moves it, and it does not merge two homes.
3. Rename the plugin manifest keys before installing: `"dsh"` becomes `"agentrans"`, `engines.dsh` becomes `engines.agentrans`, and `dsh.profile.bundles` becomes `agentrans.profile.bundles`. A bundle that keeps the retired keys fails to load rather than loading half-configured.
4. Rename `dsh` to `agentrans` in scripts, aliases, CI steps, and desktop shortcuts. `AGENTRANS_HOME` replaces `DSH_HOME`, and the remaining `DSH_*` variables follow the same pattern.
5. To keep using the old directory, point `AGENTRANS_HOME` at it. That is a choice about where data lives, not a migration: the path still carries the retired name.
6. Do not move `~/.dsh` while another DeepSeek Harness installation runs from it. That installation would stop finding its data. Keep the two installations on separate homes.
7. There is no downgrade path: this release writes `agentrans.profile.bundles`, which an earlier build does not read.
