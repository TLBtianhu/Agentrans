import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadDesktopPackageEnvironment, localMacOSPackageEnvironment, validateDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { resolveWindowsPackageSettings } from '../scripts/windows-package-settings.mjs'

const WINDOWS = { platform: 'win32', arch: 'x64' } as const
const MACOS = { platform: 'darwin', arch: 'arm64' } as const
const RELEASE = { AGENTRANS_DESKTOP_APP_ID: 'com.example.desktop' }

async function withDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-env-'))
  try {
    await action(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('Desktop local packaging configuration', () => {
  it('loads file-owned compression and defaults to fast Windows archive compression', async () => {
    expect(resolveWindowsPackageSettings({}).compressionLevel).toBe(3)
    await withDirectory(async (directory) => {
      await writeFile(join(directory, '.env.windows'), 'AGENTRANS_DESKTOP_WINDOWS_COMPRESSION_LEVEL=3\n')
      const selected = loadDesktopPackageEnvironment('win32', { AGENTRANS_DESKTOP_WINDOWS_COMPRESSION_LEVEL: '0' }, directory)
      expect(resolveWindowsPackageSettings(selected).compressionLevel).toBe(3)
    })
  })

  it.each(['3', '7'])('applies an explicit Windows workflow compression override %s', async (value) => {
    await withDirectory(async (directory) => {
      await writeFile(join(directory, '.env.windows'), 'AGENTRANS_DESKTOP_WINDOWS_COMPRESSION_LEVEL=5\n')
      const selected = loadDesktopPackageEnvironment('win32', { PACKAGE_WINDOWS_COMPRESSION_LEVEL: value }, directory)
      expect(resolveWindowsPackageSettings(selected).compressionLevel).toBe(Number(value))
      const unchanged = loadDesktopPackageEnvironment('win32', { PACKAGE_WINDOWS_COMPRESSION_LEVEL: '' }, directory)
      expect(resolveWindowsPackageSettings(unchanged).compressionLevel).toBe(5)
    })
  })

  it.each(['0', '5', '7', '9'])('retains explicit Windows file compression %s outside the workflow', async (value) => {
    await withDirectory(async (directory) => {
      await writeFile(join(directory, '.env.windows'), `AGENTRANS_DESKTOP_WINDOWS_COMPRESSION_LEVEL=${value}\n`)
      expect(resolveWindowsPackageSettings(loadDesktopPackageEnvironment('win32', {}, directory)).compressionLevel).toBe(Number(value))
    })
  })

  it('keeps the legacy builder override below the file-owned Windows setting', () => {
    expect(resolveWindowsPackageSettings({ ELECTRON_BUILDER_COMPRESSION_LEVEL: '7' }).compressionLevel).toBe(7)
    expect(resolveWindowsPackageSettings({ ELECTRON_BUILDER_COMPRESSION_LEVEL: '7', AGENTRANS_DESKTOP_WINDOWS_COMPRESSION_LEVEL: '3' }).compressionLevel).toBe(3)
  })

  it.each(['test', 'production'])('uses the same Windows compression defaults and overrides for %s', async (preset) => {
    await withDirectory(async (directory) => {
      await mkdir(join(directory, 'presets'))
      const path = join(directory, 'presets', `${preset}.env`)
      const parent = { AGENTRANS_PACKAGING_CONFIG_DIR: directory, AGENTRANS_PACKAGING_PRESET: preset }
      await writeFile(path, 'AGENTRANS_DESKTOP_APP_ID=com.example.desktop\n')
      const load = (environment: NodeJS.ProcessEnv) => resolveWindowsPackageSettings(
        loadDesktopPackageEnvironment('win32', environment, directory, { unsigned: true }),
      ).compressionLevel
      expect(load(parent)).toBe(3)
      await writeFile(path, 'AGENTRANS_DESKTOP_APP_ID=com.example.desktop\nAGENTRANS_DESKTOP_WINDOWS_COMPRESSION_LEVEL=9\n')
      expect(load(parent)).toBe(9)
      expect(load({ ...parent, PACKAGE_WINDOWS_COMPRESSION_LEVEL: '3' })).toBe(3)
      expect(load({ ...parent, PACKAGE_WINDOWS_COMPRESSION_LEVEL: '7' })).toBe(7)
    })
  })

  it.each([' ', '0', '5', '9', '-1', '10', '3.5', '03', 'fast'])('rejects invalid workflow compression %j before reading settings', (value) => {
    expect(() => loadDesktopPackageEnvironment('win32', { PACKAGE_WINDOWS_COMPRESSION_LEVEL: value }, 'missing-settings'))
      .toThrow('PACKAGE_WINDOWS_COMPRESSION_LEVEL')
  })

  it('rejects a Windows compression override for macOS before reading settings', () => {
    expect(() => loadDesktopPackageEnvironment('darwin', { PACKAGE_WINDOWS_COMPRESSION_LEVEL: '3' }, 'missing-settings'))
      .toThrow('PACKAGE_WINDOWS_COMPRESSION_LEVEL')
  })
  it.each(['', '-1', '10', '3.5', '03', 'fast'])('rejects invalid compression %j before preparation', (value) => {
    const selected = { ...RELEASE, AGENTRANS_DESKTOP_WINDOWS_COMPRESSION_LEVEL: value }
    expect(() => { validateDesktopPackageEnvironment(selected, WINDOWS, { unsigned: true }) })
      .toThrow('COMPRESSION_LEVEL')
  })

  it.each(['', ' ', 'relative/cache'])('rejects invalid package caches before any signing mode %j', (directory) => {
    for (const target of [WINDOWS, MACOS]) {
      for (const options of [{ unsigned: true }, { prepareOnly: true }, {}]) {
        expect(() => { validateDesktopPackageEnvironment({ AGENTRANS_DESKTOP_PACKAGE_CACHE_DIR: directory }, target, options) })
          .toThrow('AGENTRANS_DESKTOP_PACKAGE_CACHE_DIR')
      }
    }
  })

  it('preserves the machine package cache when loading a release file', async () => {
    await withDirectory(async (directory) => {
      await writeFile(join(directory, '.env.windows'), '')
      expect(loadDesktopPackageEnvironment('win32', { AGENTRANS_DESKTOP_PACKAGE_CACHE_DIR: directory }, directory))
        .toEqual({ AGENTRANS_DESKTOP_PACKAGE_CACHE_DIR: directory })
    })
  })
  it('selects macOS local defaults while excluding inherited release settings and retaining build networking', () => {
    const parent = {
      PATH: 'build-tools', HTTPS_PROXY: 'http://proxy.example:8080', AGENTRANS_DESKTOP_NPM_REGISTRY: 'https://registry.npmmirror.com',
      AGENTRANS_DESKTOP_APP_ID: 'com.example.release', AGENTRANS_DESKTOP_UNSIGNED: '0',
      AGENTRANS_DESKTOP_MACOS_SIGNING_IDENTITY: 'Release identity', CSC_LINK: 'missing.p12',
      APPLE_API_KEY: 'missing.p8',
    }
    const local = localMacOSPackageEnvironment(parent)
    expect(local).toEqual({
      PATH: parent.PATH, HTTPS_PROXY: parent.HTTPS_PROXY, AGENTRANS_DESKTOP_NPM_REGISTRY: parent.AGENTRANS_DESKTOP_NPM_REGISTRY,
      AGENTRANS_DESKTOP_APP_ID: 'com.deepseek.harness', AGENTRANS_DESKTOP_UNSIGNED: '1',
    })
    expect(() => { validateDesktopPackageEnvironment(local, MACOS, { unsigned: true }) }).not.toThrow()
    expect(parent.AGENTRANS_DESKTOP_UNSIGNED).toBe('0')
    expect(parent.AGENTRANS_DESKTOP_APP_ID).toBe('com.example.release')
  })

  it('takes cache concurrency from the Windows file and defaults to four without ambient overrides', async () => {
    await withDirectory(async (directory) => {
      const parent = { AGENTRANS_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY: '8' }
      await writeFile(join(directory, '.env.windows'), '')
      expect(resolveWindowsPackageSettings(loadDesktopPackageEnvironment('win32', parent, directory)).signatureCacheConcurrency).toBe(4)
      await writeFile(join(directory, '.env.windows'), 'AGENTRANS_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY=2\n')
      expect(resolveWindowsPackageSettings(loadDesktopPackageEnvironment('win32', parent, directory)).signatureCacheConcurrency).toBe(2)
    })
  })

  it('takes pack concurrency from the Windows file without inheriting ambient tuning', async () => {
    await withDirectory(async (directory) => {
      const parent = { AGENTRANS_DESKTOP_WINDOWS_PACK_CONCURRENCY: '8' }
      await writeFile(join(directory, '.env.windows'), '')
      expect(resolveWindowsPackageSettings(loadDesktopPackageEnvironment('win32', parent, directory)).packConcurrency).toBe(4)
      await writeFile(join(directory, '.env.windows'), 'AGENTRANS_DESKTOP_WINDOWS_PACK_CONCURRENCY=2\n')
      expect(resolveWindowsPackageSettings(loadDesktopPackageEnvironment('win32', parent, directory)).packConcurrency).toBe(2)
    })
  })

  it.each(['', '0', '-1', '1.5', 'Infinity', '01', '9007199254740992'])('rejects invalid pack concurrency %s', (value) => {
    expect(() => resolveWindowsPackageSettings({ AGENTRANS_DESKTOP_WINDOWS_PACK_CONCURRENCY: value })).toThrow('PACK_CONCURRENCY')
    for (const options of [{ unsigned: true }, { prepareOnly: true }]) {
      expect(() => {
        validateDesktopPackageEnvironment({ ...RELEASE, AGENTRANS_DESKTOP_WINDOWS_PACK_CONCURRENCY: value }, WINDOWS, options)
      }).toThrow('PACK_CONCURRENCY')
    }
  })

  it.each(['1', '2', '4', '8'])('accepts cache concurrency %s', (value) => {
    const settings = resolveWindowsPackageSettings({ AGENTRANS_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY: value })
    expect(settings.signatureCacheConcurrency).toBe(Number(value))
  })

  it.each(['', '0', '-1', '9', '1.5', 'Infinity', '01'])('rejects invalid cache concurrency %s', (value) => {
    expect(() => resolveWindowsPackageSettings({ AGENTRANS_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY: value })).toThrow('integer from 1 to 8')
    for (const options of [{ unsigned: true }, { prepareOnly: true }]) {
      expect(() => {
        validateDesktopPackageEnvironment({ ...RELEASE, AGENTRANS_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY: value }, WINDOWS, options)
      }).toThrow('integer from 1 to 8')
    }
  })

  it('selects the platform file, preserves literal secrets, and excludes stale ambient release settings', async () => {
    await withDirectory(async (directory) => {
      await writeFile(join(directory, '.env.windows'), '\uFEFFAGENTRANS_DESKTOP_APP_ID=com.example.windows\r\nAGENTRANS_DESKTOP_WINDOWS_TOKEN_PIN=" #!$%&literal "\r\nAGENTRANS_DESKTOP_WINDOWS_CER_FILE="keys/public certificate.cer"\r\n')
      await writeFile(join(directory, '.env.macos'), 'AGENTRANS_DESKTOP_APP_ID=com.example.mac\nAPPLE_KEYCHAIN_PROFILE=release\nCSC_LINK=keys/signing.p12\nCSC_KEY_PASSWORD=" # literal "\n')
      const parent = {
        PATH: 'build-tools', AGENTRANS_DESKTOP_APP_ID: 'com.stale.desktop',
        AGENTRANS_DESKTOP_WINDOWS_TOKEN_PIN: 'stale-pin', APPLE_ID: 'stale-apple-id',
        dsh_desktop_windows_key_container: 'case-insensitive-stale-container',
      }
      expect(loadDesktopPackageEnvironment('win32', parent, directory)).toEqual({
        PATH: 'build-tools', AGENTRANS_DESKTOP_APP_ID: 'com.example.windows',
        AGENTRANS_DESKTOP_WINDOWS_TOKEN_PIN: ' #!$%&literal ',
        AGENTRANS_DESKTOP_WINDOWS_CER_FILE: join(directory, 'keys', 'public certificate.cer'),
      })
      expect(loadDesktopPackageEnvironment('darwin', parent, directory)).toEqual({
        PATH: 'build-tools', AGENTRANS_DESKTOP_APP_ID: 'com.example.mac', APPLE_KEYCHAIN_PROFILE: 'release',
        CSC_LINK: join(directory, 'keys/signing.p12'), CSC_KEY_PASSWORD: ' # literal ',
      })
      expect(parent.AGENTRANS_DESKTOP_WINDOWS_TOKEN_PIN).toBe('stale-pin')
    })
  })

  it.each(['win32', 'darwin'] as const)('owns the %s application identifier in its platform file', async (platform) => {
    await withDirectory(async (directory) => {
      const settings = Object.entries(RELEASE).map(([name, value]) => `${name}='${value}'`).join('\n') + '\n'
      const file = join(directory, platform === 'win32' ? '.env.windows' : '.env.macos')
      const parent = { AGENTRANS_DESKTOP_APP_ID: 'com.example.stale' }
      await writeFile(file, settings)
      expect(loadDesktopPackageEnvironment(platform, parent, directory).AGENTRANS_DESKTOP_APP_ID).toBe('com.example.desktop')
      await writeFile(file, settings.replace("AGENTRANS_DESKTOP_APP_ID='com.example.desktop'\n", ''))
      const missing = loadDesktopPackageEnvironment(platform, parent, directory)
      expect(missing.AGENTRANS_DESKTOP_APP_ID).toBeUndefined()
      expect(parent.AGENTRANS_DESKTOP_APP_ID).toBe('com.example.stale')
    })
  })
})
