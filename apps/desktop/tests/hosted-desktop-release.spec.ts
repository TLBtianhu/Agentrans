import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { assembleDesktopRelease, verifySignedDesktopRelease } from '../scripts/prepare-desktop-release.ts'
import { signReleaseAssets } from '../scripts/publish-github-release.ts'
import { planHostedDesktopRelease } from '../scripts/stage-hosted-desktop-release.ts'
import { publicKeyFromBase64, verifyFileDigest } from '../src/update-signature.ts'

const version = '2.4.6-test.20270129.2'
const channel = 'nightly'
const sourceSha = 'e'.repeat(40)
const otherSha = 'a'.repeat(40)
const repository = 'TLBtianhu/Agentrans'
const workflow = { id: 321, path: '.github/workflows/agentrans-hosted-package.yml' }
const digest = 'sha256:' + 'c'.repeat(64)
const namesByTarget = {
  all: ['agentrans-win-x64', 'agentrans-mac'],
  'win-x64': ['agentrans-win-x64'],
  mac: ['agentrans-mac'],
  'mac-arm64': ['agentrans-mac-arm64'],
  'mac-x64': ['agentrans-mac-x64'],
} as const

type SourceTarget = keyof typeof namesByTarget
type NativeTarget = Exclude<SourceTarget, 'all' | 'mac'>

function source(id: number, target: SourceTarget, sha = sourceSha) {
  const run = {
    id, workflow_id: workflow.id, status: 'completed', conclusion: 'success', event: 'workflow_dispatch',
    repository: { full_name: repository }, head_repository: { full_name: repository },
    head_sha: sha, display_title: `Package Agentrans · ${target} · ${channel} · ${version}`,
  }
  const artifacts = namesByTarget[target].map((name, index) => ({
    id: id * 10 + index + 1, name, digest, expired: false, size_in_bytes: 3100 + index,
    workflow_run: { id, head_sha: sha },
  }))
  return { runId: String(id), run, archiveList: { total_count: artifacts.length, artifacts } }
}

const inputCases = {
  'one all run': [source(11, 'all')],
  'Windows and combined Mac': [source(18, 'mac'), source(12, 'win-x64')],
  'three platform runs': [source(15, 'mac-x64'), source(12, 'win-x64'), source(14, 'mac-arm64')],
}

function plan(sources: readonly ReturnType<typeof source>[]) {
  return planHostedDesktopRelease(workflow, sources, version, channel, sourceSha)
}

function combinedSource() {
  const combined = source(11, 'all')
  const [win, mac] = combined.archiveList.artifacts
  if (win === undefined || mac === undefined) throw new Error('Expected both archives in the combined fixture')
  return { combined, win, mac }
}

describe('hosted Desktop archive source', () => {
  it.each([
    { label: 'one all run', sources: inputCases['one all run'], expected: [['win-x64', '11', '111'], ['mac', '11', '112']] },
    {
      label: 'Windows and combined Mac', sources: inputCases['Windows and combined Mac'],
      expected: [['win-x64', '12', '121'], ['mac', '18', '181']],
    },
    {
      label: 'three platform runs', sources: inputCases['three platform runs'],
      expected: [['win-x64', '12', '121'], ['mac-arm64', '14', '141'], ['mac-x64', '15', '151']],
    },
  ])('plans $label in platform order from a single intended commit', ({ sources, expected }) => {
    const result = plan(sources)
    expect(result).toMatchObject({ version, channel, sourceSha })
    expect(result.archives).toEqual(expected.map(([target, runId, artifactId]) => ({
      target, runId, artifactId, name: 'agentrans-' + target, digest, size: artifactId === '112' ? 3101 : 3100,
    })))
  })

  it('rejects a successful component from a different build commit', () => {
    expect(() => plan([source(12, 'win-x64'), source(14, 'mac-arm64', otherSha), source(15, 'mac-x64')]))
      .toThrow(/did not use/u)
  })

  it.each([
    { label: 'missing Intel Mac', sources: [source(12, 'win-x64'), source(14, 'mac-arm64')] },
    {
      label: 'duplicate Apple Silicon', sources: [source(12, 'win-x64'), source(14, 'mac-arm64'), source(16, 'mac-arm64')],
    },
    { label: 'overlapping combined and split Mac', sources: [source(12, 'win-x64'), source(18, 'mac'), source(15, 'mac-x64')] },
  ])('rejects invalid platform coverage with $label', ({ sources }) => {
    expect(() => plan(sources)).toThrow(/exactly once|overlapping/u)
  })

  it('rejects a missing or additional archive in the combined run', () => {
    const { combined, win, mac } = combinedSource()
    expect(() => plan([{ ...combined, archiveList: { total_count: 1, artifacts: [win] } }])).toThrow()
    expect(() => plan([{
      ...combined,
      archiveList: { total_count: 3, artifacts: [win, mac, { ...mac, id: 119 }] },
    }])).toThrow()
  })

  it('rejects an archive ID reused across different platforms', () => {
    const { combined, win, mac } = combinedSource()
    expect(() => plan([{
      ...combined, archiveList: { total_count: 2, artifacts: [win, { ...mac, id: win.id }] },
    }])).toThrow()
  })

  it.each([
    { label: 'an unusable digest', changes: { digest: 'sha256:xyz' } },
    { label: 'an expired archive', changes: { expired: true } },
    { label: 'an archive bound to another run', changes: { workflow_run: { id: 99, head_sha: sourceSha } } },
  ])('rejects $label before downloading', ({ changes }) => {
    const { combined, win, mac } = combinedSource()
    expect(() => plan([{
      ...combined, archiveList: { total_count: 2, artifacts: [win, { ...mac, ...changes }] },
    }])).toThrow()
  })
})

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function stem(target: NativeTarget): string {
  return `agentrans-${version}-${target}-unsigned`
}

async function writeArchive(directory: string, targets: readonly NativeTarget[]) {
  await mkdir(directory)
  const windows = targets[0] === 'win-x64'
  const files = await Promise.all(targets.map(async (target) => {
    const url = stem(target) + (windows ? '.exe' : '.zip')
    const content = Buffer.from('installer for ' + target)
    await Promise.all([
      writeFile(join(directory, url), content),
      writeFile(join(directory, url + '.blockmap'), 'blockmap for ' + target),
      ...(windows ? [] : [writeFile(join(directory, stem(target) + '.dmg'), 'disk image for ' + target)]),
    ])
    return { url, size: content.length, sha512: createHash('sha512').update(content).digest('base64') }
  }))
  const first = files[0]
  if (first === undefined) throw new Error('The fixture requires package targets')
  await writeFile(join(directory, windows ? 'test.yml' : 'test-mac.yml'), dump({
    version, files, path: first.url, sha512: first.sha512, releaseDate: '2027-01-29T05:00:00.000Z',
  }))
}

async function fixture(combined: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'hosted-desktop-release-'))
  roots.push(root)
  const input = join(root, 'input')
  const work = join(root, 'work')
  await Promise.all([mkdir(input), mkdir(work)])
  await writeArchive(join(input, 'win-x64'), ['win-x64'])
  if (combined) await writeArchive(join(input, 'mac'), ['mac-arm64', 'mac-x64'])
  else await Promise.all([
    writeArchive(join(input, 'mac-arm64'), ['mac-arm64']), writeArchive(join(input, 'mac-x64'), ['mac-x64']),
  ])
  return { input, work, release: plan(combined ? inputCases['one all run'] : inputCases['three platform runs']) }
}

const expectedNames = [
  stem('win-x64') + '.exe', stem('win-x64') + '.exe.blockmap', 'test.yml', 'test-mac.yml',
  ...(['mac-arm64', 'mac-x64'] as const).flatMap(target => ['.dmg', '.zip', '.zip.blockmap'].map(ext => stem(target) + ext)),
]

async function signedFixture() {
  const { input, work, release } = await fixture(false)
  const { directory, assets } = await assembleDesktopRelease(release, input, work)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signingKey = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  await signReleaseAssets(assets, signingKey, publicKeyBase64)
  return { directory, publicKeyBase64 }
}

describe('three-platform Desktop release assets', () => {
  it.each([false, true])('assembles the full validated release with combined Mac input %s', async (combined) => {
    const { input, work, release } = await fixture(combined)
    const { directory, assets } = await assembleDesktopRelease(release, input, work)
    expect(assets.map(asset => asset.name).sort()).toEqual([...expectedNames].sort())

    const metadata = load(await readFile(join(directory, 'test-mac.yml'), 'utf8'))
    const files = (['mac-arm64', 'mac-x64'] as const).map((target) => {
      const content = Buffer.from('installer for ' + target)
      return { url: stem(target) + '.zip', size: content.length, sha512: createHash('sha512').update(content).digest('base64') }
    })
    expect(metadata).toMatchObject({ version, files })
  })

  it('rejects an altered split Mac installer against its original metadata', async () => {
    const { input, work, release } = await fixture(false)
    await writeFile(join(input, 'mac-x64', stem('mac-x64') + '.zip'), 'installer for mac-arm')
    await expect(assembleDesktopRelease(release, input, work)).rejects.toThrow(/SHA-512|size/iu)
  })

  it('verifies all ten sources and detached signatures, including the combined feed', async () => {
    const { directory, publicKeyBase64 } = await signedFixture()
    const verified = await verifySignedDesktopRelease(directory, version, channel, publicKeyBase64)
    expect(verified.assets).toHaveLength(20)
    expect(verified.receipts.map(receipt => receipt.name).sort()).toEqual([
      ...expectedNames, ...expectedNames.map(name => name + '.sig'),
    ].sort())
    const feed = join(directory, 'test-mac.yml')
    const signature = await readFile(feed + '.sig', 'utf8')
    await expect(verifyFileDigest(feed, signature, publicKeyFromBase64(publicKeyBase64))).resolves.toBe(true)
  })

  it('rejects a mutated disk image even though it is not listed in the update metadata', async () => {
    const { directory, publicKeyBase64 } = await signedFixture()
    await writeFile(join(directory, stem('mac-x64') + '.dmg'), 'disk image for mac-z64')
    await expect(verifySignedDesktopRelease(directory, version, channel, publicKeyBase64)).rejects.toThrow(/signature/iu)
  })

  it('rejects a missing feed signature', async () => {
    const { directory, publicKeyBase64 } = await signedFixture()
    await rm(join(directory, 'test-mac.yml.sig'))
    await expect(verifySignedDesktopRelease(directory, version, channel, publicKeyBase64)).rejects.toThrow()
  })

  it('uses the pinned production key when no test trust root is supplied', async () => {
    const { directory } = await signedFixture()
    await expect(verifySignedDesktopRelease(directory, version, channel)).rejects.toThrow(/signature/iu)
  })
})
