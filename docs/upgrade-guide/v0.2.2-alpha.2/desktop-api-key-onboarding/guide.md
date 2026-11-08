---
kind: upgrade-guide
description: "Desktop startup uses configured model API keys instead of native account sign-in."
---

# Configure a model API key for Desktop

English | [中文](guide.zh.md)

## Change

Desktop onboarding previously offered official account sign-in. It now opens one Agentrans API-key form when no model key is configured. Account-only users see this form after upgrading. Native account callbacks and expiry notices no longer choose the startup window.

Stored account grants are retained. Optional Web account, embedded Platform and mandatory-update authentication capabilities are unchanged.

## Migration

1. Enter a DeepSeek API key and choose **Save and continue**, or choose **Set up later** and configure another model in Settings. A configured key from any supported model provider satisfies the next startup check.
2. **Get an API key from DeepSeek** opens the [official key page](https://platform.deepseek.com/api_keys) in the system browser. Return to the form to enter the key. A failed save keeps the draft for retry; a failed page open leaves the form available.
3. Restart Desktop to confirm that a configured model key opens the workspace directly. Skipping without a key shows the form again on the next cold start. Existing configuration and Session logs need no migration.
