/** Stage, sign and review a complete Desktop release from verified hosted archives. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { publicKeyFromBase64, signatureAssetName, verifyFileDigest } from '../src/update-signature.ts'
import { UPDATE_SIGNING_PUBLIC_KEY } from '../src/update-signing-key.ts'
import { DESKTOP_UPDATE_REPOSITORY } from './desktop-release-environment.mjs'
import { assembleMacRelease } from './merge-mac-metadata.mjs'
import {
  publishGitHubRelease, reviewGitHubRelease, signReleaseAssets,
  type GitHubReleaseAsset, type GitHubReleaseAssetReceipt,
} from './publish-github-release.ts'
import { collectReleaseAssets, type CollectedReleaseAsset } from './release-artifacts.ts'
import { stageHostedPackageAssets, type HostedDesktopReleasePlan } from './stage-hosted-desktop-release.ts'
import { verifyCandidateReleaseTrust } from './verify-candidate-release-trust.ts'

const planSchema = z.strictObject({
  version: z.string(),
  channel: z.enum(['nightly', 'latest']),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/u),
  archives: z.array(z.strictObject({
    target: z.enum(['win-x64', 'mac', 'mac-arm64', 'mac-x64']),
    runId: z.string().regex(/^[1-9][0-9]*$/u),
    artifactId: z.string().regex(/^[1-9][0-9]*$/u),
    name: z.string(),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    size: z.int().positive(),
  })),
})
const proof = z.object({ plan: z.unknown(), publicKeySha256: z.string(), assets: z.unknown() })
const proofFilename = 'preflight.json'
const signaturesDirectory = 'signatures'
const publicKeySha256 = createHash('sha256')
  .update(publicKeyFromBase64(UPDATE_SIGNING_PUBLIC_KEY).export({ format: 'der', type: 'spki' })).digest('hex')

async function assertExactFiles(directory: string, names: readonly string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.some(entry => !entry.isFile())) throw new Error(`desktop release: expected regular files in ${directory}`)
  assert.deepEqual(entries.map(entry => entry.name).sort(), [...names].sort(), `desktop release: unexpected inventory in ${directory}`)
}

/**
 * Validate source inventories, merge separate macOS feeds, and stage the complete release.
 * @param plan - Verified archive targets, version, and channel.
 * @param input - Parent of the extracted target directories.
 * @param work - Empty work directory owned by this preparation.
 * @returns The complete release directory and its verified base assets.
 */
export async function assembleDesktopRelease(
  plan: HostedDesktopReleasePlan,
  input: string,
  work: string,
): Promise<{ directory: string; assets: CollectedReleaseAsset[] }> {
  const { version, channel, archives } = plan
  const targets = archives.map(({ target }) => target).sort()
  const separateMac = targets.join(',') === 'mac-arm64,mac-x64,win-x64'
  if (!separateMac && targets.join(',') !== 'mac,win-x64') {
    throw new Error('desktop release: expected Windows x64 and both macOS architectures exactly once')
  }
  await Promise.all(targets.map(async (target) => {
    const source = join(input, target)
    if (!(await lstat(source)).isDirectory()) throw new Error(`desktop release: expected a directory at ${source}`)
    const assets = await collectReleaseAssets(source, version, channel, target)
    await assertExactFiles(source, assets.map(asset => asset.name))
  }))
  const mac = separateMac ? join(work, 'mac-merged') : join(input, 'mac')
  if (separateMac) assembleMacRelease([join(input, 'mac-arm64'), join(input, 'mac-x64')], mac)
  const directory = join(work, 'assets')
  await stageHostedPackageAssets([join(input, 'win-x64'), mac], directory)
  return { directory, assets: await collectReleaseAssets(directory, version, channel, 'all') }
}

/**
 * Verify each detached signature and measure the complete signed asset inventory.
 * @param directory - Directory holding the assembled installers, metadata and signatures.
 * @param version - Canonical build version.
 * @param channel - Publication channel.
 * @param publicKeyBase64 - DER SPKI Ed25519 key, defaulting to the installed application's pin.
 * @returns Signed assets and matching size/digest receipts.
 */
export async function verifySignedDesktopRelease(
  directory: string, version: string, channel: HostedDesktopReleasePlan['channel'], publicKeyBase64 = UPDATE_SIGNING_PUBLIC_KEY,
): Promise<{ assets: GitHubReleaseAsset[]; receipts: GitHubReleaseAssetReceipt[] }> {
  const originals = await collectReleaseAssets(directory, version, channel, 'all')
  const signatureNames = originals.map(asset => signatureAssetName(asset.name))
  await assertExactFiles(directory, [...originals.map(asset => asset.name), ...signatureNames])
  const key = publicKeyFromBase64(publicKeyBase64)
  const signatures = []
  for (const asset of originals) {
    const name = signatureAssetName(asset.name)
    const path = join(directory, name)
    const signature = await readFile(path, 'utf8')
    if (!/^[A-Za-z0-9+/]{86}==$/u.test(signature) || !await verifyFileDigest(asset.path, signature, key)) {
      throw new Error(`desktop release: invalid Ed25519 signature for ${asset.name}`)
    }
    signatures.push({
      name, path, contentType: 'text/plain', sha256: createHash('sha256').update(signature).digest('hex'),
    })
  }
  const assets = [...originals, ...signatures]
  const receipts = await Promise.all(assets.map(async ({ name, path, sha256 }) => ({
    name, size: (await lstat(path)).size, sha256,
  })))
  return { assets, receipts }
}

async function writePreflight(
  plan: HostedDesktopReleasePlan, input: string, directory: string, assets: readonly CollectedReleaseAsset[], proofRoot: string,
): Promise<void> {
  const key = process.env.AGENTRANS_UPDATE_SIGNING_KEY
  if (!key) throw new Error('desktop release: AGENTRANS_UPDATE_SIGNING_KEY is required for preflight')
  const trust = await verifyCandidateReleaseTrust(input, plan)
  await signReleaseAssets(assets, key, UPDATE_SIGNING_PUBLIC_KEY)
  const { receipts } = await verifySignedDesktopRelease(directory, plan.version, plan.channel)
  await mkdir(proofRoot, { recursive: true })
  const signatures = join(proofRoot, signaturesDirectory)
  await mkdir(signatures)
  await Promise.all(assets.map(async (asset) => {
    const name = signatureAssetName(asset.name)
    await copyFile(join(directory, name), join(signatures, name), constants.COPYFILE_EXCL)
  }))
  await writeFile(join(proofRoot, proofFilename), JSON.stringify({
    plan, publicKeySha256, trust, assets: receipts,
  }, null, 2) + '\n', { flag: 'wx' })
  console.log(`Verified ${String(receipts.length)} signed assets for Desktop ${plan.version}`)
}

async function reviewPreflight(
  operation: 'stage-draft' | 'review',
  plan: HostedDesktopReleasePlan,
  directory: string,
  assets: readonly CollectedReleaseAsset[],
  proofRoot: string,
): Promise<void> {
  const token = process.env.GH_TOKEN
  if (!token) throw new Error(`desktop release: GH_TOKEN is required to ${operation}`)
  const expected = proof.parse(JSON.parse(await readFile(join(proofRoot, proofFilename), 'utf8')))
  assert.deepEqual(expected.plan, plan, 'desktop release: preflight plan does not match the verified archives')
  assert.equal(expected.publicKeySha256, publicKeySha256, 'desktop release: preflight signer differs from the installed key')
  const signatures = join(proofRoot, signaturesDirectory)
  const names = assets.map(asset => signatureAssetName(asset.name))
  await assertExactFiles(signatures, names)
  await Promise.all(names.map(async (name) => {
    await copyFile(join(signatures, name), join(directory, name), constants.COPYFILE_EXCL)
  }))
  const inventory = await verifySignedDesktopRelease(directory, plan.version, plan.channel)
  assert.deepEqual(inventory.receipts, expected.assets, 'desktop release: asset inventory changed after preflight')
  const request = {
    ...DESKTOP_UPDATE_REPOSITORY, token, version: plan.version, channel: plan.channel, targetCommitish: plan.sourceSha,
  }
  const requireDraft = operation === 'stage-draft'
  if (requireDraft) await publishGitHubRelease({ ...request, draftOnly: true, assets: inventory.assets })
  const result = await reviewGitHubRelease({ ...request, requireDraft, assets: inventory.receipts })
  console.log(`Reviewed ${result.draft ? 'draft' : 'published release'} ${result.tag} with ${String(result.assetCount)} verified assets`)
  console.log(result.url)
}

async function main(): Promise<void> {
  const [operation, planPath, input, proofRoot, ...extra] = process.argv.slice(2)
  if ((operation !== 'preflight' && operation !== 'stage-draft' && operation !== 'review')
    || !planPath || !input || !proofRoot || ![planPath, input, proofRoot].every(isAbsolute) || extra.length > 0) {
    throw new Error('Usage: prepare-desktop-release <preflight|stage-draft|review> <absolute-plan-file> <absolute-input-root> <absolute-proof-root>')
  }
  const plan: HostedDesktopReleasePlan = planSchema.parse(JSON.parse(await readFile(planPath, 'utf8')))
  const temporaryRoot = await realpath(tmpdir())
  const work = await mkdtemp(join(temporaryRoot, 'agentrans-release-assets-'))
  try {
    const { directory, assets } = await assembleDesktopRelease(plan, input, work)
    if (operation === 'preflight') await writePreflight(plan, input, directory, assets, proofRoot)
    else await reviewPreflight(operation, plan, directory, assets, proofRoot)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

if (import.meta.main) await main()
