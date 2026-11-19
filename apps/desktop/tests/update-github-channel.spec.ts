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
const testVersion = '0.1.0-test.20261119.1'
const targets = ['win-x64', 'mac-arm64', 'mac-x64'] as const
type Target = typeof targets[number]

interface ReleaseOptions {
  readonly draft?: boolean
  readonly targets?: readonly Target[]
  readonly omitMetadata?: boolean
  readonly metadataTargets?: readonly Target[]
  readonly metadataVersion?: string
  readonly metadataSize?: number
  readonly metadataPackages?: Readonly<Record<string, { path: string; sha512: string; size: number }>>
  readonly metadataStatus?: 404 | 503
}

function platform(target: Target): 'win32' | 'darwin' {
  return target === 'win-x64' ? 'win32' : 'darwin'
}

function updateFile(version: string, target: Target, size = 1024) {
  const extension = platform(target) === 'win32' ? 'exe' : 'zip'
  const url = `agentrans-${version}-${target}-unsigned.${extension}`
  const sha512 = createHash('sha512').update(url).digest('base64')
  return { url, sha512, size }
}

function channelMetadataName(version: string, target: Target): string {
  const suffix = platform(target) === 'darwin' ? '-mac' : ''
  return `${prerelease(version)?.[0] ?? 'latest'}${suffix}.yml`
}

function channelMetadataPath(version: string, target: Target = 'win-x64'): string {
  return `${assetsPath}v${version}/${channelMetadataName(version, target)}`
}

function release(version: string, isPrerelease: boolean, options: ReleaseOptions = {}) {
  const availableTargets = options.targets ?? targets
  const names = new Set(availableTargets.map(target => updateFile(version, target).url))
  if (options.omitMetadata !== true) {
    for (const target of availableTargets) names.add(channelMetadataName(version, target))
  }
  return {
    version,
    options,
    record: {
      tag_name: `v${version}`,
      draft: options.draft ?? false,
      prerelease: isPrerelease,
      name: `Agentrans ${version}`,
      body: `Notes for ${version}`,
      assets: [...names].map(name => ({ name, state: 'uploaded', size: 1024 })),
    },
  }
}

async function fixture(
  channel: DesktopUpdateChannel,
  releases: readonly ReturnType<typeof release>[],
  { target = 'win-x64', version: currentVersion = installedVersion }: { target?: Target; version?: string } = {},
) {
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
    version: currentVersion, name: 'Agentrans', isPackaged: true, appUpdateConfigPath: config,
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
      return JSON.stringify(releases.slice((page - 1) * size, page * size).map(item => item.record))
    }
    if (options.hostname === 'github.com' && pathname.startsWith(assetsPath)) {
      requestedMetadata.push(pathname)
      const source = releases.find(item => pathname === channelMetadataPath(item.version, target))
      if (source === undefined) throw new Error(`Unexpected update metadata ${pathname}`)
      const { metadataStatus, metadataTargets, metadataVersion, metadataSize, metadataPackages } = source.options
      if (metadataStatus !== undefined) {
        throw Object.assign(new Error(`Metadata request failed (${metadataStatus})`), { statusCode: metadataStatus })
      }
      const files = (metadataTargets ?? source.options.targets ?? targets)
        .filter(fileTarget => platform(fileTarget) === platform(target))
        .map(fileTarget => updateFile(source.version, fileTarget, metadataSize))
      const [first] = files
      return dump({
        version: metadataVersion ?? source.version,
        files,
        path: first?.url,
        sha512: first?.sha512,
        packages: metadataPackages,
      })
    }
    throw new Error(`Unexpected update request ${options.hostname}${pathname}`)
  })
  // electron-updater accepts a custom AppAdapter and leaves its transport uninitialized in that case.
  // Its per-instance test platform also keeps the provider's channel filenames independent of the host.
  Object.assign(updater, { httpExecutor: executor, _testOnlyOptions: { platform: platform(target) } })
  const appArchitecture = target === 'mac-arm64' ? 'arm64' : 'x64'
  await configureDesktopGitHubUpdateFeed(updater, channel, directory, appArchitecture)
  const onAvailable = vi.fn()
  updater.on('update-available', onAvailable)
  const coordinator = new DesktopUpdateCoordinator(state => state, async () => true, updater,
    () => true, () => currentVersion, undefined, channel, { verify: unexpectedLifecycle })
  onTestFinished(() => {
    coordinator.dispose()
    updater.off('update-available', onAvailable)
  })
  return { coordinator, requestedMetadata, onAvailable }
}

it('selects the newest nightly version when a stable release is first', async () => {
  const { coordinator, requestedMetadata, onAvailable } = await fixture('nightly', [
    release('3.0.0', false), release('1.3.0-test.1', true), release('2.0.0-test.1', true), release('4.0.0-test.1', true, { draft: true }),
  ])

  await expect(coordinator.check(true)).resolves.toEqual({ phase: 'available', version: '2.0.0-test.1' })
  expect(requestedMetadata).toEqual([channelMetadataPath('2.0.0-test.1')])
  expect(onAvailable).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tag: 'v2.0.0-test.1' }))
})

it.each(targets)('stays in the installed test series despite a higher alpha release (%s)', async (target) => {
  const next = '0.1.0-test.20261119.2'
  const { coordinator, requestedMetadata, onAvailable } = await fixture('nightly', [
    release('0.2.2-alpha.2', true, { targets: ['win-x64', 'mac-arm64'] }),
    release('0.1.0', false),
    release(testVersion, true),
    release(next, true),
  ], { target, version: testVersion })

  await expect(coordinator.check(true)).resolves.toEqual({ phase: 'available', version: next })
  expect(requestedMetadata).toEqual([channelMetadataPath(next, target)])
  expect(onAvailable).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tag: `v${next}` }))
})

it('keeps a nightly alpha install in the alpha series without pinning its alpha number', async () => {
  const { coordinator, requestedMetadata } = await fixture('nightly', [
    release('3.0.0-test.1', true), release('2.0.0-alpha.2', true),
  ], { version: '2.0.0-alpha.1' })

  await expect(coordinator.check(true)).resolves.toEqual({ phase: 'available', version: '2.0.0-alpha.2' })
  expect(requestedMetadata).toEqual([channelMetadataPath('2.0.0-alpha.2')])
})

it.each(targets)('finds the newest same-series release with an actual indexed package (%s)', async (target) => {
  const next = '0.1.0-test.20261119.2'
  const missingIndexTarget = '0.1.0-test.20261119.3'
  const mismatchedSize = '0.1.0-test.20261119.4'
  const otherTarget = target === 'mac-arm64' ? 'mac-x64' : 'mac-arm64'
  const { coordinator, requestedMetadata, onAvailable } = await fixture('nightly', [
    release(next, true),
    release('0.1.0-test.20261119.5', true, { omitMetadata: true }),
    release('0.1.0-test.20261119.6', true, { targets: [otherTarget] }),
    release(mismatchedSize, true, { metadataSize: 2048 }),
    release(missingIndexTarget, true, { metadataTargets: [otherTarget] }),
  ], { target, version: testVersion })

  await expect(coordinator.check(true)).resolves.toEqual({ phase: 'available', version: next })
  expect(requestedMetadata).toEqual([
    channelMetadataPath(mismatchedSize, target), channelMetadataPath(missingIndexTarget, target), channelMetadataPath(next, target),
  ])
  const file = updateFile(next, target)
  expect(onAvailable).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    tag: `v${next}`, files: [file], path: file.url, sha512: file.sha512,
  }))
})

it('reports idle when the only newer Intel nightly has an Apple Silicon ZIP', async () => {
  const { coordinator, onAvailable } = await fixture('nightly', [
    release('0.2.2-alpha.2', true, { targets: ['mac-arm64'] }),
    release(testVersion, true),
    release('0.1.0-test.20261119.2', true, { targets: ['mac-arm64'] }),
  ], { target: 'mac-x64', version: testVersion })

  await expect(coordinator.check(true)).resolves.toEqual({ phase: 'idle' })
  expect(onAvailable).not.toHaveBeenCalled()
})

it('rewrites the macOS primary path and hash for the selected Intel ZIP', async () => {
  const next = '0.1.0-test.20261119.2'
  // The combined feed's top-level fields refer to its first (Apple Silicon) ZIP.
  const { coordinator, onAvailable } = await fixture('nightly', [release(next, true)], {
    target: 'mac-x64', version: testVersion,
  })

  await expect(coordinator.check(true)).resolves.toEqual({ phase: 'available', version: next })
  const file = updateFile(next, 'mac-x64')
  expect(onAvailable).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    files: [file], path: file.url, sha512: file.sha512,
  }))
})

it('keeps only the qualified offline installer when an NSIS index also lists a web package', async () => {
  const version = '2.0.0'
  const file = updateFile(version, 'win-x64')
  const { coordinator, onAvailable } = await fixture('latest', [release(version, false, {
    metadataPackages: { x64: { path: 'extra-package.7z', sha512: file.sha512, size: 1024 } },
  })])

  await expect(coordinator.check(true)).resolves.toEqual({ phase: 'available', version })
  expect(onAvailable).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ files: [file] }))
  expect(onAvailable.mock.calls[0]?.[0]).not.toHaveProperty('packages')
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

it('skips an index that disappeared between release listing and metadata retrieval', async () => {
  const { coordinator, requestedMetadata } = await fixture('latest', [
    release('2.0.0', false, { metadataStatus: 404 }), release('1.5.0', false),
  ])

  await expect(coordinator.check(true)).resolves.toEqual({ phase: 'available', version: '1.5.0' })
  expect(requestedMetadata).toEqual([channelMetadataPath('2.0.0'), channelMetadataPath('1.5.0')])
})

it('retains a check error when the current index is temporarily unavailable', async () => {
  const { coordinator, requestedMetadata, onAvailable } = await fixture('latest', [
    release('2.0.0', false, { metadataStatus: 503 }), release('1.5.0', false),
  ])

  await expect(coordinator.check(true)).resolves.toMatchObject({ phase: 'error', failedOperation: 'check' })
  expect(requestedMetadata).toEqual([channelMetadataPath('2.0.0')])
  expect(onAvailable).not.toHaveBeenCalled()
})

it('rejects metadata for a version other than the chosen release tag', async () => {
  const { coordinator, requestedMetadata } = await fixture('latest', [
    release('2.0.0', false, { metadataVersion: '3.0.0' }),
  ])

  await expect(coordinator.check(true)).resolves.toMatchObject({ phase: 'error', failedOperation: 'check' })
  expect(requestedMetadata).toEqual([channelMetadataPath('2.0.0')])
})
