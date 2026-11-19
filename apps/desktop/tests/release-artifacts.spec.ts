/** Desktop release collection against the packaged files and update metadata. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump } from 'js-yaml'
import { describe, expect, it, onTestFinished } from 'vitest'
import { collectReleaseAssets } from '../scripts/release-artifacts.ts'

type Target = 'win-x64' | 'mac-arm64' | 'mac-x64'

interface FeedFile {
  readonly url: string
  readonly size: number
  readonly sha512: string
}

async function releaseDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-release-artifacts-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function writeTarget(directory: string, version: string, target: Target): Promise<FeedFile> {
  const windows = target === 'win-x64'
  const base = `agentrans-${version}-${target}-unsigned`
  const update = `${base}.${windows ? 'exe' : 'zip'}`
  const body = Buffer.from(`update file ${target}`)
  await writeFile(join(directory, update), body)
  await writeFile(join(directory, `${update}.blockmap`), 'blockmap')
  if (!windows) await writeFile(join(directory, `${base}.dmg`), 'disk image')
  return { url: update, size: body.byteLength, sha512: createHash('sha512').update(body).digest('base64') }
}

function updateFeed(version: string, files: readonly [FeedFile, ...FeedFile[]]) {
  return { version, files, path: files[0].url, sha512: files[0].sha512 }
}

async function windowsRelease(directory: string, version = '1.2.3') {
  const installer = await writeTarget(directory, version, 'win-x64')
  const feed = updateFeed(version, [installer])
  await writeFile(join(directory, 'latest.yml'), dump(feed))
  return { installer, feed }
}

describe('collect Desktop release artifacts', () => {
  it.each(['latest', 'nightly'] as const)('accepts the stable installer and version-derived feed on %s', async (channel) => {
    const directory = await releaseDirectory()
    const { installer, feed } = await windowsRelease(directory)
    await writeFile(join(directory, 'builder-debug.yml'), 'ignored diagnostic')
    const assets = await collectReleaseAssets(directory, '1.2.3', channel)
    expect(assets.map(asset => asset.name)).toEqual([installer.url, `${installer.url}.blockmap`, 'latest.yml'])
    expect(assets[0]?.sha256).toBe(createHash('sha256').update('update file win-x64').digest('hex'))
    expect(assets[2]?.sha256).toBe(createHash('sha256').update(dump(feed)).digest('hex'))
  })

  it('validates the full declared target set and one merged macOS feed', async () => {
    const directory = await releaseDirectory()
    const version = '1.2.3-alpha.1'
    const [windows, arm, intel] = await Promise.all([
      writeTarget(directory, version, 'win-x64'),
      writeTarget(directory, version, 'mac-arm64'),
      writeTarget(directory, version, 'mac-x64'),
    ])
    await writeFile(join(directory, 'alpha.yml'), dump(updateFeed(version, [windows])))
    await writeFile(join(directory, 'alpha-mac.yml'), dump(updateFeed(version, [arm, intel])))
    const artifacts = await collectReleaseAssets(directory, version, 'nightly', 'all')
    expect(artifacts).toHaveLength(10)
    expect(new Set(artifacts.slice(-2).map(asset => asset.name))).toEqual(new Set(['alpha.yml', 'alpha-mac.yml']))
    await expect(collectReleaseAssets(directory, version, 'latest')).rejects.toThrow(/requires a stable version/u)
    await expect(collectReleaseAssets(directory, version, 'nightly', 'mac')).rejects.toThrow(/expected mac-arm64, mac-x64/u)
    await writeFile(join(directory, 'alpha-mac.yml'), dump(updateFeed(version, [arm])))
    await expect(collectReleaseAssets(directory, version, 'nightly', 'all')).rejects.toThrow(/omits an update file/u)
  })

  it('refuses an empty directory and a feed without installers', async () => {
    const directory = await releaseDirectory()
    await expect(collectReleaseAssets(directory, '1.2.3', 'latest')).rejects.toThrow(/no Desktop installer artifacts/u)
    await writeFile(join(directory, 'latest.yml'), 'version: 1.2.3')
    await expect(collectReleaseAssets(directory, '1.2.3', 'latest')).rejects.toThrow(/no Desktop installer artifacts/u)
  })

  it('rejects an entirely missing expected platform', async () => {
    const directory = await releaseDirectory()
    await windowsRelease(directory)
    await expect(collectReleaseAssets(directory, '1.2.3', 'latest', 'all')).rejects.toThrow(/expected win-x64, mac-arm64, mac-x64/u)
  })

  it('requires each target’s blockmap and update feed', async () => {
    const directory = await releaseDirectory()
    const { installer } = await windowsRelease(directory)
    await unlink(join(directory, `${installer.url}.blockmap`))
    await expect(collectReleaseAssets(directory, '1.2.3', 'latest')).rejects.toThrow(/missing artifact .*\.exe\.blockmap/u)
    await writeFile(join(directory, `${installer.url}.blockmap`), 'blockmap')
    await rename(join(directory, 'latest.yml'), join(directory, 'nightly.yml'))
    await expect(collectReleaseAssets(directory, '1.2.3', 'latest')).rejects.toThrow(/missing update feed latest\.yml/u)
    await writeFile(join(directory, 'latest.yml'), '')
    await expect(collectReleaseAssets(directory, '1.2.3', 'latest')).rejects.toThrow(/unexpected update feed nightly\.yml/u)
  })

  it('requires the manual disk image for a macOS target', async () => {
    const directory = await releaseDirectory()
    const zip = await writeTarget(directory, '1.2.3', 'mac-x64')
    await writeFile(join(directory, 'latest-mac.yml'), dump(updateFeed('1.2.3', [zip])))
    await unlink(join(directory, zip.url.replace(/\.zip$/u, '.dmg')))
    await expect(collectReleaseAssets(directory, '1.2.3', 'latest', 'mac-x64')).rejects.toThrow(/missing artifact .*\.dmg/u)
  })

  it('rejects a different version that shares a filename prefix', async () => {
    const directory = await releaseDirectory()
    await windowsRelease(directory, '1.2.30')
    await expect(collectReleaseAssets(directory, '1.2.3', 'latest')).rejects.toThrow(/does not match .* version 1\.2\.3/u)
  })

  it('rejects missing, malformed and mismatched feed metadata', async () => {
    const directory = await releaseDirectory()
    const { feed, installer } = await windowsRelease(directory)
    const rewritten = [
      { value: { version: feed.version }, error: /must carry version, files, size and SHA-512 metadata/u },
      { value: { ...feed, version: '1.2.4' }, error: /carries version 1\.2\.4, expected 1\.2\.3/u },
      { value: { ...feed, files: [{ ...installer, url: 'missing.exe' }] }, error: /unexpected or missing update file missing\.exe/u },
      { value: { ...feed, files: [{ ...installer, size: installer.size + 1 }] }, error: /size or SHA-512 does not match/u },
      { value: { ...feed, files: [installer, installer] }, error: /more than once/u },
      { value: { ...feed, path: 'missing.exe' }, error: /primary update path or SHA-512 does not match/u },
    ]
    for (const { value, error } of rewritten) {
      await writeFile(join(directory, 'latest.yml'), dump(value))
      await expect(collectReleaseAssets(directory, '1.2.3', 'latest')).rejects.toThrow(error)
    }
    await writeFile(join(directory, 'latest.yml'), dump(feed))
    await writeFile(join(directory, installer.url), 'update file WIN-X64')
    await expect(collectReleaseAssets(directory, '1.2.3', 'latest')).rejects.toThrow(/size or SHA-512 does not match/u)
  })

  it('refuses a directory in place of a release file', async () => {
    const directory = await releaseDirectory()
    const { installer } = await windowsRelease(directory)
    await unlink(join(directory, installer.url))
    await mkdir(join(directory, installer.url))
    await expect(collectReleaseAssets(directory, '1.2.3', 'latest')).rejects.toThrow(/must be a regular file/u)
  })
})
