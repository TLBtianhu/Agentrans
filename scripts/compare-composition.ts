/**
 * Compare two Cordis patch documents row by row.
 *
 * The product composition is a patch layer, so "how do we differ from a
 * reference composition" is a row-set question: which ids exist on one side
 * only, and which shared ids carry a different name, mount state, or config.
 * Both sides load through the launcher's own patch reader, so `insert`,
 * overrides by id, and loader expressions compare exactly as they load.
 *
 * Usage: `pnpm run compare-composition -- <theirs.patch.yml> [--ours <path>]`
 */

import { relative, resolve } from 'node:path'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '../packages/boot/app-boot/src/index.ts'

interface Row {
  readonly name: string
  readonly disabled: unknown
  readonly config: unknown
}

const root = resolve(import.meta.dirname, '..')
const DEFAULT_OURS = 'packages/bundle/base/cordis.patch.yml'

/**
 * Read one patch document into its effective row set.
 * @param path - absolute patch path.
 * @returns rows keyed by id, with nested groups flattened under their parent id.
 */
function rowsOf(path: string): Map<string, Row> {
  const patches = loadOverlayPatches('compare-composition', path)
  const entries = applyEntryPatches([], patches, () => {})
  const rows = new Map<string, Row>()
  const visit = (list: readonly unknown[], prefix: string): void => {
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as { id?: unknown; name?: unknown; disabled?: unknown; config?: unknown }
      const id = typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : undefined
      if (id === undefined) continue
      // A group nests its children in config; they are rows in their own right.
      if (Array.isArray(entry.config)) {
        visit(entry.config, `${prefix}${id}/`)
        continue
      }
      rows.set(`${prefix}${id}`, {
        name: typeof entry.name === 'string' ? entry.name : '',
        disabled: entry.disabled,
        config: entry.config,
      })
    }
  }
  visit(entries, '')
  return rows
}

/**
 * Describe how one shared row differs.
 * @param ours - our row.
 * @param theirs - the reference row.
 * @returns human-readable differences; empty when the rows match.
 */
function differences(ours: Row, theirs: Row): string[] {
  const notes: string[] = []
  if (ours.name !== theirs.name) notes.push(`name: ${ours.name} -> ${theirs.name}`)
  if (JSON.stringify(ours.disabled) !== JSON.stringify(theirs.disabled)) {
    notes.push(`disabled: ${JSON.stringify(ours.disabled ?? null)} -> ${JSON.stringify(theirs.disabled ?? null)}`)
  }
  if (JSON.stringify(ours.config) !== JSON.stringify(theirs.config)) {
    const keys = (value: unknown): string[] => typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.keys(value) : []
    const mine = keys(ours.config)
    const yours = keys(theirs.config)
    const changed = [...new Set([...mine, ...yours])].filter(key => JSON.stringify(
      (ours.config as Record<string, unknown> | undefined)?.[key],
    ) !== JSON.stringify((theirs.config as Record<string, unknown> | undefined)?.[key]))
    notes.push(`config: ${changed.length === 0 ? 'differs' : changed.join(', ')}`)
  }
  return notes
}

/**
 * Print the row-set comparison.
 * @param oursPath - our patch document, relative to the repository root.
 * @param theirsPath - the reference patch document.
 */
function report(oursPath: string, theirsPath: string): void {
  const ours = rowsOf(resolve(root, oursPath))
  const theirs = rowsOf(resolve(theirsPath))
  const added = [...theirs].filter(([id]) => !ours.has(id))
  const removed = [...ours].filter(([id]) => !theirs.has(id))
  const changed = [...theirs].flatMap(([id, row]) => {
    const mine = ours.get(id)
    if (mine === undefined) return []
    const notes = differences(mine, row)
    return notes.length === 0 ? [] : [{ id, notes }]
  })
  console.log(`ours:   ${String(ours.size)} rows  ${oursPath}`)
  console.log(`theirs: ${String(theirs.size)} rows  ${relative(root, resolve(theirsPath))}`)
  console.log('')
  console.log(`added (theirs only): ${String(added.length)}`)
  for (const [id, row] of added) console.log(`  ${id}  ${row.name}`)
  console.log(`removed (ours only): ${String(removed.length)}`)
  for (const [id, row] of removed) console.log(`  ${id}  ${row.name}`)
  console.log(`changed: ${String(changed.length)}`)
  for (const entry of changed) console.log(`  ${entry.id}  ${entry.notes.join('; ')}`)
  if (added.length + removed.length + changed.length === 0) console.log('  compositions match')
}

/**
 * Parse argv and run the comparison.
 * @param argv - arguments after the script name.
 */
function main(argv: readonly string[]): void {
  const oursIndex = argv.indexOf('--ours')
  const ours = oursIndex === -1 ? DEFAULT_OURS : argv[oursIndex + 1]
  const theirs = argv.find((argument, index) => !argument.startsWith('--') && (oursIndex === -1 || index !== oursIndex + 1))
  if (theirs === undefined || ours === undefined) {
    console.error('usage: pnpm run compare-composition -- <theirs.patch.yml> [--ours <path>]')
    process.exitCode = 1
    return
  }
  report(ours, theirs)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2))
}

// The read is exported for tests; the CLI above is the only runtime caller.
export { differences, rowsOf }
