# Agentrans

English | [中文](README.zh.md)

Agent + Trans: a general programming Agent workbench that turns explanations into executable Artifacts and supports auditable inquiry branches. Agentrans is an independently identified downstream project based on DeepSeek Harness; it is not an official DeepSeek product.

## Current vertical slices

- **Executable Artifacts** — self-contained HTML with complete snapshots, compare-and-set revisions, an opaque sandboxed iframe, and confirmed semantic actions. The Agent can update an Artifact without pasting its source back into the conversation.
- **Artifact design system** — the on-demand [artifact-design skill](.agents/skills/artifact-design/SKILL.md) supplies design tokens, polished prediction and parameter-explorer templates, restrained motion primitives, and real-browser screenshot review.
- **SceneHost and comparison** — inline, beside, focus, and PiP layouts retain Artifact state and conversation origin. Independent control/variant scenes can synchronize commands and return one confirmed comparison result.
- **Native SceneSpec generation** — the `scene` tool accepts model-generated SceneSpec, validates it through a versioned SceneCatalog, persists `format: 'scene'` snapshots, and renders function plots natively with a safe expression parser. A real local model has generated a new damped-oscillator scene through this path; replay fixtures remain keyless.
- **SceneSpec primitives** — the [function-plot](.agents/skills/artifact-design/references/function-plot.html), [flowchart](.agents/skills/artifact-design/references/flowchart.html), and [particle-system](.agents/skills/artifact-design/references/particle-system.html) templates demonstrate declarative functions, parameters, trace, derivative, integral, nodes, edges, and deterministic physical simulation. Six primitives are supported: `function-plot`, `flowchart`, `particle-system`, `timeline`, `network-graph`, and `map`, each with a confirmed action and an optional style field.
- **SceneSpec styles** — an optional `style` field selects the visual idiom (editorial, transit-map, blueprint, math-proof-lecture, or particles) for every primitive, so the same declarative spec can be presented as a math proof, a transit map, a blueprint, or a particle simulation.
- **Export center** — the export action downloads a self-contained HTML animation program with an inline parser and shared renderers, and a WebM video of the same replay through the canvas stream and MediaRecorder, with no ffmpeg or external encoder.
- **Shared renderer and registry** — the conversation preview and the animation exporter use the same framework-free renderer for each primitive, and a `scenePrimitives` registry resolves the renderer for the preview and the exporter through one registration point.
- **Default entry and display rules** — interactive explanations default to the Artifact system (SceneSpec or HTML cards in the conversation), not to workspace files; only write a workspace file when the user explicitly asks for a standalone HTML file or program. The display layer is pure text and structured formatted code text (SceneSpec, HTML, or SVG), not photos or searched images; use structured markup instead of pixels for illustrations.
- **Confirmed interaction** — browser actions stay pending until the user sends them. Only then do they become ordinary user input; they grant no filesystem, network, or approval authority.
- **Inquiry branches** — fork an assistant conclusion into an independent Session, then preview and confirm a visible result back to the direct parent. No child transcript or reasoning is copied, and no parent model turn starts implicitly.

The shipped replay scenarios exercise these flows through the real Web composition and a real browser, not only isolated components.

<a id="run-from-source"></a>
## Development and user-state separation

Build output is an intermediate for producing distributions, not a user home. Development runs use isolated data roots and never reuse the upstream DSH profile. Do not install or run this checkout over an existing DSH installation.

The source `dsh`, `start:web`, and `dev:web` commands initialize a per-worktree development instance outside the source tree. `AGENTRANS_DEV_ROOT` may select an explicit empty or already marked development root; inherited Harness home variables do not select product state. Existing unmarked data is rejected rather than migrated.

```powershell
pnpm install
pnpm run build
pnpm agentrans web --no-open --port 58910
```

Portable and installed distributions must use separate program and data paths from each other and from upstream DSH. See [DISTRIBUTION.md](DISTRIBUTION.md) for the invariants and the external-identity audit required before packaging.

<a id="run"></a>
## Model configuration

Agentrans has no DeepSeek account login or server-side account binding. Users configure providers and credentials themselves: endpoint URL, wire protocol, model ids, and model metadata. Custom providers can use `openai-completions`, `openai-responses`, or `anthropic-messages`; adding a new model does not require an upstream source update. See [custom-provider.cordis.yml](apps/cli/config/examples/custom-provider.cordis.yml) and the [provider guide](docs/user/guide/providers.md). Credentials stay in the local credential store or environment, never in the repository.

## Default data sharing

The shipped Agentrans composition disables Session-log attachments, plugin-inventory attachments, feedback-triggered Session uploads, and Desktop product analytics. Feedback and conversation history remain local. Normal model requests, search, and user-configured plugins can still use the network. See the [base bundle](packages/bundle/base/README.md#included-capabilities) and [Web bundle](packages/bundle/web-app/README.md) for composition settings; custom overlays can explicitly change them.

## Verification

```sh
pnpm run build
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/artifact-interaction.e2e.ts apps/web/tests/branch-result.e2e.ts
```

Browser scenarios replay recorded model streams; they do not require provider credentials. Set `DSH_PLAYWRIGHT_EXECUTABLE_PATH` when Playwright must use an installed browser. The Artifact scenario covers create/update, counter interaction, and confirmation-only action admission. The branch scenario covers fork, preview, cancel, confirmed return, and no implicit parent turn.

## Upstream and license

[UPSTREAM.md](UPSTREAM.md) records the exact upstream commit, archive hash, and source-synchronization role. `upstream` is not this product's update, account, signing, or telemetry endpoint.

[MIT](LICENSE). Third-party notices are retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
