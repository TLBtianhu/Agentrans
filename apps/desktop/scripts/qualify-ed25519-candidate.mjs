/** Preflight the three pinned candidate archives; stage only the verified inventory. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { publicKeyFromBase64, signatureAssetName, verifyFileDigest } from '../src/update-signature.ts'
import { UPDATE_SIGNING_PUBLIC_KEY } from '../src/update-signing-key.ts'
import { DESKTOP_UPDATE_REPOSITORY } from './desktop-release-environment.mjs'
import { assembleMacRelease } from './merge-mac-metadata.mjs'
import { publishGitHubRelease, signReleaseAssets } from './publish-github-release.ts'
import { collectReleaseAssets } from './release-artifacts.ts'
import { stageHostedPackageAssets } from './stage-hosted-desktop-release.ts'
import { verifyCandidateTrust } from './verify-candidate-trust.mjs'

const version = '0.1.0-test.20261119.1'
const channel = 'nightly'
const sourceSha = 'bee9aaee0db28bf05061b3f7461842b6d85b1fb0'
const targets = ['win-x64', 'mac-arm64', 'mac-x64']
const artifactCount = 10
const publicKey = publicKeyFromBase64(UPDATE_SIGNING_PUBLIC_KEY)
const publicKeySha256 = createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex')

async function assertExactFiles(directory, names) {
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.some(entry => !entry.isFile())) throw new Error('Desktop candidate requires regular files in ' + directory)
  assert.deepEqual(entries.map(entry => entry.name).sort(), [...names].sort(), 'Unexpected Desktop candidate inventory in ' + directory)
}

async function readSignedInventory(staged) {
  const originals = await collectReleaseAssets(staged, version, channel, 'all')
  assert.equal(originals.length, artifactCount, 'Incomplete Desktop asset set')
  const signatureNames = originals.map(({ name }) => signatureAssetName(name))
  await assertExactFiles(staged, [...originals.map(({ name }) => name), ...signatureNames])

  const signatures = []
  for (const asset of originals) {
    const name = signatureAssetName(asset.name)
    const path = join(staged, name)
    const bytes = await readFile(path)
    const signature = bytes.toString('ascii')
    if (bytes.length !== 88 || !/^[A-Za-z0-9+/]{86}==$/u.test(signature)
      || !await verifyFileDigest(asset.path, signature, publicKey)) {
      throw new Error('Desktop candidate signature failed for ' + asset.name)
    }
    signatures.push({
      name, path, contentType: 'text/plain', sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  const assets = [...originals, ...signatures]
  const receipts = await Promise.all(assets.map(async ({ name, path, sha256 }) => ({
    name, size: (await lstat(path)).size, sha256,
  })))
  return { assets, receipts }
}

async function stageCandidate(input) {
  await Promise.all(targets.map(async target => {
    const directory = join(input, target)
    const assets = await collectReleaseAssets(directory, version, channel, target)
    await assertExactFiles(directory, assets.map(({ name }) => name))
  }))
  const macMerged = join(input, 'mac-merged')
  assembleMacRelease(targets.slice(1).map(target => join(input, target)), macMerged)
  const staged = join(input, 'staged')
  await stageHostedPackageAssets([join(input, targets[0]), macMerged], staged)
  return { staged, originals: await collectReleaseAssets(staged, version, channel, 'all') }
}

async function preflight(input, proof) {
  const key = process.env.AGENTRANS_UPDATE_SIGNING_KEY
  if (!key) throw new Error('Desktop candidate preflight requires the existing AGENTRANS_UPDATE_SIGNING_KEY secret')
  const trust = await verifyCandidateTrust(input)
  const { staged, originals } = await stageCandidate(input)
  const signed = await signReleaseAssets(originals, key, UPDATE_SIGNING_PUBLIC_KEY)
  const { receipts } = await readSignedInventory(staged)
  await mkdir(proof)
  const signatures = join(proof, 'signatures')
  await mkdir(signatures)
  await Promise.all(signed.filter(asset => asset.name.endsWith('.sig')).map(asset =>
    copyFile(asset.path, join(signatures, asset.name), constants.COPYFILE_EXCL)))
  await writeFile(join(proof, 'preflight.json'), JSON.stringify({
    version, channel, sourceSha, publicKeySha256, signatureCount: artifactCount, trust, assets: receipts,
  }, null, 2) + '\n', { flag: 'wx' })
  console.log('Verified 10 detached Ed25519 signatures for the three Desktop candidates and their update feeds')
}

async function stageDraft(input, proof) {
  const token = process.env.GH_TOKEN
  if (!token) throw new Error('Desktop draft staging requires GH_TOKEN')
  const expected = JSON.parse(await readFile(join(proof, 'preflight.json'), 'utf8'))
  assert.equal(expected.version, version)
  assert.equal(expected.channel, channel)
  assert.equal(expected.sourceSha, sourceSha)
  assert.equal(expected.publicKeySha256, publicKeySha256)
  assert.equal(expected.signatureCount, artifactCount)
  const { staged, originals } = await stageCandidate(input)
  const signatures = join(proof, 'signatures')
  const signatureNames = originals.map(({ name }) => signatureAssetName(name))
  await assertExactFiles(signatures, signatureNames)
  await Promise.all(signatureNames.map(name =>
    copyFile(join(signatures, name), join(staged, name), constants.COPYFILE_EXCL)))
  const inventory = await readSignedInventory(staged)
  assert.deepEqual(inventory.receipts, expected.assets, 'Verified candidate assets changed after preflight')
  const draft = await publishGitHubRelease({
    token,
    owner: DESKTOP_UPDATE_REPOSITORY.owner,
    repo: DESKTOP_UPDATE_REPOSITORY.repo,
    version,
    channel,
    targetCommitish: sourceSha,
    draftOnly: true,
    assets: inventory.assets,
  })
  assert.equal(draft.draft, true)
  console.log('Verified draft ' + draft.tag + ' with ' + (draft.uploaded.length + draft.skipped.length) + ' assets')
}

const [command, input, proof, ...rest] = process.argv.slice(2)
if (!input || !proof || !isAbsolute(input) || !isAbsolute(proof) || rest.length !== 0) {
  throw new Error('Usage: qualify-ed25519-candidate <preflight|stage-draft> <absolute-input-dir> <absolute-proof-dir>')
}
if (command === 'preflight') await preflight(input, proof)
else if (command === 'stage-draft') await stageDraft(input, proof)
else throw new Error('Unknown Desktop candidate command')
