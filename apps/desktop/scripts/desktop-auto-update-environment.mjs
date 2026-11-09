/** Resolve the Desktop auto-update channel, target, deployment, and packaged artifact names. */

import { valid } from 'semver'
import { assertUpstreamDesktopReleaseIdentity, DESKTOP_UPDATE_REPOSITORY } from './desktop-release-environment.mjs'

/**
 * Resolve the channel embedded in the installer; omitted local settings retain nightly.
 * @param {NodeJS.ProcessEnv} env Packaging settings.
 * @returns {'nightly' | 'latest'} Validated channel.
 */
export function resolveDesktopUpdateChannel(env) {
  const channel = env.DSH_DESKTOP_UPDATE_CHANNEL || 'nightly'
  if (channel !== 'nightly' && channel !== 'latest') throw new Error('desktop auto-update: invalid update channel')
  return channel
}

/** Environment variable that selects the Desktop release deployment. */
export const DESKTOP_AUTO_UPDATE_ENV = 'DSH_DESKTOP_AUTO_UPDATE_ENV'

/**
 * Resolve the release deployment a policy or package declares, defaulting to test.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {'test' | 'production'} Validated deployment name.
 */
export function resolveDesktopAutoUpdateEnvironment(env) {
  const value = env[DESKTOP_AUTO_UPDATE_ENV]?.trim() || 'test'
  if (value !== 'test' && value !== 'production') {
    throw new Error(`desktop auto-update: ${DESKTOP_AUTO_UPDATE_ENV} must be "test" or "production"`)
  }
  return value
}
const UPDATE_TARGETS = new Set(['mac-arm64', 'mac-x64', 'win-x64'])

/**
 * Resolve the packaged target name for a host platform and architecture.
 * @param {NodeJS.Platform} platform - Host platform.
 * @param {string} arch - Host architecture.
 * @returns {'mac-arm64' | 'mac-x64' | 'win-x64'} Supported target name.
 */
export function resolveDesktopAutoUpdateTarget(platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'mac-x64'
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  throw new Error(`desktop auto-update: unsupported target ${platform} ${arch}`)
}

/**
 * Name one target's build record in the artifact directory.
 * @param {'mac-arm64' | 'mac-x64' | 'win-x64'} target Supported Desktop target.
 * @returns {string} Build record filename.
 */
export function desktopBuildRecordFilename(target) {
  if (!UPDATE_TARGETS.has(target)) {
    throw new Error(`desktop auto-update: unsupported target ${target}`)
  }
  return `${target}-release.json`
}

/**
 * Return the electron-builder channel metadata filename for an application version.
 * @param {string} version - Desktop semantic version.
 * @param {NodeJS.Platform} platform - Target platform.
 * @param {'nightly' | 'latest'} channel - Selected channel; omitted means nightly.
 * @returns {string} Channel metadata filename emitted for the target.
 */
export function desktopUpdateMetadataFilename(version, platform, channel = 'nightly') {
  if (valid(version) === null) {
    throw new Error(`desktop auto-update: invalid Desktop version ${JSON.stringify(version)}`)
  }
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`desktop auto-update: unsupported metadata platform ${platform}`)
  }
  resolveDesktopUpdateChannel({ DSH_DESKTOP_UPDATE_CHANNEL: channel })
  return `${channel}${platform === 'darwin' ? '-mac' : ''}.yml`
}

/**
 * Resolve the GitHub Releases feed a packaged application embeds.
 *
 * The release type carries the channel: a nightly build reads prereleases and a
 * latest build reads published releases, so neither offers the other's builds.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {{ provider: 'github', owner: string, repo: string, channel: 'nightly' | 'latest', releaseType: 'release' | 'prerelease' }} Feed coordinates embedded at build time.
 */
export function resolveDesktopGitHubUpdateConfig(env) {
  assertUpstreamDesktopReleaseIdentity(env.DSH_DESKTOP_APP_ID)
  const channel = resolveDesktopUpdateChannel(env)
  return {
    provider: 'github',
    owner: DESKTOP_UPDATE_REPOSITORY.owner,
    repo: DESKTOP_UPDATE_REPOSITORY.repo,
    channel,
    releaseType: channel === 'latest' ? 'release' : 'prerelease',
  }
}
