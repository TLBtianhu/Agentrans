/**
 * Shared filesystem path helpers for DeepSeek Harness user data.
 *
 * @module @agentrans/home-paths
 */

import { existsSync, readdirSync } from 'node:fs'
import { opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Directory name for the default Agentrans home under the OS home. */
export const AGENTRANS_HOME_DIR_NAME = '.agentrans'

/**
 * Directory name this home used before the product took its own name. A release around the
 * rename still wrote here, so an upgrade has to tell the user that their data is elsewhere.
 */
export const RETIRED_AGENTRANS_HOME_DIR_NAME = '.dsh'

/** Stable user-facing display form for the retired home. */
export const RETIRED_AGENTRANS_HOME_DISPLAY = `~/${RETIRED_AGENTRANS_HOME_DIR_NAME}`

/** Stable user-facing display form for the default Agentrans home. */
export const DEFAULT_AGENTRANS_HOME_DISPLAY = `~/${AGENTRANS_HOME_DIR_NAME}`

/** Environment variable that overrides the default Agentrans home. */
export const AGENTRANS_HOME_ENV = 'AGENTRANS_HOME'

/** Directory name for the default shared agent configuration root under the OS home. */
export const AGENTS_HOME_DIR_NAME = '.agents'

/** Stable user-facing display form for the default shared agent configuration root. */
export const DEFAULT_AGENTS_HOME_DISPLAY = `~/${AGENTS_HOME_DIR_NAME}`

/** Environment variable that overrides the default shared agent configuration root. */
export const AGENTS_HOME_ENV = 'AGENTRANS_AGENTS_HOME'

/**
 * Give a native filesystem watcher one canonical spelling of a path, even
 * when its final components do not exist yet. The deepest existing ancestor
 * is resolved through {@link realpath}; when a suffix is missing, that
 * ancestor is also proved to be an enumerable directory before the suffix is
 * restored. This prevents Windows from treating a regular-file ancestor as
 * ordinary absence, and prevents short-name aliases from being mixed with
 * long paths emitted by the native watcher backend.
 * @param path - Watch target or root, resolved against the current directory.
 * @returns the target with its existing ancestor canonicalized.
 * @throws when ancestor traversal encounters an error other than absence, or
 * the existing ancestor of a missing suffix is not an enumerable directory.
 */
export async function canonicalizeWatchPath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      if (missing.length > 0) {
        // A Windows file-as-parent probe reports ENOENT. Opening the resolved
        // ancestor preserves the cross-platform directory requirement.
        const directory = await opendir(canonical)
        await directory.close()
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      /* v8 ignore next -- a filesystem root exists, so traversal resolves before this guard */
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve the default DeepSeek Harness home using Node's platform path rules.
 * @returns the absolute default harness home path.
 */
export function defaultDshHome(): string {
  return join(homedir(), AGENTRANS_HOME_DIR_NAME)
}

/**
 * Resolve the default shared agent configuration root using Node's platform path rules.
 * @returns the absolute default shared agent configuration root.
 */
export function defaultAgentsHome(): string {
  return join(homedir(), AGENTS_HOME_DIR_NAME)
}

/**
 * Resolve the retired default home this product wrote before it took its own name.
 * @returns the absolute retired home path.
 */
export function retiredDshHome(): string {
  return join(homedir(), RETIRED_AGENTRANS_HOME_DIR_NAME)
}

/** What a startup check found in the retired home. */
export interface RetiredHomeFinding {
  /** Absolute path of the retired home. */
  readonly path: string
  /** Symbolic label for user-facing messages. */
  readonly display: string
}

/**
 * Report a retired home that still holds data while the current home does not exist yet.
 *
 * The check answers one narrow question — would this start silently look like a fresh
 * installation to someone whose data sits at the previous path — so it stays quiet when the
 * user pointed `$AGENTRANS_HOME` somewhere, when the current home already exists, and when the
 * retired directory is absent or empty.
 * @param options - overwritable seams for tests and callers that already resolved a root.
 * @returns the retired home to report, or undefined when this start needs no notice.
 */
export function detectRetiredHome(options: {
  env?: Record<string, string | undefined>
  home?: string
  retired?: string
  exists?: (path: string) => boolean
  entries?: (path: string) => number
} = {}): RetiredHomeFinding | undefined {
  const env = options.env ?? process.env
  const configured = env[AGENTRANS_HOME_ENV]
  if (configured !== undefined && configured.trim().length > 0) return undefined
  const home = options.home ?? defaultDshHome()
  const retired = options.retired ?? retiredDshHome()
  if (resolve(home) === resolve(retired)) return undefined
  const exists = options.exists ?? existsSync
  if (exists(home)) return undefined
  if (!exists(retired)) return undefined
  const entries = options.entries ?? countEntries
  if (entries(retired) === 0) return undefined
  return { path: retired, display: RETIRED_AGENTRANS_HOME_DISPLAY }
}

/**
 * Expand supported tilde prefixes against the operating-system home.
 * @param path - configured path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the original value when no supported prefix is present.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve one user-data root from an explicit path, an environment override, and a default.
 * @param configured - explicit path, which has highest precedence.
 * @param env - environment mapping to read.
 * @param envName - environment variable that overrides the default.
 * @param fallback - default root, used when neither the explicit path nor the environment provides one.
 * @returns the normalized absolute root.
 */
function resolveRoot(
  configured: string | undefined,
  env: Record<string, string | undefined>,
  envName: string,
  fallback: () => string,
): string {
  const fromEnv = env[envName]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : fallback())
  return resolve(expandHomePath(selected))
}

/**
 * Label one resolved user-data root symbolically for user-facing display.
 * @param resolvedRoot - absolute path returned by the matching resolver.
 * @param defaultRoot - absolute default root whose symbolic label applies to a match.
 * @param defaultLabel - symbolic label for the default root.
 * @param envName - environment variable name that labels any other root.
 * @returns the symbolic label.
 */
function rootDisplay(resolvedRoot: string, defaultRoot: string, defaultLabel: string, envName: string): string {
  return resolvedRoot === resolve(defaultRoot) ? defaultLabel : `$${envName}`
}

/**
 * Resolve the single-root DeepSeek Harness home.
 *
 * Precedence, highest first: an explicit configured path, `$AGENTRANS_HOME`, then
 * `~/.dsh`. The harness keeps all user data under one root. An empty or
 * whitespace-only `$AGENTRANS_HOME` is treated as unset, so a blank override never
 * resolves the home to the current working directory.
 * @param configured - explicit harness-home override, which has highest precedence.
 * @param env - environment mapping used to read `AGENTRANS_HOME`.
 * @returns the normalized absolute harness home path.
 */
export function resolveDshHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  return resolveRoot(configured, env, AGENTRANS_HOME_ENV, defaultDshHome)
}

/**
 * Resolve the shared agent configuration root.
 *
 * Precedence, highest first: an explicit configured path, `$AGENTRANS_AGENTS_HOME`,
 * then `~/.agents`. The root holds configuration shared with other agent tools,
 * so it stays independent of the DeepSeek Harness home. An empty or
 * whitespace-only `$AGENTRANS_AGENTS_HOME` is treated as unset, so a blank override
 * never resolves the root to the current working directory.
 * @param configured - explicit shared-root override, which has highest precedence.
 * @param env - environment mapping used to read `AGENTRANS_AGENTS_HOME`.
 * @returns the normalized absolute shared agent configuration root.
 */
export function resolveAgentsHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  return resolveRoot(configured, env, AGENTS_HOME_ENV, defaultAgentsHome)
}

/**
 * Join path segments onto the resolved DeepSeek Harness home.
 * @param segments - path segments appended to the Harness home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/**
 * Join path segments onto the resolved Harness home's `cache` directory without creating it; no arguments returns the directory itself.
 * @param optionsOrSegment - explicit home override, or the first path segment; omission uses the default home resolution.
 * @param segments - additional path segments after the first child, if any.
 * @returns the normalized absolute cache path.
 */
export function dshCachePath(optionsOrSegment: { dshHome?: string } | string = {}, ...segments: string[]): string {
  if (typeof optionsOrSegment === 'string') return dshHomePath('cache', optionsOrSegment, ...segments)
  return join(resolveDshHome(optionsOrSegment.dshHome), 'cache', ...segments)
}

/**
 * Describe a resolved harness home symbolically for user-facing display.
 *
 * It never returns an absolute machine path: the default home is labelled
 * `~/.dsh`, and any configured home is labelled `$AGENTRANS_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveDshHome}.
 * @returns `~/.dsh` for the default home, otherwise `$AGENTRANS_HOME`.
 */
export function dshHomeDisplay(resolvedHome: string): string {
  return rootDisplay(resolvedHome, defaultDshHome(), DEFAULT_AGENTRANS_HOME_DISPLAY, AGENTRANS_HOME_ENV)
}

/**
 * Describe a resolved shared agent configuration root symbolically for user-facing display.
 *
 * It never returns an absolute machine path: the default root is labelled
 * `~/.agents`, and any configured root is labelled `$AGENTRANS_AGENTS_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveAgentsHome}.
 * @returns `~/.agents` for the default root, otherwise `$AGENTRANS_AGENTS_HOME`.
 */
export function agentsHomeDisplay(resolvedHome: string): string {
  return rootDisplay(resolvedHome, defaultAgentsHome(), DEFAULT_AGENTS_HOME_DISPLAY, AGENTS_HOME_ENV)
}

/**
 * Count the entries directly inside a directory.
 * @param path - directory to read.
 * @returns the number of entries it holds.
 */
function countEntries(path: string): number {
  return readdirSync(path).length
}
