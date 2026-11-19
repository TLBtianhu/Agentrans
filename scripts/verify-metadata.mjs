import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

const [directory, version, reportPath, ...extra] = process.argv.slice(2)
assert.ok(directory && version && reportPath && extra.length === 0,
  'Usage: node verify-metadata.mjs <absolute-artifact-directory> <version> <absolute-report-path>')
assert.ok(isAbsolute(directory) && isAbsolute(reportPath), 'Artifact directory and report path must be absolute')
assert.ok((await lstat(directory)).isDirectory(), 'Artifact directory must be a regular directory')

const requireDesktop = createRequire(resolve('apps/desktop/package.json'))
const { parse } = requireDesktop('semver')
const { version: updaterVersion } = requireDesktop('electron-updater/package.json')
const { GitHubProvider } = requireDesktop('electron-updater/out/providers/GitHubProvider.js')
const { MacUpdater } = requireDesktop('electron-updater/out/MacUpdater.js')
const { findFile, parseUpdateInfo } = requireDesktop('electron-updater/out/providers/Provider.js')
const requireBuilder = createRequire(requireDesktop.resolve('app-builder-lib/package.json'))
const { blake2b } = requireBuilder('@noble/hashes/blake2b.js')

const parsedVersion = parse(version)
assert.equal(parsedVersion?.version, version, 'Expected a canonical SemVer version')
assert.equal(parsedVersion?.prerelease[0], 'test', 'Expected the nightly test channel version')
const provider = new GitHubProvider({ owner: 'TLBtianhu', repo: 'Agentrans' }, {}, { platform: 'darwin' })
const metadataName = provider.getCustomChannelName(parsedVersion.prerelease[0]) + '.yml'
assert.equal(metadataName, 'test-mac.yml')
const tag = 'v' + version
const downloadBase = 'https://github.com/TLBtianhu/Agentrans/releases/download/' + tag + '/'
const architectures = ['arm64', 'x64']
const assetNames = new Map(architectures.map(arch => {
  const prefix = 'agentrans-' + version + '-mac-' + arch + '-unsigned'
  return [arch, { dmg: prefix + '.dmg', zip: prefix + '.zip', blockmap: prefix + '.zip.blockmap' }]
}))
const expectedNames = [metadataName, ...[...assetNames.values()].flatMap(names => Object.values(names))]
const entries = await readdir(directory, { withFileTypes: true })
assert.ok(entries.every(entry => entry.isFile()), 'Expected only regular files at the artifact root')
assert.deepEqual(entries.map(entry => entry.name).sort(), expectedNames.sort(), 'Unexpected macOS artifact inventory')

async function digestAsset(name) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(join(directory, name))) {
    bytes += chunk.length
    hash.update(chunk)
  }
  assert.ok(bytes > 0, 'Empty artifact ' + name)
  return { name, bytes, sha256: hash.digest('hex') }
}

async function verifyBlockmapAndZip(names, metadataEntry) {
  const blockmap = await readFile(join(directory, names.blockmap))
  const decoded = JSON.parse(gunzipSync(blockmap, { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8'))
  assert.equal(decoded.version, '2', 'Unexpected electron-builder blockmap version')
  assert.ok(Array.isArray(decoded.files) && decoded.files.length === 1, 'Expected one ZIP extent in ' + names.blockmap)
  const [{ name, offset, sizes, checksums }] = decoded.files
  assert.equal(name, 'file', 'Expected electron-builder single-file blockmap entry')
  assert.equal(offset, 0, 'ZIP blockmap must start at offset zero')
  assert.ok(Array.isArray(sizes) && sizes.length > 0 &&
    sizes.every(size => Number.isSafeInteger(size) && size > 0), 'Invalid block sizes in ' + names.blockmap)
  assert.ok(Array.isArray(checksums) && checksums.length === sizes.length &&
    checksums.every(sum => typeof sum === 'string' && /^[A-Za-z0-9+/]{24}$/.test(sum)), 'Invalid block checksums in ' + names.blockmap)
  const zipLength = (await lstat(join(directory, names.zip))).size
  assert.equal(sizes.reduce((sum, size) => sum + size, 0), zipLength, 'Blockmap does not cover the full ZIP')
  assert.equal(metadataEntry.size, zipLength, 'ZIP byte length disagrees with the feed')

  const sha512 = createHash('sha512')
  const sha256 = createHash('sha256')
  let blockIndex = 0
  let blockBytes = 0
  let blockHash = blake2b.create({ dkLen: 18 })
  for await (const chunk of createReadStream(join(directory, names.zip))) {
    sha512.update(chunk)
    sha256.update(chunk)
    let start = 0
    while (start < chunk.length) {
      assert.ok(blockIndex < sizes.length, 'Trailing ZIP bytes beyond the blockmap')
      const end = Math.min(chunk.length, start + sizes[blockIndex] - blockBytes)
      blockHash.update(chunk.subarray(start, end))
      blockBytes += end - start
      start = end
      if (blockBytes === sizes[blockIndex]) {
        assert.equal(Buffer.from(blockHash.digest()).toString('base64'), checksums[blockIndex],
          names.blockmap + ' has the wrong ZIP checksum for block ' + blockIndex)
        blockIndex++
        blockBytes = 0
        if (blockIndex < sizes.length) blockHash = blake2b.create({ dkLen: 18 })
      }
    }
  }
  assert.equal(blockIndex, sizes.length, 'ZIP ended before all blockmap blocks were verified')
  const zipSha512 = sha512.digest('base64')
  assert.equal(zipSha512, metadataEntry.sha512, 'ZIP SHA-512 disagrees with the feed')
  return {
    zip: { name: names.zip, bytes: zipLength, sha256: sha256.digest('hex'), sha512: zipSha512 },
    blockmap: {
      name: names.blockmap,
      bytes: blockmap.length,
      sha256: createHash('sha256').update(blockmap).digest('hex'),
      version: decoded.version,
      verifiedBlocks: blockIndex,
      coveredZipBytes: zipLength,
    },
  }
}

const metadataUrl = new URL(metadataName, downloadBase)
const updateInfo = parseUpdateInfo(await readFile(join(directory, metadataName), 'utf8'), metadataName, metadataUrl)
assert.ok(updateInfo && typeof updateInfo === 'object' && !Array.isArray(updateInfo), 'Expected an updater metadata document')
assert.equal(updateInfo.version, version, 'Feed version disagrees with the build version')
assert.ok(Array.isArray(updateInfo.files), 'Update feed files are missing')
const files = new Map()
for (const entry of updateInfo.files) {
  assert.ok(entry && typeof entry.url === 'string' && !files.has(entry.url), 'Missing or duplicate metadata file name')
  assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0 && typeof entry.sha512 === 'string' &&
    /^[A-Za-z0-9+/]{86}==$/.test(entry.sha512), 'Missing ZIP size or SHA-512 in the feed')
  files.set(entry.url, entry)
}
assert.deepEqual([...files.keys()].sort(), [...assetNames.values()].map(names => names.zip).sort(),
  'Expected exactly one update ZIP for each architecture')
assert.ok(files.has(updateInfo.path), 'Legacy path does not point at a published ZIP entry')
assert.equal(updateInfo.sha512, files.get(updateInfo.path).sha512, 'Legacy SHA-512 disagrees with its ZIP entry')
assert.ok(typeof updateInfo.releaseDate === 'string' && Number.isFinite(Date.parse(updateInfo.releaseDate)),
  'Feed releaseDate is missing or invalid')

const resolved = provider.resolveFiles({ ...updateInfo, tag })
const architectureReports = {}
for (const arch of architectures) {
  const names = assetNames.get(arch)
  const arm64 = arch === 'arm64'
  const route = findFile(MacUpdater.filterFilesForArch(resolved, arm64), 'zip', ['pkg', 'dmg'])
  assert.equal(route?.url.href, new URL(names.zip, downloadBase).href,
    'electron-updater resolved the wrong ZIP for ' + arch)
  const [, blockmapUrl] = provider.getBlockMapFiles(route.url, version, version)
  assert.equal(blockmapUrl.href, new URL(names.blockmap, downloadBase).href,
    'electron-updater resolved the wrong blockmap for ' + arch)
  const dm = await digestAsset(names.dmg)
  architectureReports[arch] = {
    dmg: dm,
    ...(await verifyBlockmapAndZip(names, files.get(names.zip))),
    updaterZipUrl: route.url.href,
    updaterBlockmapUrl: blockmapUrl.href,
  }
  console.log('Verified macOS update metadata and ZIP blockmap for ' + arch)
}
const result = {
  passed: true,
  version,
  channel: 'nightly',
  updaterVersion,
  metadata: await digestAsset(metadataName),
  releaseDate: updateInfo.releaseDate,
  legacyPath: updateInfo.path,
  architectures: architectureReports,
}
await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
