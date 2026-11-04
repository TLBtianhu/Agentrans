import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import {
  activateRuntime,
  createInstallManifest,
  ensureProductLayout,
  ProductLayout,
  readInstallManifest,
  relocatePyvenv,
  writeInstallManifest,
  type ProductChannel,
} from '../src/index.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentrans-layout-'))
  roots.push(root)
  return root
}

describe('ProductLayout', () => {
  it('derives every application, data, asset, and DSH path from one root', async () => {
    const root = await tempRoot()
    const layout = ProductLayout.fromRoot(root, 'development')
    expect(layout.appDir).toBe(join(root, 'app'))
    expect(layout.dataDir).toBe(join(root, 'data'))
    expect(layout.modelsDir).toBe(join(root, 'models'))
    expect(layout.runtimesDir).toBe(join(root, 'runtime-envs'))
    expect(layout.dshHomeDir).toBe(join(root, 'data', 'dsh', 'home'))
    expect(layout.dshAgentsHomeDir).toBe(join(root, 'data', 'dsh', 'agents'))
    expect(layout.installManifestPath).toBe(join(root, 'data', 'install', 'manifest.json'))

    const portable = ProductLayout.fromRoot(join(root, 'portable'), 'portable')
    const installed = ProductLayout.fromRoot(join(root, 'installed'), 'installed')
    expect(portable.dataDir).not.toBe(installed.dataDir)
    expect(portable.dshHomeDir).not.toBe(installed.dshHomeDir)
    expect(() => ProductLayout.fromRoot('', 'installed')).toThrow('root must be non-empty')
    expect(() => ProductLayout.fromRoot(root, 'other' as ProductChannel)).toThrow('Unsupported product channel')
  })

  it('creates fixed subdirectories without replacing existing data', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'portable')
    const existing = join(layout.dataDir, 'sessions', 'existing.txt')
    await mkdir(join(layout.dataDir, 'sessions'), { recursive: true })
    await writeFile(existing, 'keep me', 'utf8')
    await ensureProductLayout(layout)
    expect(await readFile(existing, 'utf8')).toBe('keep me')
    expect((await stat(layout.dshHomeDir)).isDirectory()).toBe(true)
    expect((await stat(join(layout.dataDir, 'settings'))).isDirectory()).toBe(true)
  })
})

describe('InstallManifest', () => {
  it('round-trips a complete manifest and rejects unsupported layout versions', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    const now = new Date('2026-11-04T00:00:00.000Z')
    const manifest = createInstallManifest(layout, '0.1.0', { now })
    await writeInstallManifest(layout.installManifestPath, manifest)
    expect(await readInstallManifest(layout.installManifestPath)).toEqual(manifest)
    await writeFile(layout.installManifestPath, JSON.stringify({ ...manifest, layoutVersion: 99 }), 'utf8')
    await expect(readInstallManifest(layout.installManifestPath)).rejects.toThrow('layoutVersion is unsupported')
  })
})

describe('runtime activation', () => {
  it('relocates pyvenv configuration and writes active state only after self-test', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    const runtimeDir = join(layout.runtimesDir, 'runtime-test')
    await mkdir(join(runtimeDir, 'Scripts'), { recursive: true })
    await writeFile(join(runtimeDir, 'Scripts', 'python.exe'), '', 'utf8')
    await writeFile(join(runtimeDir, 'pyvenv.cfg'), 'home = C:\\old\\Scripts\nexecutable = C:\\old\\Scripts\\python.exe\ninclude-system-site-packages = true\ncommand = do-not-run\n', 'utf8')
    const calls: string[] = []
    const record = await activateRuntime({
      layout, id: 'runtime-test', version: '1.0.0', sha256: 'a'.repeat(64), now: new Date('2026-11-04T00:00:00.000Z'),
      verify: async () => { calls.push('verify') },
      selfTest: async (executable) => { calls.push(`selfTest:${executable}`) },
    })
    expect(calls[0]).toBe('verify')
    expect(calls[1]).toBe(`selfTest:${join(runtimeDir, 'Scripts', 'python.exe')}`)
    expect(record.state).toBe('active')
    expect(record.location).toBe(relative(layout.root, runtimeDir))
    const config = await readFile(join(runtimeDir, 'pyvenv.cfg'), 'utf8')
    expect(config).toContain(`home = ${join(runtimeDir, 'Scripts')}`)
    expect(config).toContain(`executable = ${join(runtimeDir, 'Scripts', 'python.exe')}`)
    expect(config).toContain('include-system-site-packages = false')
    expect(config).toContain('command = do-not-run')
    expect(JSON.parse(await readFile(join(runtimeDir, 'active-runtime.json'), 'utf8')).state).toBe('active')
  })

  it('does not write active state when self-test fails', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    const runtimeDir = join(layout.runtimesDir, 'runtime-test')
    await mkdir(join(runtimeDir, 'Scripts'), { recursive: true })
    await writeFile(join(runtimeDir, 'Scripts', 'python.exe'), '', 'utf8')
    await writeFile(join(runtimeDir, 'pyvenv.cfg'), 'home = C:\\old\\Scripts\n', 'utf8')
    await expect(activateRuntime({
      layout, id: 'runtime-test', version: '1.0.0', sha256: 'b'.repeat(64),
      verify: async () => {},
      selfTest: async () => { throw new Error('interpreter failed') },
    })).rejects.toMatchObject({ code: 'RUNTIME_SELF_TEST_FAILED' })
    await expect(readFile(join(runtimeDir, 'active-runtime.json'), 'utf8')).rejects.toThrow()
  })

  it('rejects a missing interpreter before self-test and never trusts relocation alone', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    const runtimeDir = join(layout.runtimesDir, 'runtime-test')
    await mkdir(runtimeDir, { recursive: true })
    await writeFile(join(runtimeDir, 'pyvenv.cfg'), 'home = C:\\old\\Scripts\n', 'utf8')
    let selfTestCalled = false
    await expect(activateRuntime({
      layout, id: 'runtime-test', version: '1.0.0', sha256: 'c'.repeat(64),
      verify: async () => {},
      selfTest: async () => { selfTestCalled = true },
    })).rejects.toMatchObject({ code: 'RUNTIME_RELOCATE_FAILED' })
    expect(selfTestCalled).toBe(false)
    await expect(readFile(join(runtimeDir, 'active-runtime.json'), 'utf8')).rejects.toThrow()
  })
})

describe('pyvenv relocation', () => {
  it('adds required fields when the source omits them', () => {
    const result = relocatePyvenv('command = preserved\n', 'D:\\runtime')
    expect(result).toContain('home = D:\\runtime\\Scripts')
    expect(result).toContain('executable = D:\\runtime\\Scripts\\python.exe')
    expect(result).toContain('include-system-site-packages = false')
    expect(result).toContain('command = preserved')
  })
})
