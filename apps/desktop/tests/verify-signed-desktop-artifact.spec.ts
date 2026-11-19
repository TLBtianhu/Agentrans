import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { verifySignedDesktopArtifact } from '../scripts/verify-signed-desktop-artifact.mjs'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}))

const platform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  vi.resetAllMocks()
})

const request = { version: '0.1.0-test.20261119.2', channel: 'nightly' } as const
const macIdentity = { macTeamId: 'TEAMID1234', macSigningIdentity: 'Example Company (TEAMID1234)' }
const macPaths = { dmg: resolve('release fixtures', 'candidate.dmg'), zip: resolve('release fixtures', 'update.zip') }

function usePlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value })
}

function isCommandArguments(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(arg => typeof arg === 'string')
}

function requiredEntry(values: readonly string[], index: number): string {
  const value = values[index]
  if (value === undefined) throw new Error(`expected entry ${index} in ${JSON.stringify(values)}`)
  return value
}

interface MacFixtureOptions {
  readonly zipVersion?: string
  readonly badZipTicket?: boolean
  readonly dmgChannel?: 'nightly' | 'latest'
  readonly zipRepo?: string
}

function writeMacFixture(directory: string, channel: 'nightly' | 'latest', repo = 'Agentrans') {
  const resources = join(directory, 'Agentrans.app', 'Contents', 'Resources')
  mkdirSync(resources, { recursive: true })
  writeFileSync(join(resources, 'app-update.yml'), JSON.stringify({
    provider: 'github', owner: 'TLBtianhu', repo, channel, updaterCacheDirName: 'agentrans-updater',
  }))
}

function macTools(arch: 'arm64' | 'x86_64', options: MacFixtureOptions = {}) {
  const details = `Authority=Developer ID Application: ${macIdentity.macSigningIdentity}\nTeamIdentifier=${macIdentity.macTeamId}`
  vi.mocked(spawnSync).mockImplementation((command, args) => {
    const missingTicket = options.badZipTicket && command === '/usr/bin/xcrun' && isCommandArguments(args) && args[2]?.endsWith('Agentrans.app')
    const stderr = missingTicket ? 'no stapled ticket' : details
    return { pid: 1, output: [null, '', stderr], stdout: '', stderr, status: missingTicket ? 1 : 0, signal: null }
  })
  const scratchDirectories: string[] = []
  vi.mocked(execFileSync).mockImplementation((command, args) => {
    if (!isCommandArguments(args)) throw new Error('expected argument vector')
    if (command === '/usr/bin/hdiutil' && args[0] === 'attach') {
      const mountFlag = args.indexOf('-mountpoint')
      if (mountFlag === -1) throw new Error('expected an explicit DMG mountpoint')
      const mount = requiredEntry(args, mountFlag + 1)
      writeMacFixture(mount, options.dmgChannel ?? request.channel)
      scratchDirectories.push(resolve(mount, '..'))
      return ''
    }
    if (command === '/usr/bin/hdiutil' && args[0] === 'detach') {
      rmSync(join(requiredEntry(args, 1), 'Agentrans.app'), { recursive: true })
      return ''
    }
    if (command === '/usr/bin/ditto') {
      const directory = requiredEntry(args, 3)
      writeMacFixture(directory, request.channel, options.zipRepo)
      scratchDirectories.push(directory)
      return ''
    }
    if (command === '/usr/bin/lipo') return arch
    if (command === '/usr/bin/plutil' && args[1] === 'CFBundleIdentifier') return 'com.agentrans.app'
    if (command === '/usr/bin/plutil' && args[1] === 'CFBundleExecutable') return 'Agentrans'
    if (command === '/usr/bin/plutil' && args[1] === 'CFBundleShortVersionString') {
      return requiredEntry(args, 5).includes('agentrans-signed-zip-') ? (options.zipVersion ?? request.version) : request.version
    }
    throw new Error(`unexpected tool ${command}`)
  })
  return scratchDirectories
}

it('checks Authenticode on the selected installer with the pinned signer, product and full prerelease version', async () => {
  usePlatform('win32')
  vi.mocked(execFileSync).mockReturnValue('')
  const installer = resolve('release fixtures', 'renamed installer.exe')
  const windowsThumbprint = 'a1'.repeat(20)

  await verifySignedDesktopArtifact('win-x64', { installer }, request, { windowsThumbprint })

  expect(execFileSync).toHaveBeenCalledExactlyOnceWith('pwsh', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', expect.stringMatching(/verify-published-windows\.ps1$/u),
    '-Installer', installer, '-Thumbprint', windowsThumbprint,
    '-ExpectedProductName', 'Agentrans', '-ExpectedProductVersion', request.version,
  ], expect.objectContaining({ encoding: 'utf8' }))
})

it('fails closed before invoking Windows verification when the public certificate pin is absent', async () => {
  usePlatform('win32')
  await expect(verifySignedDesktopArtifact('win-x64', { installer: 'test.exe' }, request, {})).rejects.toThrow(/certificate thumbprint/u)
  expect(execFileSync).not.toHaveBeenCalled()
})

it.each([['mac-arm64', 'arm64'], ['mac-x64', 'x86_64']] as const)(
  'verifies the %s app within both distribution formats and checks tickets at the appropriate layers',
  async (target, arch) => {
    usePlatform('darwin')
    const scratch = macTools(arch)

    await verifySignedDesktopArtifact(target, macPaths, request, macIdentity)

    expect(execFileSync).toHaveBeenCalledWith('/usr/bin/hdiutil', [
      'attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', expect.any(String), macPaths.dmg,
    ], expect.anything())
    expect(execFileSync).toHaveBeenCalledWith('/usr/bin/ditto', ['-x', '-k', macPaths.zip, requiredEntry(scratch, 1)], expect.anything())
    const tickets = vi.mocked(spawnSync).mock.calls.flatMap(([command, args]) =>
      command === '/usr/bin/xcrun' && isCommandArguments(args) ? [basename(requiredEntry(args, 2))] : [])
    expect(tickets).toEqual(['candidate.dmg', 'Agentrans.app'])
    expect(scratch).toHaveLength(2)
    expect(scratch.map(path => existsSync(path))).toEqual([false, false])
  },
)

it('detaches the DMG and stops before ZIP extraction when the actual executable architecture differs', async () => {
  usePlatform('darwin')
  const scratch = macTools('x86_64')

  await expect(verifySignedDesktopArtifact('mac-arm64', macPaths, request, macIdentity)).rejects.toThrow(/expected arm64.+found x86_64/u)

  const directory = requiredEntry(scratch, 0)
  expect(execFileSync).toHaveBeenLastCalledWith('/usr/bin/hdiutil', ['detach', join(directory, 'volume')], expect.anything())
  expect(existsSync(directory)).toBe(false)
})

it('rejects a ZIP containing a different signed and stapled release version', async () => {
  usePlatform('darwin')
  const scratch = macTools('arm64', { zipVersion: '0.1.0-test.20261119.1' })

  await expect(verifySignedDesktopArtifact('mac-arm64', macPaths, request, macIdentity)).rejects.toThrow(/expected bundle version 0\.1\.0-test\.20261119\.2/u)

  expect(scratch.map(path => existsSync(path))).toEqual([false, false])
})

it('fails when the enclosed ZIP app does not have a valid stapled ticket', async () => {
  usePlatform('darwin')
  const scratch = macTools('arm64', { badZipTicket: true })

  await expect(verifySignedDesktopArtifact('mac-arm64', macPaths, request, macIdentity)).rejects.toThrow(/no stapled ticket/u)

  expect(scratch.map(path => existsSync(path))).toEqual([false, false])
})

it('rejects a DMG with a signed app configured to read the other update channel', async () => {
  usePlatform('darwin')
  const scratch = macTools('arm64', { dmgChannel: 'latest' })

  await expect(verifySignedDesktopArtifact('mac-arm64', macPaths, request, macIdentity))
    .rejects.toThrow(/app-update\.yml does not match TLBtianhu\/Agentrans on channel nightly/u)

  expect(scratch.map(path => existsSync(path))).toEqual([false])
})

it('rejects a ZIP with a signed and stapled app configured to read a different update repository', async () => {
  usePlatform('darwin')
  const scratch = macTools('arm64', { zipRepo: 'Other' })

  await expect(verifySignedDesktopArtifact('mac-arm64', macPaths, request, macIdentity))
    .rejects.toThrow(/app-update\.yml does not match TLBtianhu\/Agentrans on channel nightly/u)

  expect(scratch.map(path => existsSync(path))).toEqual([false, false])
})
