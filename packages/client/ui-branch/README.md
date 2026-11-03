---
description: "Inline preview, confirmation, and retry for returning one durable assistant conclusion from an ordinary manual branch to its direct parent."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-branch

English | [中文](README.zh.md)

## Summary

`ui-branch` contributes one assistant-detail entry for ordinary manual branches. A user first opens an inline preview of the exact visible text that the Host will reread, then explicitly confirms the return. Cancelling sends no request. A failure retains the preview for retry, and a successful return opens the parent Session.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with Chat, Session, Workspace, Slot, and locale services. It contributes `branch-result` under `conversation.chat.assistant.details`. Durable user and assistant rows expose their exact fork sequence; streaming or synthetic rows do not receive a branch action.

The confirmation is inline rather than a dialog. Cancel emits no request, repeated clicks are deduplicated, and a busy parent keeps the preview available for retry. A successful confirmation opens the parent but does not start a model turn.

-----

<a id="model-experience"></a>
## Model Experience

### Returning a branch result

#### What the model sees

The package submits only the parent Session id, branch Session id, and durable assistant result seq. The Host rereads the selected assistant message and appends one ordinary model-visible user message to the parent; it does not invoke the parent model automatically. No child full transcript, reasoning, sibling result, or later parent text is submitted by this UI.

#### Token effect

Only the confirmed visible text can add model-visible content. Preview, cancel, and failed confirmation add nothing. The returned text becomes one parent-local user message rather than a copied child transcript.

#### KV Cache effect

The confirmed text can affect the parent Session's next provider request under its ordinary prefix-cache rules. Preview, cancel, and failed confirmation do not change model history.

##### Return boundary

```markdown
Only confirmed visible text becomes parent history; preview, cancellation, and failure add nothing.
```

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only direct ordinary manual branches are eligible. Subagent settlement, automatic return, and branch graphs are outside this package's current behavior.

### Dev Note

The keyless [branch-result scenario](../../../apps/web/tests/branch-result.e2e.ts) verifies the shipped browser flow: fork, child-owned preview, cancel without a return, and confirmed parent-local result without a new model turn.
