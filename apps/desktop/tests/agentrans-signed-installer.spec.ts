import { beforeEach, describe, expect, it, vi } from 'vitest'
import { desktopTargetBuildPaths } from '../scripts/desktop-build-paths.mjs'
import {
  agentransInstallerEnvironment,
  createAgentransInstallerConfig,
  createAgentransSignedInstallerConfig,
} from '../scripts/agentrans-installer-config.mjs'

const signer = vi.hoisted(() => {
  const sign = vi.fn(async () => undefined)
  return {
    sign,
    create: vi.fn(() => sign),
    bootstrap: vi.fn(),
    publisher: vi.fn(() => 'Fixture Authenticode Publisher'),
  }
})
vi.mock('../scripts/windows-sign.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/windows-sign.mjs')>(),
  createWindowsTokenSigner: signer.create,
  installWindowsNsisBootstrapSigner: signer.bootstrap,
  resolveWindowsUpdatePublisher: signer.publisher,
}))
vi.mock('../scripts/windows-directory-installer.mjs', () => ({ installWindowsDirectoryInstaller: vi.fn() }))

const identity = { AGENTRANS_DESKTOP_APP_ID: 'com.agentrans.app', AGENTRANS_DESKTOP_UNSIGNED: '0' }
const macSigning = {
  AGENTRANS_DESKTOP_MACOS_SIGNING_IDENTITY: 'Agentrans Fixture (TEAMID1234)',
  AGENTRANS_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
  APPLE_KEYCHAIN_PROFILE: 'agentrans-test',
}

describe('Agentrans system-signed installer builder', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('requires the product identity and an explicit signed build', () => {
    expect(() => createAgentransSignedInstallerConfig({ ...identity, AGENTRANS_DESKTOP_APP_ID: 'com.example.other' }, 'win32', 'x64'))
      .toThrow('AGENTRANS_DESKTOP_APP_ID=com.agentrans.app')
    expect(() => createAgentransSignedInstallerConfig({ ...identity, AGENTRANS_DESKTOP_UNSIGNED: '1' }, 'win32', 'x64'))
      .toThrow('AGENTRANS_DESKTOP_UNSIGNED=0')
    expect(() => createAgentransSignedInstallerConfig({ AGENTRANS_DESKTOP_APP_ID: 'com.agentrans.app' }, 'win32', 'x64'))
      .toThrow('AGENTRANS_DESKTOP_UNSIGNED=0')
    expect(signer.create).not.toHaveBeenCalled()
  })

  it('preserves the Windows token signer and publisher in an Agentrans NSIS build', () => {
    const config = createAgentransSignedInstallerConfig({
      ...identity,
      AGENTRANS_DESKTOP_TARGET_PLATFORM: 'win32',
      AGENTRANS_DESKTOP_TARGET_ARCH: 'x64',
      AGENTRANS_DESKTOP_UPDATE_CHANNEL: 'latest',
      AGENTRANS_DESKTOP_WINDOWS_CER_FILE: 'fixture.cer',
      AGENTRANS_DESKTOP_WINDOWS_SIGNTOOL: 'fixture-signtool.exe',
      AGENTRANS_DESKTOP_WINDOWS_KEY_CONTAINER: 'fixture-container',
      AGENTRANS_DESKTOP_WINDOWS_TOKEN_PIN: 'fixture-pin',
    }, 'darwin', 'arm64')
    expect(signer.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      certificateFile: 'fixture.cer', signTool: 'fixture-signtool.exe',
      keyContainer: 'fixture-container', tokenPin: 'fixture-pin',
    }))
    expect(signer.bootstrap).toHaveBeenCalledExactlyOnceWith({ sign: signer.sign })
    expect(signer.publisher).toHaveBeenCalledExactlyOnceWith('fixture.cer')
    expect(signer.sign).not.toHaveBeenCalled()
    expect(config).toMatchObject({
      appId: identity.AGENTRANS_DESKTOP_APP_ID, productName: 'Agentrans',
      protocols: [],
      extraMetadata: { name: 'agentrans', agentransAppId: identity.AGENTRANS_DESKTOP_APP_ID, agentransChannel: 'latest' },
      directories: { output: desktopTargetBuildPaths('win-x64').artifacts },
      win: { forceCodeSigning: true, signtoolOptions: { sign: signer.sign, publisherName: 'Fixture Authenticode Publisher' } },
      nsis: { shortcutName: 'Agentrans', uninstallDisplayName: 'Agentrans', artifactName: config.artifactName, differentialPackage: true },
      publish: [{ provider: 'github', owner: 'TLBtianhu', repo: 'Agentrans', releaseType: 'release', channel: 'latest' }],
    })
    expect(config.artifactName).toBe('agentrans-${version}-${os}-${arch}.${ext}')
    expect(config.files).toContain('installer/**/*')
    expect(config.extraResources.map(resource => resource.to)).toEqual(expect.arrayContaining([
      'packages/boot/product-layout', 'distribution/keys',
    ]))
  })

  it.each(['arm64', 'x64'] as const)('preserves Developer ID signing and notarization on %s', (arch) => {
    const config = createAgentransSignedInstallerConfig({
      ...identity,
      ...macSigning,
      AGENTRANS_DESKTOP_TARGET_PLATFORM: 'darwin',
      AGENTRANS_DESKTOP_TARGET_ARCH: arch,
    }, 'win32', 'x64')
    expect(config).toMatchObject({
      appId: identity.AGENTRANS_DESKTOP_APP_ID, productName: 'Agentrans', protocols: [],
      directories: { output: desktopTargetBuildPaths(`mac-${arch}`).artifacts },
      mac: { identity: macSigning.AGENTRANS_DESKTOP_MACOS_SIGNING_IDENTITY, forceCodeSigning: true, notarize: true, target: ['dmg', 'zip'] },
      dmg: { sign: true },
      publish: [{ provider: 'github', owner: 'TLBtianhu', repo: 'Agentrans', releaseType: 'prerelease' }],
    })
    expect(config).not.toHaveProperty('nsis')
    expect(signer.create).not.toHaveBeenCalled()
  })

  it('keeps signed Mac output separate when notarization is explicitly skipped', () => {
    const config = createAgentransSignedInstallerConfig({
      ...identity,
      ...macSigning,
      AGENTRANS_DESKTOP_MACOS_SKIP_NOTARIZATION: '1',
    }, 'darwin', 'arm64')
    expect(config.directories.output).toBe(desktopTargetBuildPaths('mac-arm64').unnotarizedArtifacts)
    expect(config.artifactName).toContain('-unnotarized.')
    expect(config.mac).toMatchObject({ identity: macSigning.AGENTRANS_DESKTOP_MACOS_SIGNING_IDENTITY, notarize: false })
  })

  it('keeps the hosted configuration unsigned and strips ambient credential settings', () => {
    const environment = {
      AGENTRANS_DESKTOP_WINDOWS_TOKEN_PIN: 'fixture-pin', CSC_LINK: 'fixture.p12', APPLE_KEYCHAIN_PROFILE: 'fixture-profile',
    }
    const sanitized = agentransInstallerEnvironment(environment, 'win-x64')
    expect(sanitized).toMatchObject({ AGENTRANS_DESKTOP_UNSIGNED: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
    for (const key of Object.keys(environment)) expect(sanitized).not.toHaveProperty(key)
    const config = createAgentransInstallerConfig({
      environment, output: 'fixture-output', repositoryRoot: 'fixture-repo', target: 'mac-arm64',
    })
    expect(config.artifactName).toBe('agentrans-${version}-mac-arm64-unsigned.${ext}')
    expect(config.mac).toMatchObject({ identity: null, forceCodeSigning: false, notarize: false })
    expect(signer.create).not.toHaveBeenCalled()
  })
})
