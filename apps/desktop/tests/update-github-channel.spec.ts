import { createHash } from 'node:crypto'
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NsisUpdater } from 'electron-updater/out/NsisUpdater.js'
import { dump } from 'js-yaml'
import { prerelease } from 'semver'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { DesktopUpdateChannel } from '../src/update-channel.ts'
import { configureDesktopGitHubUpdateFeed } from '../src/update-github-provider.ts'
import { DesktopUpdateHttpExecutor } from '../src/update-http-executor.ts'

// Avoid initializing Electron's process singleton in Node. The fixture injects a real updater instance.
vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }))

const { DesktopUpdateCoordinator } = await import('../src/update-coordinator.ts')
const repository = '/TLBtianhu/Agentrans'
const releasesPath = `${repository}/releases`
const assetsPath = `${releasesPath}/download/`
const installedVersion = '1.0.0'

interface SimulatedRelease {
  readonly tag_name: string
  readonly draft: boolean
  readonly prerelease: boolean
  readonly name: string
  readonly body: string
}

function release(version: string, isPrerelease: boolean, draft = false): SimulatedRelease {
  return { tag_name: `v${version}`, draft, prerelease: isPrerelease, name: `Agentrans ${version}`, body: `Notes for ${version}` }
}

function channelMetadataPath(version: string): string {
  const arch = process.env.TEST_UPDATER_ARCH ?? process.arch
  const suffix = process.platform === 'darwin' ? '-mac'
    : process.platform === 'linux' ? (arch === 'x64' ? '-linux' : `-linux-${arch}`) : ''
  return `${assetsPath}v${version}/${prerelease(version)?.[0] ?? 'latest'}${suffix}.yml`
}

async function fixture(channel: DesktopUpdateChannel, releases: readonly SimulatedRelease[], metadataVersion?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'agentrans-update-channel-'))
  const config = join(directory, 'app-update.yml')
  onTestFinished(async () => {
    await Promise.all([config, join(directory, '.updaterId')].map(path => rm(path, { force: true })))
    await rmdir(directory)
  })
  await writeFile(config, dump({
    provider: 'github', owner: 'TLBtianhu', repo: 'Agentrans', channel: 'latest',
    releaseType: channel === 'nightly' ? 'prerelease' : 'release', updaterCacheDirName: 'agentrans-updater',
  }))

  const unexpectedLifecycle = () => { throw new Error('Update checks must not install or restart') }
  const updater = new NsisUpdater(undefined, {
    version: installedVersion, name: 'Agentrans', isPackaged: true, appUpdateConfigPath: config,
    userDataPath: directory, baseCachePath: directory, whenReady: async () => {},
    relaunch: unexpectedLifecycle, quit: unexpectedLifecycle, onQuit: unexpectedLifecycle,
  })
  updater.logger = null
  const requestedMetadata: string[] = []
  const executor = new DesktopUpdateHttpExecutor(1_000)
  vi.spyOn(executor, 'request').mockImplementation(async (options) => {
    const { pathname, searchParams } = new URL(options.path ?? '', `https://${options.hostname}`)
    if (options.hostname === 'api.github.com' && pathname === `/repos${releasesPath}`) {
      const size = Number(searchParams.get('per_page') ?? '100')
      const page = Number(searchParams.get('page') ?? '1')
      return JSON.stringify(releases.slice((page - 1) * size, page * size))
    }
    if (options.hostname === 'github.com' && pathname === `${releasesPath}.atom`) {
      const entries = releases.filter(item => !item.draft).map(item => [
        '<entry>', `<title>${item.name}</title>`, `<link href="https://github.com${releasesPath}/tag/${item.tag_name}"/>`, '</entry>',
      ].join('')).join('')
      return `<feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`
    }
    if (options.hostname === 'github.com' && pathname === `${releasesPath}/latest`) {
      return JSON.stringify(releases.find(item => !item.prerelease && !item.draft) ?? {})
    }
    if (options.hostname === 'github.com' && pathname.startsWith(assetsPath)) {
      requestedMetadata.push(pathname)
      const source = releases.find(item => pathname === channelMetadataPath(item.tag_name.slice(1)))
      if (source === undefined) throw new Error(`Unexpected update metadata ${pathname}`)
      const version = metadataVersion ?? source.tag_name.slice(1)
      const url = `agentrans-${version}.exe`
      const sha512 = createHash('sha512').update(version).digest('base64')
      return dump({ version, files: [{ url, sha512, size: 1024 }], path: url, sha512 })
    }
    throw new Error(`Unexpected update request ${options.hostname}${pathname}`)
  })
  // electron-updater accepts a custom AppAdapter and leaves its transport uninitialized in that case.
  Object.assign(updater, { httpExecutor: executor })
  await configureDesktopGitHubUpdateFeed(updater, channel, directory)
  const onAvailable = vi.fn()
  updater.on('update-available', onAvailable)
  const coordinator = new DesktopUpdateCoordinator(state => state, async () => true, updater,
    () => true, () => installedVersion, undefined, channel, { verify: unexpectedLifecycle })
  onTestFinished(() => {
    coordinator.dispose()
    updater.off('update-available', onAvailable)
  })
  return { coordinator, requestedMetadata, onAvailable }
}

it('selects the newest nightly version when a stable release is first', async () => {
  const { coordinator, requestedMetadata, onAvailable } = await fixture('nightly', [
    release('3.0.0', false), release('1.3.0-test.1', true), release('2.0.0-test.1', true), release('4.0.0-test.1', true, true),
  ])

  await expect(coordinator.check(true)).resolves.toEqual({ phase: 'available', version: '2.0.0-test.1' })
  expect(requestedMetadata).toEqual([channelMetadataPath('2.0.0-test.1')])
  expect(onAvailable).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tag: 'v2.0.0-test.1' }))
})

it('selects a stable release ahead of nightlies with higher stable or prerelease versions', async () => {
  const { coordinator, requestedMetadata, onAvailable } = await fixture('latest', [
    release('3.0.0', true), release('2.2.0-beta.1', true), release('1.6.0', false), release('2.0.0', false),
  ])

  await expect(coordinator.check(true)).resolves.toEqual({ phase: 'available', version: '2.0.0' })
  expect(requestedMetadata).toEqual([channelMetadataPath('2.0.0')])
  expect(onAvailable).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tag: 'v2.0.0' }))
})

it('finds newer stable releases after the first page of nightlies', async () => {
  const nightlies = Array.from({ length: 100 }, (_, index) => release(`3.0.0-test.${index + 1}`, true))
  const { coordinator, requestedMetadata } = await fixture('latest', [...nightlies, release('2.0.0', false)])

  await expect(coordinator.check(true)).resolves.toEqual({ phase: 'available', version: '2.0.0' })
  expect(requestedMetadata).toEqual([channelMetadataPath('2.0.0')])
})

it('uses the GitHub prerelease flag for a nightly published with a stable version', async () => {
  const { coordinator, requestedMetadata } = await fixture('nightly', [release('3.0.0', false), release('2.0.0', true)])

  await expect(coordinator.check(true)).resolves.toEqual({ phase: 'available', version: '2.0.0' })
  expect(requestedMetadata).toEqual([channelMetadataPath('2.0.0')])
})

it.each(['latest', 'nightly'] as const)('reports no update when only the opposite channel has a newer release (%s)', async (channel) => {
  const isNightly = channel === 'nightly'
  const { coordinator, requestedMetadata } = await fixture(channel, [
    release('2.0.0', !isNightly), release('1.0.0', isNightly), release('0.9.0', isNightly),
  ])

  await expect(coordinator.check(true)).resolves.toEqual({ phase: 'idle' })
  expect(requestedMetadata).toEqual([])
})

it('rejects metadata for a version other than the chosen release tag', async () => {
  const { coordinator, requestedMetadata } = await fixture('latest', [release('2.0.0', false)], '3.0.0')

  await expect(coordinator.check(true)).resolves.toMatchObject({ phase: 'error', failedOperation: 'check' })
  expect(requestedMetadata).toEqual([channelMetadataPath('2.0.0')])
})
