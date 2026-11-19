import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const helper = fileURLToPath(new URL('../scripts/prepare-hosted-macos-ci.mjs', import.meta.url))
const desktopManifest = new URL('../package.json', import.meta.url)
const roots: string[] = []
const certificate = Buffer.from('fictional test certificate')
const key = Buffer.from('fictional test key')
const password = ' password\' with #, " and spaces '
const signing = {
  MACOS_DEVELOPER_ID_P12_BASE64: certificate.toString('base64'),
  MACOS_DEVELOPER_ID_P12_PASSWORD: password,
  MACOS_NOTARIZATION_KEY_P8_BASE64: key.toString('base64'),
  MACOS_NOTARIZATION_KEY_ID: 'A1B2C3D4E5',
  MACOS_NOTARIZATION_ISSUER_ID: '12345678-1234-1234-1234-1234567890ab',
  DESKTOP_MACOS_TEAM_ID: 'TEAM123456',
  DESKTOP_MACOS_SIGNING_IDENTITY: 'Test Company (TEAM123456)',
}

async function fixture(arch = 'arm64') {
  const created = await mkdtemp(join(tmpdir(), 'hosted-macos-packaging-'))
  roots.push(created)
  const root = await realpath(created)
  const workspace = join(root, 'checkout')
  const temporary = join(root, 'runner-temp')
  const output = join(root, 'github-env')
  await Promise.all([mkdir(workspace), mkdir(temporary)])
  const config = join(temporary, `agentrans-hosted-macos-1234567890-2-${arch}`)
  const environment: NodeJS.ProcessEnv = {
    AGENTRANS_DESKTOP_TARGET_PLATFORM: 'darwin', AGENTRANS_DESKTOP_TARGET_ARCH: arch,
    AGENTRANS_PACKAGING_PRESET: 'production', PACKAGE_SKIP_NOTARIZATION: 'false', PACKAGE_SOURCE_REF: 'main',
    AGENTRANS_DESKTOP_UPDATE_CHANNEL: 'nightly', PACKAGE_MACOS_ZIP_COMPRESSION_LEVEL: '3', PACKAGE_VERSION_MODE: 'product',
    GITHUB_WORKSPACE: workspace, RUNNER_TEMP: temporary, GITHUB_RUN_ID: '1234567890', GITHUB_RUN_ATTEMPT: '2', GITHUB_ENV: output,
  }
  function run(command: string, overrides: NodeJS.ProcessEnv = {}) {
    const result = spawnSync(process.execPath, [helper, command], {
      cwd: workspace, env: { ...process.env, ...environment, ...overrides }, encoding: 'utf8', windowsHide: true, timeout: 15_000,
    })
    if (result.error) throw result.error
    return result
  }
  return { config, run, temporary, workspace, output, published: { AGENTRANS_PACKAGING_CONFIG_DIR: config } }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('hosted macOS packaging configuration', () => {
  it.each(['arm64', 'x64'])('creates only the public production preset for %s and removes its owned root', async (arch) => {
    const f = await fixture(arch)
    const result = f.run('public')
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const manifest = JSON.parse(await readFile(desktopManifest, 'utf8')) as { version: string }
    expect(parseEnv(await readFile(f.output, 'utf8'))).toEqual({
      ...f.published, PACKAGE_VERSION: manifest.version,
    })
    const preset = join(f.config, 'presets', 'production.env')
    expect(await readFile(preset, 'utf8')).toBe('AGENTRANS_DESKTOP_APP_ID=com.agentrans.app\n')
    expect((await readdir(f.config)).sort()).toEqual(['.hosted-macos-config', 'presets'])
    if (process.platform !== 'win32') {
      expect((await stat(f.config)).mode & 0o777).toBe(0o700)
      expect((await stat(preset)).mode & 0o777).toBe(0o600)
    }
    expect(f.run('cleanup', f.published).status).toBe(0)
    expect(f.run('cleanup', f.published).status).toBe(0)
    expect(await readdir(f.temporary)).toEqual([])
  })

  it.each([{ PACKAGE_SKIP_NOTARIZATION: 'true' }, { AGENTRANS_PACKAGING_PRESET: 'test' }, { AGENTRANS_DESKTOP_UPDATE_CHANNEL: 'broken' }])(
    'rejects nonproduction settings before creating files (%j)', async (overrides) => {
      const f = await fixture()
      expect(f.run('public', overrides).status).toBe(1)
      expect(await readdir(f.temporary)).toEqual([])
    },
  )

  it('refuses temporary configuration in the checkout', async () => {
    const f = await fixture()
    const result = f.run('public', { RUNNER_TEMP: f.workspace })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('RUNNER_TEMP outside the checkout')
    expect(await readdir(f.workspace)).toEqual([])
  })

  it('removes a partial public configuration when publication of its path fails', async () => {
    const f = await fixture()
    expect(f.run('public', { GITHUB_ENV: f.workspace }).status).toBe(1)
    expect(await readdir(f.temporary)).toEqual([])
  })

  it('materializes distinct private signing files and preserves a complex export password', async () => {
    const f = await fixture()
    expect(f.run('public').status).toBe(0)
    const result = f.run('credentials', { ...f.published, ...signing })
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const paths = [join(f.config, 'certificates', 'developer-id.p12'), join(f.config, 'certificates', 'notarization.p8'),
      join(f.config, 'secrets', 'macos-signing.env')] as const
    expect(await readFile(paths[0])).toEqual(certificate)
    expect(await readFile(paths[1])).toEqual(key)
    expect(parseEnv(await readFile(paths[2], 'utf8'))).toEqual({
      AGENTRANS_DESKTOP_MACOS_SIGNING_IDENTITY: signing.DESKTOP_MACOS_SIGNING_IDENTITY,
      AGENTRANS_DESKTOP_MACOS_TEAM_ID: signing.DESKTOP_MACOS_TEAM_ID,
      CSC_LINK: '../certificates/developer-id.p12', CSC_KEY_PASSWORD: password,
      APPLE_API_KEY: '../certificates/notarization.p8', APPLE_API_KEY_ID: signing.MACOS_NOTARIZATION_KEY_ID,
      APPLE_API_ISSUER: signing.MACOS_NOTARIZATION_ISSUER_ID,
    })
    if (process.platform !== 'win32') {
      for (const path of paths) expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
    expect(f.run('cleanup', f.published).status).toBe(0)
    expect(await readdir(f.temporary)).toEqual([])
  })

  it.each([
    ['MACOS_DEVELOPER_ID_P12_BASE64', 'AB==', 'MACOS_DEVELOPER_ID_P12_BASE64'],
    ['MACOS_NOTARIZATION_KEY_P8_BASE64', 'not a Base64 payload', 'MACOS_NOTARIZATION_KEY_P8_BASE64'],
    ['MACOS_NOTARIZATION_KEY_ID', 'bad-value', 'MACOS_NOTARIZATION_KEY_ID'],
    ['MACOS_NOTARIZATION_ISSUER_ID', 'bad-issuer', 'MACOS_NOTARIZATION_ISSUER_ID'],
    ['MACOS_DEVELOPER_ID_P12_PASSWORD', 'cannot\'choose`a"delimiter', 'CSC_KEY_PASSWORD'],
  ])('rejects invalid %s without logging the value or writing signing files', async (name, value, label) => {
    const f = await fixture()
    expect(f.run('public').status).toBe(0)
    const result = f.run('credentials', { ...f.published, ...signing, [name]: value })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(label)
    expect(result.stderr).not.toContain(value)
    expect((await readdir(f.config)).sort()).toEqual(['.hosted-macos-config', 'presets'])
  })

  it('refuses cleanup of unowned or substituted directories', async () => {
    const f = await fixture()
    const unrelated = join(f.temporary, 'unrelated')
    await mkdir(unrelated)
    expect(f.run('cleanup', { AGENTRANS_PACKAGING_CONFIG_DIR: unrelated }).stderr).toContain('does not match this run')
    await mkdir(f.config, { mode: 0o700 })
    expect(f.run('cleanup').stderr).toContain('has no matching ownership marker')
    expect((await readdir(f.temporary)).sort()).toEqual(['agentrans-hosted-macos-1234567890-2-arm64', 'unrelated'])
  })

  it('rejects a host that does not match the native architecture', async () => {
    const arch = process.arch === 'arm64' ? 'x64' : 'arm64'
    const f = await fixture(arch)
    const result = f.run('check', f.published)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`requires a native macOS ${arch} runner`)
  })
})
