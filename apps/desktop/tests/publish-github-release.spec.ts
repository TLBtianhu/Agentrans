/** GitHub Releases publishing of packaged Desktop artifacts. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { desktopGitHubReleaseTag, publishGitHubRelease, type GitHubReleaseAsset } from '../scripts/publish-github-release.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/**
 * Write one packaged asset.
 * @param name - file name.
 * @returns its absolute path.
 */
async function assetPath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'github-publish-'))
  directories.push(directory)
  const path = join(directory, name)
  await writeFile(path, 'bytes')
  return path
}

/**
 * Answer one API call the way GitHub would.
 * @param existingAssets - asset names the release already carries.
 * @returns a fetch that records every request.
 */
function fakeGitHub(existingAssets?: readonly string[]): { fetch: typeof globalThis.fetch; calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, method: init?.method ?? 'GET' })
    const respond = (status: number, body: unknown): Response => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' },
    })
    if (url.includes('/releases/tags/')) {
      return existingAssets === undefined
        ? respond(404, { message: 'Not Found' })
        : respond(200, { html_url: 'https://github.com/o/r/releases/tag/x', upload_url: 'https://uploads.github.com/x/assets{?name,label}', assets: existingAssets.map(name => ({ name })) })
    }
    if (url.endsWith('/releases')) {
      return respond(201, { html_url: 'https://github.com/o/r/releases/tag/x', upload_url: 'https://uploads.github.com/x/assets{?name,label}', assets: [] })
    }
    return respond(201, { name: 'uploaded' })
  }) as unknown as typeof globalThis.fetch
  return { fetch: fetchImpl, calls }
}

const assets = async (names: readonly string[]): Promise<GitHubReleaseAsset[]> => Promise.all(names.map(async name => ({
  path: await assetPath(name), contentType: 'application/octet-stream',
})))

describe('desktop GitHub release publishing', () => {
  it('names one tag per Desktop version', () => {
    expect(desktopGitHubReleaseTag('1.2.3')).toBe('desktop-v1.2.3')
  })

  it('creates a missing release and uploads every asset', async () => {
    const github = fakeGitHub()
    const result = await publishGitHubRelease({
      token: 't', owner: 'o', repo: 'r', version: '1.2.3', channel: 'latest',
      assets: await assets(['Agentrans-1.2.3.exe', 'latest.yml']),
    }, github.fetch)
    expect(result.tag).toBe('desktop-v1.2.3')
    expect(result.uploaded).toEqual(['Agentrans-1.2.3.exe', 'latest.yml'])
    expect(result.skipped).toEqual([])
  })

  it('skips an asset the release already carries, so a retry never replaces published bytes', async () => {
    const github = fakeGitHub(['Agentrans-1.2.3.exe'])
    const result = await publishGitHubRelease({
      token: 't', owner: 'o', repo: 'r', version: '1.2.3', channel: 'nightly',
      assets: await assets(['Agentrans-1.2.3.exe', 'latest.yml']),
    }, github.fetch)
    expect(result.skipped).toEqual(['Agentrans-1.2.3.exe'])
    expect(result.uploaded).toEqual(['latest.yml'])
  })

  it('marks a nightly release as a prerelease and latest as a release', async () => {
    const nightly = fakeGitHub()
    const created: string[] = []
    const capturing = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/releases') && init?.body !== undefined) created.push(String(init.body))
      return nightly.fetch(input, init)
    }) as unknown as typeof globalThis.fetch
    await publishGitHubRelease({ token: 't', owner: 'o', repo: 'r', version: '2.0.0', channel: 'nightly', assets: [] }, capturing)
    expect(JSON.parse(created[0] ?? '{}')).toMatchObject({ tag_name: 'desktop-v2.0.0', prerelease: true })
  })
})
