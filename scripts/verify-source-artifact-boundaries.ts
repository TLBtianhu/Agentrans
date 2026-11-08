/** Reject compiled siblings that can replace workspace TypeScript source during module resolution. */
import { lstatSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { workspaceManifestPaths, workspacePackageGlobs } from './workspace-package-globs.ts'

// These browser programs and their TS string bindings are both owned by generate-scene-bundles.ts.
const OWNED_SOURCE_PROGRAMS = new Set([
  'packages/artifact/artifact/src/scene-expr.generated.js',
  'packages/artifact/artifact/src/scene-renderers.generated.js',
])

function ordinaryDirectory(root: string, path: string): boolean {
  const offset = relative(root, path)
  if (isAbsolute(offset) || offset === '..' || offset.startsWith(`..${sep}`)) return false
  let current = root
  for (const name of ['', ...offset.split(sep).filter(Boolean)]) {
    current = join(current, name)
    const entry = lstatSync(current, { throwIfNoEntry: false })
    if (entry === undefined || entry.isSymbolicLink() || !entry.isDirectory()) return false
  }
  return true
}

/**
 * Find source-adjacent emission without following linked directories or removing any file.
 * @param root - Repository or fixture workspace root.
 * @returns Repository-relative conflicting artifacts sorted for diagnostics.
 */
export function sourceArtifactBoundaryViolations(root: string): string[] {
  const absoluteRoot = resolve(root)
  const violations = new Set<string>()
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') visit(path)
        continue
      }
      if (!entry.isFile() || !/\.(?:ts|tsx|mts|cts)$/u.test(entry.name) || /\.d\.[cm]?ts$/u.test(entry.name)) continue
      const sourceExtension = entry.name.slice(entry.name.lastIndexOf('.'))
      const stem = path.slice(0, -sourceExtension.length)
      const runtime = sourceExtension === '.mts' ? '.mjs' : sourceExtension === '.cts' ? '.cjs' : '.js'
      const declaration = sourceExtension === '.mts' ? '.d.mts' : sourceExtension === '.cts' ? '.d.cts' : '.d.ts'
      const suffixes = [runtime, `${runtime}.map`, declaration, `${declaration}.map`,
        ...sourceExtension === '.tsx' ? ['.jsx', '.jsx.map'] : []]
      for (const suffix of suffixes) {
        const candidate = `${stem}${suffix}`
        if (lstatSync(candidate, { throwIfNoEntry: false }) === undefined) continue
        const rel = relative(absoluteRoot, candidate).split(sep).join('/')
        if (!OWNED_SOURCE_PROGRAMS.has(rel)) violations.add(rel)
      }
    }
  }
  for (const directory of workspacePackageGlobs(workspaceManifestPaths(absoluteRoot))) {
    const source = resolve(absoluteRoot, directory, 'src')
    if (ordinaryDirectory(absoluteRoot, source)) visit(source)
  }
  return [...violations].sort()
}

/**
 * Stop before build generators or compilers can consume conflicting source-adjacent files.
 * @param root - Repository or fixture workspace root.
 * @returns Nothing for clean source directories.
 * @throws When compiled siblings are present; files remain untouched for inspection or verified quarantine.
 */
export function assertSourceArtifactBoundaries(root: string): void {
  const violations = sourceArtifactBoundaryViolations(root)
  if (violations.length > 0) {
    throw new Error(['source-artifact-boundaries: compiled siblings can shadow TypeScript source:',
      ...violations.map(path => `  ${path}`),
      'Inspect these files and move verified build residue outside src before rerunning the supported build. No files were removed.',
    ].join('\n'))
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { root: { type: 'string' } }, allowPositionals: false })
    assertSourceArtifactBoundaries(resolve(values.root ?? fileURLToPath(new URL('..', import.meta.url))))
    console.log('source-artifact-boundaries: workspace source directories contain no conflicting build output.')
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
