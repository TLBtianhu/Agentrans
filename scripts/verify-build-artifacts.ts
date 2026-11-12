/**
 * Prove that the tree a `build:check` run trusts still holds the runtime artifacts its manifests declare.
 *
 * `build:check` type-checks declarations, so it stays green on a tree whose tsdown bundles, CLI entries,
 * or client build record were removed after the last complete build. This gate re-derives each workspace
 * manifest's runtime entries and reads the client build record, then reports every missing artifact with the
 * command that rebuilds it. Publishability stays publint's fact in `hygiene`; this gate owns build integrity.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { readClientBuildRecord } from './client-build-environment.ts'
import { workspaceManifestPaths } from './workspace-package-globs.ts'

/** One artifact the package manifests declare, with the manifest that names it. */
export interface DeclaredRuntimeArtifact {
  /** Repository-relative artifact path using forward slashes. */
  readonly path: string
  /** Repository-relative manifest that declares the path. */
  readonly declaredBy: string
}

const RUNTIME_EXTENSIONS = /\.(?:js|mjs|cjs)$/u
const DECLARATION_FILE = /\.d\.[cm]?ts$/u
const WILDCARD = /[*?]/u

/**
 * Collect the runtime entry paths one package manifest declares.
 * @param manifest - Parsed package.json value; unrecognized fields are ignored.
 * @returns Runtime paths under `lib/`, normalized without a leading `./`, sorted and unique.
 */
export function declaredRuntimePaths(manifest: unknown): string[] {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return []
  const paths = new Set<string>()
  const admit = (value: unknown): void => {
    if (typeof value !== 'string') return
    const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '')
    if (!normalized.startsWith('lib/') || WILDCARD.test(normalized) || DECLARATION_FILE.test(normalized)) return
    if (!RUNTIME_EXTENSIONS.test(normalized)) return
    paths.add(normalized)
  }
  const record = manifest as Record<string, unknown>
  admit(record['main'])
  admit(record['module'])
  const bin = record['bin']
  if (typeof bin === 'string') admit(bin)
  else if (typeof bin === 'object' && bin !== null && !Array.isArray(bin)) {
    for (const value of Object.values(bin)) admit(value)
  }
  const pending: unknown[] = [record['exports']]
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value === 'string') admit(value)
    else if (Array.isArray(value)) pending.push(...value)
    else if (typeof value === 'object' && value !== null) pending.push(...Object.values(value))
  }
  return [...paths].sort()
}

/**
 * List every runtime artifact the workspace manifests require.
 * @param root - Repository or fixture root containing `pnpm-workspace.yaml`.
 * @returns Declared artifacts sorted by path.
 * @throws When no manifest declares a runtime entry, so a narrowed corpus cannot pass silently.
 */
export function declaredRuntimeArtifacts(root: string): DeclaredRuntimeArtifact[] {
  const absoluteRoot = resolve(root)
  const artifacts: DeclaredRuntimeArtifact[] = []
  for (const manifestPath of workspaceManifestPaths(absoluteRoot)) {
    if (manifestPath === 'package.json') continue
    const manifest: unknown = JSON.parse(readFileSync(join(absoluteRoot, manifestPath), 'utf8'))
    const directory = dirname(manifestPath).replaceAll('\\', '/')
    for (const path of declaredRuntimePaths(manifest)) artifacts.push({ path: `${directory}/${path}`, declaredBy: manifestPath })
  }
  if (artifacts.length === 0) {
    throw new Error('build-artifacts: no workspace manifest declares a runtime entry under lib/; the gate found no corpus to verify')
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path))
}

/**
 * Find declared runtime artifacts that are absent from the tree.
 * @param root - Repository or fixture root containing the compiled workspace.
 * @returns Repository-relative missing paths with their declaring manifest.
 */
export function missingRuntimeArtifacts(root: string): DeclaredRuntimeArtifact[] {
  const absoluteRoot = resolve(root)
  return declaredRuntimeArtifacts(absoluteRoot).filter(artifact => !existsSync(join(absoluteRoot, artifact.path)))
}

/**
 * Require the client build record that binds a complete build to the artifacts on disk.
 * @param root - Repository or fixture root containing the record and client artifacts.
 * @returns The verified record's artifact count.
 * @throws When the record is missing, invalid, or no longer matches the client artifacts.
 */
export function verifyClientBuildRecord(root: string): number {
  return readClientBuildRecord(root).artifacts.fileCount
}

/**
 * Reject a tree whose declared runtime artifacts or client build record are absent.
 * @param root - Repository or fixture root to verify without rebuilding anything.
 * @returns Counts of verified runtime artifacts and client artifacts.
 * @throws When any declared runtime artifact is missing or the client build record does not match.
 */
export function verifyBuildArtifacts(root: string): { readonly artifacts: number; readonly clientArtifacts: number } {
  const absoluteRoot = resolve(root)
  const declared = declaredRuntimeArtifacts(absoluteRoot)
  const missing = declared.filter(artifact => !existsSync(join(absoluteRoot, artifact.path)))
  const problems: string[] = []
  if (missing.length > 0) {
    problems.push(...missing.map(artifact => `  ${artifact.path} (declared by ${artifact.declaredBy})`))
  }
  let clientArtifacts = 0
  try {
    clientArtifacts = verifyClientBuildRecord(absoluteRoot)
  } catch (error) {
    problems.push(`  ${error instanceof Error ? error.message : String(error)}`)
  }
  if (problems.length > 0) {
    throw new Error(['build-artifacts: the tree does not hold a complete build:', ...problems,
      'Run a complete `pnpm run build` before trusting this tree; build:check only type-checks declarations.',
    ].join('\n'))
  }
  return { artifacts: declared.length, clientArtifacts }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { root: { type: 'string' } }, allowPositionals: false })
    const result = verifyBuildArtifacts(values.root === undefined ? resolve(import.meta.dirname, '..') : resolve(values.root))
    console.log(`build-artifacts: ${String(result.artifacts)} declared runtime artifacts and a ${String(result.clientArtifacts)}-file client build are present.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
