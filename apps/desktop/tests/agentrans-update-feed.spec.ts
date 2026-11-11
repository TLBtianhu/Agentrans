import { describe, expect, it } from 'vitest'
import { resolveDesktopAgentransUpdateConfig, resolveDesktopGitHubUpdateConfig } from '../scripts/desktop-auto-update-environment.mjs'
import { createAgentransInstallerBuilderConfig } from '../scripts/electron-builder-config.mjs'

describe('Agentrans update feed', () => {
  it('names the product repository and the channel release type', () => {
    expect(resolveDesktopAgentransUpdateConfig({ AGENTRANS_DESKTOP_UPDATE_CHANNEL: 'latest' })).toEqual({
      provider: 'github', owner: 'TLBtianhu', repo: 'Agentrans', channel: 'latest', releaseType: 'release',
    })
    expect(resolveDesktopAgentransUpdateConfig({})).toMatchObject({ channel: 'nightly', releaseType: 'prerelease' })
  })

  it('accepts the product identity that the upstream feed rejects', () => {
    expect(() => resolveDesktopGitHubUpdateConfig({ AGENTRANS_DESKTOP_APP_ID: 'com.agentrans.app' }))
      .toThrow(/upstream release/u)
    expect(resolveDesktopAgentransUpdateConfig({ AGENTRANS_DESKTOP_APP_ID: 'com.agentrans.app' }))
      .toMatchObject({ owner: 'TLBtianhu', repo: 'Agentrans' })
  })

  it('embeds the feed in the installer build it produces', () => {
    const config = createAgentransInstallerBuilderConfig({
      AGENTRANS_DESKTOP_APP_ID: 'com.agentrans.app',
      AGENTRANS_DESKTOP_UNSIGNED: '1',
      AGENTRANS_DESKTOP_TARGET_PLATFORM: 'win32',
      AGENTRANS_DESKTOP_TARGET_ARCH: 'x64',
      AGENTRANS_DESKTOP_UPDATE_CHANNEL: 'nightly',
    }, 'win32', 'x64')
    expect(config.publish).toEqual([
      // The metadata file follows the build version's prerelease id; a stable version names the stable file.
      { provider: 'github', owner: 'TLBtianhu', repo: 'Agentrans', releaseType: 'prerelease', channel: 'latest' },
    ])
    expect(config.appId).toBe('com.agentrans.app')
  })
})
