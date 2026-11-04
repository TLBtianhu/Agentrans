import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  planWindowsRegistration,
  ProductLayout,
  removeWindowsRegistration,
  signReleaseManifest,
  verifyWindowsRegistration,
  type WindowsRegistrationPlan,
} from '../../../packages/boot/product-layout/src/index.ts'

const execFileAsync = promisify(execFile)
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const roots: string[] = []
const registrations: WindowsRegistrationPlan[] = []
const installer = 'C:/agent制作/deepseek-harness/apps/desktop/installer/agentrans-installer.mjs'
const publicPem = publicKey.export({ type: 'spki', format: 'pem' })

afterEach(async () => {
  for (const plan of registrations.splice(0)) await removeWindowsRegistration(plan).catch(() => {})
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setupRelease(version: string): Promise<{
  root: string
  releasePath: string
  manifestPath: string
  publicKeyPath: string
  registration: WindowsRegistrationPlan
}> {
  const root = await mkdtemp(join(tmpdir(), 'agentrans-installer-cli-'))
  roots.push(root)
  const payload = join(root, 'payload')
  await mkdir(payload, { recursive: true })
  await writeFile(join(payload, 'index.js'), `export const version = '${version}'\n`, 'utf8')
  const releasePath = join(root, 'release.zip')
  await execFileAsync('tar', ['-cf', releasePath, '-C', payload, '.'])
  const manifestPath = join(root, 'release.json')
  await writeFile(manifestPath, JSON.stringify(await signReleaseManifest(releasePath, privateKey, { version }), null, 2), 'utf8')
  const publicKeyPath = join(root, 'public.pem')
  await writeFile(publicKeyPath, publicPem, 'utf8')
  const layout = ProductLayout.fromRoot(root, 'installed')
  const registration = planWindowsRegistration(layout, {
    productName: 'Agentrans Test', version, publisher: 'Agentrans',
    uninstallKey: `HKCU\\Software\\AgentransInstallerTest-${Date.now()}`,
    shortcutPath: join(root, 'Agentrans Test.lnk'),
  })
  registrations.push(registration)
  return { root, releasePath, manifestPath, publicKeyPath, registration }
}

describe('agentrans-installer CLI', () => {
  it('installs a signed release and silently uninstalls app-only scope', async () => {
    const { root, releasePath, manifestPath, publicKeyPath, registration } = await setupRelease('0.1.0')
    await execFileAsync(process.execPath, [installer, 'install', '--root', root, '--release', releasePath, '--manifest', manifestPath, '--public-key', publicKeyPath, '--uninstall-key', registration.uninstallKey, '--shortcut-path', registration.shortcutPath])
    expect(await readFile(join(root, 'app', 'index.js'), 'utf8')).toContain('0.1.0')
    await verifyWindowsRegistration(registration)

    await mkdir(join(root, 'data', 'sessions'), { recursive: true })
    await writeFile(join(root, 'data', 'sessions', 'keep.txt'), 'keep', 'utf8')
    await execFileAsync(process.execPath, [installer, 'uninstall', '--root', root, '--silent', '--uninstall-key', registration.uninstallKey, '--shortcut-path', registration.shortcutPath])
    await expect(readFile(join(root, 'app', 'index.js'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(root, 'data', 'sessions', 'keep.txt'), 'utf8')).toBe('keep')
    await expect(verifyWindowsRegistration(registration)).rejects.toThrow()
  })

  it('supports silent full cleanup without opening the dialog', async () => {
    const { root, releasePath, manifestPath, publicKeyPath, registration } = await setupRelease('0.2.0')
    await execFileAsync(process.execPath, [installer, 'install', '--root', root, '--release', releasePath, '--manifest', manifestPath, '--public-key', publicKeyPath, '--uninstall-key', registration.uninstallKey, '--shortcut-path', registration.shortcutPath])
    await mkdir(join(root, 'data', 'sessions'), { recursive: true })
    await mkdir(join(root, 'models'), { recursive: true })
    await mkdir(join(root, 'runtime-envs'), { recursive: true })
    await execFileAsync(process.execPath, [installer, 'uninstall', '--root', root, '--silent', '--all', '--uninstall-key', registration.uninstallKey, '--shortcut-path', registration.shortcutPath])
    await expect(readFile(join(root, 'data', 'sessions', 'keep.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(root, 'models', 'model.bin'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(root, 'runtime-envs', 'runtime.bin'), 'utf8')).rejects.toThrow()
  })

  it('parses the native uninstall dialog without executing it', async () => {
    const script = 'C:/agent制作/deepseek-harness/apps/desktop/installer/uninstall-dialog.ps1'
    const command = `$errors = $null; [System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw '${script}'), [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { throw $errors[0] }`
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])
  })
})
