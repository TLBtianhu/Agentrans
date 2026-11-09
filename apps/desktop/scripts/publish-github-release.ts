/**
 * Publish packaged Desktop artifacts as a GitHub Release.
 *
 * The packaged updater names this repository as its feed provider, so the
 * release must carry the installer, its blockmaps, and the generated channel
 * metadata under the names electron-builder wrote. Uploads are additive: an
 * existing asset with the same name is left alone, so a retried publish never
 * replaces bytes a user may already be downloading.
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

/** One packaged file to attach. */
export interface GitHubReleaseAsset {
  /** Absolute path of the packaged file. */
  readonly path: string
  /** Name the release asset carries; defaults to the file's basename. */
  readonly name?: string
  /** Media type GitHub serves for this asset. */
  readonly contentType: string
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
  readonly assets: readonly GitHubReleaseAsset[]
}

/** What one publish attempt did. */
export interface GitHubReleaseResult {
  /** Tag the release is addressable by. */
  readonly tag: string
  /** Release page URL. */
  readonly url: string
  /** Asset names uploaded by this attempt. */
  readonly uploaded: string[]
  /** Asset names already present and therefore not uploaded. */
  readonly skipped: string[]
}

/** Tag naming one Desktop release, distinct from the npm family's `dsh-v*`. */
export function desktopGitHubReleaseTag(version: string): string {
  return `desktop-v${version}`
}

/**
 * Publish every asset to the release named by the version.
 * @param request - repository, version, channel, and assets.
 * @param fetchImpl - fetch implementation; defaults to the platform one.
 * @returns the release tag, URL, and which assets were uploaded or skipped.
 */
export async function publishGitHubRelease(
  request: GitHubReleaseRequest,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<GitHubReleaseResult> {
  const { token, owner, repo, version, channel } = request
  const tag = desktopGitHubReleaseTag(version)
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'agentrans-desktop-publish',
  }
  const base = `https://api.github.com/repos/${owner}/${repo}`
  const release = await findOrCreateRelease(tag, channel === 'latest' ? false : true, fetchImpl, base, headers, version)
  const present = new Set(((release.assets ?? []) as { name: string }[]).map(asset => asset.name))
  const uploaded: string[] = []
  const skipped: string[] = []
  for (const asset of request.assets) {
    const name = asset.name ?? basename(asset.path)
    if (present.has(name)) {
      skipped.push(name)
      continue
    }
    const body = await readFile(asset.path)
    const upload = await fetchImpl(`${release.upload_url.replace('{?name,label}', '')}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': asset.contentType, 'Content-Length': String(body.byteLength) },
      body,
    })
    if (!upload.ok) {
      throw new Error(`desktop publish: uploading ${name} failed with ${String(upload.status)} ${await upload.text()}`)
    }
    uploaded.push(name)
  }
  return { tag, url: release.html_url, uploaded, skipped }
}

interface GitHubRelease {
  readonly html_url: string
  readonly upload_url: string
  readonly assets?: readonly { name: string }[]
}

/**
 * Read the release for a tag, creating it when absent.
 * @param tag - release tag.
 * @param prerelease - whether a new release is marked prerelease.
 * @returns the existing or created release.
 */
async function findOrCreateRelease(
  tag: string,
  prerelease: boolean,
  fetchImpl: typeof globalThis.fetch,
  base: string,
  headers: Record<string, string>,
  version: string,
): Promise<GitHubRelease> {
  const existing = await fetchImpl(`${base}/releases/tags/${encodeURIComponent(tag)}`, { headers })
  if (existing.ok) return await existing.json() as GitHubRelease
  if (existing.status !== 404) {
    throw new Error(`desktop publish: reading release ${tag} failed with ${String(existing.status)} ${await existing.text()}`)
  }
  const created = await fetchImpl(`${base}/releases`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: `Agentrans ${version}`, draft: false, prerelease }),
  })
  if (!created.ok) {
    throw new Error(`desktop publish: creating release ${tag} failed with ${String(created.status)} ${await created.text()}`)
  }
  return await created.json() as GitHubRelease
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('publish-github-release.ts')) {
  const [directory, version, channel] = process.argv.slice(2)
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (directory === undefined || version === undefined || channel === undefined || token === undefined) {
    console.error('usage: publish-github-release <artifacts-dir> <version> <nightly|latest> (GH_TOKEN required)')
    process.exitCode = 1
  }
}
