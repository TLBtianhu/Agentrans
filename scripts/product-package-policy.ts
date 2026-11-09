/** Non-default package roles retained outside the experimental group. */

/** Product role that does not require a default runtime mount. */
export type ProductPackageCategory = 'optional' | 'disabled' | 'sdk' | 'build' | 'test' | 'web-distribution' | 'declarations'

/** One explicitly maintained package role and its reason. */
export interface ProductPackagePolicy {
  /** Why this package remains outside the experimental group. */
  readonly reason: string
  /** The supported product role checked against its directory. */
  readonly category: ProductPackageCategory
}

/**
 * Exceptions to default runtime reachability, keyed by repository-relative package directory.
 * Optional integrations may be reached by an optional bundle without becoming default capabilities.
 */
export const PRODUCT_PACKAGE_POLICY: Readonly<Record<string, ProductPackagePolicy>> = {
  'packages/core/agent-tool-presentation': { category: 'optional', reason: 'Deprecated selector retained for existing executor configurations.' },
  'packages/browser-use/browser-use': { category: 'optional', reason: 'Service definition used by explicitly selected browser providers.' },
  'packages/computer-use/computer-use': { category: 'optional', reason: 'Service definition used by explicitly selected computer providers.' },
  'packages/lsp/lsp': { category: 'optional', reason: 'Service definition for deployment-configured language servers.' },
  'packages/lsp/lsp-stdio': { category: 'optional', reason: 'Requires an explicit server list and language-server executables.' },
  'packages/lsp/tool-lsp': { category: 'optional', reason: 'Model tools selected together with a configured LSP provider.' },
  'packages/ssh/ssh': { category: 'optional', reason: 'Explicit remote connection and helper configuration.' },
  'packages/ssh/ssh-helper-runtime': { category: 'optional', reason: 'Private executable carrier for explicitly configured SSH connections.' },
  'packages/ssh/fs-ssh': { category: 'optional', reason: 'Remote filesystem provider selected in an SSH composition.' },
  'packages/ssh/sandbox-ssh': { category: 'optional', reason: 'Remote confinement provider selected in an SSH composition.' },
  'packages/ssh/subprocess-ssh': { category: 'optional', reason: 'Remote process provider selected in an SSH composition.' },
  'packages/storage/storage-sqlite': { category: 'optional', reason: 'Persistent storage requires an explicit database path and backend selection.' },
  'packages/subagent/subagent-acp': { category: 'optional', reason: 'Requires a configured external ACP agent command.' },
  'packages/subagent/subagent-claude-code': { category: 'optional', reason: 'Separately installed native Claude Code agent integration.' },
  'packages/subagent/subagent-codex': { category: 'optional', reason: 'Separately installed native Codex agent integration.' },
  'packages/subagent/subagent-dsh-sdk': { category: 'optional', reason: 'Requires an explicitly configured external DSH home.' },
  'packages/web/web-search-exa': { category: 'optional', reason: 'Alternative search provider requiring its own API credentials.' },
  'packages/web/web-search-perplexity': { category: 'optional', reason: 'Alternative search provider requiring its own API credentials.' },
  'packages/context/tmux-context': { category: 'optional', reason: 'Context contribution requiring a tmux pane.' },
  'packages/fs/tool-str-replace-editor': { category: 'optional', reason: 'Explicit alternative to the default filesystem editing tools.' },
  'packages/sdk/client': { category: 'sdk', reason: 'Published TypeScript embedding client runs in the consumer process.' },
  'packages/typert/generator': { category: 'build', reason: 'Build-time generation of type metadata.' },
  'packages/test-support/agent-loop-testkit': { category: 'test', reason: 'Published agent-loop test harness.' },
  'packages/test-support/tool-testkit': { category: 'test', reason: 'Shared tool definition and execution fixtures for tests and benchmarks.' },
  'packages/test-support/client-runtime': { category: 'test', reason: 'Published browser plugin test harness.' },
  'packages/test-support/llm-mock-server': { category: 'test', reason: 'Published model-provider test server.' },
  'packages/test-support/llm-replay': { category: 'test', reason: 'Published recorded-model replay harness.' },
  'packages/test-support/loader-smoke': { category: 'test', reason: 'Published plugin Loader smoke-test harness.' },
  'packages/test-support/remote-mock': { category: 'test', reason: 'Published typed Remote test proxies.' },
  'packages/test-support/session-snapshot': { category: 'test', reason: 'Published Session snapshot replay harness.' },
  'packages/client/web': { category: 'web-distribution', reason: 'Browser boot kernel bundled into the Web distribution.' },
  'packages/client/ui-dockkit': { category: 'web-distribution', reason: 'Layout library bundled into the Web distribution.' },
  'packages/util/package-manifest': { category: 'declarations', reason: 'Shared package metadata declarations have no runtime mount.' },

  // Shipped rows the product keeps switched off. Each stays in the composition so an
  // explicit overlay can audit or enable it, but no default profile activates it.
  'packages/client/ui-settings-session-log': { category: 'disabled', reason: 'Upload settings row for the session log contribution; the shipped Web and Desktop compositions disable it.' },
  'packages/host/product-telemetry-otel': { category: 'disabled', reason: 'Host product telemetry exporter; the shipped Web composition disables product analytics.' },
  'packages/llm/plugin-package-inventory-deepseek': { category: 'disabled', reason: 'Active package inventory request field; the shipped compositions disable the contribution.' },
  'packages/session/session-log-deepseek': { category: 'disabled', reason: 'DeepSeek-specific API session log field; the shipped compositions disable the contribution.' },
  'packages/session/session-telemetry': { category: 'disabled', reason: 'Service definition for the session telemetry seam consumed by the disabled OTel sink.' },
  'packages/session/session-telemetry-otel': { category: 'disabled', reason: 'OTel session telemetry sink; the shipped compositions disable it.' },
  'packages/web/web-deepseek-api': { category: 'disabled', reason: 'Search and fetch providers bound to the account integration; the shipped composition selects the API-key search and HTTP fetch rows instead.' },

  // DeepSeek account delivery stays in the tree because upstream ships it as a base
  // capability, but no shipped composition mounts it: the product admits models and
  // Web access through the API-key issuer. Enabling sign-in means mounting these rows,
  // not rebuilding the clients.
  'packages/credentials/deepseek-account-platform': { category: 'disabled', reason: 'System-browser sign-in and Platform session grants; the shipped compositions authenticate with an API-key issuer instead.' },
  'packages/llm/llm-deepseek-account': { category: 'disabled', reason: 'Model provider admitting account credentials; the shipped compositions admit the API-key provider only.' },
  'packages/client/ui-settings-account': { category: 'disabled', reason: 'Account settings surface for the sign-in row above; it has no mounted owner while that row stays off.' },
}
