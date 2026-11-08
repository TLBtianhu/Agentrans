/** Select independently owned prompt and tool-schema sidecars for recorded-session profiles. */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseSnapshotManifest, type SnapshotHeaderManifest } from './manifest.ts'

/**
 * Select a declared host variant, or the shared schema sidecar when none is declared for that host.
 * @param header - schema owner's manifest metadata; absent metadata selects the shared file.
 * @param platform - host being checked; defaults to the current Node host.
 * @returns The selected sidecar's filename, without checking its presence.
 */
export function toolSchemasSnapshotFilename(
  header: Pick<SnapshotHeaderManifest, 'toolSchemasVariants'> | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' && header?.toolSchemasVariants?.includes('win32') === true
    ? 'tool-schemas.win32.expected.json'
    : 'tool-schemas.expected.json'
}

/**
 * Select a declared host prompt, or the shared prompt when none is declared for that host.
 * @param header - prompt owner's manifest metadata; absent metadata selects the shared file.
 * @param platform - host being checked; defaults to the current Node host.
 * @returns The selected sidecar's filename, without checking its presence.
 */
export function systemPromptSnapshotFilename(
  header: Pick<SnapshotHeaderManifest, 'systemPromptVariants'> | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' && header?.systemPromptVariants?.includes('win32') === true
    ? 'system-prompt.win32.expected.md'
    : 'system-prompt.expected.md'
}

async function resolveHeaderSidecarPath(
  directory: string,
  kind: 'toolSchemas' | 'systemPrompt',
  platform: NodeJS.Platform,
): Promise<string> {
  let owner = resolve(directory)
  const visited = new Set<string>()
  const sourceField = kind === 'toolSchemas' ? 'toolSchemasSource' : 'systemPromptSource'
  const variantsField = kind === 'toolSchemas' ? 'toolSchemasVariants' : 'systemPromptVariants'
  const label = kind === 'toolSchemas' ? 'tool-schema' : 'system-prompt'
  while (!visited.has(owner)) {
    visited.add(owner)
    const manifestPath = join(owner, 'snapshot.yml')
    const { header } = parseSnapshotManifest(await readFile(manifestPath, 'utf8'), manifestPath)
    const source = header?.[sourceField]
    // Sources with a profile prefix are corpus-relative; bare names are profile-local.
    const next = source === undefined ? owner : resolve(
      source.includes('/') ? dirname(dirname(owner)) : dirname(owner), source,
    )
    if (next === owner) return join(owner, kind === 'toolSchemas'
      ? toolSchemasSnapshotFilename(header, platform) : systemPromptSnapshotFilename(header, platform))
    if (header?.[variantsField] !== undefined) {
      throw new Error(`${manifestPath}: ${variantsField} requires ownership of the ${label} sidecar`)
    }
    owner = next
  }
  throw new Error(`${directory}: cyclic ${label} sidecar source at ${owner}`)
}

/**
 * Resolve local or corpus-relative schema sources, then select the final owner's host sidecar.
 * Missing manifests, cycles, and variants declared by a borrower fail; a missing selected file never falls back.
 * @param directory - referring scenario directory under a profile's snapshot directory.
 * @param platform - host being checked; defaults to the current Node host.
 * @returns The selected sidecar path. Readers and writers own opening that exact path.
 */
export async function resolveToolSchemasSnapshotPath(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  return resolveHeaderSidecarPath(directory, 'toolSchemas', platform)
}

/**
 * Resolve local or corpus-relative prompt sources, then select the final owner's host sidecar.
 * Missing manifests, cycles, and variants declared by a borrower fail; a missing selected file never falls back.
 * @param directory - referring scenario directory under a profile's snapshot directory.
 * @param platform - host being checked; defaults to the current Node host.
 * @returns The selected sidecar path. Readers and writers own opening that exact path.
 */
export async function resolveSystemPromptSnapshotPath(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  return resolveHeaderSidecarPath(directory, 'systemPrompt', platform)
}
