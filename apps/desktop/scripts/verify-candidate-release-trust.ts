/** Read platform, feed, source and Ed25519 trust from the retained Desktop packages. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, createPublicKey } from 'node:crypto'
import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { load } from 'js-yaml'
import { prerelease } from 'semver'
import { z } from 'zod'
import { desktopReleaseArtifactStems, type DesktopReleaseTarget } from '../src/update-release-assets.ts'
import { UPDATE_SIGNING_PUBLIC_KEY } from '../src/update-signing-key.ts'
import { publicKeyFromBase64, sha256File } from '../src/update-signature.ts'
import { DESKTOP_ARTIFACT_SLUG, DESKTOP_PRODUCT_NAME } from './desktop-product-identity.mjs'
import { DESKTOP_UPDATE_REPOSITORY } from './desktop-release-environment.mjs'
import type { HostedDesktopReleasePlan } from './stage-hosted-desktop-release.ts'

const run = promisify(execFile)
const require = createRequire(import.meta.url)
// Keep the verification reader on the same locked ASAR implementation as the packager.
const asar = createRequire(require.resolve('app-builder-lib'))('@electron/asar') as {
  extractFile(path: string, filename: string): Buffer
}
const targets = ['win-x64', 'mac-arm64', 'mac-x64'] as const
const keyPath = 'distribution/keys/agentrans-update-ed25519-public.pem'
const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  main: z.literal('lib/main.js'),
  dshDesktopUpdateChannel: z.enum(['nightly', 'latest']),
  dshBuildCommit: z.string().optional(),
  dshBuildDirty: z.boolean().optional(),
})
const feedSchema = z.object({ provider: z.literal('github'), owner: z.string(), repo: z.string(), channel: z.string() })

async function extract(archive: string, output: string, members: readonly string[], flatten = false): Promise<void> {
  await run('7z', [
    flatten ? 'e' : 'x', '-y', '-bb0', '-bso0', '-bsp0', '-spd',
    ...(flatten ? ['-r'] : []), '-o' + output, archive, ...members,
  ], { timeout: 180_000, maxBuffer: 1024 * 1024, windowsHide: true })
}

async function extractApplication(
  input: string, scratch: string, plan: HostedDesktopReleasePlan, target: DesktopReleaseTarget,
): Promise<{ resources: string; executable: string }> {
  const archive = plan.archives.find(entry => entry.target === target || entry.target === 'mac' && target !== 'win-x64')
  assert.ok(archive, 'Missing retained archive for ' + target)
  const directory = join(input, archive.target)
  const extension = target === 'win-x64' ? '.exe' : '.zip'
  const names = desktopReleaseArtifactStems(DESKTOP_ARTIFACT_SLUG, plan.version, target).map(stem => stem + extension)
  const installers = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && names.includes(entry.name))
  const installer = installers[0]
  assert.ok(installers.length === 1 && installer, 'Expected one installer for ' + target)
  const payload = join(directory, installer.name)
  const resources = ['app.asar', 'app-update.yml', keyPath]

  if (target === 'win-x64') {
    await extract(payload, scratch, ['app-64.7z'], true)
    const executable = DESKTOP_PRODUCT_NAME + '.exe'
    await extract(join(scratch, 'app-64.7z'), scratch, [executable, ...resources.map(name => 'resources/' + name)])
    return { resources: join(scratch, 'resources'), executable: join(scratch, executable) }
  }

  const bundle = DESKTOP_PRODUCT_NAME + '.app/Contents'
  const executable = bundle + '/MacOS/' + DESKTOP_PRODUCT_NAME
  await extract(payload, scratch, [executable, ...resources.map(name => bundle + '/Resources/' + name)])
  return { resources: join(scratch, bundle, 'Resources'), executable: join(scratch, executable) }
}

async function verifyArchitecture(path: string, target: DesktopReleaseTarget): Promise<void> {
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(64)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    assert.equal(bytesRead, header.length, 'Incomplete executable header for ' + target)
    if (target === 'win-x64') {
      assert.equal(header.toString('ascii', 0, 2), 'MZ', 'Expected a Windows executable')
      const pe = Buffer.alloc(6)
      assert.equal((await file.read(pe, 0, pe.length, header.readUInt32LE(60))).bytesRead, pe.length)
      assert.equal(pe.readUInt32LE(0), 0x4550, 'Expected a PE header')
      assert.equal(pe.readUInt16LE(4), 0x8664, 'Expected a Windows x64 executable')
      return
    }
    assert.equal(header.readUInt32LE(0), 0xfeedfacf, 'Expected a single-architecture 64-bit Mac executable')
    const cpu = target === 'mac-arm64' ? 0x0100000c : 0x01000007
    assert.equal(header.readUInt32LE(4), cpu, 'Unexpected executable architecture for ' + target)
  } finally {
    await file.close()
  }
}

/**
 * Verify the actual packaged app without starting it or changing any Release.
 * @param input - Downloaded archives organized by the plan's target names.
 * @param plan - Expected version, channel, source and archive topology.
 * @returns Identity and public-key evidence for all three architectures.
 */
export async function verifyCandidateReleaseTrust(input: string, plan: HostedDesktopReleasePlan) {
  const pin = publicKeyFromBase64(UPDATE_SIGNING_PUBLIC_KEY)
  const publicKeySha256 = createHash('sha256').update(pin.export({ format: 'der', type: 'spki' })).digest('hex')
  const packages = []
  const expectedFeedChannel = String(prerelease(plan.version)?.[0] ?? 'latest')
  for (const target of targets) {
    const scratch = await mkdtemp(join(tmpdir(), 'agentrans-release-trust-'))
    try {
      const { resources, executable } = await extractApplication(input, scratch, plan, target)
      await verifyArchitecture(executable, target)
      const archive = join(resources, 'app.asar')
      const manifest = manifestSchema.parse(JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8')))
      assert.equal(manifest.name, DESKTOP_ARTIFACT_SLUG, target + ' product identity')
      assert.equal(manifest.version, plan.version, target + ' packaged version')
      assert.equal(manifest.dshDesktopUpdateChannel, plan.channel, target + ' packaged channel')
      if (manifest.dshBuildCommit !== undefined || manifest.dshBuildDirty !== undefined) {
        assert.equal(manifest.dshBuildCommit, plan.sourceSha, target + ' packaged commit')
        assert.equal(manifest.dshBuildDirty, false, target + ' packaged checkout cleanliness')
      }
      assert.ok(asar.extractFile(archive, manifest.main).includes(UPDATE_SIGNING_PUBLIC_KEY), target + ' packaged updater public key')
      const pem = await readFile(join(resources, keyPath), 'utf8')
      assert.ok(createPublicKey(pem).equals(pin), target + ' distributed PEM')
      const feed = feedSchema.parse(load(await readFile(join(resources, 'app-update.yml'), 'utf8')))
      assert.equal(feed.owner, DESKTOP_UPDATE_REPOSITORY.owner, target + ' feed owner')
      assert.equal(feed.repo, DESKTOP_UPDATE_REPOSITORY.repo, target + ' feed repository')
      assert.ok(feed.channel === plan.channel || feed.channel === expectedFeedChannel, target + ' feed channel')
      packages.push({
        target, version: manifest.version, channel: manifest.dshDesktopUpdateChannel,
        embeddedCommit: manifest.dshBuildCommit ?? null, feedChannel: feed.channel, asarSha256: await sha256File(archive),
      })
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
  return { publicKeySha256, packages }
}
