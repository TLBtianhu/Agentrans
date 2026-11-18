/** Collect and validate the installer set and update feeds before publication. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { load } from 'js-yaml'
import { parse } from 'semver'
import { z } from 'zod'
import { DESKTOP_ARTIFACT_SLUG } from './desktop-product-identity.mjs'

const layouts = [
  { target: 'win-x64', feedSuffix: '', update: '.exe', files: ['.exe', '.exe.blockmap'] },
  { target: 'mac-arm64', feedSuffix: '-mac', update: '.zip', files: ['.dmg', '.zip', '.zip.blockmap'] },
  { target: 'mac-x64', feedSuffix: '-mac', update: '.zip', files: ['.dmg', '.zip', '.zip.blockmap'] },
] as const

type Layout = typeof layouts[number]
type Target = Layout['target']
type PackageFile = Layout['files'][number]

const packageTargets = new Map<string, readonly Target[]>([
  ['all', ['win-x64', 'mac-arm64', 'mac-x64']],
  ['mac', ['mac-arm64', 'mac-x64']],
  ...layouts.map(({ target }) => [target, [target]] as const),
])

const contentTypes: ReadonlyMap<string, string> = new Map([
  ['.exe', 'application/octet-stream'],
  ['.dmg', 'application/x-apple-diskimage'],
  ['.zip', 'application/zip'],
  ['.blockmap', 'application/octet-stream'],
  ['.yml', 'text/yaml'],
])

const sha512 = z.string().regex(/^[A-Za-z0-9+/]{86}==$/u)
const feedDocument = z.object({
  version: z.string(),
  files: z.array(z.object({ url: z.string(), sha512, size: z.int().positive() })).nonempty(),
  path: z.string(),
  sha512,
})

interface MatchedFile {
  readonly layout: Layout
  readonly stem: string
  readonly kind: PackageFile
}

/** A packaged file whose bytes were measured while collecting the release. */
export interface CollectedReleaseAsset {
  readonly name: string
  readonly path: string
  readonly contentType: string
  readonly sha256: string
}

function releaseFileNames(version: string): ReadonlyMap<string, MatchedFile> {
  const files = new Map<string, MatchedFile>()
  for (const layout of layouts) {
    const suffixes = layout.target === 'win-x64' ? ['', '-unsigned'] : ['', '-unsigned', '-unnotarized']
    for (const suffix of suffixes) {
      const stem = `${DESKTOP_ARTIFACT_SLUG}-${version}-${layout.target}${suffix}`
      for (const kind of layout.files) files.set(`${stem}${kind}`, { layout, stem, kind })
    }
  }
  return files
}

interface FileHashes {
  readonly size: number
  readonly sha256: string
  readonly sha512: string | undefined
}

async function hashFile(path: string, forUpdate: boolean): Promise<FileHashes> {
  const sha256Hash = createHash('sha256')
  const sha512Hash = forUpdate ? createHash('sha512') : undefined
  let size = 0
  for await (const chunk of createReadStream(path)) {
    const bytes: unknown = chunk
    if (!(bytes instanceof Buffer)) throw new Error(`desktop publish: could not read bytes from ${path}`)
    size += bytes.length
    sha256Hash.update(bytes)
    sha512Hash?.update(bytes)
  }
  return { size, sha256: sha256Hash.digest('hex'), sha512: sha512Hash?.digest('base64') }
}

async function verifyUpdateFeed(path: string, name: string, version: string, expected: ReadonlyMap<string, FileHashes>): Promise<string> {
  const bytes = await readFile(path)
  const parsedDocument: unknown = load(bytes.toString('utf8'), { filename: name })
  const parsed = feedDocument.safeParse(parsedDocument)
  if (!parsed.success) throw new Error(`desktop publish: ${name} must carry version, files, size and SHA-512 metadata`)
  const feed = parsed.data
  if (feed.version !== version) {
    throw new Error(`desktop publish: ${name} carries version ${feed.version}, expected ${version}`)
  }
  const seen = new Set<string>()
  for (const file of feed.files) {
    const source = expected.get(file.url)
    if (source === undefined) throw new Error(`desktop publish: ${name} references an unexpected or missing update file ${file.url}`)
    if (seen.has(file.url)) throw new Error(`desktop publish: ${name} references ${file.url} more than once`)
    if (file.size !== source.size || file.sha512 !== source.sha512) {
      throw new Error(`desktop publish: ${name} size or SHA-512 does not match ${file.url}`)
    }
    seen.add(file.url)
  }
  if (seen.size !== expected.size) throw new Error(`desktop publish: ${name} omits an update file for this release`)
  if (!seen.has(feed.path) || feed.sha512 !== expected.get(feed.path)?.sha512) {
    throw new Error(`desktop publish: ${name} primary update path or SHA-512 does not match its files`)
  }
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Collect a complete set of Desktop installers and verify each update feed against the shipped bytes.
 * @param directory - Flat electron-builder or merged macOS output directory.
 * @param version - Exact packaged semantic version, without build metadata.
 * @param channel - Release type selected by the packaged application.
 * @param expectedTarget - Hosted packaging target, when known. Direct calls infer targets from the filenames.
 * @returns Validated artifacts followed by their update feeds, with pinned SHA-256 digests.
 */
export async function collectReleaseAssets(
  directory: string,
  version: string,
  channel: 'nightly' | 'latest',
  expectedTarget?: string,
): Promise<CollectedReleaseAsset[]> {
  const parsed = parse(version)
  if (parsed === null || parsed.version !== version || parsed.build.length !== 0) {
    throw new Error(`desktop publish: ${version} is not a canonical Desktop build version`)
  }
  if (channel === 'latest' && parsed.prerelease.length !== 0) throw new Error('desktop publish: latest requires a stable version')
  if (expectedTarget !== undefined && !packageTargets.has(expectedTarget)) {
    throw new Error(`desktop publish: unsupported packaging target ${expectedTarget}`)
  }
  const possibleFiles = releaseFileNames(version)
  const candidates = new Map<string, MatchedFile>()
  const stems = new Map<Target, string>()
  const feeds = new Set<string>()
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const { name } = entry
    const extension = extname(name)
    if (name === 'builder-debug.yml' || !contentTypes.has(extension)) continue
    if (!entry.isFile()) throw new Error(`desktop publish: ${name} must be a regular file`)
    if (extension === '.yml') {
      feeds.add(name)
      continue
    }
    const file = possibleFiles.get(name)
    if (file === undefined) throw new Error(`desktop publish: ${name} does not match a supported installer artifact for version ${version}`)
    const previous = stems.get(file.layout.target)
    if (previous !== undefined && previous !== file.stem) {
      throw new Error(`desktop publish: multiple build variants for ${file.layout.target}`)
    }
    stems.set(file.layout.target, file.stem)
    candidates.set(name, file)
  }
  if (stems.size === 0) throw new Error('desktop publish: no Desktop installer artifacts found')
  const targets = expectedTarget === undefined ? undefined : packageTargets.get(expectedTarget)
  if (targets !== undefined && (targets.length !== stems.size || targets.some(target => !stems.has(target)))) {
    throw new Error(`desktop publish: expected ${targets.join(', ')} artifacts for target ${expectedTarget}`)
  }

  const feedNames = new Map<string, Map<string, FileHashes>>()
  // The updater's file name follows SemVer, including a stable version on nightly.
  const feedPrefix = parsed.prerelease[0] ?? 'latest'
  for (const layout of layouts) {
    const stem = stems.get(layout.target)
    if (stem === undefined) continue
    for (const extension of layout.files) {
      if (!candidates.has(`${stem}${extension}`)) throw new Error(`desktop publish: missing artifact ${stem}${extension}`)
    }
    const feed = `${feedPrefix}${layout.feedSuffix}.yml`
    if (!feeds.has(feed)) throw new Error(`desktop publish: missing update feed ${feed}`)
    if (!feedNames.has(feed)) feedNames.set(feed, new Map())
  }
  for (const feed of feeds) {
    if (!feedNames.has(feed)) throw new Error(`desktop publish: unexpected update feed ${feed}`)
  }

  const assets: CollectedReleaseAsset[] = []
  for (const [name, file] of candidates) {
    const path = join(directory, name)
    const forUpdate = file.kind === file.layout.update
    const hashes = await hashFile(path, forUpdate)
    if (hashes.size === 0) throw new Error(`desktop publish: empty artifact ${name}`)
    if (forUpdate) feedNames.get(`${feedPrefix}${file.layout.feedSuffix}.yml`)?.set(name, hashes)
    const contentType = contentTypes.get(extname(name))
    if (contentType === undefined) throw new Error(`desktop publish: unsupported file type for ${name}`)
    assets.push({ name, path, contentType, sha256: hashes.sha256 })
  }
  for (const [name, contents] of feedNames) {
    const path = join(directory, name)
    assets.push({ name, path, contentType: 'text/yaml', sha256: await verifyUpdateFeed(path, name, version, contents) })
  }
  return assets
}
