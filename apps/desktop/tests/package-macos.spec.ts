/** Exercise notarization overlap and artifact isolation without Apple credentials or network. */

import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { dump } from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'
import {
  packageMacOSArtifacts,
  type DesktopPrepackagedArtifact,
  type MacOSArtifactOperations,
} from '../scripts/package-macos.ts'
import { desktopElectronBuilderArguments, resolveDesktopPackageTarget } from '../scripts/package-target.ts'
import { writeMacOSAppUpdateConfig } from '../scripts/macos-app-update-config.mjs'
import { collectReleaseAssets } from '../scripts/release-artifacts.ts'

const environment = {
  AGENTRANS_DESKTOP_APP_ID: 'com.agentrans.app',
  AGENTRANS_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
  AGENTRANS_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
  APPLE_KEYCHAIN_PROFILE: 'fixture-profile',
}

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

interface MacOSFixtureOptions {
  readonly arch: 'arm64' | 'x64'
  readonly channel: 'latest' | 'nightly'
  readonly version: string
  readonly metadata: string
}

const prereleaseFixture: MacOSFixtureOptions = { arch: 'arm64', channel: 'nightly', version: '1.2.3-alpha.1', metadata: 'alpha-mac.yml' }

async function fixture({ arch, channel, version, metadata }: MacOSFixtureOptions = prereleaseFixture) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-parallel-notarization-'))
  const artifactsRoot = join(root, 'artifacts')
  const appPath = join(artifactsRoot, arch === 'arm64' ? 'mac-arm64' : 'mac', 'Agentrans.app')
  await mkdir(join(appPath, 'Contents', 'Resources'), { recursive: true })
  await writeFile(join(appPath, 'payload'), 'signed content')
  await writeMacOSAppUpdateConfig(join(appPath, 'Contents', 'Resources'), {
    provider: 'github',
    owner: 'TLBtianhu',
    repo: 'Agentrans',
    channel,
  }, 'agentrans-updater')
  const base = `agentrans-${version}-mac-${arch}`
  const request = { arch, artifactsRoot, version, environment: { ...environment, AGENTRANS_DESKTOP_UPDATE_CHANNEL: channel } }
  const apple: MacOSArtifactOperations = {
    copyApp: async (source, destination) => {
      await cp(source, destination, { recursive: true, verbatimSymlinks: true })
    },
    notarize: async ({ appPath: path }) => { await writeFile(join(path, 'ticket'), 'accepted') },
    verifySignature: vi.fn(),
    verifyNotarization: vi.fn((path: string) => {
      if (!existsSync(join(path, 'ticket'))) throw new Error('missing App ticket')
    }),
  }
  const build = async (artifact: DesktopPrepackagedArtifact) => {
    await mkdir(artifact.output, { recursive: true })
    const contents = JSON.stringify({
      payload: await readFile(join(artifact.appPath, 'payload'), 'utf8'),
      appTicket: existsSync(join(artifact.appPath, 'ticket')),
    })
    await writeFile(join(artifact.output, `${base}.${artifact.format}`), contents)
    if (artifact.format === 'zip') {
      const path = `${base}.zip`
      const sha512 = createHash('sha512').update(contents).digest('base64')
      await writeFile(join(artifact.output, `${base}.zip.blockmap`), 'blockmap')
      await writeFile(join(artifact.output, metadata), dump({
        version, path, sha512, files: [{ url: path, sha512, size: Buffer.byteLength(contents) }],
      }))
    }
  }
  return { root, appPath, request, apple, build, base, metadata }
}

describe('parallel macOS artifacts', () => {
  const cases: readonly MacOSFixtureOptions[] = [
    prereleaseFixture,
    { arch: 'arm64', channel: 'nightly', version: '1.2.3', metadata: 'latest-mac.yml' },
    { arch: 'x64', channel: 'latest', version: '1.2.3', metadata: 'latest-mac.yml' },
  ]

  it.each(cases)('overlaps notarization and promotes qualified $arch payloads for $channel $version', async (options) => {
    const f = await fixture(options)
    const appStarted = barrier()
    const appAccepted = barrier()
    const dmgCompleted = barrier()
    const zipCompleted = barrier()
    const starts: string[] = []
    const copies: string[] = []
    const operation = packageMacOSArtifacts(f.request, async (artifact) => {
      starts.push(artifact.format)
      if (artifact.format === 'dmg') await dmgCompleted.promise
      await f.build(artifact)
      if (artifact.format === 'zip') zipCompleted.release()
    }, {
      ...f.apple,
      copyApp: async (source, destination) => {
        copies.push(destination)
        await f.apple.copyApp(source, destination)
      },
      notarize: async (options) => {
        starts.push('app')
        appStarted.release()
        await appAccepted.promise
        await f.apple.notarize(options)
      },
    })
    try {
      await Promise.race([appStarted.promise, operation])
      await vi.waitFor(() => { expect([...starts]).toEqual(expect.arrayContaining(['app', 'dmg'])) })
      expect(new Set(copies).size).toBe(2)
      expect(copies.every(path => path !== f.appPath)).toBe(true)
      appAccepted.release()
      await Promise.race([zipCompleted.promise, operation])
      expect(existsSync(join(f.appPath, 'ticket'))).toBe(false)
      expect(existsSync(join(f.request.artifactsRoot, `${f.base}.zip`))).toBe(false)
      dmgCompleted.release()
      await operation
      expect(JSON.parse(await readFile(join(f.request.artifactsRoot, `${f.base}.zip`), 'utf8')))
        .toEqual({ payload: 'signed content', appTicket: true })
      expect(JSON.parse(await readFile(join(f.request.artifactsRoot, `${f.base}.dmg`), 'utf8')))
        .toEqual({ payload: 'signed content', appTicket: false })
      expect(await readFile(join(f.appPath, 'ticket'), 'utf8')).toBe('accepted')
      expect(await readFile(join(f.appPath, 'Contents', 'Resources', 'app-update.yml'), 'utf8'))
        .toContain('repo: Agentrans')
      const assets = await collectReleaseAssets(f.request.artifactsRoot, options.version, options.channel, `mac-${options.arch}`)
      expect(assets.map(asset => asset.name).sort()).toEqual([
        `${f.base}.dmg`, `${f.base}.zip`, `${f.base}.zip.blockmap`, f.metadata,
      ].sort())
      expect((await readdir(f.root)).sort()).toEqual(['artifacts'])
      expect(f.apple.verifySignature).toHaveBeenCalledTimes(4)
      expect(f.apple.verifyNotarization).toHaveBeenCalledTimes(1)
    } finally {
      appAccepted.release()
      dmgCompleted.release()
      await Promise.allSettled([operation])
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('collects both failures after both lanes release their copies and publishes neither payload', async () => {
    const f = await fixture()
    const appStarted = barrier()
    const failApp = barrier()
    const failDmg = barrier()
    const appError = new Error('App rejected')
    const dmgError = new Error('DMG rejected')
    const released: string[] = []
    const outcome = packageMacOSArtifacts(f.request, async (artifact) => {
      expect(artifact.format).toBe('dmg')
      await failDmg.promise
      expect(await readFile(join(artifact.appPath, 'payload'), 'utf8')).toBe('signed content')
      released.push('dmg')
      throw dmgError
    }, {
      ...f.apple,
      notarize: async () => {
        appStarted.release()
        await failApp.promise
        released.push('app')
        throw appError
      },
    }).catch((error: unknown) => error)
    try {
      await appStarted.promise
      failApp.release()
      failDmg.release()
      const error = await outcome
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([appError, dmgError])
      expect(released.sort()).toEqual(['app', 'dmg'])
      expect(await readdir(f.root)).toEqual(['artifacts'])
      expect(await readdir(f.request.artifactsRoot)).toEqual(['mac-arm64'])
      expect(existsSync(join(f.appPath, 'ticket'))).toBe(false)
    } finally {
      failApp.release()
      failDmg.release()
      await outcome
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it.each(['copy', 'signature', 'post-signature', 'ticket', 'metadata', 'update-config', 'post-update-config'] as const)('rejects incomplete %s qualification without promoting artifacts', async (failure) => {
    const f = await fixture()
    try {
      if (failure === 'update-config') {
        await writeFile(join(f.appPath, 'Contents', 'Resources', 'app-update.yml'), 'provider: generic\nurl: https://wrong.example.com/\nchannel: nightly\nupdaterCacheDirName: fixture\n')
      }
      let signatureChecks = 0
      const apple: MacOSArtifactOperations = {
        ...f.apple,
        ...(failure === 'copy' ? { copyApp: async () => { throw new Error('copy failed') } } : {}),
        ...(failure === 'signature' || failure === 'post-signature' ? {
          verifySignature: () => {
            signatureChecks += 1
            if (failure === 'signature' || signatureChecks > 2) throw new Error('signature failed')
          },
        } : {}),
        ...(failure === 'ticket' ? { verifyNotarization: () => { throw new Error('ticket failed') } } : {}),
      }
      await expect(packageMacOSArtifacts(f.request, async (artifact) => {
        await f.build(artifact)
        if (failure === 'metadata' && artifact.format === 'zip') {
          await writeFile(join(artifact.output, f.metadata), '')
        }
        if (failure === 'post-update-config' && artifact.format === 'zip') {
          await writeFile(join(artifact.appPath, 'Contents', 'Resources', 'app-update.yml'), '{}')
        }
      }, apple)).rejects.toThrow()
      expect(await readdir(f.root)).toEqual(['artifacts'])
      expect(await readdir(f.request.artifactsRoot)).toEqual(['mac-arm64'])
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('passes the actual App and isolated output directory to each single-target builder', () => {
    const target = resolveDesktopPackageTarget('mac-arm64', 'darwin', 'arm64')
    for (const format of ['zip', 'dmg'] as const) {
      const appPath = join('private build', format, 'Agentrans.app')
      const output = join(dirname(appPath), 'artifacts')
      expect(desktopElectronBuilderArguments(target, false, { format, appPath, output })).toEqual([
        'exec', 'electron-builder', '--config', 'electron-builder.config.mjs',
        '--mac', format, '--arm64', '--publish', 'never',
        '--config.mac.notarize=false',
        '--prepackaged', appPath, '--config.directories.output', output,
      ])
    }
  })
})
