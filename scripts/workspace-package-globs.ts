/** Convert discovered package manifests into portable bundler workspace patterns. */
import { join, posix } from 'node:path'
import { globSync, readFileSync } from 'node:fs'
import { load as loadYaml } from 'js-yaml'

/**
 * Discover the root and member manifests declared by the workspace, including exclusion patterns.
 * @param root - Repository or fixture root containing pnpm-workspace.yaml.
 * @returns Sorted repository-relative manifest paths, without dependency or Git directories.
 * @throws When package patterns are invalid or match no member manifests.
 */
export function workspaceManifestPaths(root: string): string[] {
  const config: unknown = loadYaml(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
  if (typeof config !== 'object' || config === null || !('packages' in config)
    || !Array.isArray(config.packages) || config.packages.length === 0
    || !config.packages.every((member: unknown): member is string => typeof member === 'string' && member.length > 0)) {
    throw new Error('pnpm-workspace.yaml: packages must be a non-empty list of workspace patterns')
  }
  const patterns = config.packages.filter(member => !member.startsWith('!')).map(member => `${member}/package.json`)
  const exclude = config.packages.filter(member => member.startsWith('!')).map(member => `${member.slice(1)}/package.json`)
  const paths = globSync(patterns, { cwd: root, exclude: ['**/node_modules/**', '**/.git/**', ...exclude] })
    .map(path => path.replaceAll('\\', '/'))
  if (paths.length === 0) throw new Error('pnpm-workspace.yaml: packages matched no workspace manifests')
  return [...new Set(['package.json', ...paths])].sort()
}

/**
 * Keep filesystem separators from becoming escapes in workspace globs.
 * @param manifests - Repository-relative manifest paths returned by filesystem discovery.
 * @returns Package directory patterns using forward slashes on every host.
 */
export function workspacePackageGlobs(manifests: readonly string[]): string[] {
  return manifests.map(path => posix.dirname(path.replaceAll('\\', '/')))
}
