/** Environment variable that selects the Desktop release deployment. */
export const DESKTOP_AUTO_UPDATE_ENV: 'DSH_DESKTOP_AUTO_UPDATE_ENV'

/** Supported packaged target names. */
export type DesktopAutoUpdateTarget = 'mac-arm64' | 'mac-x64' | 'win-x64'

/** GitHub Releases feed embedded at build time. */
export interface DesktopGitHubUpdateConfig {
  readonly provider: 'github'
  readonly owner: string
  readonly repo: string
  readonly channel: 'nightly' | 'latest'
  readonly releaseType: 'release' | 'prerelease'
}

/**
 * Resolve the channel embedded in the installer.
 * @param env - Packaging settings.
 * @returns The validated channel; nightly when unset.
 */
export function resolveDesktopUpdateChannel(env: NodeJS.ProcessEnv): 'nightly' | 'latest'

/**
 * Resolve the release deployment a policy or package declares.
 * @param env - Packaging environment.
 * @returns The validated deployment name.
 */
export function resolveDesktopAutoUpdateEnvironment(env: NodeJS.ProcessEnv): 'test' | 'production'

/**
 * Resolve the packaged target name for a host platform and architecture.
 * @param platform - Host platform.
 * @param arch - Host architecture.
 * @returns The supported target name.
 */
export function resolveDesktopAutoUpdateTarget(platform: NodeJS.Platform, arch: string): DesktopAutoUpdateTarget

/**
 * Name one target's build record in the artifact directory.
 * @param target - Supported Desktop target.
 * @returns The build record filename.
 */
export function desktopBuildRecordFilename(target: DesktopAutoUpdateTarget): string

/**
 * Return the electron-builder channel metadata filename for an application version.
 * @param version - Desktop semantic version.
 * @param platform - Target platform.
 * @param channel - Selected channel; omitted means nightly.
 * @returns The channel metadata filename emitted for the target.
 */
export function desktopUpdateMetadataFilename(version: string, platform: NodeJS.Platform, channel?: 'nightly' | 'latest'): string

/**
 * Resolve the GitHub Releases feed a packaged application embeds.
 * @param env - Packaging environment.
 * @returns Feed coordinates embedded at build time.
 */
export function resolveDesktopGitHubUpdateConfig(env: NodeJS.ProcessEnv): DesktopGitHubUpdateConfig
