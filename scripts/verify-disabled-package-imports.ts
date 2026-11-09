/**
 * Keep shipped-but-off packages out of every other package's runtime imports.
 *
 * A package classified `disabled` in the product policy is shipped and never
 * mounted: an overlay may turn it on, and nothing else may depend on it being
 * there. The product decisions that removed the account line and the hosted
 * telemetry leave several such packages in the tree, so the rule needs an
 * executed check rather than review attention.
 *
 * Two forms stay allowed, because neither requires the package at runtime:
 * `import type …` (including `import type {}` used for declaration merging) and
 * an optional service lookup such as `ctx.get('service')`.
 */
import { globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { collectRuntimeSourceSpecifiers } from './source-parse-uses.ts'
import { PRODUCT_PACKAGE_POLICY } from './product-package-policy.ts'

const root = resolve(import.meta.dirname, '..')

/**
 * Read the package name each product-policy entry declares.
 * @param directory - Repository-relative package directory.
 * @returns Declared package name, or `undefined` when the manifest is unreadable.
 */
export function packageNameOf(directory: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8')) as { name?: string }
    return manifest.name
  } catch {
    return undefined
  }
}

/**
 * Map every shipped-but-off package directory to the name importers use.
 * @returns Directory to package name.
 */
export function disabledPackageNames(): Map<string, string> {
  const names = new Map<string, string>()
  for (const [directory, policy] of Object.entries(PRODUCT_PACKAGE_POLICY)) {
    if (policy.category !== 'disabled') continue
    const name = packageNameOf(directory)
    if (name !== undefined) names.set(directory, name)
  }
  return names
}

/**
 * Report the shipped-but-off packages one source file imports for runtime use.
 * @param file - Repository-relative source path, used in the message.
 * @param source - File contents.
 * @param declared - Names of the shipped-but-off packages.
 * @returns One message per offending specifier.
 */
export function disabledImportsInSource(
  file: string,
  source: string,
  declared: ReadonlySet<string>,
): string[] {
  const messages: string[] = []
  for (const specifier of collectRuntimeSourceSpecifiers(file, source)) {
    if (!declared.has(specifier)) continue
    messages.push(`${file}: imports ${specifier} at runtime, but that package is shipped-but-off`)
  }
  return messages
}
/**
 * Report runtime imports of a shipped-but-off package from any other package.
 * @returns Violations and the number of packages the scan covered.
 */
export function collectDisabledImportViolations(): { violations: string[]; scannedPackages: number } {
  const disabled = disabledPackageNames()
  const declared = new Set(disabled.values())
  const violations: string[] = []
  let scannedPackages = 0
  for (const manifestPath of globSync('packages/*/*/package.json', { cwd: root }).map(path => path.split('\\').join('/'))) {
    const directory = dirname(manifestPath)
    if (disabled.has(directory)) continue
    scannedPackages += 1
    for (const file of globSync(`${directory}/**/*.ts`, { cwd: root }).map(path => path.split('\\').join('/'))) {
      if (file.includes('/tests/') || file.endsWith('.spec.ts')) continue
      violations.push(...disabledImportsInSource(file, readFileSync(resolve(root, file), 'utf8'), declared))
    }
  }
  return { violations, scannedPackages }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('verify-disabled-package-imports.ts')) {
  const { violations, scannedPackages } = collectDisabledImportViolations()
  if (violations.length > 0) {
    console.error(`verify-disabled-package-imports: ${String(violations.length)} runtime import(s) of a shipped-but-off package across ${String(scannedPackages)} package(s)`)
    for (const violation of violations.sort()) console.error(`  ${violation}`)
    process.exitCode = 1
  } else {
    console.log(`verify-disabled-package-imports: ${String(scannedPackages)} package(s) scanned, no runtime import of a shipped-but-off package`)
  }
}
