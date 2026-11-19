import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  assembleSignedRelease, selectSignedPackageArtifact, selectSignedPackageRun, verifySignedTarget,
} from '../scripts/stage-signed-desktop-release.ts'

type Target = Parameters<typeof verifySignedTarget>[1]
type Request = Parameters<typeof verifySignedTarget>[2]
type Artifact = Parameters<typeof verifySignedTarget>[3]

const repository = { id: 1000, full_name: 'TLBtianhu/Agentrans' }
const buildRecordName = 'desktop-signed-build.json'
const request = {
  sourceSha: 'a'.repeat(40),
  workflowSha: 'b'.repeat(40),
  version: '0.1.0-test.20261118.5',
  channel: 'nightly',
} as const satisfies Request
const stableRequest = { ...request, version: '0.1.0', channel: 'latest' } as const satisfies Request
const runId = 49268129
const attempt = 3
const archiveDigest = `sha256:${'c'.repeat(64)}` as const
const workflow = { id: 81451, path: '.github/workflows/windows-package.yml' }
const run = {
  id: runId,
  workflow_id: workflow.id,
  path: workflow.path,
  run_attempt: attempt,
  repository,
  head_repository: repository,
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  head_sha: request.workflowSha,
  head_branch: 'main',
}

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-signed-intake-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }))
  return directory
}

async function writeTarget(root: string, target: Target, build: Request, id = runId, feedSizeOffset = 0) {
  const directory = join(root, target)
  await mkdir(directory)
  const stem = `agentrans-${build.version}-${target}`
  const windows = target === 'win-x64'
  const updateName = `${stem}.${windows ? 'exe' : 'zip'}`
  const update = Buffer.from(`fixture bytes for ${target}`)
  const metadata = {
    url: updateName,
    size: update.byteLength + feedSizeOffset,
    sha512: createHash('sha512').update(update).digest('base64'),
  }
  const feedPrefix = build.version === stableRequest.version ? 'latest' : 'test'
  const feedName = `${feedPrefix}${windows ? '' : '-mac'}.yml`
  const contents = new Map<string, string | Buffer>([
    [updateName, update],
    [`${updateName}.blockmap`, `differential download data for ${target}`],
    [feedName, dump({ version: build.version, files: [metadata], path: metadata.url, sha512: metadata.sha512 })],
    [`${target}-release.json`, JSON.stringify({
      schemaVersion: 1,
      target,
      version: build.version,
      provider: 'github',
      owner: 'TLBtianhu',
      repo: 'Agentrans',
      channel: build.channel,
      commit: build.sourceSha,
      dirty: false,
    })],
  ])
  if (!windows) contents.set(`${stem}.dmg`, `disk image for ${target}`)
  await Promise.all([...contents].map(([name, bytes]) => writeFile(join(directory, name), bytes)))
  const assets = Object.fromEntries([...contents].map(([name, bytes]) => [name, {
    bytes: Buffer.byteLength(bytes),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }]))
  await writeFile(join(directory, buildRecordName), JSON.stringify({
    schemaVersion: 1,
    target,
    commit: build.sourceSha,
    version: build.version,
    channel: build.channel,
    appId: 'com.agentrans.app',
    preset: 'production',
    sourceRef: 'dsh-v0.1.0',
    runId: id,
    runAttempt: attempt,
    workflowSha: build.workflowSha,
    assets,
  }))
  const artifact: Artifact = { runId: id, runAttempt: attempt, artifactId: id + 100, archiveDigest }
  return { directory, target, artifact, updateName, update, metadata, stem }
}

async function verifiedTargets(root: string, build: Request) {
  const fixtures = await Promise.all([
    writeTarget(root, 'win-x64', build),
    writeTarget(root, 'mac-arm64', build, runId + 1),
    writeTarget(root, 'mac-x64', build, runId + 2),
  ])
  const verifyNative = vi.fn<Parameters<typeof verifySignedTarget>[4]>().mockResolvedValue(undefined)
  await Promise.all(fixtures.map(fixture => verifySignedTarget(fixture.directory, fixture.target, build, fixture.artifact, verifyNative)))
  return { fixtures, verifyNative }
}

describe('signed Desktop packaging provenance', () => {
  it('selects only the requested successful workflow revision and attempt', () => {
    expect(selectSignedPackageRun('win-x64', runId, request.workflowSha, workflow, run)).toBe(attempt)
    expect(() => selectSignedPackageRun('win-x64', runId, request.workflowSha, workflow, {
      ...run, workflow_id: workflow.id + 1,
    })).toThrow()
    expect(() => selectSignedPackageRun('win-x64', runId, request.workflowSha, workflow, {
      ...run, head_sha: request.sourceSha,
    })).toThrow()
    expect(() => selectSignedPackageRun('win-x64', runId, request.workflowSha, workflow, {
      ...run, head_repository: { id: repository.id + 1, full_name: 'fork/Agentrans' },
    })).toThrow()
  })

  it('requires one unexpired signed artifact with an archive digest for the selected attempt', () => {
    const signed = {
      id: 20931133,
      name: `windows-x64-signed-${request.version}-${String(runId)}-${String(attempt)}`,
      expired: false,
      digest: archiveDigest,
      size_in_bytes: 512,
      workflow_run: { id: runId, repository_id: repository.id, head_repository_id: repository.id, head_sha: request.workflowSha },
    }
    const previous = { ...signed, id: signed.id + 1, name: signed.name.replace(/-3$/u, '-2') }
    const unsigned = { ...signed, id: signed.id + 2, name: signed.name.replace('-signed-', '-unsigned-') }
    const select = (artifacts: readonly unknown[]) => selectSignedPackageArtifact(
      { total_count: artifacts.length, artifacts }, 'win-x64', runId, attempt, request.version,
    )
    expect(select([signed])).toMatchObject({ id: signed.id, digest: archiveDigest, size_in_bytes: 512 })
    expect(() => select([previous])).toThrow()
    expect(() => select([unsigned])).toThrow()
    expect(() => select([{ ...signed, expired: true }])).toThrow()
    expect(() => select([{ ...signed, digest: null }])).toThrow()
    expect(() => select([signed, { ...signed, id: signed.id + 3 }])).toThrow()
  })
})

describe('signed Desktop artifact intake', () => {
  it.each([
    { build: request, feedName: 'test-mac.yml' },
    { build: stableRequest, feedName: 'latest-mac.yml' },
  ])('assembles both native Mac architectures in $feedName', async ({ build, feedName }) => {
    const root = await fixtureDirectory()
    const { fixtures: [windows, arm, intel], verifyNative } = await verifiedTargets(root, build)
    const output = join(root, 'assembled')
    expect(verifyNative).toHaveBeenCalledTimes(3)
    expect(verifyNative).toHaveBeenCalledWith('win-x64', { installer: join(windows.directory, windows.updateName) }, build)
    for (const mac of [arm, intel]) {
      expect(verifyNative).toHaveBeenCalledWith(mac.target, {
        dmg: join(mac.directory, `${mac.stem}.dmg`), zip: join(mac.directory, mac.updateName),
      }, build)
    }
    await assembleSignedRelease([windows.directory, arm.directory, intel.directory], output, build)
    const feed: unknown = load(await readFile(join(output, feedName), 'utf8'))
    expect(feed).toMatchObject({ version: build.version, files: [arm.metadata, intel.metadata] })
    expect(await readFile(join(output, windows.updateName))).toEqual(windows.update)
    const report: unknown = JSON.parse(await readFile(join(output, 'signed-desktop-intake.json'), 'utf8'))
    expect(report).toMatchObject({
      ...build,
      nativeVerification: [windows, arm, intel].map(({ target, artifact }) => ({ target, ...artifact })),
    })
  })

  it.each([
    ['source commit', { ...stableRequest, sourceSha: request.workflowSha }],
    ['update channel', { ...stableRequest, channel: 'nightly' }],
  ] as const)('rejects a mismatched %s before native verification', async (_field, mismatched) => {
    const root = await fixtureDirectory()
    const { directory, target, artifact } = await writeTarget(root, 'win-x64', stableRequest)
    const verifyNative = vi.fn<Parameters<typeof verifySignedTarget>[4]>()
    await expect(verifySignedTarget(directory, target, mismatched, artifact, verifyNative))
      .rejects.toThrow(/build record disagrees with the requested/u)
    expect(verifyNative).not.toHaveBeenCalled()
  })

  it('checks feed sizes even when the package record fingerprints the altered feed', async () => {
    const root = await fixtureDirectory()
    const { directory, target, artifact } = await writeTarget(root, 'mac-arm64', request, runId, 1)
    const verifyNative = vi.fn<Parameters<typeof verifySignedTarget>[4]>()
    await expect(verifySignedTarget(directory, target, request, artifact, verifyNative)).rejects.toThrow(/size or SHA-512/u)
    expect(verifyNative).not.toHaveBeenCalled()
  })

  it('leaves no native receipt when the platform rejects the signature', async () => {
    const root = await fixtureDirectory()
    const { directory, target, artifact } = await writeTarget(root, 'win-x64', request)
    const before = (await readdir(directory)).sort()
    const verifyNative = vi.fn<Parameters<typeof verifySignedTarget>[4]>().mockRejectedValue(new Error('Wrong certificate'))
    await expect(verifySignedTarget(directory, target, request, artifact, verifyNative)).rejects.toThrow(/Wrong certificate/u)
    expect((await readdir(directory)).sort()).toEqual(before)
  })

  it('rejects a duplicated architecture and refuses bytes changed after native verification', async () => {
    const root = await fixtureDirectory()
    const { fixtures: [windows, arm, intel] } = await verifiedTargets(root, request)
    const output = join(root, 'assembled')
    await expect(assembleSignedRelease([windows.directory, arm.directory, arm.directory], output, request))
      .rejects.toThrow(/missing mac-x64 verification receipt/u)
    const blockmapName = `${intel.updateName}.blockmap`
    const blockmap = join(intel.directory, blockmapName)
    const original = await readFile(blockmap, 'utf8')
    const changed = original.replace('differential', 'Differential')
    await writeFile(blockmap, changed)
    await expect(assembleSignedRelease([windows.directory, arm.directory, intel.directory], output, request))
      .rejects.toThrow(/SHA-256 mismatch/u)

    const manifestPath = join(intel.directory, buildRecordName)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { assets: Record<string, { bytes: number; sha256: string }> }
    manifest.assets[blockmapName] = { bytes: Buffer.byteLength(changed), sha256: createHash('sha256').update(changed).digest('hex') }
    await writeFile(manifestPath, JSON.stringify(manifest))
    await expect(assembleSignedRelease([windows.directory, arm.directory, intel.directory], output, request))
      .rejects.toThrow(/manifest changed after native verification/u)
    await expect(readFile(join(output, 'signed-desktop-intake.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
