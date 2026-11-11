/**
 * Move a home written by an earlier release onto the current home path.
 *
 * The rename that gave the product its own name also moved its home from `~/.dsh` to
 * `~/.agentrans`. Nothing reads the old path, so an upgrade must let the user decide: keep the
 * old data by moving it here, or start clean. This module performs that move and refuses every
 * ambiguous state instead of merging two homes.
 * @module @agentrans/cli/home
 */

import { existsSync, renameSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { detectRetiredHome, resolveDshHome, retiredDshHome } from '@agentrans/home-paths'

/** Why a home move did not happen. */
export type HomeAdoptRefusal = 'no-retired-home' | 'home-exists' | 'not-a-directory'

/** Result of asking to adopt the retired home. */
export type HomeAdoptResult =
  | { readonly status: 'moved'; readonly from: string; readonly to: string }
  | { readonly status: 'refused'; readonly reason: HomeAdoptRefusal; readonly from: string; readonly to: string }

/**
 * Move the retired home to the current home path.
 *
 * The move is a single directory rename, so it either completes or leaves both paths untouched.
 * A non-empty current home is never merged into: the caller must resolve the two homes itself.
 * @param options - resolved paths and filesystem seams; defaults resolve the current environment.
 * @returns the move that happened, or the state that refused it.
 */
export function adoptRetiredHome(options: {
  home?: string
  retired?: string
  exists?: (path: string) => boolean
  rename?: (from: string, to: string) => void
} = {}): HomeAdoptResult {
  const home = resolve(options.home ?? resolveDshHome())
  const retired = resolve(options.retired ?? retiredDshHome())
  const exists = options.exists ?? existsSync
  const refused = (reason: HomeAdoptRefusal): HomeAdoptResult => ({ status: 'refused', reason, from: retired, to: home })
  if (!exists(retired)) return refused('no-retired-home')
  if (!statSync(retired).isDirectory()) return refused('not-a-directory')
  if (exists(home)) return refused('home-exists')
  const rename = options.rename ?? renameSync
  // The home's parent must exist; rename never creates one.
  const parent = dirname(home)
  if (!exists(parent)) throw new Error(`agentrans: the parent directory ${parent} does not exist`)
  rename(retired, home)
  return { status: 'moved', from: retired, to: home }
}

/**
 * Describe the startup notice for a retire home that current releases do not read.
 * @param finding - result of {@link detectRetiredHome}.
 * @param home - the current home path, for the message.
 * @returns the notice text, one line per sentence.
 */
export function retiredHomeNotice(finding: { display: string }, home: string): string {
  return [
    `agentrans: an earlier release kept its data at ${finding.display}.`,
    `This release reads ${home} instead, so starting now would look like a fresh installation.`,
    'Move the old data with `agentrans home adopt`, or start with AGENTRANS_HOME pointing at it.',
    'If another DeepSeek Harness installation still runs from that directory, leave it where it is.',
  ].join('\n  ')
}

/**
 * Report the startup notice when it applies, without touching either home.
 * @param options - filesystem seams for tests.
 * @returns the notice text, or undefined when no notice applies.
 */
export function startupHomeNotice(options: Parameters<typeof detectRetiredHome>[0] = {}): string | undefined {
  const finding = detectRetiredHome(options)
  if (finding === undefined) return undefined
  return retiredHomeNotice(finding, resolveDshHome(undefined, options.env ?? process.env))
}
