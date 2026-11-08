---
kind: upgrade-guide
description: "Agentrans disables ancillary uploads in shipped profiles and separates HTTP attribution from DeepSeek catalog compatibility."
---

# Review data-sharing defaults

English | [中文](guide.zh.md)

## Change

The shipped base bundle now disables `session-log-deepseek`, `plugin-package-inventory-deepseek`, and `session-telemetry-otel`. The standalone `sdk-minimal` bundle also disables the first two rows in its independent tree. The Web/Desktop bundle disables `desktop-product-telemetry`, `product-analytics`, and `ui-settings-session-log`. Feedback and conversation history remain local. Normal model requests, search, and other plugins can still use the network; custom overlays can explicitly enable the disabled rows.

Default provider HTTP attribution now identifies Agentrans with the manifest version and project URL. DeepSeek Messages requests no longer add `x-deepseek-harness-user-id`, `x-deepseek-harness-session-id`, or `x-deepseek-harness-compact`. Authentication and provider protocol headers remain. DeepSeek model-catalog requirement and metadata lookup retain the stable `deepseek-harness` compatibility key through `DEEPSEEK_CLIENT_COMPATIBILITY`, independent of product attribution.

## Migration

1. Review home patches, profile patches, and command-line overlays for explicit activation of the six rows above, including the independent `sdk-minimal` profile. Remove overrides to adopt the shipped defaults. If sharing is intentional, configure the destination and inspect the owning plugin's contract before enabling it; see the [base bundle](../../../../packages/bundle/base/README.md#included-capabilities), [minimal SDK bundle](../../../../packages/bundle/sdk-minimal/README.md), and [Web bundle](../../../../packages/bundle/web-app/README.md).
2. Consumers of `APP_IDENTITY.product` for DeepSeek model-catalog parsing must use `DEEPSEEK_CLIENT_COMPATIBILITY.key` from `@deepseek-ai/dsh-llm-deepseek`. Use its `version` for adapter compatibility checks. Continue using `APP_IDENTITY` for public HTTP attribution.
3. Inspect an intercepted model request: the User-Agent starts with `agentrans/`, the three tracking headers are absent, and the default body has neither `dsh_session_log` nor `dsh_plugin_packages`. Confirm local feedback remains in Session history without a collector request. No Session-data migration is required.
