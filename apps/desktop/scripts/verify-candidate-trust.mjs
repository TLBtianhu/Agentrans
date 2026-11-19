/** Read the installed-app trust settings directly from the retained candidate archives. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, createPublicKey } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { load } from 'js-yaml'
import { publicKeyFromBase64, sha256File } from '../src/update-signature.ts'
import { UPDATE_SIGNING_PUBLIC_KEY } from '../src/update-signing-key.ts'

const run = promisify(execFile)
const require = createRequire(import.meta.url)
// Reuse the ASAR reader already locked by the Desktop packager.
const { extractFile } = createRequire(require.resolve('app-builder-lib'))('@electron/asar')
const targets = ['win-x64', 'mac-arm64', 'mac-x64']
const version = '0.1.0-test.20261119.1'
const commit = 'bee9aaee0db28bf05061b3f7461842b6d85b1fb0'
const channel = 'nightly'
const pemPath = 'distribution/keys/agentrans-update-ed25519-public.pem'
// Prior native QA read both the mounted DMG and the extracted ZIP.
const macAsarFromBothContainers = {
  'mac-arm64': '539ca7e361ea0aaf5dd790ef8b3f11996d80a65af7a70bbb8e206580dd802cf2',
  'mac-x64': 'b39719e1285b327deb4aa5f51d33e9e2fe0b1c2dfe665bcadde22a39028571c6',
}

async function extract(sevenZip, archive, output, members, flatten = false) {
  await run(sevenZip, [
    flatten ? 'e' : 'x', '-y', '-bb0', '-bso0', '-bsp0', '-spd',
    ...(flatten ? ['-r'] : []),
    '-o' + output, archive, ...members,
  ], { timeout: 180_000, maxBuffer: 1024 * 1024, windowsHide: true })
}

async function appResources(input, scratch, target, sevenZip) {
  const artifact = join(input, target, 'agentrans-' + version + '-' + target + '-unsigned')
  const names = ['app.asar', 'app-update.yml', pemPath]
  if (target === 'win-x64') {
    await extract(sevenZip, artifact + '.exe', scratch, ['app-64.7z'], true)
    const payload = join(scratch, 'app-64.7z')
    assert.ok((await stat(payload)).isFile(), 'The NSIS installer must contain its x64 payload')
    await extract(sevenZip, payload, scratch, names.map(name => 'resources/' + name))
    return join(scratch, 'resources')
  }
  const prefix = 'Agentrans.app/Contents/Resources'
  await extract(sevenZip, artifact + '.zip', scratch, names.map(name => prefix + '/' + name))
  return join(scratch, ...prefix.split('/'))
}

/**
 * Verify the real .1 updater trust wiring without launching an installer or writing to the input archives.
 * @param {string} input Root containing the three directories named for their package targets.
 * @param {string} sevenZip Full 7-Zip executable with NSIS support.
 * @returns {Promise<object>} Public signing-key fingerprint and the three checked package identities.
 */
export async function verifyCandidateTrust(input, sevenZip = '7z') {
  const pinnedKey = publicKeyFromBase64(UPDATE_SIGNING_PUBLIC_KEY)
  assert.equal(pinnedKey.asymmetricKeyType, 'ed25519')
  const fingerprint = createHash('sha256').update(pinnedKey.export({ format: 'der', type: 'spki' })).digest('hex')
  const checked = []
  for (const target of targets) {
    const scratch = await mkdtemp(join(tmpdir(), 'agentrans-candidate-trust-'))
    try {
      const resources = await appResources(resolve(input), scratch, target, sevenZip)
      const asar = join(resources, 'app.asar')
      const manifest = JSON.parse(extractFile(asar, 'package.json').toString('utf8'))
      assert.equal(manifest.name, 'agentrans', target + ' embedded package name')
      assert.equal(manifest.version, version, target + ' embedded package version')
      if (manifest.dshBuildCommit !== undefined || manifest.dshBuildDirty !== undefined) {
        assert.equal(manifest.dshBuildCommit, commit, target + ' embedded code commit')
        assert.equal(manifest.dshBuildDirty, false, target + ' embedded build checkout was dirty')
      }
      assert.equal(manifest.dshDesktopUpdateChannel, channel, target + ' embedded update channel')
      assert.equal(manifest.main, 'lib/main.js', target + ' packaged main entry')
      const main = extractFile(asar, manifest.main).toString('utf8')
      assert.ok(main.includes(UPDATE_SIGNING_PUBLIC_KEY), target + ' packaged updater lacks the pinned key')
      const pem = await readFile(join(resources, pemPath), 'utf8')
      assert.ok(createPublicKey(pem).equals(pinnedKey), target + ' distributed PEM must match the packaged updater key')
      const feed = load(await readFile(join(resources, 'app-update.yml'), 'utf8'))
      assert.equal(feed.provider, 'github', target + ' update provider')
      assert.equal(feed.owner, 'TLBtianhu', target + ' update repository owner')
      assert.equal(feed.repo, 'Agentrans', target + ' update repository name')
      // Windows electron-builder emits the prerelease file prefix here. The
      // application takes its release class from the packaged manifest above.
      assert.equal(feed.channel, target === 'win-x64' ? 'test' : channel, target + ' embedded feed channel')
      const asarSha256 = await sha256File(asar)
      if (target !== 'win-x64') {
        assert.equal(asarSha256, macAsarFromBothContainers[target], target + ' ZIP ASAR must match native DMG and ZIP evidence')
      }
      checked.push({
        target, version: manifest.version, embeddedCommit: manifest.dshBuildCommit ?? null,
        channel: manifest.dshDesktopUpdateChannel, feedChannel: feed.channel, asarSha256,
      })
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
  return { publicKeySha256: fingerprint, packages: checked }
}
