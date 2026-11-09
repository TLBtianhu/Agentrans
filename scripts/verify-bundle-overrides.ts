/**
 * Verify that a bundle layer restates every config key a lower layer declared.
 *
 * A patch replaces the targeted row's whole `config` instead of merging into it,
 * so a later layer that lists fewer keys than the layer it overrides silently
 * reverts the omitted ones to the plugin's defaults. The bundle convention is
 * that each layer writes the complete configuration it wants; this gate checks
 * that a shipped profile composes that way.
 *
 * Only rows present in more than one layer are compared, and only object
 * `config` values are compared. `!!js` expressions, arrays, and rows a layer
 * drops entirely are out of scope: an expression is evaluated per context, and a
 * row absent from a later layer keeps the earlier definition.
 */
import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROFILE_TEMPLATES } from '../packages/util/official-bundles/src/bundles.ts'
import { loadCordisYaml } from './cordis-yaml.ts'

const root = resolve(import.meta.dirname, '..')

/** One composed row definition, as a single layer wrote it. */
export interface LayerRow {
  /** Row id the layer declares (`- id:`). */
  readonly id: string
  /** Config object the layer declares, absent when it declares none. */
  readonly config?: Readonly<Record<string, unknown>>
}

/**
 * Report the keys a later layer dropped from an earlier definition.
 * @param before - Config keys the earlier layer declared.
 * @param after - Config keys the overriding layer declares.
 * @returns Keys the override omits, sorted.
 */
export function droppedOverrideKeys(before: ReadonlySet<string>, after: ReadonlySet<string>): string[] {
  return [...before].filter(key => !after.has(key)).sort()
}

/**
 * Read the rows a patch file declares, including `insert` lists and groups.
 * @param file - Repository-relative patch path.
 * @returns Rows that carry an id.
 */
export function patchRows(file: string): LayerRow[] {
  const document = loadCordisYaml(readFileSync(resolve(root, file), 'utf8'))
  const rows: LayerRow[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (typeof value !== 'object' || value === null) return
    const row = value as Record<string, unknown>
    visit(row.insert)
    if (typeof row.id !== 'string') {
      // A group carries its nested rows in `config`.
      if (Array.isArray(row.config)) visit(row.config)
      return
    }
    const config = row.config
    rows.push({
      id: row.id,
      ...typeof config === 'object' && config !== null && !Array.isArray(config)
        ? { config: config as Record<string, unknown> }
        : {},
    })
  }
  visit(document)
  return rows
}

/**
 * Resolve every workspace bundle to the patch layers it ships, in order.
 * @returns Package name to repository-relative patch files.
 */
export function bundlePatchLayers(): Map<string, string[]> {
  const layers = new Map<string, string[]>()
  for (const manifestPath of globSync('packages/*/*/package.json', { cwd: root }).map(path => path.split('\\').join('/'))) {
    const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8')) as {
      name?: string
      dsh?: { bundle?: { patch?: string | string[] } }
    }
    const patch = manifest.dsh?.bundle?.patch
    if (manifest.name === undefined || patch === undefined) continue
    const directory = manifestPath.replace(/\/package\.json$/u, '')
    layers.set(manifest.name, (Array.isArray(patch) ? patch : [patch])
      .map(entry => `${directory}/${entry.replace(/^\.\//u, '')}`))
  }
  return layers
}

/**
 * Compose every shipped profile and report overrides that drop a declared key.
 * @returns Violations and the number of overrides the comparison reached.
 */
export function collectBundleOverrideViolations(): { violations: string[]; overridesChecked: number } {
  const layers = bundlePatchLayers()
  const violations: string[] = []
  let overridesChecked = 0
  for (const [profile, template] of Object.entries(PROFILE_TEMPLATES)) {
    const declared = new Map<string, { keys: Set<string>; layer: string }>()
    for (const bundle of template.bundles) {
      for (const file of layers.get(bundle) ?? []) {
        for (const row of patchRows(file)) {
          if (row.config === undefined || Object.keys(row.config).length === 0) continue
          const keys = new Set(Object.keys(row.config))
          const before = declared.get(row.id)
          if (before !== undefined) {
            overridesChecked += 1
            const dropped = droppedOverrideKeys(before.keys, keys)
            if (dropped.length > 0) {
              violations.push(`${profile}: ${file} overrides ${row.id} without ${dropped.join(', ')}; ${before.layer} declares them`)
            }
          }
          declared.set(row.id, { keys, layer: file })
        }
      }
    }
  }
  return { violations, overridesChecked }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('verify-bundle-overrides.ts')) {
  const { violations, overridesChecked } = collectBundleOverrideViolations()
  if (violations.length > 0) {
    console.error(`verify-bundle-overrides: ${String(violations.length)} override(s) drop a declared key; ${String(overridesChecked)} override(s) checked`)
    for (const violation of violations.sort()) console.error(`  ${violation}`)
    process.exitCode = 1
  } else {
    console.log(`verify-bundle-overrides: ${String(overridesChecked)} override(s) checked, each restates the keys it replaces`)
  }
}
