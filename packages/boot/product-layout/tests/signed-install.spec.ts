import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  installSignedRelease,
  ProductLayout,
  SignedReleaseInstallError,
  signReleaseManifest,
  WindowsRegistrationError,
  WindowsRegistrationOwnershipError,
} from '../src/index.ts'

const execFileAsync = promisify(execFile)
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentrans-signed-install-'))
  roots.push(root)
  return root
}

async function archive(root: string, version: string): Promise<string> {
  const payload = join(root, `payload-${version}`)
  await mkdir(payload, { recursive: true })
  await writeFile(join(payload, 'index.js'), `export const version = '${version}'\n`, 'utf8')
  const file = join(root, 'release.zip')
  await execFileAsync('tar', ['-cf', file, '-C', payload, '.'])
  return file
}

describe('signed release installation', () => {
  it('verifies, unpacks, installs, and registers a signed release', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    const releasePath = await archive(layout.root, '0.1.0')
    const manifest = await signReleaseManifest(releasePath, privateKey, { version: '0.1.0' })
    const result = await installSignedRelease({
      layout,
      releasePath,
      manifest,
      publicKey,
      registration: {
        productName: 'Agentrans Test',
        version: '0.1.0',
        publisher: 'Agentrans',
        uninstallKey: 'HKCU\\Software\\AgentransTest',
        shortcutPath: join(layout.root, 'Agentrans Test.lnk'),
      },
      registrationReader: async () => ({ registry: 'missing', shortcut: 'missing' }),
      runner: async (file, args) => {
        if (file === 'tar.exe') await execFileAsync(file, [...args])
      },
    })
    expect(result.install.manifest.appVersion).toBe('0.1.0')
    expect(result.registration?.displayName).toBe('Agentrans Test')
    expect(await readFile(join(layout.appDir, 'index.js'), 'utf8')).toContain('0.1.0')
  })

  it('rejects a tampered release before changing the app directory', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    const releasePath = await archive(layout.root, '0.1.0')
    const manifest = await signReleaseManifest(releasePath, privateKey, { version: '0.1.0' })
    await writeFile(releasePath, 'tampered release bytes', 'utf8')
    await expect(installSignedRelease({ layout, releasePath, manifest, publicKey, register: false }))
      .rejects.toMatchObject({ code: 'RELEASE_CONTENT_MISMATCH' })
    await expect(readFile(join(layout.appDir, 'index.js'), 'utf8')).rejects.toThrow()
  })

  it('reports an installed app when Windows registration fails', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    const releasePath = await archive(layout.root, '0.1.0')
    const manifest = await signReleaseManifest(releasePath, privateKey, { version: '0.1.0' })
    let failure: unknown
    try {
      await installSignedRelease({
        layout,
        releasePath,
        manifest,
        publicKey,
        registration: {
          productName: 'Agentrans Test',
          version: '0.1.0',
          publisher: 'Agentrans',
          uninstallKey: 'HKCU\\Software\\AgentransTest',
          shortcutPath: join(layout.root, 'Agentrans Test.lnk'),
        },
        registrationReader: async () => ({ registry: 'missing', shortcut: 'missing' }),
        runner: async (file, args) => {
          if (file === 'reg.exe') throw new Error('registry failed')
          await execFileAsync(file, [...args])
        },
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(SignedReleaseInstallError)
    if (failure instanceof SignedReleaseInstallError) {
      expect(failure.install.manifest.appVersion).toBe('0.1.0')
      expect(failure.registrationError).toBeInstanceOf(WindowsRegistrationError)
    }
    expect(await readFile(join(layout.appDir, 'index.js'), 'utf8')).toContain('0.1.0')
  })

  it('refuses foreign registration before preparing or replacing the installed app', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    const releasePath = await archive(layout.root, '0.1.0')
    const manifest = await signReleaseManifest(releasePath, privateKey, { version: '0.1.0' })
    const refusal = new WindowsRegistrationOwnershipError('registry', 'HKCU\\Software\\foreign', 'FOREIGN')
    await expect(installSignedRelease({ layout, releasePath, manifest, publicKey,
      registration: { version: '0.1.0', publisher: 'Agentrans' },
      registrationReader: async () => { throw refusal },
    })).rejects.toBe(refusal)
    await expect(readFile(join(layout.appDir, 'index.js'), 'utf8')).rejects.toThrow()
  })

  it('reports the installed app when registration ownership changes after unpacking', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    const releasePath = await archive(layout.root, '0.1.0')
    const manifest = await signReleaseManifest(releasePath, privateKey, { version: '0.1.0' })
    const refusal = new WindowsRegistrationOwnershipError('registry', 'HKCU\\Software\\foreign', 'FOREIGN')
    let inspections = 0
    const attempt = installSignedRelease({ layout, releasePath, manifest, publicKey,
      registration: { version: '0.1.0', publisher: 'Agentrans' },
      registrationReader: async () => {
        if (inspections++ > 0) throw refusal
        return { registry: 'missing', shortcut: 'missing' }
      },
      runner: async (file, args) => { if (file === 'tar.exe') await execFileAsync(file, [...args]) },
    })
    await expect(attempt).rejects.toBeInstanceOf(SignedReleaseInstallError)
    await expect(attempt).rejects.toMatchObject({ registrationError: refusal,
      install: { manifest: { appVersion: '0.1.0' } } })
    expect(await readFile(join(layout.appDir, 'index.js'), 'utf8')).toContain('0.1.0')
  })
})
