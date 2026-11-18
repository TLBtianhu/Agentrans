/** GitHub Releases publishing with an in-memory GitHub API and real local signatures. */
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collectReleaseAssets, desktopGitHubReleaseTag, publishGitHubRelease, signReleaseAssets, type GitHubReleaseRequest,
} from '../scripts/publish-github-release.ts'
import { verifyFileDigest } from '../src/update-signature.ts'

const directories: string[] = []
const version = '1.2.3'
const installer = 'agentrans-1.2.3-win-x64.exe'
const blockmap = installer + '.blockmap'
const feed = 'latest.yml'
const buildSha = '1'.repeat(40)

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(channel: GitHubReleaseRequest['channel'] = 'latest') {
  const directory = await mkdtemp(join(tmpdir(), 'github-publish-'))
  directories.push(directory)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signingKey = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const installerBytes = Buffer.from('installer bytes')
  const digest = createHash('sha512').update(installerBytes).digest('base64')
  await Promise.all([
    writeFile(join(directory, installer), installerBytes),
    writeFile(join(directory, blockmap), 'blockmap bytes'),
    writeFile(join(directory, feed), `version: ${version}\nfiles:\n  - url: ${installer}\n    size: ${installerBytes.length}\n`
      + `    sha512: ${digest}\npath: ${installer}\nsha512: ${digest}\n`),
  ])
  const files = await collectReleaseAssets(directory, version, channel, 'win-x64')
  const assets = await signReleaseAssets(files, signingKey, publicKey.export({ format: 'der', type: 'spki' }).toString('base64'))
  const request: GitHubReleaseRequest = { token: 'test', owner: 'o', repo: 'r', version, channel, assets }
  return { request, assets, files, signingKey, publicKey }
}

interface RecordedCall {
  readonly method: string
  readonly endpoint: string
  readonly body: unknown
}

interface Release {
  readonly id: number
  readonly tag_name: string
  readonly html_url: string
  readonly upload_url: string
  readonly draft: boolean
  readonly prerelease: boolean
  readonly target_commitish?: string
}

const releasePath = '/repos/o/r/releases/42'
const allNames = [installer, blockmap, feed, installer + '.sig', blockmap + '.sig', feed + '.sig']

function release(draft: boolean, prerelease = false): Release {
  return {
    id: 42, tag_name: 'v1.2.3', html_url: 'https://github.com/o/r/releases/tag/v1.2.3',
    upload_url: 'https://uploads.github.com/repos/o/r/releases/42/assets{?name,label}', draft, prerelease,
  }
}

interface FakeAsset {
  readonly id: number
  readonly bytes: Buffer
  readonly digest: string | null
}

function fakeGitHub(current?: Release) {
  const calls: RecordedCall[] = []
  const assets = new Map<string, FakeAsset>()
  const failures = { upload: '', publishReceipt: false, omitFromListing: '', publishBeforeDraftRead: false }
  const tag = { commit: '', annotation: '' }
  const putAsset = (name: string, bytes: Buffer, noDigest = false): void => {
    assets.set(name, { id: assets.size + 1, bytes, digest: noDigest ? null : 'sha256:' + createHash('sha256').update(bytes).digest('hex') })
  }
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const endpoint = url.pathname
    const method = init?.method ?? 'GET'
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
    calls.push({ method, endpoint, body })
    const respond = (status: number, value: unknown): Response => Response.json(value, { status })
    if (endpoint === '/repos/o/r/releases' && method === 'GET') return respond(200, current === undefined ? [] : [current])
    if (endpoint === '/repos/o/r/releases' && method === 'POST') {
      expect(current).toBeUndefined()
      expect(body).toMatchObject({ draft: true })
      current = { ...release(true), ...body as Partial<Release> }
      return respond(201, current)
    }
    if (endpoint === releasePath + '/assets' && method === 'GET') {
      return respond(200, [...assets].filter(([name]) => name !== failures.omitFromListing).map(([name, asset]) => ({
        id: asset.id, name, state: 'uploaded', size: asset.bytes.length, digest: asset.digest,
      })))
    }
    if (endpoint === releasePath + '/assets' && method === 'POST') {
      expect(current?.draft).toBe(true)
      expect(url.origin).toBe('https://uploads.github.com')
      const name = url.searchParams.get('name')
      if (name === null || !Buffer.isBuffer(body)) throw new Error('Expected an upload with bytes and a name')
      if (name === failures.upload) {
        failures.upload = ''
        return respond(502, { message: 'Upload temporarily failed' })
      }
      expect(assets.has(name)).toBe(false)
      putAsset(name, body)
      return respond(201, { name })
    }
    if (endpoint === releasePath && method === 'GET') {
      if (current === undefined) return respond(404, {})
      if (failures.publishBeforeDraftRead) current = { ...current, draft: false }
      return respond(200, current)
    }
    if (endpoint === releasePath && method === 'PATCH') {
      if (current === undefined) throw new Error('Expected a draft to publish')
      expect(new Set(assets.keys())).toEqual(new Set(allNames))
      current = { ...current, ...body as Partial<Release> }
      if (failures.publishReceipt) {
        failures.publishReceipt = false
        throw new TypeError('Publication response lost')
      }
      return respond(200, current)
    }
    if (endpoint.startsWith('/repos/o/r/releases/assets/') && method === 'GET') {
      expect(new Headers(init?.headers).get('Accept')).toBe('application/octet-stream')
      const file = [...assets.values()].find(item => item.id === Number(endpoint.split('/').at(-1)))
      return file === undefined ? respond(404, {}) : new Response(new Uint8Array(file.bytes))
    }
    if (endpoint === '/repos/o/r/git/ref/tags/v1.2.3' && method === 'GET') {
      return tag.commit === '' ? respond(404, {})
        : respond(200, { object: tag.annotation === '' ? { type: 'commit', sha: tag.commit } : { type: 'tag', sha: tag.annotation } })
    }
    if (endpoint === '/repos/o/r/git/tags/' + tag.annotation && method === 'GET') {
      return respond(200, { object: { type: 'commit', sha: tag.commit } })
    }
    throw new Error('Unexpected GitHub call ' + method + ' ' + endpoint)
  })
  return { fetch, calls, failures, tag, putAsset, current: () => current, mutations: () => calls.filter(call => call.method !== 'GET') }
}

describe('desktop GitHub release publishing', () => {
  it('names one tag per Desktop version', () => {
    expect(desktopGitHubReleaseTag(version)).toBe('v1.2.3')
  })

  it.each(['latest', 'nightly'] as const)('publishes %s only after checking the complete signed draft', async (channel) => {
    const github = fakeGitHub()
    const { request } = await fixture(channel)
    const result = await publishGitHubRelease({ ...request, targetCommitish: buildSha }, github.fetch)
    const prerelease = channel === 'nightly'
    expect(result).toMatchObject({ tag: 'v1.2.3', draft: false, uploaded: allNames, skipped: [] })
    expect(github.mutations()[0]?.body).toMatchObject({ draft: true, prerelease, target_commitish: buildSha })
    expect(github.calls.filter(call => call.method === 'GET' && call.endpoint === releasePath + '/assets')).toHaveLength(2)
    expect(github.mutations().at(-1)).toEqual({ method: 'PATCH', endpoint: releasePath,
      body: { draft: false, prerelease, make_latest: prerelease ? 'false' : 'true', target_commitish: buildSha } })
    expect(github.current()?.draft).toBe(false)
  })

  it('uploads a complete draft and reuses it on retry', async () => {
    const github = fakeGitHub()
    const { request } = await fixture('nightly')
    const draftRequest = { ...request, targetCommitish: buildSha, draftOnly: true }
    const result = await publishGitHubRelease(draftRequest, github.fetch)
    const draft = github.current()
    const mutations = github.mutations()
    expect(result).toMatchObject({ tag: 'v1.2.3', draft: true, uploaded: allNames, skipped: [] })
    expect(draft).toMatchObject({ draft: true, prerelease: true, target_commitish: buildSha })
    expect(mutations.map(({ method, endpoint }) => [method, endpoint])).toEqual([
      ['POST', '/repos/o/r/releases'],
      ...allNames.map(() => ['POST', releasePath + '/assets']),
    ])
    const releaseReads = github.calls.filter(call => call.method === 'GET' && call.endpoint.startsWith(releasePath))
    expect(releaseReads.map(call => call.endpoint)).toEqual([releasePath + '/assets', releasePath + '/assets', releasePath])

    const retried = await publishGitHubRelease(draftRequest, github.fetch)
    expect(retried).toMatchObject({ draft: true, url: result.url, uploaded: [], skipped: allNames })
    expect(github.current()).toBe(draft)
    expect(github.mutations()).toEqual(mutations)
  })

  it('rejects an already public release in draft-only mode', async () => {
    const github = fakeGitHub(release(false))
    const { request, assets } = await fixture()
    github.tag.commit = buildSha
    for (const asset of assets) github.putAsset(basename(asset.path), await readFile(asset.path))
    await expect(publishGitHubRelease({ ...request, targetCommitish: buildSha, draftOnly: true }, github.fetch))
      .rejects.toThrow(/public|already published/u)
    expect(github.current()?.draft).toBe(false)
    expect(github.mutations()).toEqual([])
  })

  it('rejects a release published externally during draft staging', async () => {
    const github = fakeGitHub()
    const { request } = await fixture()
    github.failures.publishBeforeDraftRead = true
    await expect(publishGitHubRelease({ ...request, draftOnly: true }, github.fetch)).rejects.toThrow(/draft|public/u)
    expect(github.calls.at(-1)).toMatchObject({ method: 'GET', endpoint: releasePath })
    expect(github.mutations().some(call => call.method === 'PATCH')).toBe(false)
  })

  it('rejects an empty set and missing signatures before calling GitHub', async () => {
    const github = fakeGitHub()
    const { request, files } = await fixture()
    await expect(publishGitHubRelease({ ...request, assets: [] }, github.fetch)).rejects.toThrow(/no signed release assets/u)
    await expect(publishGitHubRelease({ ...request, assets: files }, github.fetch)).rejects.toThrow(/detached signature/u)
    expect(github.fetch).not.toHaveBeenCalled()
  })

  it('leaves an interrupted upload in draft and sends only missing assets on retry', async () => {
    const github = fakeGitHub()
    const { request } = await fixture()
    github.failures.upload = feed
    await expect(publishGitHubRelease(request, github.fetch)).rejects.toThrow(/uploading latest\.yml/u)
    expect(github.current()?.draft).toBe(true)
    expect(github.calls.some(call => call.method === 'PATCH')).toBe(false)
    const retry = await publishGitHubRelease(request, github.fetch)
    expect(retry.skipped).toEqual([installer, blockmap])
    expect(retry.uploaded).toEqual(allNames.slice(2))
    expect(github.current()?.draft).toBe(false)
    expect(github.calls.filter(call => call.method === 'POST' && call.endpoint === '/repos/o/r/releases')).toHaveLength(1)
  })

  it.each([false, true])('rejects a missing server asset after successful uploads with draftOnly=%s', async (draftOnly) => {
    const github = fakeGitHub()
    const { request } = await fixture()
    github.failures.omitFromListing = feed + '.sig'
    await expect(publishGitHubRelease({ ...request, draftOnly }, github.fetch)).rejects.toThrow(/missing latest\.yml\.sig/u)
    expect(github.calls.some(call => call.method === 'PATCH')).toBe(false)
    expect(github.current()?.draft).toBe(true)
  })

  it('refuses a same-size same-name mismatch before modifying a draft', async () => {
    const github = fakeGitHub(release(true))
    const { request } = await fixture()
    github.putAsset(installer, Buffer.from('different bytes'))
    await expect(publishGitHubRelease(request, github.fetch)).rejects.toThrow(/different bytes/u)
    expect(github.mutations()).toEqual([])
  })

  it('uses authenticated asset bytes when an older GitHub asset has no digest', async () => {
    const github = fakeGitHub(release(true))
    const { request, files } = await fixture()
    const file = files[0]
    if (file === undefined) throw new Error('Expected a local installer')
    github.putAsset(installer, await readFile(file.path), true)
    const result = await publishGitHubRelease(request, github.fetch)
    expect(result.skipped).toEqual([installer])
    expect(github.calls.some(call => call.method === 'GET' && call.endpoint === '/repos/o/r/releases/assets/1')).toBe(true)
  })

  it('accepts a verified public release after the publication response is lost', async () => {
    const github = fakeGitHub()
    const { request } = await fixture()
    github.failures.publishReceipt = true
    await expect(publishGitHubRelease(request, github.fetch)).rejects.toThrow(/Publication response lost/u)
    expect(github.current()?.draft).toBe(false)
    const mutationCount = github.mutations().length
    const retried = await publishGitHubRelease(request, github.fetch)
    expect(retried).toMatchObject({ draft: false, uploaded: [], skipped: allNames })
    expect(github.mutations()).toHaveLength(mutationCount)
  })

  it('rejects an incomplete public release without adding assets to it', async () => {
    const github = fakeGitHub(release(false))
    const { request } = await fixture()
    await expect(publishGitHubRelease(request, github.fetch)).rejects.toThrow(/missing/u)
    expect(github.mutations()).toEqual([])
  })

  it('rejects a tag pointing to another build and accepts an annotated tag for this build', async () => {
    const github = fakeGitHub()
    const { request } = await fixture()
    github.tag.commit = '2'.repeat(40)
    await expect(publishGitHubRelease({ ...request, targetCommitish: buildSha }, github.fetch)).rejects.toThrow(/does not point/u)
    expect(github.mutations()).toEqual([])
    github.tag.commit = buildSha
    github.tag.annotation = 'a'.repeat(40)
    await expect(publishGitHubRelease({ ...request, targetCommitish: buildSha }, github.fetch)).resolves.toMatchObject({
      uploaded: allNames,
    })
    expect(github.calls.some(call => call.endpoint === '/repos/o/r/git/tags/' + github.tag.annotation)).toBe(true)
  })
})

describe('release artifact signatures', () => {
  it('signs each asset and carries the exact SHA-256 of the signed bytes', async () => {
    const { assets, publicKey } = await fixture()
    expect(assets.map(asset => asset.name)).toEqual(allNames)
    for (const asset of assets) {
      const bytes = await readFile(asset.path)
      expect(asset.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      if (basename(asset.path).endsWith('.sig')) {
        await expect(verifyFileDigest(asset.path.slice(0, -4), bytes.toString('utf8'), publicKey)).resolves.toBe(true)
      }
    }
  })

  it('refuses a signing key that does not match the application trust root', async () => {
    const { files, signingKey } = await fixture()
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    await expect(signReleaseAssets(files, signingKey, other)).rejects.toThrow(/does not match/u)
    await expect(signReleaseAssets(files, 'not-a-key')).rejects.toThrow(/signing key/u)
  })

  it('refuses a package changed between validation and signing or between signing and uploading', async () => {
    const github = fakeGitHub()
    const { request, signingKey, assets } = await fixture()
    const checkedInstaller = assets[0]
    if (checkedInstaller === undefined) throw new Error('Expected a checked installer')
    await writeFile(checkedInstaller.path, 'different data')
    await expect(signReleaseAssets([checkedInstaller], signingKey)).rejects.toThrow(/changed after package validation/u)
    await expect(publishGitHubRelease(request, github.fetch)).rejects.toThrow(/changed after signing/u)
    expect(github.fetch).not.toHaveBeenCalled()
  })
})
