/**
 * Verify shipped Loader configuration against each plugin's declared config keys.
 *
 * The Loader hands a row's `config` to the plugin's config schema, and that
 * schema ignores keys it does not declare. A misspelled or retired key in a
 * bundle patch, an application config, or a preset therefore changes nothing and
 * reports nothing. This gate reads the same declared keys the config catalog
 * documents and rejects a shipped row that names a key the plugin does not take.
 *
 * The walk follows `insert` lists and group rows, so bundle patches, application
 * configs, and presets are all covered. Only top-level keys are compared. Nested
 * paths (`agents[].id`) are documented but not walked, because a schema may
 * legitimately declare a nested object with free-form children. A row whose
 * plugin declares no schema is counted, not judged. Recorded session pickles
 * under `snapshots/` keep the configuration shape of the release that produced
 * them and are not checked.
 */
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { collectConfigCatalog } from './gen-config-catalog.ts'
import { cordisConfigFiles } from './cordis-config-files.ts'
import { loadCordisYaml } from './cordis-yaml.ts'

const root = resolve(import.meta.dirname, '..')

/** Configurations that record a past release rather than describe the current one. */
const RECORDED_PREFIXES = ['snapshots/']

/** Top-level config keys a plugin's schema declares. */
export type DeclaredConfigKeys = readonly string[]

/**
 * Report the config keys a plugin does not declare.
 * @param config - The row's config object.
 * @param declared - Top-level keys the plugin's schema declares.
 * @returns Undeclared keys, sorted for stable reporting.
 */
export function unknownConfigKeys(
  config: Readonly<Record<string, unknown>>,
  declared: DeclaredConfigKeys,
): string[] {
  // A nested schema path (gents[].id) declares its top-level key too.
  const known = new Set(declared.map(key => key.split(/[.[]/u)[0]))
  return Object.keys(config).filter(key => !known.has(key)).sort()
}

/**
 * Resolve the package a Loader row names, so its schema can be looked up.
 * @param name - Row `name` as written in the Loader file.
 * @returns Package name, or `undefined` for a relative entry.
 */
export function configOwnerPackage(name: string): string | undefined {
  if (name.startsWith('.')) return undefined
  return name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
}

/**
 * Read every shipped Loader file and compare its rows against declared keys.
 * @param scanRoot - Repository root to scan.
 * @returns Violation messages and the coverage the comparison reached.
 */
export function collectConfigKeyViolations(scanRoot: string = root): {
  violations: string[]
  checkedRows: number
  undeclaredRows: number
} {
  const keysByPackage = new Map<string, DeclaredConfigKeys | null>()
  for (const entry of collectConfigCatalog(scanRoot)) keysByPackage.set(entry.pkg, entry.schemaKeys ?? null)
  const violations: string[] = []
  let checkedRows = 0
  let undeclaredRows = 0
  for (const candidate of cordisConfigFiles(scanRoot)) {
    // Glob results carry the platform separator; repository paths use / everywhere else.
    const file = candidate.split(sep).join('/')
    if (RECORDED_PREFIXES.some(prefix => file.startsWith(prefix))) continue
    let document: unknown
    try { document = loadCordisYaml(readFileSync(resolve(scanRoot, file), 'utf8')) } catch { continue }
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { for (const item of value) visit(item); return }
      if (typeof value !== 'object' || value === null) return
      const row = value as Record<string, unknown>
      visit(row.insert)
      const name = typeof row.name === 'string' ? row.name : undefined
      const config = row.config
      if (name === undefined) {
        // A group carries its nested rows in `config`; a non-group row without a
        // name is not a plugin mount this gate can classify.
        if (Array.isArray(config)) visit(config)
        return
      }
      if (typeof config !== 'object' || config === null || Array.isArray(config)) return
      const owner = configOwnerPackage(name)
      const declared = owner === undefined ? undefined : keysByPackage.get(owner)
      if (declared === undefined || declared === null) { undeclaredRows += 1; return }
      checkedRows += 1
      for (const key of unknownConfigKeys(config as Record<string, unknown>, declared)) {
        violations.push(`${file}: ${name} does not declare config key ${key}`)
      }
    }
    visit(document)
  }
  return { violations, checkedRows, undeclaredRows }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('verify-config-keys.ts')) {
  const { violations, checkedRows, undeclaredRows } = collectConfigKeyViolations()
  const coverage = `${String(checkedRows)} row(s) checked, ${String(undeclaredRows)} without a declared schema`
  if (violations.length > 0) {
    console.error(`verify-config-keys: ${String(violations.length)} undeclared key(s); ${coverage}`)
    for (const violation of violations.sort()) console.error(`  ${violation}`)
    process.exitCode = 1
  } else {
    console.log(`verify-config-keys: ${coverage}, every declared key accepted`)
  }
}
