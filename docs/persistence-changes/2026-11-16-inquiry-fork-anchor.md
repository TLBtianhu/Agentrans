---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-16-inquiry-fork-anchor

English | [中文](2026-11-16-inquiry-fork-anchor.zh.md)

## Summary

Persists the selected assistant passage in the optional inquiry field of a manual child Session header and its JSONL header line.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-16-inquiry-fork-anchor
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-09-11-initial"
    after: "0be486bfbfc5be794025190e28b5049c72431826a474c98c9bc15b0783e580cc"
    decision: same-version
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "9ae228c37b0e13402dff526e4b2237f8a08ca2136bd3c8b006e39f664ff6520e"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The current reader accepts prior headers with inquiry absent. Ordinary forks keep the prior header shape. Earlier strict V4 readers refuse a header with inquiry before replay or mutation, so those readers cannot open newly created inquiry branches. Both readers refuse malformed headers before processing the event log.

<a id="verification"></a>
## Verification

The Session fork command tests verify the selected UTF-16 range and completed parent answer. V4 codec tests cover the field round trip and rejection by older framing. JSONL tests reopen the child through a fresh store and recover the anchor through list, stat, and replay.

<a id="dev-note"></a>
## Dev Note

None.
