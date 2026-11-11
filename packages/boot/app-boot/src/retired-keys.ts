/**
 * Read manifests written before the `dsh` → `agentrans` rename as if they carried the new names.
 *
 * The rename ships a reader for the retired keys so an installed profile and an out-of-tree plugin
 * keep loading, and reports each affected file once. Writing always uses the new names, so a
 * manifest the product rewrites migrates itself.
 * @module @agentrans/app-boot/retired-keys
 */
import type { DshManifest, DshPackageManifest } from '@agentrans/package-manifest'

/** Manifest key the product reads and writes. */
export const AUTHOR_KEY = 'agentrans' as const
/** Manifest key written before the rename. */
export const RETIRED_AUTHOR_KEY = 'dsh' as const
/** Engine name the product reads. */
export const ENGINE_KEY = 'agentrans' as const
/** Engine name written before the rename. */
export const RETIRED_ENGINE_KEY = 'dsh' as const

/** Files already reported, so one manifest produces one notice however often it is read. */
const reported = new Set<string>()

/**
 * Report one retired-key notice for a file.
 * @param path - Manifest path, or a description when no file backs the value.
 * @param detail - What the file declares and how to rename it.
 */
function reportRetiredKey(path: string, detail: string): void {
  const key = `${path}\u0000${detail}`
  if (reported.has(key)) return
  reported.add(key)
  process.emitWarning(`${path}: ${detail}`, { code: 'AGENTRANS_RETIRED_MANIFEST_KEY', type: 'DeprecationWarning' })
}

/**
 * Move a manifest's author fields onto the current key, in place.
 * @param manifest - Parsed manifest; a retired key is replaced by the current one.
 * @param path - Manifest path used in the deprecation notice.
 * @returns The same manifest, carrying `agentrans` and no retired key.
 */
export function normalizeAuthorKey(manifest: Partial<DshPackageManifest>, path: string): Partial<DshPackageManifest> {
  /* eslint-disable-next-line typescript/no-deprecated -- reading the retired key is this module's job */
  const retired = manifest[RETIRED_AUTHOR_KEY]
  if (retired === undefined) return manifest
  if (manifest[AUTHOR_KEY] === undefined) {
    manifest[AUTHOR_KEY] = retired
    reportRetiredKey(path, `declares its plugin fields under the retired "${RETIRED_AUTHOR_KEY}" key; rename it to "${AUTHOR_KEY}"`)
  } else {
    reportRetiredKey(path, `carries both "${AUTHOR_KEY}" and the retired "${RETIRED_AUTHOR_KEY}" key; "${RETIRED_AUTHOR_KEY}" is ignored`)
  }
  Reflect.deleteProperty(manifest, RETIRED_AUTHOR_KEY)
  return manifest
}

/**
 * Move a `dsh` engine requirement onto the current engine name, in place.
 * @param manifest - Parsed manifest; the retired engine entry is replaced by the current one.
 * @param path - Manifest path used in the deprecation notice.
 * @returns The same manifest, carrying `engines.agentrans` and no retired engine entry.
 */
export function normalizeEngineKey(manifest: Partial<DshPackageManifest>, path: string): Partial<DshPackageManifest> {
  const engines = manifest.engines
  if (engines === undefined) return manifest
  /* eslint-disable-next-line typescript/no-deprecated -- reading the retired engine name is this module's job */
  const retired = engines[RETIRED_ENGINE_KEY]
  if (retired === undefined) return manifest
  if (engines[ENGINE_KEY] === undefined) {
    engines[ENGINE_KEY] = retired
    reportRetiredKey(path, `declares its runtime range under the retired "engines.${RETIRED_ENGINE_KEY}"; rename it to "engines.${ENGINE_KEY}"`)
  } else {
    reportRetiredKey(path, `carries both "engines.${ENGINE_KEY}" and the retired "engines.${RETIRED_ENGINE_KEY}"; the retired entry is ignored`)
  }
  Reflect.deleteProperty(engines, RETIRED_ENGINE_KEY)
  return manifest
}

/**
 * Apply both retired-key moves to a parsed manifest.
 * @param manifest - Parsed manifest; returned after the in-place moves.
 * @param path - Manifest path used in the deprecation notices.
 * @returns The same manifest under the current names.
 */
export function normalizeRetiredKeys(manifest: Partial<DshPackageManifest>, path: string): Partial<DshPackageManifest> {
  normalizeAuthorKey(manifest, path)
  normalizeEngineKey(manifest, path)
  return manifest
}

/**
 * Read the author fields a manifest declares under either key.
 * @param manifest - Parsed manifest, normalized or not.
 * @param path - Manifest path used in the deprecation notice.
 * @returns The declared author fields, if any.
 */
export function readAuthorFields(manifest: Partial<DshPackageManifest>, path: string): DshManifest | undefined {
  return normalizeAuthorKey(manifest, path)[AUTHOR_KEY]
}

/**
 * Read the Agentrans engine range a manifest declares under either engine name.
 * @param manifest - Parsed manifest, normalized or not.
 * @param path - Manifest path used in the deprecation notice.
 * @returns The declared range, if any.
 */
export function readEngineRange(manifest: Partial<DshPackageManifest>, path: string): string | undefined {
  return normalizeEngineKey(manifest, path).engines?.[ENGINE_KEY]
}
