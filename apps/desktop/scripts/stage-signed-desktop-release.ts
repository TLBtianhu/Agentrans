/** Stage a signed Desktop candidate for read-only release review. */

import { createHash } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import extractZip from 'extract-zip'
import { dump } from 'js-yaml'
import { parse } from 'semver'
import { z } from 'zod'
import { desktopBuildRecordFilename } from './desktop-auto-update-environment.mjs'
import { AGENTRANS_DESKTOP_APP_ID, DESKTOP_UPDATE_REPOSITORY } from './desktop-release-environment.mjs'
import { mergeMacReleaseMetadata } from './merge-mac-metadata.mjs'
import { collectReleaseAssets, signedDesktopAssetNames } from './release-artifacts.ts'
import { verifySignedDesktopArtifact } from './verify-signed-desktop-artifact.mjs'

const targetSpec = {
  'win-x64': { workflow: 'windows-package.yml', artifactPrefix: 'windows-x64' },
  'mac-arm64': { workflow: 'macos-package.yml', artifactPrefix: 'macos-arm64' },
  'mac-x64': { workflow: 'macos-intel-package.yml', artifactPrefix: 'macos-x64' },
} as const

const targets = ['win-x64', 'mac-arm64', 'mac-x64'] as const
type SignedTarget = typeof targets[number]
const productRepository = `${DESKTOP_UPDATE_REPOSITORY.owner}/${DESKTOP_UPDATE_REPOSITORY.repo}`
const buildManifestName = 'desktop-signed-build.json'
const receiptName = 'desktop-native-verification.json'
const sha = z.string().regex(/^[a-f0-9]{40}$/u)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const archiveDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const id = z.int().positive()
const targetName = z.enum(targets)
const channelName = z.enum(['nightly', 'latest'])

interface IntakeRequest {
  readonly sourceSha: string
  readonly workflowSha: string
  readonly version: string
  readonly channel: z.infer<typeof channelName>
}

const artifactProvenance = z.object({ runId: id, runAttempt: id, artifactId: id, archiveDigest })
type ArtifactProvenance = z.infer<typeof artifactProvenance>
const repository = z.object({
  full_name: z.string().refine(name => name.toLowerCase() === productRepository.toLowerCase()),
})
const workflowSchema = z.object({ id, path: z.string() })
const runSchema = z.object({
  id, workflow_id: id, run_attempt: id,
  event: z.literal('workflow_dispatch'), status: z.literal('completed'), conclusion: z.literal('success'),
  head_sha: sha, repository, head_repository: repository,
})
const artifactListSchema = z.object({
  total_count: z.literal(1),
  artifacts: z.tuple([z.object({
    id, name: z.string(), size_in_bytes: id, expired: z.literal(false),
    digest: archiveDigest, workflow_run: z.object({ id }),
  })]),
})
const assetSeal = z.object({ bytes: id, sha256 })
const signedBuildSchema = z.object({
  schemaVersion: z.literal(1), target: targetName, commit: sha, version: z.string(), channel: channelName,
  appId: z.literal(AGENTRANS_DESKTOP_APP_ID), preset: z.literal('production'),
  sourceRef: z.string().regex(/^(?:main|master|dsh-v[^\s]+)$/u),
  runId: id, runAttempt: id, workflowSha: sha, assets: z.record(z.string(), assetSeal),
})
const releaseRecordSchema = z.object({
  schemaVersion: z.literal(1), target: targetName, version: z.string(), channel: channelName, commit: sha,
  dirty: z.literal(false), provider: z.literal('github'), owner: z.literal(DESKTOP_UPDATE_REPOSITORY.owner),
  repo: z.literal(DESKTOP_UPDATE_REPOSITORY.repo),
})
const nativeReceipt = artifactProvenance.extend({
  schemaVersion: z.literal(1), target: targetName, manifestSha256: sha256,
})
type NativePaths = { installer: string } | { dmg: string; zip: string }
type NativeVerifier = (target: SignedTarget, paths: NativePaths, request: IntakeRequest) => Promise<void>

function signedArtifactName(target: SignedTarget, runId: number, attempt: number, version: string): string {
  return `${targetSpec[target].artifactPrefix}-signed-${version}-${runId}-${attempt}`
}

/**
 * Require a successful attempt of the expected repository workflow at its pinned revision.
 * @param target - Requested native packaging target.
 * @param runId - Explicit Actions run ID.
 * @param workflowSha - Trusted packaging workflow commit.
 * @param workflowResponse - Authenticated workflow definition response.
 * @param runResponse - Authenticated run response.
 * @returns The latest completed attempt number.
 */
export function selectSignedPackageRun(
  target: SignedTarget, runId: number, workflowSha: string, workflowResponse: unknown, runResponse: unknown,
): number {
  const workflow = workflowSchema.safeParse(workflowResponse)
  const run = runSchema.safeParse(runResponse)
  if (!workflow.success || workflow.data.path !== `.github/workflows/${targetSpec[target].workflow}`
    || !run.success || run.data.id !== runId || run.data.workflow_id !== workflow.data.id || run.data.head_sha !== workflowSha) {
    throw new Error(`signed desktop intake: run ${runId} is not a successful ${target} packaging run at the trusted workflow commit`)
  }
  return run.data.run_attempt
}

/**
 * Choose the exact signed archive from the latest successful packaging attempt.
 * @param listResponse - Authenticated run artifact list filtered by exact name.
 * @param target - Requested native packaging target.
 * @param runId - Explicit Actions run ID.
 * @param attempt - Latest successful run attempt.
 * @param version - Requested packaged version.
 * @returns The artifact ID, GitHub archive digest, and compressed size.
 */
export function selectSignedPackageArtifact(listResponse: unknown, target: SignedTarget, runId: number, attempt: number, version: string) {
  const expectedName = signedArtifactName(target, runId, attempt, version)
  const list = artifactListSchema.safeParse(listResponse)
  const artifact = list.success ? list.data.artifacts[0] : undefined
  if (artifact === undefined || artifact.name !== expectedName || artifact.workflow_run.id !== runId) {
    throw new Error(`signed desktop intake: expected one live GitHub artifact with a digest named ${expectedName}`)
  }
  return artifact
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

function assertNames(actual: readonly string[], expected: readonly string[]): void {
  if (actual.length !== expected.length || expected.some(name => !actual.includes(name))) {
    throw new Error(`signed desktop intake: expected exactly ${expected.join(', ')}; found ${actual.join(', ')}`)
  }
}

async function verifyTargetFiles(
  directory: string, target: SignedTarget, request: IntakeRequest, artifact: ArtifactProvenance, withReceipt: boolean,
) {
  const signedNames = signedDesktopAssetNames(target, request.version)
  const recordName = desktopBuildRecordFilename(target)
  const sealedNames = [...signedNames, recordName]
  const entries = await readdir(directory, { withFileTypes: true })
  const expectedNames = [...sealedNames, buildManifestName]
  if (withReceipt) expectedNames.push(receiptName)
  assertNames(entries.map(entry => entry.name), expectedNames)
  if (entries.some(entry => !entry.isFile())) throw new Error(`signed desktop intake: ${target} requires regular files`)

  const manifestBytes = await readFile(join(directory, buildManifestName))
  const signedBuild = signedBuildSchema.parse(JSON.parse(manifestBytes.toString('utf8')))
  const releaseRecord = releaseRecordSchema.parse(await readJson(join(directory, recordName)))
  for (const record of [signedBuild, releaseRecord]) {
    if (record.target !== target || record.commit !== request.sourceSha
      || record.version !== request.version || record.channel !== request.channel) {
      throw new Error(`signed desktop intake: ${target} build record disagrees with the requested target, source commit, version, or channel`)
    }
  }
  if (signedBuild.runId !== artifact.runId || signedBuild.runAttempt !== artifact.runAttempt
    || signedBuild.workflowSha !== request.workflowSha) {
    throw new Error(`signed desktop intake: ${target} build record disagrees with the selected workflow run or attempt`)
  }
  assertNames(Object.keys(signedBuild.assets), sealedNames)
  const assets = await collectReleaseAssets(directory, request.version, request.channel, target)
  const recordPath = join(directory, recordName)
  const checks = [...assets, { name: recordName, path: recordPath, sha256: await hashFile(recordPath) }]
  for (const file of checks) {
    const expected = signedBuild.assets[file.name]
    if (file.sha256 !== expected?.sha256 || (await lstat(file.path)).size !== expected.bytes) {
      throw new Error(`signed desktop intake: size or SHA-256 mismatch for ${file.name}`)
    }
  }
  return { assets, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex') }
}

function nativeAssetPaths(assets: Awaited<ReturnType<typeof collectReleaseAssets>>, target: SignedTarget): NativePaths {
  const exactFile = (suffix: string) => {
    const asset = assets.find(({ name }) => name.endsWith(suffix))
    if (asset === undefined) throw new Error(`signed desktop intake: ${target} is missing ${suffix}`)
    return asset.path
  }
  return target === 'win-x64' ? { installer: exactFile('.exe') } : { dmg: exactFile('.dmg'), zip: exactFile('.zip') }
}

/**
 * Check a flat signed artifact and record native verification of its payload.
 * @param directory - Fresh, privately extracted Actions artifact directory.
 * @param target - Expected architecture and platform.
 * @param request - Independently pinned source, workflow, version, and channel.
 * @param artifact - Provenance of the authenticated and verified archive.
 * @param verifyNative - Native verifier for the indicated installer formats.
 * @returns When the immutable receipt has been written.
 */
export async function verifySignedTarget(
  directory: string, target: SignedTarget, request: IntakeRequest, artifact: ArtifactProvenance, verifyNative: NativeVerifier,
): Promise<void> {
  const provenance = artifactProvenance.parse(artifact)
  const { assets, manifestSha256 } = await verifyTargetFiles(directory, target, request, provenance, false)
  await verifyNative(target, nativeAssetPaths(assets, target), request)
  const receipt = { schemaVersion: 1, target, ...provenance, manifestSha256 }
  await writeFile(join(directory, receiptName), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
}

/**
 * Assemble all three targets from the native verification jobs and check the merged update feeds.
 * @param directories - Trusted job outputs in Windows x64, macOS arm64, and macOS x64 order.
 * @param output - New output directory for the reviewed assets and report.
 * @param request - Independently pinned source, workflow, version, and channel.
 * @returns When the merged feeds and final asset bytes have been verified.
 */
export async function assembleSignedRelease(
  directories: readonly [string, string, string], output: string, request: IntakeRequest,
): Promise<void> {
  const inputs = await Promise.all(targets.map(async (target, index) => {
    const directory = directories[index]
    if (directory === undefined) throw new Error(`signed desktop intake: missing ${target} verified directory`)
    const receipt = nativeReceipt.parse(await readJson(join(directory, receiptName)))
    if (receipt.target !== target) throw new Error(`signed desktop intake: missing ${target} verification receipt`)
    const { assets, manifestSha256 } = await verifyTargetFiles(directory, target, request, receipt, true)
    if (manifestSha256 !== receipt.manifestSha256) throw new Error(`signed desktop intake: ${target} manifest changed after native verification`)
    return { receipt, assets }
  }))
  const distinctIds = new Set(inputs.map(({ receipt }) => receipt.artifactId))
  if (distinctIds.size !== targets.length) throw new Error('signed desktop intake: all three targets require distinct build artifacts')

  await mkdir(output)
  const expected = new Map<string, string>()
  for (const { assets } of inputs) {
    for (const { name, path, sha256: digest } of assets) {
      if (name.endsWith('-mac.yml')) continue
      await copyFile(path, join(output, name), constants.COPYFILE_EXCL)
      expected.set(name, digest)
    }
  }
  const metadata = mergeMacReleaseMetadata(directories.slice(1))
  await writeFile(join(output, metadata.name), dump(metadata.document, { lineWidth: -1 }), { flag: 'wx' })
  const finalAssets = await collectReleaseAssets(output, request.version, request.channel, 'all')
  for (const { name, sha256: digest } of finalAssets) {
    if (name !== metadata.name && expected.get(name) !== digest) throw new Error(`signed desktop intake: asset ${name} changed during assembly`)
  }
  await writeFile(join(output, 'signed-desktop-intake.json'), `${JSON.stringify({
    schemaVersion: 1,
    ...request,
    nativeVerification: inputs.map(({ receipt }) => receipt),
    assets: finalAssets.map(({ name, sha256: digest }) => ({ name, sha256: digest })),
  }, null, 2)}\n`, { flag: 'wx' })
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function github(endpoint: string, token: string): Promise<Response> {
  return fetch(`https://api.github.com/repos/${productRepository}/${endpoint}`, {
    headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'manual',
  })
}

async function githubRecord(endpoint: string, token: string): Promise<unknown> {
  const response = await github(endpoint, token)
  if (!response.ok) throw new Error(`signed desktop intake: GitHub GET ${endpoint} returned HTTP ${response.status}`)
  return response.json()
}

async function downloadArtifact(artifact: ReturnType<typeof selectSignedPackageArtifact>, token: string, path: string): Promise<void> {
  const redirect = await github(`actions/artifacts/${artifact.id}/zip`, token)
  const location = redirect.headers.get('location')
  if (redirect.status !== 302 || location === null || new URL(location).protocol !== 'https:') {
    throw new Error(`signed desktop intake: could not open GitHub artifact ${artifact.id} (HTTP ${redirect.status})`)
  }
  // The signed download URL carries its own authorization. Do not send the Actions token to storage.
  const response = await fetch(location, { redirect: 'error' }).catch(() => {
    throw new Error(`signed desktop intake: could not fetch storage for artifact ${artifact.id}`)
  })
  if (!response.ok || response.body === null) throw new Error(`signed desktop intake: artifact ${artifact.id} download returned HTTP ${response.status}`)
  await pipeline(response.body, createWriteStream(path, { flags: 'wx' }))
  if ((await lstat(path)).size !== artifact.size_in_bytes || `sha256:${await hashFile(path)}` !== artifact.digest) {
    throw new Error(`signed desktop intake: GitHub archive size or SHA-256 mismatch for artifact ${artifact.id}`)
  }
}

async function checkTarget(target: SignedTarget, runId: number, request: IntakeRequest, output: string): Promise<void> {
  const token = process.env.GH_TOKEN
  if (!token) throw new Error('signed desktop intake: GH_TOKEN with Actions read access is required')
  const [workflow, run] = await Promise.all([
    githubRecord(`actions/workflows/${targetSpec[target].workflow}`, token),
    githubRecord(`actions/runs/${runId}`, token),
  ])
  const attempt = selectSignedPackageRun(target, runId, request.workflowSha, workflow, run)
  const name = signedArtifactName(target, runId, attempt, request.version)
  const list = await githubRecord(`actions/runs/${runId}/artifacts?name=${encodeURIComponent(name)}`, token)
  const artifact = selectSignedPackageArtifact(list, target, runId, attempt, request.version)
  const tmp = await mkdtemp(join(tmpdir(), 'agentrans-signed-archive-'))
  try {
    const archive = join(tmp, 'artifact.zip')
    await downloadArtifact(artifact, token, archive)
    const allowed = new Set([...signedDesktopAssetNames(target, request.version), desktopBuildRecordFilename(target), buildManifestName])
    await mkdir(output)
    await extractZip(archive, {
      dir: resolve(output),
      onEntry(entry) {
        const kind = (entry.externalFileAttributes >>> 16) & 0o170000
        if (!allowed.delete(entry.fileName) || (kind !== 0 && kind !== 0o100000)) {
          throw new Error(`signed desktop intake: unexpected or duplicate GitHub archive entry ${entry.fileName}`)
        }
      },
    })
    const identity = {
      windowsThumbprint: process.env.DESKTOP_WINDOWS_CERT_THUMBPRINT ?? '',
      macTeamId: process.env.DESKTOP_MACOS_TEAM_ID ?? '',
      macSigningIdentity: process.env.DESKTOP_MACOS_SIGNING_IDENTITY ?? '',
    }
    await verifySignedTarget(output, target, request, {
      runId, runAttempt: attempt, artifactId: artifact.id, archiveDigest: artifact.digest,
    }, (nativeTarget, paths, input) => verifySignedDesktopArtifact(nativeTarget, paths, input, identity))
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

function intakeRequest(sourceSha: string | undefined, version: string | undefined, channel: string | undefined): IntakeRequest {
  const parsed = version === undefined ? null : parse(version)
  const requestedChannel = channelName.parse(channel)
  if (parsed === null || parsed.version !== version || parsed.build.length > 0
    || (requestedChannel === 'latest' && parsed.prerelease.length > 0)) {
    throw new Error('signed desktop intake: use a canonical version and select nightly for prereleases')
  }
  return {
    sourceSha: sha.parse(sourceSha), workflowSha: sha.parse(process.env.DESKTOP_SIGNED_WORKFLOW_SHA),
    version: parsed.version, channel: requestedChannel,
  }
}

async function main(args: string[]): Promise<void> {
  const [command, ...params] = args
  if (command === 'check-target' && params.length === 6) {
    const [target, run, source, version, channel, output] = params
    if (run === undefined || !/^[1-9][0-9]*$/u.test(run) || !output) throw new Error('signed desktop intake: supply a numeric run ID and output directory')
    await checkTarget(targetName.parse(target), id.parse(Number(run)), intakeRequest(source, version, channel), output)
    return
  }
  if (command === 'assemble' && params.length === 7) {
    const [source, version, channel, output, win, arm, intel] = params
    if (!output || !win || !arm || !intel) throw new Error('signed desktop intake: supply an output directory and three verified target directories')
    await assembleSignedRelease([win, arm, intel], output, intakeRequest(source, version, channel))
    return
  }
  throw new Error('signed desktop intake: expected check-target <target> <run> <source> <version> <channel> <output> or assemble <source> <version> <channel> <output> <win> <arm> <intel>')
}

if (import.meta.main) await main(process.argv.slice(2))
