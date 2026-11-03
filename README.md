# Agentrans

English | [中文](README.zh.md)

Agent + Trans: a general programming Agent workbench that turns explanations into executable Artifacts and supports auditable inquiry branches. Agentrans is an independently identified downstream project based on DeepSeek Harness; it is not an official DeepSeek product.

## Current vertical slices

- **Executable Artifacts** — self-contained HTML with complete snapshots, compare-and-set revisions, an opaque sandboxed iframe, and confirmed semantic actions. The Agent can update an Artifact without pasting its source back into the conversation.
- **Artifact design system** — the on-demand [artifact-design skill](.agents/skills/artifact-design/SKILL.md) supplies design tokens, polished prediction and parameter-explorer templates, restrained motion primitives, and real-browser screenshot review.
- **SceneHost and comparison** — inline, beside, focus, and PiP layouts retain Artifact state and conversation origin. Independent control/variant scenes can synchronize commands and return one confirmed comparison result.
- **Native SceneSpec generation** — the `scene` tool accepts model-generated SceneSpec, validates it through a versioned SceneCatalog, persists `format: 'scene'` snapshots, and renders function plots natively with a safe expression parser. A real local model has generated a new damped-oscillator scene through this path; replay fixtures remain keyless.
- **SceneSpec primitives** — the [function-plot](.agents/skills/artifact-design/references/function-plot.html), [flowchart](.agents/skills/artifact-design/references/flowchart.html), and [particle-system](.agents/skills/artifact-design/references/particle-system.html) templates demonstrate declarative functions, parameters, trace, derivative, integral, nodes, edges, and deterministic physical simulation.
- **Confirmed interaction** — browser actions stay pending until the user sends them. Only then do they become ordinary user input; they grant no filesystem, network, or approval authority.
- **Inquiry branches** — fork an assistant conclusion into an independent Session, then preview and confirm a visible result back to the direct parent. No child transcript or reasoning is copied, and no parent model turn starts implicitly.

The shipped replay scenarios exercise these flows through the real Web composition and a real browser, not only isolated components.

## Development and user-state separation

Build output is an intermediate for producing distributions, not a user home. Development runs use isolated data roots and never reuse the upstream DSH profile. Do not install or run this checkout over an existing DSH installation.

```powershell
pnpm install
pnpm run build
$env:DSH_HOME = 'C:\agent制作\.dev-data\harness'
$env:DSH_AGENTS_HOME = 'C:\agent制作\.dev-data\agents'
pnpm dsh web --no-open --port 58910
```

Portable and installed distributions must use separate program and data paths from each other and from upstream DSH. See [DISTRIBUTION.md](DISTRIBUTION.md) for the invariants and the external-identity audit required before packaging.

## Model configuration

Agentrans has no DeepSeek account login or server-side account binding. Users configure providers and credentials themselves: endpoint URL, wire protocol, model ids, and model metadata. Custom providers can use `openai-completions`, `openai-responses`, or `anthropic-messages`; adding a new model does not require an upstream source update. See [custom-provider.cordis.yml](apps/cli/config/examples/custom-provider.cordis.yml) and the [provider guide](docs/user/guide/providers.md). Credentials stay in the local credential store or environment, never in the repository.

## Verification

```sh
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/artifact-interaction.e2e.ts apps/web/tests/branch-result.e2e.ts
```

Browser scenarios replay recorded model streams; they do not require provider credentials. Set `DSH_PLAYWRIGHT_EXECUTABLE_PATH` when Playwright must use an installed browser. The Artifact scenario covers create/update, counter interaction, and confirmation-only action admission. The branch scenario covers fork, preview, cancel, confirmed return, and no implicit parent turn.

## Upstream and license

[UPSTREAM.md](UPSTREAM.md) records the exact upstream commit, archive hash, and source-synchronization role. `upstream` is not this product's update, account, signing, or telemetry endpoint.

[MIT](LICENSE). Third-party notices are retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
