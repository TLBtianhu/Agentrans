# Agent Note: Platform client identity belongs to the embedding client

Status: implemented

English | [中文](2026-11-09-platform-client-identity.zh.md)

## Problem

The [account Service Definition](../../../../packages/credentials/deepseek-account/README.md) also built the Platform client-identity headers. Its single caller was the [desktop Platform view](../../../../apps/desktop/src/platform-view.ts), which is the only place that knows a build version, an active interface language, and a UTC offset. A client that needed those headers therefore depended on the account package to describe its own interface, and the definition package — which should name a capability — carried DeepSeek's wire vocabulary.

## Decision

The seam keeps three roles and one dependency direction:

- The [definition package](../../../../packages/credentials/deepseek-account/src/index.ts) declares `deepseekAccount`, `PlatformSession`, `AccountClientMetadata`, and the operation signatures. It builds no request headers and knows no header names.
- The provider owns deployment request headers and delivers them through `PlatformSession.requestHeaders`, because a deployment knows which headers its Platform origin requires.
- The embedding client composes the client identity of its own interface in [platform-client-headers.ts](../../../../apps/desktop/src/platform-client-headers.ts): platform, build version, wire locale, UTC offset, and the cookie merge for requests to its own origin.

[verify-seam-roles](../../../../scripts/verify-seam-roles.ts) enforces the direction from the same `SERVICE_ROLES` table the [capability-seams page](../../../../docs/capability-seams.md) renders: a declared consumer or the definition itself may not import a provider at runtime. `import type` stays legal because declaration merging needs the provider's augmentation without loading it, and `ctx.get('deepseekAccount')` is a lookup, not an import.

## Alternatives considered

**Move the helpers into the provider.** Rejected: the desktop is not a provider, so this would trade one dependency on the seam for a dependency on one implementation, and the values being composed are the caller's, not the deployment's.

**Add a `platformRequestHeaders(client)` method to the service.** Rejected as a public service method with a single caller, which [packages/AGENTS.md](../../../../packages/AGENTS.md) names as the inverse of a useful seam; revisiting this is the natural move if a second client of the same Platform appears.

**Keep the helpers in the definition package.** Rejected: that is exactly what put wire protocol inside the seam definition.

## Consequences

A future client of this Platform composes its own identity headers instead of sharing one implementation, and the two composition sites can drift. The shipped-but-off `web-deepseek-api` no longer has a shared wire-locale helper; re-enabling it either composes its own identity or replaces this decision. The definition package has no runtime behavior left beyond the abstract service class, which is why it now carries no spec of its own.

## Testing

`apps/desktop/tests/platform-client-headers.spec.ts` pins the platform mapping, the locale reduction, and the cookie merge. `apps/desktop/tests/platform-view.spec.ts` keeps the injection and cross-origin stripping behavior of the view itself. `scripts/verify-seam-roles.spec.ts` proves the check rejects a value import and accepts a type-only import beside a `ctx.get` lookup.
