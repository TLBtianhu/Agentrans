/** Desktop auto-update channel, target, and packaged artifact naming. */
import { describe, expect, it } from 'vitest'
import {
  desktopBuildRecordFilename,
  desktopUpdateMetadataFilename,
  resolveDesktopAutoUpdateTarget,
  resolveDesktopGitHubUpdateConfig,
  resolveDesktopUpdateChannel,
} from '../scripts/desktop-auto-update-environment.mjs'

describe('desktop auto-update environment', () => {
  it('defaults the channel to nightly and rejects an unknown one', () => {
    expect(resolveDesktopUpdateChannel({})).toBe('nightly')
    expect(resolveDesktopUpdateChannel({ DSH_DESKTOP_UPDATE_CHANNEL: 'latest' })).toBe('latest')
    expect(() => resolveDesktopUpdateChannel({ DSH_DESKTOP_UPDATE_CHANNEL: 'stable' }))
      .toThrow(/invalid update channel/u)
  })

  it('names one target per supported host', () => {
    expect(resolveDesktopAutoUpdateTarget('darwin', 'arm64')).toBe('mac-arm64')
    expect(resolveDesktopAutoUpdateTarget('darwin', 'x64')).toBe('mac-x64')
    expect(resolveDesktopAutoUpdateTarget('win32', 'x64')).toBe('win-x64')
    expect(() => resolveDesktopAutoUpdateTarget('linux', 'x64')).toThrow(/unsupported target/u)
  })

  it('derives the build record and channel metadata filenames', () => {
    expect(desktopBuildRecordFilename('win-x64')).toBe('win-x64-release.json')
    expect(() => desktopBuildRecordFilename('linux-x64' as never)).toThrow(/unsupported target/u)
    expect(desktopUpdateMetadataFilename('1.2.3', 'win32')).toBe('nightly.yml')
    expect(desktopUpdateMetadataFilename('1.2.3', 'darwin', 'latest')).toBe('latest-mac.yml')
    expect(() => desktopUpdateMetadataFilename('1.2.3', 'linux')).toThrow(/unsupported metadata platform/u)
    expect(() => desktopUpdateMetadataFilename('not-a-version', 'win32')).toThrow(/invalid Desktop version/u)
  })

  it('maps each channel onto a GitHub release type', () => {
    expect(resolveDesktopGitHubUpdateConfig({})).toMatchObject({
      provider: 'github', owner: 'TLBtianhu', repo: 'Agentrans', channel: 'nightly', releaseType: 'prerelease',
    })
    expect(resolveDesktopGitHubUpdateConfig({ DSH_DESKTOP_UPDATE_CHANNEL: 'latest' }))
      .toMatchObject({ channel: 'latest', releaseType: 'release' })
  })
})
