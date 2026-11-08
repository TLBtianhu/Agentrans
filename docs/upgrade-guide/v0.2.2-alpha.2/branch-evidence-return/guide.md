---
kind: upgrade-guide
description: "Branch-result return now rejects changed confirmed content and distinguishes busy admission from an unknown storage outcome."
---

# Retry branch-result returns with unchanged content

English | [中文](guide.zh.md)

## Change

Plain and evidence-bearing returns share one parent commit operation. The same `(parent, branch, resultSeq)` reuses its receipt only when the confirmed content matches. Switching between plain and evidence-bearing returns, or changing evidence after a successful return, reports `session/branch-result-conflict` instead of silently acknowledging different content.

Only failure to enter parent maintenance is reported as busy. A later storage or response failure can conceal an accepted message; it must not be treated as proof that nothing committed. No Session source fields or event types change.

The Web composition mounts `@deepseek-ai/dsh-artifact-branch` for evidence return. The main Artifact service and headless profiles remain independent of this bridge.

## Migration

1. Keep the conclusion and evidence references fixed while retrying an unknown result. Identical retry recovers the existing receipt without adding input or starting a model turn.
2. Treat `session/branch-result-conflict` as terminal for the unchanged request. Open the parent to review its accepted content. Use a new child conclusion when a different return is intended.
3. In custom Web compositions that need evidence return, add an `@deepseek-ai/dsh-artifact-branch` plugin row beside the existing Artifact, Session Query and Session Controller services. Configure its complete-message `maxActionBytes` budget when needed.
4. Confirm a branch result, drop or interrupt its response, then retry the same choice. Verify one parent message, both conclusion and evidence text blocks, unchanged child history and no automatic parent turn. See [branch verification](../../../subsystems/branch.md#verification).
