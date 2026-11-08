/** Product identity, version and explicit no-policy mode are checked without starting the builder or its hooks. */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppInfo, Packager } from 'app-builder-lib'
import { expandMacro } from 'app-builder-lib/out/util/macroExpander.js'
import { describe, expect, it } from 'vitest'
import { agentransInstallerEnvironment, createAgentransInstallerConfig } from '../scripts/agentrans-installer-config.mjs'
import { desktopBuildVersionPrefix } from '../scripts/desktop-build-version.mjs'
import { createElectronBuilderConfig, createUnsignedWindowsConfigWithoutPolicy } from '../scripts/electron-builder-config.mjs'
import { resolveDesktopAutoUpdateConfig, resolveDesktopUploadConfig } from '../scripts/desktop-auto-update-environment.mjs'
import { resolveDesktopPurgeConfig } from '../scripts/desktop-edgeone.ts'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const metadata: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (metadata === null || typeof metadata !== 'object' || !('version' in metadata) || typeof metadata.version !== 'string') {
  throw new Error('Desktop package must declare its version')
}
const productVersion = metadata.version

function config(environment: NodeJS.ProcessEnv = {}) {
  return createAgentransInstallerConfig({ environment, output: join(tmpdir(), 'agentrans-config-output'), repositoryRoot })
}

describe('Agentrans installer identity', () => {
  it.each([productVersion, `${desktopBuildVersionPrefix(productVersion)}20261108.1`])(
    'uses %s in the packaged manifest and artifact names without enabling publication', (version) => {
      const build = config({ DSH_DESKTOP_BUILD_VERSION: version,
        DSH_DESKTOP_BUILD_COMMIT: 'a'.repeat(40), DSH_DESKTOP_BUILD_DIRTY: '1' })
      const packager = new Packager({ projectDir: tmpdir() })
      Object.defineProperties(packager, { config: { value: build },
        metadata: { value: { ...metadata, ...build.extraMetadata } } })
      const appInfo = new AppInfo(packager, undefined)
      expect(appInfo.version).toBe(version)
      expect(appInfo.productName).toBe('Agentrans')
      expect(expandMacro(build.artifactName, null, appInfo, { ext: 'exe' }, false))
        .toBe(`agentrans-${version}-win-x64-unsigned.exe`)
      expect(build.nsis.artifactName).toBe(build.artifactName)
      expect(build.appId).toBe('com.agentrans.app')
      expect(build.extraMetadata).toMatchObject({ name: 'agentrans', version,
        dshDesktopAppId: build.appId, agentransAppId: build.appId,
        agentransChannel: 'nightly', dshBuildCommit: 'a'.repeat(40), dshBuildDirty: true })
      expect(Object.hasOwn(build.extraMetadata, 'dshMandatoryUpdatePolicy')).toBe(false)
      expect(build.publish).toBeNull()
      expect(build.protocols).toEqual([])
      expect(build.win.forceCodeSigning).toBe(false)
      expect(build.win.signtoolOptions.sign).toBeUndefined()
      expect(build.nsis).toMatchObject({ uninstallDisplayName: 'Agentrans', shortcutName: 'Agentrans' })
      expect(build.files).toContain('installer/**/*')
      expect(build.extraResources).toContainEqual({ from: join(repositoryRoot, 'packages/boot/product-layout'),
        to: 'packages/boot/product-layout' })
    })

  it('uses the current package version without a separate product-version override', () => {
    expect(config().extraMetadata.version).toBe(productVersion)
    expect(() => config({ DSH_DESKTOP_BUILD_VERSION: '0.1.0' })).toThrow('must extend')
  })

  it.each([
    ['DSH_DESKTOP_APP_ID', 'com.other.product'], ['DSH_DESKTOP_TARGET_PLATFORM', 'darwin'],
    ['DSH_DESKTOP_TARGET_ARCH', 'arm64'], ['DSH_DESKTOP_UNSIGNED', '0'],
    ['DSH_DESKTOP_AUTO_UPDATE_ENV', 'production'], ['DSH_DESKTOP_UPDATE_CHANNEL', 'latest'],
    ['DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN', 'https://old-policy.example.com'],
    ['DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', '{}'],
  ])('refuses conflicting %s before preparing the builder', (name, value) => {
    expect(() => config({ [name]: value })).toThrow(name)
  })

  it('strips signing inputs while retaining build version, tool paths and the caller environment', () => {
    const parent = { PATH: 'tool-path', DSH_DESKTOP_BUILD_VERSION: productVersion,
      CSC_LINK: 'unused-signing-file', WIN_CSC_LINK: 'unused-Windows-file', APPLE_ID: 'unused-account',
      DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'unused-pin', NPM_TOKEN: 'unused-token' }
    const snapshot = { ...parent }
    const prepared = agentransInstallerEnvironment(parent)
    expect(prepared).toMatchObject({ PATH: 'tool-path', DSH_DESKTOP_BUILD_VERSION: productVersion,
      DSH_DESKTOP_APP_ID: 'com.agentrans.app', DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64', DSH_DESKTOP_UNSIGNED: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
    for (const name of ['CSC_LINK', 'WIN_CSC_LINK', 'APPLE_ID', 'DSH_DESKTOP_WINDOWS_TOKEN_PIN', 'NPM_TOKEN']) {
      expect(Object.hasOwn(prepared, name)).toBe(false)
    }
    expect(parent).toEqual(snapshot)
  })

  it('removes signing names regardless of Windows environment-key casing', () => {
    const prepared = agentransInstallerEnvironment({ Path: 'tool-path', csc_link: 'unused', Win_Csc_Link: 'unused',
      apple_id: 'unused', dsh_desktop_windows_cer_file: 'unused', DsH_DeSkToP_WiNdOwS_KeY_CoNtAiNeR: 'unused' })
    expect(prepared.Path).toBe('tool-path')
    expect(Object.keys(prepared).filter(name => /^(?:(?:WIN_)?CSC_|APPLE_|DSH_DESKTOP_WINDOWS_)/iu.test(name)))
      .toEqual(['CSC_IDENTITY_AUTO_DISCOVERY'])
  })

  it.each([
    ['dsh_desktop_target_platform', 'darwin', 'DSH_DESKTOP_TARGET_PLATFORM'],
    ['DsH_DeSkToP_UnSiGnEd', '0', 'DSH_DESKTOP_UNSIGNED'],
    ['dsh_desktop_mandatory_update_config', '{}', 'DSH_DESKTOP_MANDATORY_UPDATE_CONFIG'],
    ['DsH_DeSkToP_AuTo_UpDaTe_EnV', 'production', 'DSH_DESKTOP_AUTO_UPDATE_ENV'],
  ])('checks the canonical identity of %s', (name, value, canonical) => {
    expect(() => config({ [name]: value })).toThrow(canonical)
  })

  it('refuses conflicting aliases rather than letting object enumeration choose a product or version', () => {
    expect(() => config({ dsh_desktop_app_id: 'com.other.product', DSH_DESKTOP_APP_ID: 'com.agentrans.app' }))
      .toThrow('conflicting environment aliases for DSH_DESKTOP_APP_ID')
    expect(() => config({ dsh_desktop_build_version: productVersion, DSH_DESKTOP_BUILD_VERSION: '0.1.0' }))
      .toThrow('conflicting environment aliases for DSH_DESKTOP_BUILD_VERSION')
  })

  it('coalesces equal aliases and resolves mixed-case build settings through the shared version owner', () => {
    const version = `${desktopBuildVersionPrefix(productVersion)}20261108.2`
    const environment = { DSH_DESKTOP_APP_ID: 'com.agentrans.app', dsh_desktop_app_id: 'com.agentrans.app',
      DsH_DeSkToP_BuIlD_VeRsIoN: version }
    const prepared = agentransInstallerEnvironment(environment)
    expect(prepared.DSH_DESKTOP_BUILD_VERSION).toBe(version)
    expect(Object.keys(prepared).filter(name => /^DSH_DESKTOP_APP_ID$/iu.test(name))).toEqual(['DSH_DESKTOP_APP_ID'])
    expect(config(environment).extraMetadata.version).toBe(version)
  })
})

describe('explicit unsigned Windows policy mode', () => {
  const environment = { DSH_DESKTOP_APP_ID: 'com.example.policy-mode', DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_UNSIGNED: '1' }

  it('permits a named no-policy mode while ordinary unsigned packaging still requires policy', () => {
    const build = createUnsignedWindowsConfigWithoutPolicy(environment, 'win32', 'x64')
    expect(Object.hasOwn(build.extraMetadata, 'dshMandatoryUpdatePolicy')).toBe(false)
    expect(build.publish).toBeNull()
    expect(() => createElectronBuilderConfig(environment, 'win32', 'x64')).toThrow('DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN')
  })

  it.each([{ DSH_DESKTOP_UNSIGNED: '0' }, { DSH_DESKTOP_UNSIGNED: undefined },
    { DSH_DESKTOP_TARGET_PLATFORM: 'darwin' }])('does not disable signed or non-Windows policy requirements for %j', (override) => {
    expect(() => createUnsignedWindowsConfigWithoutPolicy({ ...environment, ...override }, 'win32', 'x64'))
      .toThrow('explicitly unsigned Windows')
  })

  it.each(['win32', 'darwin'] as const)('refuses Agentrans in the ordinary %s release factory before signing configuration', (platform) => {
    expect(() => createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.agentrans.app', DSH_DESKTOP_TARGET_PLATFORM: platform }, platform, 'x64'))
      .toThrow('Agentrans requires its unsigned Windows installer entry')
  })

  it.each(['test', 'production'])('refuses Agentrans upstream feeds, uploads and purge preparation in %s', (deployment) => {
    const env = { DSH_DESKTOP_APP_ID: 'com.agentrans.app', DSH_DESKTOP_AUTO_UPDATE_ENV: deployment }
    expect(() => resolveDesktopAutoUpdateConfig(env, 'win32', 'x64')).toThrow('Agentrans requires')
    expect(() => resolveDesktopUploadConfig(env, 'darwin', 'arm64')).toThrow('Agentrans requires')
    if (deployment === 'production') expect(() => resolveDesktopPurgeConfig(env, 'win-x64')).toThrow('Agentrans requires')
  })
})
