import { createHash, sign } from 'node:crypto'
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NsisUpdater } from 'electron-updater/out/NsisUpdater.js'
import { dump } from 'js-yaml'
import { prerelease } from 'semver'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { DesktopUpdateState } from '../src/ipc.ts'
import type { DesktopUpdateChannel } from '../src/update-channel.ts'
import { configureDesktopGitHubUpdateFeed } from '../src/update-github-provider.ts'
import * as updateTransport from '../src/update-http-executor.ts'

// Avoid initializing Electron's process singleton in Node. The fixture injects a real updater instance.
vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }))
const signingKeys = await vi.hoisted(async () => (await import('node:crypto')).generateKeyPairSync('ed25519'))
vi.mock('../src/update-signing-key.ts', () => ({
  UPDATE_SIGNING_PUBLIC_KEY: signingKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
}))

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
  readonly signatureStatus?: 'unlisted' | 404
  readonly serveMetadata?: (bytes: Buffer) => Buffer
  readonly serveSignature?: (bytes: Buffer) => Buffer | Promise<Buffer>
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
    for (const target of availableTargets) {
      const metadata = channelMetadataName(version, target)
      names.add(metadata)
      if (options.signatureStatus !== 'unlisted') names.add(`${metadata}.sig`)
    }
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

function metadataBytes(source: ReturnType<typeof release>, target: Target): Buffer {
  const { metadataTargets, metadataVersion, metadataSize, metadataPackages } = source.options
  const files = (metadataTargets ?? source.options.targets ?? targets)
    .filter(fileTarget => platform(fileTarget) === platform(target))
    .map(fileTarget => updateFile(source.version, fileTarget, metadataSize))
  const [first] = files
  return Buffer.from(dump({
    version: metadataVersion ?? source.version,
    files,
    path: first?.url,
    sha512: first?.sha512,
    packages: metadataPackages,
    releaseNotes: '更新说明',
  }).replaceAll('\n', '\r\n'))
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

  const unexpectedLifecycle = () => { throw new Error('Update checks must not download, install or restart') }
  const updater = new NsisUpdater(undefined, {
    version: currentVersion, name: 'Agentrans', isPackaged: true, appUpdateConfigPath: config,
    userDataPath: directory, baseCachePath: directory, whenReady: async () => {},
    relaunch: unexpectedLifecycle, quit: unexpectedLifecycle, onQuit: unexpectedLifecycle,
  })
  updater.logger = null
  const requestedMetadata: string[] = []
  const requestedSignatures: string[] = []
  const executor = new updateTransport.DesktopUpdateHttpExecutor(1_000)
  vi.spyOn(executor, 'request').mockImplementation(async (options) => {
    const { pathname, searchParams } = new URL(options.path ?? '', `https://${options.hostname}`)
    if (options.hostname === 'api.github.com' && pathname === `/repos${releasesPath}`) {
      const size = Number(searchParams.get('per_page') ?? '100')
      const page = Number(searchParams.get('page') ?? '1')
      return JSON.stringify(releases.slice((page - 1) * size, page * size).map(item => item.record))
    }
    throw new Error(`Unexpected update request ${options.hostname}${pathname}`)
  })
  const requestBytes = vi.spyOn(updateTransport, 'requestUpdateBytes').mockImplementation(async (transport, options) => {
    const { pathname } = new URL(options.path ?? '', `https://${options.hostname}`)
    const isSignature = pathname.endsWith('.sig')
    const metadataPath = isSignature ? pathname.slice(0, -4) : pathname
    const source = releases.find(item => metadataPath === channelMetadataPath(item.version, target))
    if (transport !== executor || options.hostname !== 'github.com' || source === undefined) {
      throw new Error(`Unexpected update asset request ${options.hostname}${pathname}`)
    }
    const { metadataStatus, signatureStatus, serveMetadata, serveSignature } = source.options
    const bytes = metadataBytes(source, target)
    if (isSignature) {
      requestedSignatures.push(pathname)
      if (signatureStatus !== undefined) throw Object.assign(new Error('Signature request failed (404)'), { statusCode: 404 })
      const digest = createHash('sha256').update(bytes).digest()
      const signature = Buffer.from(sign(null, digest, signingKeys.privateKey).toString('base64'))
      return serveSignature?.(signature) ?? signature
    }
    requestedMetadata.push(pathname)
    if (metadataStatus !== undefined) {
      throw Object.assign(new Error(`Metadata request failed (${metadataStatus})`), { statusCode: metadataStatus })
    }
    return serveMetadata?.(bytes) ?? bytes
  })
  onTestFinished(() => { requestBytes.mockRestore() })
  // electron-updater accepts a custom AppAdapter and leaves its transport uninitialized in that case.
  // Its per-instance test platform also keeps the provider's channel filenames independent of the host.
  Object.assign(updater, { httpExecutor: executor, _testOnlyOptions: { platform: platform(target) } })
  const appArchitecture = target === 'mac-arm64' ? 'arm64' : 'x64'
  await configureDesktopGitHubUpdateFeed(updater, channel, directory, appArchitecture)
  const onAvailable = vi.fn()
  const onError = vi.fn()
  const downloadUpdate = vi.spyOn(updater, 'downloadUpdate').mockImplementation(unexpectedLifecycle)
  const publish = vi.fn((state: DesktopUpdateState) => state)
  updater.on('update-available', onAvailable)
  updater.on('error', onError)
  const coordinator = new DesktopUpdateCoordinator(publish, async () => true, updater,
    () => true, () => currentVersion, undefined, channel, { verify: unexpectedLifecycle })
  onTestFinished(() => {
    coordinator.dispose()
    updater.off('update-available', onAvailable)
    updater.off('error', onError)
  })
  return { coordinator, requestedMetadata, requestedSignatures, onAvailable, onError, downloadUpdate, publish }
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
  const { coordinator, requestedMetadata, requestedSignatures, onAvailable, downloadUpdate } = await fixture('nightly', [
    release('0.2.2-alpha.2', true, { targets: ['win-x64', 'mac-arm64'] }),
    release('0.1.0', false),
    release(testVersion, true),
    release(next, true),
  ], { target, version: testVersion })

  await expect(coordinator.check(true)).resolves.toEqual({ phase: 'available', version: next })
  expect(requestedMetadata).toEqual([channelMetadataPath(next, target)])
  expect(requestedSignatures).toEqual([`${channelMetadataPath(next, target)}.sig`])
  expect(onAvailable).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tag: `v${next}`, releaseNotes: '更新说明' }))
  expect(downloadUpdate).not.toHaveBeenCalled()
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

it.each([
  {
    description: 'an unlisted Windows sidecar', channel: 'latest', target: 'win-x64', fetchSignature: false,
    options: { signatureStatus: 'unlisted' },
  },
  {
    description: 'a listed macOS sidecar that returns 404', channel: 'nightly', target: 'mac-arm64', fetchSignature: true,
    options: { signatureStatus: 404 },
  },
  {
    description: 'a modified but base64-encoded signature', channel: 'latest', target: 'win-x64', fetchSignature: true,
    options: { serveSignature: signature => Buffer.concat([Buffer.from(signature[0] === 65 ? 'B' : 'A'), signature.subarray(1)]) },
  },
  {
    description: 'YAML whose line endings changed', channel: 'nightly', target: 'mac-x64', fetchSignature: true,
    options: { serveMetadata: bytes => Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n')) },
  },
  {
    description: 'metadata with invalid UTF-8 bytes', channel: 'latest', target: 'win-x64', fetchSignature: true,
    options: { serveMetadata: bytes => Buffer.concat([Buffer.from([0xff]), bytes]) },
  },
  {
    description: 'metadata with invalid YAML syntax', channel: 'nightly', target: 'mac-arm64', fetchSignature: true,
    options: { serveMetadata: bytes => Buffer.concat([bytes, Buffer.from('unterminated: [')]) },
  },
] satisfies readonly {
  description: string
  channel: DesktopUpdateChannel
  target: Target
  fetchSignature: boolean
  options: ReleaseOptions
}[])('rejects $description before offering an update', async ({ channel, target, fetchSignature, options }) => {
  const nightly = channel === 'nightly'
  const version = nightly ? '2.0.0-test.1' : '2.0.0'
  const older = nightly ? '1.5.0-test.1' : '1.5.0'
  const { coordinator, requestedMetadata, requestedSignatures, onAvailable, onError, downloadUpdate } = await fixture(channel, [
    release(version, nightly, options), release(older, nightly),
  ], { target })

  await expect(coordinator.check(true)).resolves.toMatchObject({ phase: 'error', failedOperation: 'check' })
  expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'ERR_UPDATER_UNTRUSTED_INDEX' }), expect.any(String))
  const path = channelMetadataPath(version, target)
  expect(requestedMetadata).toEqual([path])
  expect(requestedSignatures).toEqual(fetchSignature ? [`${path}.sig`] : [])
  expect(onAvailable).not.toHaveBeenCalled()
  await expect(coordinator.download(version)).rejects.toThrow('no checked update is available')
  expect(downloadUpdate).not.toHaveBeenCalled()
})

it('joins automatic and manual checks while waiting for one index signature', async () => {
  const version = '2.0.0'
  const signatureStarted = Promise.withResolvers<undefined>()
  const allowSignature = Promise.withResolvers<undefined>()
  const { coordinator, requestedMetadata, requestedSignatures, onAvailable, downloadUpdate, publish } = await fixture('latest', [
    release(version, false, {
      async serveSignature(signature) {
        signatureStarted.resolve(undefined)
        await allowSignature.promise
        return signature
      },
    }),
  ])
  const automatic = coordinator.check()
  const manual = coordinator.check(true)
  try {
    await Promise.race([signatureStarted.promise, automatic.then(() => {
      throw new Error('The update check completed before requesting its index signature')
    })])
    expect(onAvailable).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(downloadUpdate).not.toHaveBeenCalled()
  } finally {
    allowSignature.resolve(undefined)
  }
  const available = { phase: 'available', version }
  await expect(Promise.all([automatic, manual])).resolves.toEqual([available, available])
  expect(requestedMetadata).toEqual([channelMetadataPath(version)])
  expect(requestedSignatures).toEqual([`${channelMetadataPath(version)}.sig`])
  expect(onAvailable).toHaveBeenCalledOnce()
  expect(publish).toHaveBeenCalledExactlyOnceWith(available)
  expect(downloadUpdate).not.toHaveBeenCalled()
})

it.each(['manual', 'automatic'] as const)('withdraws the prior offer when a %s recheck rejects the index', async (mode) => {
  const version = '2.0.0'
  let tampered = false
  const { coordinator, requestedSignatures, onAvailable, downloadUpdate, publish } = await fixture('latest', [
    release(version, false, { serveMetadata: bytes => tampered ? Buffer.concat([bytes, Buffer.from('# changed\n')]) : bytes }),
  ])

  await expect(coordinator.check(true)).resolves.toEqual({ phase: 'available', version })
  tampered = true
  const failure = await coordinator.check(mode === 'manual')
  expect(failure).toMatchObject({ phase: 'error', failedOperation: 'check' })
  const state = mode === 'manual' ? failure : { phase: 'idle' }
  expect(coordinator.state).toEqual(state)
  expect(publish).toHaveBeenLastCalledWith(state)
  const signature = `${channelMetadataPath(version)}.sig`
  expect(requestedSignatures).toEqual([signature, signature])
  expect(onAvailable).toHaveBeenCalledOnce()
  await expect(coordinator.download(version)).rejects.toThrow('no checked update is available')
  expect(downloadUpdate).not.toHaveBeenCalled()

  tampered = false
  await expect(coordinator.check(true)).resolves.toEqual({ phase: 'available', version })
  expect(requestedSignatures).toEqual([signature, signature, signature])
  expect(onAvailable).toHaveBeenCalledTimes(2)
})
