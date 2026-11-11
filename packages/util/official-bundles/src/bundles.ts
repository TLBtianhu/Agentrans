/** The bundle package names the dsh installation selects, offers, installs on demand, or retires. */

/** Installation-owned defaults used when a shipped profile is first opened. */
export interface ProfileTemplate {
  /** Ordered bundle layer list. */
  bundles: readonly string[]
}

/** The shipped profile templates auto-initialized on first use, by name. */
export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  acp: {
    bundles: ['@agentrans/base', '@agentrans/acp-app'],
  },
  web: {
    bundles: ['@agentrans/base', '@agentrans/web-app'],
  },
  headless: {
    bundles: ['@agentrans/base', '@agentrans/headless'],
  },
  sdk: {
    bundles: ['@agentrans/base', '@agentrans/sdk-app'],
  },
  'sdk-minimal': {
    bundles: ['@agentrans/sdk-minimal'],
  },
}

/**
 * Installation-owned bundle tuples that an earlier release wrote into a shipped profile; app-boot replaces an exact
 * match with the {@link PROFILE_TEMPLATES} entry of the same name and leaves every other list untouched.
 */
export const INSTALLATION_OWNED_PROFILE_TUPLES: Readonly<Record<string, readonly string[]>> = {
  headless: ['@agentrans/base', '@agentrans/web-app', '@agentrans/headless'],
}

/** Bundles an earlier release shipped and the installation no longer carries; app-boot removes them from profiles. */
export const RETIRED_BUNDLES: ReadonlySet<string> = new Set([
  // The Web composition mounts Schedule itself
  // ([upgrade guide](../../../../docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/guide.md)).
  '@agentrans/experimental-schedule-bundle',
])

/** The bundle list a `dsh plugin` init uses for a name with no shipped template. */
export const DEFAULT_PROFILE_BUNDLES: readonly string[] = ['@agentrans/base']

/**
 * The bundles the dsh installation ships for a person to switch on: each a
 * runtime dependency of the installation that declares `dsh.bundle.patch`,
 * an `icon`, and `./locale/*.json` display metadata, selected by no shipped
 * template, and offered switched off by the plugin manager except persistent
 * terminals, which have no page switch
 * ([rationale](../../../../.agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.md),
 * [admission](../../../../.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md)).
 */
export const OPTIONAL_BUNDLES: readonly string[] = [
  '@agentrans/personalized-recommendations',
  '@agentrans/experimental-session-search',
  '@agentrans/experimental-ralph-bundle',
  '@agentrans/experimental-terminal-bundle',
  '@agentrans/experimental-badge-skill-bundle',
  '@agentrans/experimental-session-titles-bundle',
  '@agentrans/experimental-agent-team-profile',
  '@agentrans/experimental-voice-input-bundle',
  '@agentrans/experimental-cot-translation-bundle',
  '@agentrans/experimental-auto-review',
  '@agentrans/experimental-inspector-profile',
  '@agentrans/experimental-liveshare',
  '@agentrans/experimental-plugin-market-bundle',
  '@agentrans/experimental-tool-worktree',
  '@agentrans/experimental-forge-bundle',
]

/** Public DSH release members available through the ordinary on-demand bundle installer. */
export const ON_DEMAND_BUNDLES: readonly string[] = [
  '@agentrans/subagent-claude-code',
  '@agentrans/subagent-codex',
  '@agentrans/cua-bundle',
]
