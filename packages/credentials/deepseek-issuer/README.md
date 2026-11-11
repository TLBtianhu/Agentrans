---
description: "The DeepSeek platform identity in one place: the credential reference every capability class shares, the capability classes themselves, and the endpoint default each class appends its own paths to."
kind: "package-reference"
---

# @agentrans/deepseek-issuer

English | [中文](README.zh.md)

## Summary

One DeepSeek key authenticates several capability classes, and each class calls a different endpoint. `dsh-deepseek-issuer` owns that shared identity: `DEEPSEEK_API_KEY_REF` is the single default credential reference, `DEEPSEEK_CAPABILITIES` names the classes the issuer serves, and `DEEPSEEK_ENDPOINTS` pairs each class with its endpoint default and the environment variable that overrides it. Providers import these values instead of restating them, so the model route, the search provider and its settings card cannot drift into two different default keys. The module performs no request, holds no secret, and has no Cordis surface.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

A provider that authenticates with the DeepSeek platform imports the credential reference and its endpoint default for the capability class it implements. A settings surface imports the same reference so the card it renders and the provider it configures name one credential.

```ts
import { credentialRef } from '@agentrans/credentials'
import { DEEPSEEK_API_KEY_REF, DEEPSEEK_ENDPOINTS } from '@agentrans/deepseek-issuer'

const credential = credentialRef(DEEPSEEK_API_KEY_REF)
const baseURL = DEEPSEEK_ENDPOINTS.models.url
```

<a id="understand-the-implementation"></a>
## Understand the implementation

The capability classes are `models`, `search`, and `search-tools`. `models` covers the Messages API and its listing; `search` covers the Anthropic-compatible endpoint that serves native web search; `search-tools` covers the search and fetch tools API.

The endpoints stay separate on purpose. `models` reads `DEEPSEEK_BASE_URL`, `search` reads `DEEPSEEK_SEARCH_BASE_URL`, and `search-tools` reads `DEEPSEEK_SEARCH_TOOLS_BASE_URL`, so pointing the model route at a gateway does not move search, and overriding search does not move the model route.

The credential reference is shared, the endpoints are not: one secret, three capability classes, three independently configurable addresses. A capability that authenticates with a different secret overrides the reference on its own configuration; this module keeps exactly one default.

<a id="further-exploration"></a>
## Further Exploration

- [Credentials](../credentials/README.md) — the seam that stores and resolves the reference.
- [DeepSeek API-key provider](../../llm/llm-deepseek-api-key/README.md) — the `models` consumer.
- [DeepSeek search provider](../../web/web-search-deepseek/README.md) — the `search` consumer.

## Model Experience

Indirectly, through the consuming adapter, which resolves each credential reference and owns every model-facing use a value authorizes.

#### KV Cache effect

No direct invalidation; endpoint and credential defaults never enter a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The issuer is constants, not a service.** Capability discovery, entitlement, and readiness are not modeled here; a provider still reports its own readiness. Grouping those into one `IssuerBinding` is the next step, and it changes provider configuration rather than this table.
- **Only the DeepSeek issuer is described.** Another vendor's identity lives with its own provider until a second issuer needs the same shape.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The tables here are read by three providers and their settings surfaces. When a default changes, change it once here and let the type checker find the consumers; a provider that re-declares a default value has already broken the rule this package exists to enforce.

The environment variable names stay flat and vendor-scoped (`DEEPSEEK_*`) because they double as the launch-environment override a deployment edits before starting the process.

</details>
