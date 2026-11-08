---
kind: upgrade-guide
description: "The DeepSeek web providers no longer accept a literal apiKey in configuration; the key comes from the apiKeyEnv credential reference."
---

# Move DeepSeek web keys out of configuration

English | [中文](guide.zh.md)

## Change

`web-search-deepseek` and `web-deepseek-api` dropped their `apiKey` configuration field. A secret in a configuration file was readable by anything that could read the file and was easy to commit by accident, while the same providers already resolved the `apiKeyEnv` reference through the credentials service or the launching environment.

Configuration that still carries `apiKey` fails to load instead of being silently ignored. The web Models page already wrote the key through the credentials service, so a key set there needs no change.

An unavailable key now reports one of `missing`, `invalid`, `unentitled`, or `unreachable` through `ctx.web.searchCapabilityState()` and `fetchCapabilityState()`; `searchReady()` and `fetchReady()` remain the boolean projection tools read.

## Migration

1. Remove `apiKey` from any `web-search-deepseek` or `web-deepseek-api` entry in `cordis.yml`.
2. Store the key through the web settings page, `dsh` credentials storage, or export `DEEPSEEK_API_KEY` in the launching environment. A different reference name stays in `apiKeyEnv`.
3. If a deployment relied on the literal key overriding a stale stored key, rotate the stored value instead of keeping a second source: the provider now reads exactly one key per request.
