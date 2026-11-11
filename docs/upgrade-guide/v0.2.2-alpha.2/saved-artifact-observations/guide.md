---
kind: upgrade-guide
description: "Artifact recovery now requires Session Projection, and older readers refuse Sessions containing saved observations."
---

# Recover saved Artifact observations through Session Projection

English | [中文](guide.zh.md)

## Change

`dsh-artifact` requires `dsh-session-projection` and awaits its registration before exposing synchronous source reads. The shipped base composition already includes this service. Custom compositions that mounted Artifact without it must add the dependency.

Saving a particle observation writes a required `artifact/observations` event containing the complete saved list for one Artifact, including each source revision, runtime checkpoint, and computed observation. Existing Sessions without these events remain readable. Older readers that do not recognize the event explicitly refuse the Session; skipping it would lose saved experiments. Saving or restoring does not create model input.

Native particle comparisons use two explicitly selected saved observations instead of transient live readings. Both must belong to the same comparison group, have the control and variant roles, and use the same runtime version, time step, and step count. Existing HTML and non-particle current-analysis comparisons retain their live path.

## Migration

1. In a custom `cordis.yml`, mount `@agentrans/session-projection` alongside `@agentrans/artifact`. Programmatic consumers await the Artifact plugin before calling its synchronous methods.
2. Keep readers that understand `artifact/observations` when opening Sessions with saved experiments. Do not delete events or rewrite logs to make an older build accept them.
3. Save a named particle observation, reload the Session, and restore it. Check its displayed source revision and exported values. Only **Send to Agent** admits the saved observation as input; retries do not admit it twice in the same Session.
4. For a native particle comparison, save and select one observation on each side, then send the comparison explicitly. Check both source revisions and checkpoints. After reload, saved observations remain available, but reselect the pair; selection itself is local. Sending the same ordered pair again does not duplicate input in that Session.
