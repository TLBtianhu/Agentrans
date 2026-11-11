/** The package names the plugin manager protects, hides, orders, or marks experimental. */

/**
 * Plugin packages the plugin manager refuses to disable or remove, because management itself needs them; a bundle that
 * contains one is read-only as well. Removing a name drops only this `management-required` refusal; the manager's own
 * entry, installation-carried bundles, and unaddressable rows stay protected by their own rules.
 */
export const PROTECTED_PLUGINS: ReadonlySet<string> = new Set([
  '@agentrans/plugin-manager', '@agentrans/cordis-plugin-loader',
  '@agentrans/cordis-plugin-include', '@agentrans/api-gateway',
  '@agentrans/host-webserver', '@agentrans/client-modules',
  '@agentrans/client-ui-settings-plugin-inventory', '@agentrans/client-ui-plugin-manager',
  '@agentrans/host-plugin-inventory', '@agentrans/typert-registry',
  '@agentrans/api-remotes', '@agentrans/api-remote-access',
  '@agentrans/cordis-plugin-timer', '@agentrans/client-connection',
  '@agentrans/host-frontend-static', '@agentrans/tools',
  '@agentrans/hmr',
])

/**
 * Built-in profile bundles and persistent terminals, which have no plugin manager page.
 * Their Host availability and activation stay intact.
 */
export const HIDDEN_BUNDLES: ReadonlySet<string> = new Set([
  '@agentrans/base',
  '@agentrans/web-app',
  '@agentrans/headless',
  '@agentrans/sdk-app',
  '@agentrans/acp-app',
  '@agentrans/sdk-minimal',
  '@agentrans/experimental-terminal-bundle',
])

/**
 * The optional bundles the plugin manager's main and More lists rank first, in this order. {@link MORE_BUNDLES}, not
 * this list, decides whether a bundle appears on the main list.
 */
export const EXTENSION_BUNDLES: readonly string[] = [
  '@agentrans/experimental-agent-team-profile',
  '@agentrans/experimental-voice-input-bundle',
  '@agentrans/experimental-plugin-market-bundle',
  '@agentrans/experimental-auto-review',
]

/**
 * The optional bundles the plugin manager's main list leaves out until the profile enables them; its More list,
 * which includes every eligible bundle, ranks them last in this order.
 */
export const MORE_BUNDLES: readonly string[] = [
  '@agentrans/personalized-recommendations',
  '@agentrans/experimental-inspector-profile',
  '@agentrans/cua-bundle',
  '@agentrans/experimental-tool-worktree',
  '@agentrans/experimental-cot-translation-bundle',
  '@agentrans/experimental-session-search',
  '@agentrans/experimental-session-titles-bundle',
  '@agentrans/experimental-badge-skill-bundle',
  '@agentrans/experimental-ralph-bundle',
  '@agentrans/subagent-codex',
  '@agentrans/subagent-claude-code',
]

/** Official bundles the plugin manager marks with the Experimental badge. */
export const EXPERIMENTAL_BUNDLES: ReadonlySet<string> = new Set([
  '@agentrans/personalized-recommendations',
  '@agentrans/cua-bundle',
  '@agentrans/experimental-agent-team-profile',
  '@agentrans/experimental-voice-input-bundle',
  '@agentrans/experimental-auto-review',
  '@agentrans/experimental-inspector-profile',
  '@agentrans/experimental-forge-bundle',
  '@agentrans/experimental-tool-worktree',
  '@agentrans/experimental-cot-translation-bundle',
  '@agentrans/experimental-session-search',
  '@agentrans/experimental-session-titles-bundle',
  '@agentrans/experimental-badge-skill-bundle',
  '@agentrans/experimental-ralph-bundle',
  '@agentrans/experimental-plugin-market-bundle',
  '@agentrans/experimental-liveshare',
])
