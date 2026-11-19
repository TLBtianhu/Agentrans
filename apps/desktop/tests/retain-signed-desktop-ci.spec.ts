import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { retainSignedDesktopCi } from '../scripts/retain-signed-desktop-ci.mjs'

const roots: string[] = []
const version = '1.2.3-alpha.4'
const workflowSha = 'a'.repeat(40)
const productionDispatch = {
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  AGENTRANS_PACKAGING_PRESET: 'production',
  PACKAGE_SIGNING: 'signed',
  PACKAGE_SKIP_NOTARIZATION: 'false',
}
const targets = [
  ['win-x64', ['exe', 'exe.blockmap'], 'alpha.yml'],
  ['mac-arm64', ['dmg', 'zip', 'zip.blockmap'], 'alpha-mac.yml'],
  ['mac-x64', ['dmg', 'zip', 'zip.blockmap'], 'alpha-mac.yml'],
] as const
type FixtureTarget = (typeof targets)[number]

async function fixture([target, suffixes, feed]: FixtureTarget, overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-signed-retention-'))
  roots.push(root)
  const workspace = join(root, 'source')
  const temporary = join(root, 'temporary')
  const config = join(root, 'config')
  const artifacts = join(workspace, 'apps', 'desktop', '.desktop-build', 'targets', target, 'artifacts')
  const preset = join(config, 'presets', 'production.env')
  await Promise.all([mkdir(artifacts, { recursive: true }), mkdir(temporary), mkdir(join(config, 'presets'), { recursive: true })])
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=Packaging Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture', '--allow-empty')
  const commit = git('rev-parse', 'HEAD')
  const filenames = [...suffixes.map(suffix => `agentrans-${version}-${target}.${suffix}`), feed]
  const buildRecordName = `${target}-release.json`
  await Promise.all([
    writeFile(preset, '\uFEFFAGENTRANS_DESKTOP_APP_ID=com.agentrans.app\n'),
    writeFile(join(artifacts, buildRecordName), JSON.stringify({
      schemaVersion: 1, target, version, provider: 'github', owner: 'TLBtianhu', repo: 'Agentrans', channel: 'nightly', commit, dirty: false, ...overrides,
    })),
    ...filenames.map(name => writeFile(join(artifacts, name), `bytes for ${name}`)),
  ])
  const output = join(root, 'github-output')
  const env: NodeJS.ProcessEnv = {
    ...productionDispatch,
    PACKAGE_SOURCE_REF: 'main',
    PACKAGE_VERSION: version,
    AGENTRANS_DESKTOP_UPDATE_CHANNEL: 'nightly',
    GITHUB_RUN_ID: '12345678901',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_WORKFLOW_SHA: workflowSha,
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: temporary,
    GITHUB_OUTPUT: output,
    AGENTRANS_PACKAGING_CONFIG_DIR: config,
  }
  return { env, git, workspace, commit, temporary, artifacts, preset, output, filenames, buildRecordName }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('production signed Desktop retention', () => {
  it.each(targets.map(spec => ({ target: spec[0], spec })))('records the exact release bytes for $target', async ({ target, spec }) => {
    const f = await fixture(spec)
    await mkdir(join(f.artifacts, 'unpacked'))
    await writeFile(join(f.artifacts, 'builder-debug.yml'), 'packager diagnostics')
    const directory = await retainSignedDesktopCi(target, f.env)
    const assetNames = [...f.filenames, f.buildRecordName]
    const manifestName = 'desktop-signed-build.json'
    expect((await readdir(directory)).sort()).toEqual([...assetNames, manifestName].sort())
    const assets = Object.fromEntries(await Promise.all(assetNames.map(async (name) => {
      const bytes = await readFile(join(f.artifacts, name))
      expect(await readFile(join(directory, name))).toEqual(bytes)
      return [name, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] as const
    })))
    expect(JSON.parse(await readFile(join(directory, manifestName), 'utf8'))).toEqual({
      schemaVersion: 1, target, commit: f.commit, version, channel: 'nightly', appId: 'com.agentrans.app', preset: 'production',
      sourceRef: 'main', runId: 12345678901, runAttempt: 2, workflowSha, assets,
    })
    expect(await readFile(f.output, 'utf8')).toBe(`directory=${directory}\n`)
  })

  it('runs from a trusted helper staged outside a checkout with no copy of the helper', async () => {
    const f = await fixture(targets[2])
    const script = join(f.temporary, 'retain-signed-desktop-ci.mjs')
    await copyFile(new URL('../scripts/retain-signed-desktop-ci.mjs', import.meta.url), script)
    execFileSync(process.execPath, [script, 'mac-x64'], { cwd: f.workspace, env: { ...process.env, ...f.env } })
    const output = await readFile(f.output, 'utf8')
    const directory = output.trimEnd().slice('directory='.length)
    expect(await readFile(join(directory, 'desktop-signed-build.json'), 'utf8')).toContain(workflowSha)
  })

  it.each([{ dirty: true }, { commit: workflowSha }, { channel: 'latest' }, { repo: 'another-repo' }])(
    'rejects release records that disagree with the build (%j)', async (record) => {
      const f = await fixture(targets[0], record)
      await expect(retainSignedDesktopCi('win-x64', f.env)).rejects.toThrow('release record does not match')
      expect(await readdir(f.temporary)).toEqual([])
      await expect(readFile(f.output)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('rejects a different production application identity', async () => {
    const f = await fixture(targets[0])
    await writeFile(f.preset, 'AGENTRANS_DESKTOP_APP_ID=com.deepseek.harness\n')
    await expect(retainSignedDesktopCi('win-x64', f.env)).rejects.toThrow('production preset must select com.agentrans.app')
  })

  it('requires the selected branch or matching product tag to identify the checkout', async () => {
    const f = await fixture(targets[0])
    await expect(retainSignedDesktopCi('win-x64', { ...f.env, PACKAGE_SOURCE_REF: 'master' })).rejects.toThrow('selected branch does not match')
    f.git('branch', 'master')
    f.git('checkout', '-q', 'master')
    await expect(retainSignedDesktopCi('win-x64', { ...f.env, PACKAGE_SOURCE_REF: 'master' })).resolves.toContain('retained-signed-win-x64')
    const tag = 'dsh-v1.2.3'
    f.git('tag', tag)
    f.git('checkout', '-q', '--detach', tag)
    await writeFile(join(f.workspace, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    await expect(retainSignedDesktopCi('win-x64', { ...f.env, PACKAGE_SOURCE_REF: `${tag}-trial` })).rejects.toThrow('selected tag does not match')
    await expect(retainSignedDesktopCi('win-x64', { ...f.env, PACKAGE_SOURCE_REF: tag })).resolves.toContain('retained-signed-win-x64')
  })

  it('rejects a qualified naming set with missing or empty files', async () => {
    const f = await fixture(targets[1])
    const file = join(f.artifacts, `agentrans-${version}-mac-arm64.dmg`)
    await rm(file)
    await expect(retainSignedDesktopCi('mac-arm64', f.env)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(file, '')
    await expect(retainSignedDesktopCi('mac-arm64', f.env)).rejects.toThrow('expected a nonempty regular file')
    expect(await readdir(f.temporary)).toEqual([])
  })

  it.each([
    ['mac-x64', { PACKAGE_SKIP_NOTARIZATION: 'true' }],
    ['mac-x64', { AGENTRANS_PACKAGING_PRESET: 'test' }],
    ['win-x64', { PACKAGE_SIGNING: 'unsigned' }],
  ] as const)('never gives %s debug or test builds a production record', async (target, env) => {
    await expect(retainSignedDesktopCi(target, { ...productionDispatch, ...env })).rejects.toThrow('requires a production signed Windows or notarized macOS dispatch')
  })
})
