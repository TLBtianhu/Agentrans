import { describe, expect, it } from 'vitest'
import { resolveDesktopAgentransUpdateConfig, resolveDesktopGitHubUpdateConfig } from '../scripts/desktop-auto-update-environment.mjs'
import { createAgentransInstallerBuilderConfig } from '../scripts/electron-builder-config.mjs'

describe('Agentrans update feed', () => {
  it('names the product repository and the channel release type', () => {
    expect(resolveDesktopAgentransUpdateConfig({ DSH_DESKTOP_UPDATE_CHANNEL: 'latest' })).toEqual({
      provider: 'github', owner: 'TLBtianhu', repo: 'Agentrans', channel: 'latest', releaseType: 'release',
    })
    expect(resolveDesktopAgentransUpdateConfig({})).toMatchObject({ channel: 'nightly', releaseType: 'prerelease' })
  })

  it('accepts the product identity that the upstream feed rejects', () => {
    expect(() => resolveDesktopGitHubUpdateConfig({ DSH_DESKTOP_APP_ID: 'com.agentrans.app' }))
      .toThrow(/upstream release/u)
    expect(resolveDesktopAgentransUpdateConfig({ DSH_DESKTOP_APP_ID: 'com.agentrans.app' }))
      .toMatchObject({ owner: 'TLBtianhu', repo: 'Agentrans' })
  })

  it('embeds the feed in the installer build it produces', () => {
    const config = createAgentransInstallerBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.agentrans.app',
      DSH_DESKTOP_UNSIGNED: '1',
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UPDATE_CHANNEL: 'nightly',
    }, 'win32', 'x64')
    expect(config.publish).toEqual([
      // The metadata file follows the build version's prerelease id, which is what the updater asks for.
      { provider: 'github', owner: 'TLBtianhu', repo: 'Agentrans', releaseType: 'prerelease', channel: 'alpha' },
    ])
    expect(config.appId).toBe('com.agentrans.app')
  })
})
