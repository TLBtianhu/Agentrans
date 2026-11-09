/**
 * Keep each capability seam's roles on one dependency direction.
 *
 * A seam has three roles: the definition package names the service, a provider
 * package implements it, and consumer packages use it through the service key.
 * Only `consumer → definition` and `provider → definition` are legal, so a
 * package that merely uses a capability must not depend on whichever
 * implementation happens to be mounted.
 *
 * The role table is `SERVICE_ROLES` in the graph generator, which also renders
 * the published seam map. This gate reads that table rather than restating it,
 * and checks the runtime import graph: a value import of a provider from any
 * package that is not itself a provider of that seam is a violation. Type-only
 * imports stay allowed, because declaration merging needs the provider's
 * augmentation without loading it, and `ctx.get(key)` lookups are not imports.
 */
import { globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { SERVICE_ROLES } from './gen-doc-graphs.ts'
import { collectRuntimeSourceSpecifiers } from './source-parse-uses.ts'

const root = resolve(import.meta.dirname, '..')

/** Prefix every first-party package name carries. */
const PACKAGE_PREFIX = '@deepseek-ai/dsh-'

/** One workspace package resolved from its manifest. */
export interface WorkspacePackage {
  /** Short name the role table uses, without the scope prefix. */
  readonly short: string
  /** Full npm package name importers write. */
  readonly name: string
  /** Repository-relative package directory. */
  readonly directory: string
}

/**
 * Name the role table may use for a package: its scope-stripped name or its
 * directory basename, which is how client packages appear in the table.
 * @param pkg - Workspace package.
 * @returns Candidate short names.
 */
export function roleNamesOf(pkg: WorkspacePackage): string[] {
  return [pkg.short, pkg.directory.split('/').pop() ?? pkg.short]
}

/**
 * Resolve every workspace package to the names the role table and importers use.
 * @returns Workspace packages in directory order.
 */
export function workspacePackages(): WorkspacePackage[] {
  const packages: WorkspacePackage[] = []
  for (const manifestPath of globSync('packages/*/*/package.json', { cwd: root }).map(path => path.split('\\').join('/'))) {
    const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8')) as { name?: string }
    if (manifest.name === undefined || !manifest.name.startsWith(PACKAGE_PREFIX)) continue
    packages.push({
      short: manifest.name.slice(PACKAGE_PREFIX.length),
      name: manifest.name,
      directory: dirname(manifestPath),
    })
  }
  return packages
}

/**
 * Report the provider packages one seam forbids outsiders from importing.
 * @param seam - Role table entry.
 * @returns Provider package names.
 */
export function providerPackagesOf(seam: { implementations?: readonly string[] }): Set<string> {
  return new Set((seam.implementations ?? []).map(short => `${PACKAGE_PREFIX}${short}`))
}

/**
 * Report the provider imports one source file makes for a seam.
 * @param file - Repository-relative source path, used in the message.
 * @param source - File contents.
 * @param seamKey - Service key that names the seam.
 * @param definition - Definition package short name.
 * @param providers - Provider package names the seam forbids reaching directly.
 * @returns One message per offending specifier.
 */
export function providerImportsInSource(
  file: string,
  source: string,
  seamKey: string,
  definition: string,
  providers: ReadonlySet<string>,
): string[] {
  const messages: string[] = []
  for (const specifier of collectRuntimeSourceSpecifiers(file, source)) {
    if (!providers.has(specifier)) continue
    messages.push(`${file}: imports provider ${specifier} at runtime; seam ${seamKey} reaches ${definition} through ctx.get('${seamKey}')`)
  }
  return messages
}

/**
 * Compare the seam role table against the runtime import graph.
 * @returns Violations, the number of seams with a provider, and the packages scanned.
 */
export function collectSeamRoleViolations(): {
  violations: string[]
  seamsChecked: number
  packagesScanned: number
} {
  const packages = workspacePackages()
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]))
  const byShort = new Map(packages.flatMap(pkg => roleNamesOf(pkg).map(short => [short, pkg] as const)))
  const violations: string[] = []
  let seamsChecked = 0
  for (const seam of SERVICE_ROLES) {
    const providers = providerPackagesOf(seam)
    if (providers.size === 0) continue
    seamsChecked += 1
    for (const short of [seam.pkg, ...seam.consumers ?? [], ...seam.implementations ?? []]) {
      if (!byShort.has(short)) violations.push(`${seam.key}: role table names unknown package ${short}`)
    }
    // Only the roles the table actually assigns are checked: a consumer and the
    // definition itself must reach the service through its key. A third package
    // is not a role this seam declares, so its imports stay out of scope.
    const constrained = [seam.pkg, ...seam.consumers ?? []]
    for (const short of constrained) {
      const pkg = byShort.get(short)
      if (pkg === undefined || providers.has(pkg.name)) continue
      for (const file of globSync(`${pkg.directory}/**/*.ts`, { cwd: root }).map(path => path.split('\\').join('/'))) {
        if (file.includes('/tests/') || file.endsWith('.spec.ts') || file.includes('/lib/')) continue
        violations.push(...providerImportsInSource(file, readFileSync(resolve(root, file), 'utf8'), seam.key, seam.pkg, providers))
      }
    }
  }
  return { violations, seamsChecked, packagesScanned: byName.size }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('verify-seam-roles.ts')) {
  const { violations, seamsChecked, packagesScanned } = collectSeamRoleViolations()
  if (violations.length > 0) {
    console.error(`verify-seam-roles: ${String(violations.length)} violation(s) across ${String(seamsChecked)} seam(s) and ${String(packagesScanned)} package(s)`)
    for (const violation of violations.sort()) console.error(`  ${violation}`)
    process.exitCode = 1
  } else {
    console.log(`verify-seam-roles: ${String(seamsChecked)} seam(s) and ${String(packagesScanned)} package(s) checked, every import follows its role`)
  }
}
