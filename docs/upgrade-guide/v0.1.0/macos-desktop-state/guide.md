---
kind: upgrade-guide
description: "The macOS Desktop bundle and terminal command share a product data directory in Application Support."
---

# macOS Desktop data directory

English | [中文](guide.zh.md)

## Change

Packaged Agentrans previously rejected ordinary macOS launches. The macOS app and its bundled terminal command now use `~/Library/Application Support/com.agentrans.app` in the OS account's home directory. Moving or replacing the application bundle preserves this location.

## Migration

1. Copy `Agentrans.app` from the DMG or extract it from the ZIP, then open it. Keep any data from prior test launches in its original location.
2. Confirm that Agentrans opens the welcome screen on first launch and creates `~/Library/Application Support/com.agentrans.app/data`.
