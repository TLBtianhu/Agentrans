/**
 * Publish packaged Desktop artifacts as a GitHub Release.
 *
 * The packaged updater names this repository as its feed provider, so the
 * release must carry the installer, its blockmaps, and the generated channel
 * metadata under the names electron-builder wrote. A Release stays in draft
 * until GitHub holds the exact local assets and their detached signatures.
 */

import { createHash, createPublicKey, sign } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { privateKeyFromBase64, publicKeyFromBase64, sha256File, signatureAssetName } from '../src/update-signature.ts'
import { UPDATE_SIGNING_PUBLIC_KEY } from '../src/update-signing-key.ts'
import { DESKTOP_UPDATE_REPOSITORY } from './desktop-release-environment.mjs'
import { collectReleaseAssets } from './release-artifacts.ts'

/** One packaged file to attach. */
export interface GitHubReleaseAsset {
  /** Absolute path of the packaged file. */
  readonly path: string
  /** Name the release asset carries; defaults to the file's basename. */
  readonly name?: string
  /** Media type GitHub serves for this asset. */
  readonly contentType: string
  /** SHA-256 hex of the bytes observed by the signing step. */
  readonly sha256?: string
}

/** Inputs for one publish attempt. */
export interface GitHubReleaseRequest {
  /** Token with `contents: write` on the repository. */
  readonly token: string
  readonly owner: string
  readonly repo: string
  /** Product version the artifacts were built from. */
  readonly version: string
  /** Update channel; `latest` publishes a release, `nightly` a prerelease. */
  readonly channel: 'nightly' | 'latest'
  /** Build commit SHA for a hosted packaging run. */
  readonly targetCommitish?: string
  /** Keep the verified release in draft. */
  readonly draftOnly?: boolean
  readonly assets: readonly GitHubReleaseAsset[]
}

/** What one publish attempt did. */
export interface GitHubReleaseResult {
  /** Tag the release is addressable by. */
  readonly tag: string
  /** Release page URL. */
  readonly url: string
  /** Whether the verified release is still a draft. */
  readonly draft: boolean
  /** Asset names uploaded by this attempt. */
  readonly uploaded: string[]
  /** Asset names verified to contain the same bytes as the local files. */
  readonly skipped: string[]
}

/** Verified size and digest of one release asset. */
export interface GitHubReleaseAssetReceipt {
  readonly name: string
  readonly size: number
  readonly sha256: string
}

/** Inputs for a read-only review of a release's complete signed inventory. */
export interface GitHubReleaseReviewRequest extends Omit<GitHubReleaseRequest, 'assets' | 'draftOnly' | 'targetCommitish'> {
  /** Exact packaging commit. */
  readonly targetCommitish: string
  /** Complete list of signed assets, already verified by preflight. */
  readonly assets: readonly GitHubReleaseAssetReceipt[]
  /** Require the matching Release to be a draft. */
  readonly requireDraft?: boolean
}

/** Verified identity and state of the reviewed Release. */
export interface GitHubReleaseReviewResult {
  readonly id: number
  readonly tag: string
  readonly url: string
  readonly draft: boolean
  readonly assetCount: number
}

/** Tag naming one Desktop release, distinct from the npm family's `dsh-v*`. */
export function desktopGitHubReleaseTag(version: string): string {
  return `v${version}`
}

function releaseApi(token: string, owner: string, repo: string, fetchImpl: typeof globalThis.fetch) {
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const base = `https://api.github.com${repoPath}`
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'agentrans-desktop-publish',
  }
  const api: GitHubApi = (path, init) => fetchImpl(`${base}${path}`, {
    ...init, headers: { ...headers, ...init?.headers }, redirect: 'error',
  })
  const download = (id: number) => fetchImpl(`${base}/releases/assets/${String(id)}`, {
    headers: { ...headers, Accept: 'application/octet-stream' },
  })
  return { api, download, headers, repoPath }
}

/**
 * Read and verify a Release without creating drafts, uploading or publishing.
 * @param request - Exact Release identity and signed asset receipts.
 * @param fetchImpl - Fetch implementation, defaulting to the platform implementation.
 * @returns The verified Release identity and asset count.
 */
export async function reviewGitHubRelease(
  request: GitHubReleaseReviewRequest,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<GitHubReleaseReviewResult> {
  const { token, owner, repo, version, channel, targetCommitish, requireDraft } = request
  if (!/^[0-9a-f]{40}$/iu.test(targetCommitish)) throw new Error('desktop publish: the packaging commit must be a full Git SHA')
  const expected = new Map<string, GitHubReleaseAssetReceipt>()
  for (const asset of request.assets) {
    if (!/^[a-z0-9][a-z0-9._+-]*$/iu.test(asset.name) || expected.has(asset.name)
      || !Number.isSafeInteger(asset.size) || asset.size < 1 || !/^[0-9a-f]{64}$/u.test(asset.sha256)) {
      throw new Error(`desktop publish: invalid or duplicate asset receipt ${asset.name}`)
    }
    expected.set(asset.name, asset)
  }
  assertPairedAssets(expected)
  const { api, download } = releaseApi(token, owner, repo, fetchImpl)
  const tag = desktopGitHubReleaseTag(version)
  const release = await findRelease(api, tag)
  if (release === undefined) throw new Error(`desktop publish: release ${tag} does not exist`)
  if (requireDraft && !release.draft) throw new Error(`desktop publish: ${tag} is already public`)
  const target = targetCommitish.toLowerCase()
  assertReleaseTarget(release, tag, channel === 'nightly', target, await verifyTag(api, tag, target))
  const path = `/releases/${String(release.id)}`
  await verifyRemoteAssets(api, path, release, expected, true, download)
  const current = readRelease(await responseJson(await api(path), `rechecking release ${tag}`))
  if (current.id !== release.id || (requireDraft && !current.draft)) {
    throw new Error(`desktop publish: ${tag} changed during review`)
  }
  assertReleaseTarget(current, tag, channel === 'nightly', target, await verifyTag(api, tag, target))
  return { id: current.id, tag, url: current.html_url, draft: current.draft, assetCount: expected.size }
}

/**
 * Verify a draft's complete signed inventory before returning or publishing it.
 * @param request - Repository, version, channel, and signed assets.
 * @param fetchImpl - Fetch implementation, defaulting to the platform implementation.
 * @returns The release tag, URL, and uploaded or verified existing assets.
 */
export async function publishGitHubRelease(
  request: GitHubReleaseRequest,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<GitHubReleaseResult> {
  const { token, owner, repo, version, channel, targetCommitish, draftOnly } = request
  if (targetCommitish !== undefined && !/^[0-9a-f]{40}$/iu.test(targetCommitish)) {
    throw new Error('desktop publish: the packaging commit must be a full Git SHA')
  }
  const assets = await prepareAssets(request.assets)
  const tag = desktopGitHubReleaseTag(version)
  const prerelease = channel === 'nightly'
  const { api, download, headers, repoPath } = releaseApi(token, owner, repo, fetchImpl)
  const target = targetCommitish?.toLowerCase()
  const tagged = target === undefined ? false : await verifyTag(api, tag, target)
  const release = await findOrCreateDraft(api, tag, version, prerelease, target)
  assertReleaseTarget(release, tag, prerelease, target, tagged)
  if (draftOnly && !release.draft) throw new Error(`desktop publish: ${tag} is already public`)
  const releasePath = `/releases/${String(release.id)}`
  const verifyInventory = async (complete: boolean) => await verifyRemoteAssets(
    api, releasePath, release, assets, complete, download,
  )
  const existing = await verifyInventory(!release.draft)
  if (!release.draft) return { tag, url: release.html_url, draft: false, uploaded: [], skipped: [...assets.keys()] }
  const uploaded: string[] = []
  const skipped: string[] = []
  const uploadUrl = releaseUploadUrl(release, repoPath)
  for (const asset of assets.values()) {
    const { name } = asset
    if (existing.has(name)) {
      skipped.push(name)
      continue
    }
    const body = await readFile(asset.path)
    if (body.byteLength !== asset.size || createHash('sha256').update(body).digest('hex') !== asset.sha256) {
      throw new Error(`desktop publish: local asset ${name} changed after verification`)
    }
    uploadUrl.searchParams.set('name', name)
    const upload = await fetchImpl(uploadUrl.href, {
      method: 'POST', redirect: 'error',
      headers: { ...headers, 'Content-Type': asset.contentType, 'Content-Length': String(body.byteLength) },
      body,
    })
    await requireSuccess(upload, `uploading ${name} to draft ${tag}`)
    uploaded.push(name)
  }
  if (uploaded.length > 0) await verifyInventory(true)
  if (draftOnly) {
    const taggedAfterUpload = target !== undefined && await verifyTag(api, tag, target)
    const draft = readRelease(await responseJson(await api(releasePath), `checking draft ${tag}`))
    if (draft.id !== release.id || !draft.draft) throw new Error(`desktop publish: ${tag} is no longer a draft`)
    assertReleaseTarget(draft, tag, prerelease, target, taggedAfterUpload)
    return { tag, url: draft.html_url, draft: true, uploaded, skipped }
  }
  if (target !== undefined) assertReleaseTarget(release, tag, prerelease, target, await verifyTag(api, tag, target))
  const published = readRelease(await responseJson(await api(releasePath, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft: false, prerelease, make_latest: prerelease ? 'false' : 'true', target_commitish: target }),
  }), `publishing draft ${tag}`))
  if (published.id !== release.id || published.tag_name !== tag || published.draft || published.prerelease !== prerelease) {
    throw new Error(`desktop publish: GitHub did not confirm publication of ${tag}`)
  }
  return { tag, url: published.html_url, draft: false, uploaded, skipped }
}

type PreparedAsset = GitHubReleaseAsset & GitHubReleaseAssetReceipt

async function prepareAssets(assets: readonly GitHubReleaseAsset[]): Promise<ReadonlyMap<string, PreparedAsset>> {
  const prepared = new Map<string, PreparedAsset>()
  for (const asset of assets) {
    const name = asset.name ?? basename(asset.path)
    if (!/^[a-z0-9][a-z0-9._+-]*$/iu.test(name) || prepared.has(name)) {
      throw new Error(`desktop publish: invalid or duplicate asset name ${name}`)
    }
    const file = await lstat(asset.path)
    if (!file.isFile() || file.size === 0) throw new Error(`desktop publish: ${name} must be a nonempty regular file`)
    const sha256 = await sha256File(asset.path)
    if (asset.sha256 !== undefined && sha256 !== asset.sha256) {
      throw new Error(`desktop publish: local asset ${name} changed after signing`)
    }
    prepared.set(name, { ...asset, name, size: file.size, sha256 })
  }
  assertPairedAssets(prepared)
  return prepared
}

function assertPairedAssets(assets: ReadonlyMap<string, GitHubReleaseAssetReceipt>): void {
  if (assets.size === 0) throw new Error('desktop publish: no signed release assets were supplied')
  for (const name of assets.keys()) {
    const signed = name.endsWith('.sig')
    const artifact = signed ? name.slice(0, -4) : name
    if (artifact.endsWith('.sig') || !assets.has(signed ? artifact : signatureAssetName(artifact))) {
      throw new Error(`desktop publish: ${name} has no matching artifact or detached signature`)
    }
  }
}

interface GitHubRelease {
  readonly id: number
  readonly tag_name: string
  readonly html_url: string
  readonly upload_url: string
  readonly draft: boolean
  readonly prerelease: boolean
  readonly target_commitish?: string
}

type GitHubApi = (path: string, init?: RequestInit) => Promise<Response>

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRelease(value: unknown): GitHubRelease {
  if (!object(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id < 1
    || typeof value.tag_name !== 'string' || typeof value.html_url !== 'string' || typeof value.upload_url !== 'string'
    || typeof value.draft !== 'boolean' || typeof value.prerelease !== 'boolean') {
    throw new Error('desktop publish: GitHub returned invalid release metadata')
  }
  const { id, tag_name, html_url, upload_url, draft, prerelease, target_commitish } = value
  return { id, tag_name, html_url, upload_url, draft, prerelease,
    ...(typeof target_commitish === 'string' ? { target_commitish } : {}) }
}

async function requireSuccess(response: Response, operation: string): Promise<void> {
  if (!response.ok) throw new Error(`desktop publish: ${operation} failed with ${String(response.status)} ${await response.text()}`)
}

async function responseJson(response: Response, operation: string): Promise<unknown> {
  await requireSuccess(response, operation)
  return await response.json()
}

async function* listGitHub(api: GitHubApi, path: string): AsyncGenerator<unknown> {
  const pageSize = 100
  for (let page = 1; ; page += 1) {
    const result = await responseJson(await api(`${path}?per_page=${String(pageSize)}&page=${String(page)}`), `listing ${path}`)
    if (!Array.isArray(result)) throw new Error(`desktop publish: GitHub returned an invalid list for ${path}`)
    yield* result
    if (result.length < pageSize) return
  }
}

async function findRelease(api: GitHubApi, tag: string): Promise<GitHubRelease | undefined> {
  let match: GitHubRelease | undefined
  // The by-tag endpoint omits drafts, which must be recovered after interrupted uploads.
  for await (const value of listGitHub(api, '/releases')) {
    const current = readRelease(value)
    if (current.tag_name !== tag) continue
    if (match !== undefined && match.id !== current.id) throw new Error(`desktop publish: multiple Releases use tag ${tag}`)
    match = current
  }
  return match
}

async function findOrCreateDraft(
  api: GitHubApi, tag: string, version: string, prerelease: boolean, target: string | undefined,
): Promise<GitHubRelease> {
  const match = await findRelease(api, tag)
  if (match !== undefined) return match
  const release = readRelease(await responseJson(await api('/releases', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: `Agentrans ${version}`, draft: true, prerelease, target_commitish: target }),
  }), `creating draft ${tag}`))
  if (!release.draft) throw new Error(`desktop publish: GitHub did not create a draft for ${tag}`)
  return release
}

function assertReleaseTarget(release: GitHubRelease, tag: string, prerelease: boolean, target: string | undefined, tagged: boolean): void {
  if (release.tag_name !== tag || release.prerelease !== prerelease) {
    throw new Error(`desktop publish: release ${tag} has a different tag or channel`)
  }
  if (target !== undefined && !tagged && (!release.draft || release.target_commitish?.toLowerCase() !== target)) {
    throw new Error(`desktop publish: release ${tag} does not target packaging commit ${target}`)
  }
}

async function verifyTag(api: GitHubApi, tag: string, target: string): Promise<boolean> {
  const ref = await api(`/git/ref/tags/${encodeURIComponent(tag)}`)
  if (ref.status === 404) return false
  let value = await responseJson(ref, `reading tag ${tag}`)
  const visited = new Set<string>()
  while (object(value) && object(value.object)) {
    const { type, sha } = value.object
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/iu.test(sha)) break
    if (type === 'commit') {
      if (sha.toLowerCase() !== target) throw new Error(`desktop publish: tag ${tag} does not point to packaging commit ${target}`)
      return true
    }
    if (type !== 'tag' || visited.has(sha) || visited.size >= 8) break
    visited.add(sha)
    value = await responseJson(await api(`/git/tags/${sha}`), `reading annotated tag ${tag}`)
  }
  throw new Error(`desktop publish: tag ${tag} has no verifiable commit`)
}

function releaseUploadUrl(release: GitHubRelease, repoPath: string): URL {
  const url = new URL(release.upload_url.replace(/\{\?name,label\}$/u, ''))
  const expectedPath = `${repoPath}/releases/${String(release.id)}/assets`.toLowerCase()
  if (url.origin !== 'https://uploads.github.com' || url.pathname.toLowerCase() !== expectedPath
    || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new Error(`desktop publish: invalid GitHub upload URL for ${release.tag_name}`)
  }
  return url
}

async function verifyRemoteAssets(
  api: GitHubApi, releasePath: string, release: GitHubRelease, expected: ReadonlyMap<string, GitHubReleaseAssetReceipt>, complete: boolean,
  download: (id: number) => Promise<Response>,
): Promise<ReadonlySet<string>> {
  const present = new Set<string>()
  for await (const value of listGitHub(api, `${releasePath}/assets`)) {
    if (!object(value) || typeof value.name !== 'string' || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id < 1) {
      throw new Error(`desktop publish: GitHub returned invalid asset metadata for ${release.tag_name}`)
    }
    const asset = expected.get(value.name)
    if (asset === undefined || present.has(value.name)) {
      throw new Error(`desktop publish: release ${release.tag_name} contains an unexpected or duplicate asset ${value.name}`)
    }
    if (value.state !== 'uploaded' || value.size !== asset.size) {
      throw new Error(`desktop publish: release ${release.tag_name} has incomplete or different bytes for ${asset.name}`)
    }
    const digest = value.digest === undefined || value.digest === null
      ? await downloadDigest(await download(value.id), asset) : value.digest
    if (digest !== `sha256:${asset.sha256}`) {
      throw new Error(`desktop publish: release ${release.tag_name} has different bytes for ${asset.name}`)
    }
    present.add(asset.name)
  }
  if (complete && present.size !== expected.size) {
    const missing = [...expected.keys()].filter(name => !present.has(name))
    throw new Error(`desktop publish: release ${release.tag_name} is missing ${missing.join(', ')}`)
  }
  return present
}

async function downloadDigest(response: Response, asset: GitHubReleaseAssetReceipt): Promise<string> {
  await requireSuccess(response, `downloading ${asset.name} to check its digest`)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > asset.size) throw new Error(`desktop publish: downloaded ${asset.name} exceeds its expected size`)
    hash.update(chunk)
  }
  if (size !== asset.size) throw new Error(`desktop publish: downloaded ${asset.name} does not have its expected size`)
  return `sha256:${hash.digest('hex')}`
}

export { collectReleaseAssets }

/**
 * Write a detached signature beside every collected artifact.
 *
 * The installer is what an update installs, so a release that cannot be verified
 * is a release no installed build should accept. Signing happens before upload
 * and covers every artifact, which keeps the channel metadata under the same
 * digest as the binaries it points at.
 * @param assets - Artifacts the release will carry.
 * @param signingKeyBase64 - DER PKCS#8 Ed25519 key from the release environment.
 * @param expectedPublicKey - Optional pinned DER SPKI Ed25519 verification key.
 * @returns the artifacts followed by one signature asset per artifact.
 */
export async function signReleaseAssets(
  assets: readonly GitHubReleaseAsset[],
  signingKeyBase64: string,
  expectedPublicKey?: string,
): Promise<GitHubReleaseAsset[]> {
  const privateKey = privateKeyFromBase64(signingKeyBase64)
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('desktop publish: signing key must use Ed25519')
  if (expectedPublicKey !== undefined && !createPublicKey(privateKey).equals(publicKeyFromBase64(expectedPublicKey))) {
    throw new Error('desktop publish: signing key does not match the application’s pinned update key')
  }
  const originals: GitHubReleaseAsset[] = []
  const signatures: GitHubReleaseAsset[] = []
  for (const asset of assets) {
    const digest = await sha256File(asset.path)
    if (asset.sha256 !== undefined && asset.sha256 !== digest) {
      throw new Error(`desktop publish: ${asset.name ?? basename(asset.path)} changed after package validation`)
    }
    originals.push({ ...asset, sha256: digest })
    const path = `${asset.path}.sig`
    const signature = sign(null, Buffer.from(digest, 'hex'), privateKey).toString('base64')
    await writeFile(path, signature)
    signatures.push({ path, name: signatureAssetName(asset.name ?? basename(asset.path)), contentType: 'text/plain',
      sha256: createHash('sha256').update(signature).digest('hex') })
  }
  return [...originals, ...signatures]
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('publish-github-release.ts')) {
  const [directory, version, channel, option, ...extra] = process.argv.slice(2)
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  const signingKey = process.env.AGENTRANS_UPDATE_SIGNING_KEY
  const targetCommitish = process.env.AGENTRANS_DESKTOP_PACKAGE_SHA
  if (directory === undefined || version === undefined || (channel !== 'nightly' && channel !== 'latest') || token === undefined
    || (option !== undefined && option !== '--draft-only') || extra.length > 0) {
    console.error('usage: publish-github-release <artifacts-dir> <version> <nightly|latest> [--draft-only] (GH_TOKEN required)')
    process.exitCode = 1
  } else if (signingKey === undefined || signingKey === '') {
    // An unsigned release would install on every build that trusts the key, so
    // publishing without one is refused rather than silently skipped.
    console.error('desktop publish: AGENTRANS_UPDATE_SIGNING_KEY is required; collect the signing key secret before publishing')
    process.exitCode = 1
  } else {
    const collected = await collectReleaseAssets(directory, version, channel, process.env.AGENTRANS_DESKTOP_PACKAGE_TARGET)
    const result = await publishGitHubRelease({
      token,
      owner: DESKTOP_UPDATE_REPOSITORY.owner,
      repo: DESKTOP_UPDATE_REPOSITORY.repo,
      version,
      channel,
      draftOnly: option === '--draft-only',
      ...(targetCommitish === undefined ? {} : { targetCommitish }),
      assets: await signReleaseAssets(collected, signingKey, UPDATE_SIGNING_PUBLIC_KEY),
    })
    const action = result.draft ? 'staged draft' : 'published'
    console.log(`${action} ${result.tag}: ${String(result.uploaded.length)} uploaded, ${String(result.skipped.length)} already present`)
    console.log(result.url)
  }
}
