import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  packInstalled,
  packPortable,
  planInstall,
  ProductLayout,
  readInstallManifest,
  writeInstallManifest,
} from '../src/index.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentrans-install-'))
  roots.push(root)
  return root
}

async function payload(root: string, version: string): Promise<string> {
  const source = join(root, `payload-${version}`)
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'index.js'), `export const version = '${version}'\n`, 'utf8')
  return source
}

describe('file-level install and upgrade', () => {
  it('packs a portable app with no external registration and preserves data on upgrade', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'portable')
    const first = await packPortable(layout, '0.1.0', { sourceDir: await payload(layout.root, 'one'), now: new Date('2026-11-04T00:00:00.000Z') })
    expect(first.manifest.channel).toBe('portable')
    expect(first.externalOperations).toEqual([])
    expect(await readFile(join(layout.appDir, 'index.js'), 'utf8')).toContain('one')

    await mkdir(join(layout.dataDir, 'sessions'), { recursive: true })
    await writeFile(join(layout.dataDir, 'sessions', 'keep.txt'), 'keep', 'utf8')
    const second = await packPortable(layout, '0.2.0', { sourceDir: await payload(layout.root, 'two'), now: new Date('2026-11-04T01:00:00.000Z') })
    expect(second.manifest.appVersion).toBe('0.2.0')
    expect(second.manifest.createdAt).toBe(first.manifest.createdAt)
    expect(await readFile(join(layout.dataDir, 'sessions', 'keep.txt'), 'utf8')).toBe('keep')
    expect(await readFile(join(layout.appDir, 'index.js'), 'utf8')).toContain('two')
  })

  it('reports installed registration operations and preserves assets across upgrades', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    const first = await packInstalled(layout, '0.1.0', { sourceDir: await payload(layout.root, 'one'), now: new Date('2026-11-04T00:00:00.000Z') })
    expect(first.externalOperations).toEqual(['windows:register-uninstall-entry', 'windows:register-start-menu-shortcut'])
    await mkdir(join(layout.modelsDir), { recursive: true })
    await mkdir(join(layout.runtimesDir), { recursive: true })
    await writeFile(join(layout.modelsDir, 'model.bin'), 'model', 'utf8')
    await writeFile(join(layout.runtimesDir, 'runtime.bin'), 'runtime', 'utf8')
    await writeInstallManifest(layout.installManifestPath, {
      ...first.manifest,
      assets: { runtime: { id: 'runtime', version: '1.0.0', sha256: 'a'.repeat(64), location: 'runtime-envs/runtime', state: 'active' } },
    })

    const second = await packInstalled(layout, '0.2.0', { sourceDir: await payload(layout.root, 'two') })
    expect(second.manifest.appVersion).toBe('0.2.0')
    expect(second.manifest.createdAt).toBe(first.manifest.createdAt)
    expect(second.manifest.assets.runtime?.state).toBe('active')
    expect(await readFile(join(layout.modelsDir, 'model.bin'), 'utf8')).toBe('model')
    expect(await readFile(join(layout.runtimesDir, 'runtime.bin'), 'utf8')).toBe('runtime')
    expect((await readInstallManifest(layout.installManifestPath)).appVersion).toBe('0.2.0')
  })

  it('rejects payloads containing user data before replacing the app', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    await packInstalled(layout, '0.1.0', { sourceDir: await payload(layout.root, 'one') })
    const dirty = await payload(layout.root, 'two')
    await mkdir(join(dirty, 'data'), { recursive: true })
    await writeFile(join(dirty, 'data', 'secret.txt'), 'do not package', 'utf8')
    await expect(packInstalled(layout, '0.2.0', { sourceDir: dirty })).rejects.toThrow('must not contain data')
    expect(await readFile(join(layout.appDir, 'index.js'), 'utf8')).toContain('one')
  })

  it('previews replacement and preservation without creating the app directory', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    const plan = await planInstall(layout, '0.1.0')
    expect(plan.replace).toEqual([layout.appDir])
    expect(plan.preserve).toEqual([layout.dataDir, layout.modelsDir, layout.runtimesDir])
    expect(plan.requiresAdmin).toBe(false)
    expect(plan.externalOperations).toContain('windows:register-uninstall-entry')
    await expect(readFile(join(layout.appDir, 'index.js'), 'utf8')).rejects.toThrow()
  })
})
