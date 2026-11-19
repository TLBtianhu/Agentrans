/** File names used by Desktop publication and the installed updater. */

/** Platform and architecture of a packaged Desktop installer. */
export type DesktopReleaseTarget = 'win-x64' | 'mac-arm64' | 'mac-x64'

/**
 * Build the stems shared by the supported variants of a release artifact.
 * @param slug - Product name as written in the installer filenames.
 * @param version - Canonical release version.
 * @param target - Packaged platform and architecture.
 * @returns Filenames without the artifact extension.
 */
export function desktopReleaseArtifactStems(slug: string, version: string, target: DesktopReleaseTarget): string[] {
  const suffixes = target === 'win-x64' ? ['', '-unsigned'] : ['', '-unsigned', '-unnotarized']
  return suffixes.map(suffix => `${slug}-${version}-${target}${suffix}`)
}
