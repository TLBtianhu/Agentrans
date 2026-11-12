/**
 * Require every `CLAUDE.md` to mirror its sibling `AGENTS.md` byte for byte.
 *
 * The source snapshot materialized what upstream kept as symbolic links, so the two files are
 * independent copies here. Without this check an edit to one copy leaves the other silently stale,
 * and a reader cannot tell which one the repository means.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/** One mirror the repository must carry. */
export interface MirrorCheck {
  /** Repository-relative path of the `CLAUDE.md` copy. */
  readonly mirror: string
  /** Repository-relative path of the `AGENTS.md` original. */
  readonly original: string
}

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git'])

/**
 * Find every `CLAUDE.md` below a directory, including dot directories.
 * @param root - Absolute root to walk.
 * @param relative - Repository-relative prefix of the directory.
 * @returns Repository-relative mirror paths in stable order.
 */
function findMirrors(root: string, relative = ''): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      found.push(...findMirrors(root, relative === '' ? entry.name : `${relative}/${entry.name}`))
      continue
    }
    if (entry.isFile() && entry.name === 'CLAUDE.md') found.push(relative === '' ? entry.name : `${relative}/${entry.name}`)
  }
  return found
}

/**
 * List every `CLAUDE.md` that must mirror a sibling `AGENTS.md`.
 * @param root - Repository or fixture root to scan.
 * @returns Mirrors in stable order, each with the original that must match it.
 * @throws When the repository carries no mirror at all, so a narrowed corpus cannot pass.
 */
export function requiredMirrors(root: string): MirrorCheck[] {
  const mirrors = findMirrors(resolve(root)).sort()
  if (mirrors.length === 0) {
    throw new Error('claude-mirror: the repository carries no CLAUDE.md; the gate has no corpus to verify')
  }
  return mirrors.map(mirror => ({ mirror, original: mirror.replace(/CLAUDE\.md$/u, 'AGENTS.md') }))
}

/**
 * Report mirrors that are missing or differ from their original.
 * @param root - Repository or fixture root to verify.
 * @returns One message per unpaired or divergent mirror, in path order.
 */
export function claudeMirrorViolations(root: string): string[] {
  const absoluteRoot = resolve(root)
  const violations: string[] = []
  for (const { mirror, original } of requiredMirrors(absoluteRoot)) {
    if (!existsSync(join(absoluteRoot, original))) {
      violations.push(`${mirror} has no sibling ${original}; a mirror cannot stand alone`)
      continue
    }
    if (!readFileSync(join(absoluteRoot, mirror)).equals(readFileSync(join(absoluteRoot, original)))) {
      violations.push(`${mirror} differs from ${original}; edit one and copy it over the other`)
    }
  }
  return violations
}

/**
 * Stop when a mirror has drifted from the instruction file it stands for.
 * @param root - Repository or fixture root to verify.
 * @returns Nothing when every mirror matches its original.
 * @throws When a mirror is missing, unpaired, or differs.
 */
export function assertClaudeMirrors(root: string): void {
  const violations = claudeMirrorViolations(root)
  if (violations.length > 0) {
    throw new Error(['claude-mirror: CLAUDE.md must match its AGENTS.md byte for byte:', ...violations].join('\n'))
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { root: { type: 'string' } }, allowPositionals: false })
    const root = values.root === undefined ? resolve(fileURLToPath(new URL('..', import.meta.url))) : resolve(values.root)
    assertClaudeMirrors(root)
    console.log(`claude-mirror: ${String(requiredMirrors(root).length)} mirror(s) match their AGENTS.md.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
