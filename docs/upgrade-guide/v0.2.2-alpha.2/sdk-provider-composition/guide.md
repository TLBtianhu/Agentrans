---
kind: upgrade-guide
description: "SDK initialization requires a model adapter registered by the surrounding profile instead of mounting the official DeepSeek adapter implicitly."
---

# Register SDK model adapters in the profile

English | [中文](guide.zh.md)

## Change

`dsh-sdk-jsonrpc-server` no longer mounts the official DeepSeek adapter when `initialize.provider` is `deepseek-official` and no adapter owns that route. Every provider must already be registered by the surrounding composition. Missing routes reject initialization with `no adapter registered for provider "<id>"`; initialization does not activate another provider.

The shipped `sdk` and `sdk-minimal` profiles already register the official adapter. Custom profiles and direct users of `HarnessSdkJsonRpcServer` that relied on implicit mounting must supply it explicitly. Existing custom and replay adapters retain their registered routes.

## Migration

1. In the custom profile's `cordis.patch.yml`, enable its existing official adapter row or insert `@deepseek-ai/dsh-llm-deepseek-api-key` when absent. For another provider, compose that provider's adapter instead. See [SDK server wiring](../../../../packages/sdk/server/README.md).
2. Match `initialize.provider` and `initialize.model` to the composed adapter. The selected adapter still validates the model, reasoning effort, and output limit before the handshake succeeds. Do not use the handshake to install a provider.
3. Verify that the intended profile initializes and completes a prompt. Disable its adapter and confirm initialization reports the missing route without registering a replacement. Custom and replay profiles must remain on their own adapters. No Session-data or wire-format migration is required.
