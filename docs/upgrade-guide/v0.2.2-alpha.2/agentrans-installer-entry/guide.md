---
kind: upgrade-guide
description: "Agentrans Windows packaging uses a versioned unsigned entry and refuses generic upstream release paths."
---

# Use the Agentrans installer entry

English | [中文](guide.zh.md)

## Change

The Agentrans Windows installer entry no longer supplies placeholder remote-update policy. It accepts only unsigned Windows x64 packaging, publishes nothing, and registers no upstream protocols. Its output is `agentrans-<version>-win-x64-unsigned.exe`; the filename and embedded metadata share the resolved build version instead of a hardcoded filename version. Generic upstream configuration and publication paths reject the Agentrans application ID.

## Migration

1. Build Agentrans candidates with `node apps/desktop/scripts/package-agentrans-installer.mjs`, rather than generic upstream release commands. Remove inherited `AGENTRANS_DESKTOP_AUTO_UPDATE_ENV`, update-channel, and mandatory-update policy settings for this entry. It rejects conflicting release configuration instead of silently repurposing it.
2. Update artifact collection to match `artifacts/agentrans-installer/agentrans-<version>-win-x64-unsigned.exe`. Inspect the resolved version and product identity before installation.
3. Treat this artifact as an unsigned candidate. Signed Agentrans publication and update delivery need their own configured release path; do not substitute the upstream feed or signing identity. See [distribution boundaries](../../../../DISTRIBUTION.md).
