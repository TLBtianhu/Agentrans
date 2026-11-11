---
kind: upgrade-guide
description: "The SDK serving plugin requests launcher-owned shutdown instead of disposing the root and forcing process exit itself."
---

# Give SDK process shutdown to the launcher

English | [中文](guide.zh.md)

## Change

The SDK serving plugin no longer disposes the root context or calls `process.exit()` after a protocol shutdown. It requests the launcher's `appExit` after the response flush. The launcher owns profile and proxy cleanup and natural process completion. The successful wire response still follows SDK-owned teardown. A teardown error retains its JSON-RPC error response and requests exit 1; a flush failure also requests exit 1.

The plugin requires `appExit` or its runtime-only `exit` hook at mount. That hook now means an exit request; it no longer implies the plugin already disposed the root. This requirement does not affect direct use of the `HarnessSdkJsonRpcServer` class. Default process stdin is paused only on protocol exit. Injected inputs and HMR-only unload keep caller stream ownership.

## Migration

1. Continue launching applications through `agentrans --profile sdk`, `sdk-minimal`, or a custom profile. The launcher supplies `appExit`. Remove code that assumes the SDK plugin owns root disposal or forces process termination.
2. Hand-mounted plugin tests must provide `appExit` or the existing `exit` hook. Treat it as a request; a real application owner must perform teardown and process completion. Code using injected streams must release its own input activity.
3. Verify the shutdown response and child exit independently. Success returns `{}` then exits 0; error responses and flush failures retain failure exit status. Keep the parent stdin pipe open while checking that the child completes naturally. The launcher's teardown deadline begins after its exit request and does not cover preceding SDK drain or response flush; client request and close timeouts remain separate.
