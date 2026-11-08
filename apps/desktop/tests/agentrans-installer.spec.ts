import { afterEach, describe, expect, it } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
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
const installer = fileURLToPath(new URL('../installer/agentrans-installer.mjs', import.meta.url))
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

async function failedUninstall(root: string, registration: WindowsRegistrationPlan, extra: readonly string[] = []): Promise<unknown> {
  try {
    await execFileAsync(process.execPath, [installer, 'uninstall', '--root', root, '--silent',
      '--uninstall-key', registration.uninstallKey, '--shortcut-path', registration.shortcutPath, ...extra])
  } catch (error) {
    expect(error).toMatchObject({ code: 1, stdout: '' })
    if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string') {
      return JSON.parse(error.stderr)
    }
    throw error
  }
  throw new Error('Expected uninstall refusal')
}

describe.skipIf(process.platform !== 'win32')('agentrans-installer CLI', { timeout: 30_000 }, () => {
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
    await writeFile(join(root, 'data', 'sessions', 'keep.txt'), 'session', 'utf8')
    await writeFile(join(root, 'models', 'model.bin'), 'model', 'utf8')
    await writeFile(join(root, 'runtime-envs', 'runtime.bin'), 'runtime', 'utf8')
    await execFileAsync(process.execPath, [installer, 'uninstall', '--root', root, '--silent', '--all', '--uninstall-key', registration.uninstallKey, '--shortcut-path', registration.shortcutPath])
    await expect(readFile(join(root, 'data', 'sessions', 'keep.txt'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(root, 'models', 'model.bin'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(root, 'runtime-envs', 'runtime.bin'), 'utf8')).rejects.toThrow()
  })

  it('upgrades the same isolated installation without replacing its data or external junction target', async () => {
    const first = await setupRelease('0.2.0')
    const second = await setupRelease('0.2.1')
    const registrationArgs = ['--uninstall-key', first.registration.uninstallKey,
      '--shortcut-path', first.registration.shortcutPath]
    await execFileAsync(process.execPath, [installer, 'install', '--root', first.root, '--release', first.releasePath,
      '--manifest', first.manifestPath, '--public-key', first.publicKeyPath, ...registrationArgs])
    const retained = ['data/dsh/home/sessions/keep.jsonl', 'data/settings/keep.json', 'models/keep.bin',
      'runtime-envs/keep.bin', 'data/exports/keep.html', 'external-project/keep.txt']
    for (const path of retained) {
      const target = join(first.root, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, path, 'utf8')
    }
    const linked = join(first.root, 'app', 'linked-project')
    await symlink(join(first.root, 'external-project'), linked, process.platform === 'win32' ? 'junction' : 'dir')
    await execFileAsync(process.execPath, [installer, 'install', '--root', first.root, '--release', second.releasePath,
      '--manifest', second.manifestPath, '--public-key', second.publicKeyPath, ...registrationArgs])
    expect(await readFile(join(first.root, 'app', 'index.js'), 'utf8')).toContain('0.2.1')
    for (const path of retained) expect(await readFile(join(first.root, path), 'utf8')).toBe(path)
    await execFileAsync(process.execPath, [installer, 'uninstall', '--root', first.root, '--silent', ...registrationArgs])
    for (const path of retained) expect(await readFile(join(first.root, path), 'utf8')).toBe(path)
    await expect(verifyWindowsRegistration(first.registration)).rejects.toThrow()
  })

  it('removes the registration even when the install manifest is unreadable', async () => {
    const { root, releasePath, manifestPath, publicKeyPath, registration } = await setupRelease('0.3.0')
    await execFileAsync(process.execPath, [installer, 'install', '--root', root, '--release', releasePath, '--manifest', manifestPath, '--public-key', publicKeyPath, '--uninstall-key', registration.uninstallKey, '--shortcut-path', registration.shortcutPath])
    await writeFile(join(root, 'data', 'install', 'manifest.json'), '{ not json', 'utf8')
    await mkdir(join(root, 'data', 'dsh', 'home', 'sessions'), { recursive: true })
    await writeFile(join(root, 'data', 'dsh', 'home', 'sessions', 'keep.jsonl'), 'keep', 'utf8')
    await execFileAsync(process.execPath, [installer, 'uninstall', '--root', root, '--silent', '--uninstall-key', registration.uninstallKey, '--shortcut-path', registration.shortcutPath])
    await expect(readFile(join(root, 'app', 'index.js'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(root, 'data', 'dsh', 'home', 'sessions', 'keep.jsonl'), 'utf8')).toBe('keep')
    await expect(verifyWindowsRegistration(registration)).rejects.toThrow()
  })

  it('refuses a cache junction before removing the app or its registration, then permits an explicit retry', async () => {
    const { root, releasePath, manifestPath, publicKeyPath, registration } = await setupRelease('0.4.0')
    await execFileAsync(process.execPath, [installer, 'install', '--root', root, '--release', releasePath,
      '--manifest', manifestPath, '--public-key', publicKeyPath,
      '--uninstall-key', registration.uninstallKey, '--shortcut-path', registration.shortcutPath])
    const outside = join(root, 'outside-selected-scope')
    const cache = join(root, 'data', 'cache')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'external sentinel', 'utf8')
    await rm(cache, { recursive: true })
    await symlink(outside, cache, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      expect(await failedUninstall(root, registration)).toMatchObject({
        status: 'error', code: 'UNINSTALL_PATH_UNSAFE', path: cache, reason: 'LINK',
      })
      expect(await readFile(join(root, 'app', 'index.js'), 'utf8')).toContain('0.4.0')
      expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('external sentinel')
      await verifyWindowsRegistration(registration)
    } finally { await unlink(cache) }
    await execFileAsync(process.execPath, [installer, 'uninstall', '--root', root, '--silent',
      '--uninstall-key', registration.uninstallKey, '--shortcut-path', registration.shortcutPath])
    await expect(readFile(join(root, 'app', 'index.js'))).rejects.toThrow()
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('external sentinel')
    await expect(verifyWindowsRegistration(registration)).rejects.toThrow()
  })

  it('unlinks a nested application junction without removing its target', async () => {
    const { root, releasePath, manifestPath, publicKeyPath, registration } = await setupRelease('0.5.0')
    await execFileAsync(process.execPath, [installer, 'install', '--root', root, '--release', releasePath,
      '--manifest', manifestPath, '--public-key', publicKeyPath,
      '--uninstall-key', registration.uninstallKey, '--shortcut-path', registration.shortcutPath])
    const outside = join(root, 'retained-project')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'external sentinel', 'utf8')
    await symlink(outside, join(root, 'app', 'linked-project'), process.platform === 'win32' ? 'junction' : 'dir')
    await execFileAsync(process.execPath, [installer, 'uninstall', '--root', root, '--silent',
      '--uninstall-key', registration.uninstallKey, '--shortcut-path', registration.shortcutPath])
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('external sentinel')
    await expect(readFile(join(root, 'app', 'index.js'))).rejects.toThrow()
    await expect(verifyWindowsRegistration(registration)).rejects.toThrow()
  })

  it('rejects a scope inherited from Object.prototype before changing files', async () => {
    const { root, registration } = await setupRelease('0.6.0')
    const app = join(root, 'app')
    await mkdir(app)
    await writeFile(join(app, 'keep.txt'), 'untouched', 'utf8')
    expect(await failedUninstall(root, registration, ['--scope', 'constructor'])).toMatchObject({
      status: 'error', code: 'ERROR', message: 'Unknown uninstall scope: constructor',
    })
    expect(await readFile(join(app, 'keep.txt'), 'utf8')).toBe('untouched')
  })

  it('refuses another installation registry before removing either application', async () => {
    const first = await setupRelease('0.6.1')
    const second = await setupRelease('0.6.2')
    for (const release of [first, second]) {
      await execFileAsync(process.execPath, [installer, 'install', '--root', release.root, '--release', release.releasePath,
        '--manifest', release.manifestPath, '--public-key', release.publicKeyPath,
        '--uninstall-key', release.registration.uninstallKey, '--shortcut-path', release.registration.shortcutPath])
    }
    expect(await failedUninstall(second.root, first.registration)).toMatchObject({
      status: 'error', code: 'WINDOWS_REGISTRATION_OWNERSHIP', component: 'registry', reason: 'FOREIGN',
    })
    for (const release of [first, second]) {
      expect(await readFile(join(release.root, 'app', 'index.js'), 'utf8')).toContain(release === first ? '0.6.1' : '0.6.2')
      await verifyWindowsRegistration(release.registration)
    }
    expect(await failedUninstall(second.root, { ...first.registration,
      uninstallKey: `${first.registration.uninstallKey}-missing` })).toMatchObject({
      status: 'error', code: 'WINDOWS_REGISTRATION_OWNERSHIP', component: 'shortcut', reason: 'FOREIGN',
    })
    expect(await readFile(join(second.root, 'app', 'index.js'), 'utf8')).toContain('0.6.2')
    await verifyWindowsRegistration(first.registration)
    await verifyWindowsRegistration(second.registration)
  })

  it('reports completed removals when a selected model is locked, then permits an explicit retry', async () => {
    const { root, releasePath, manifestPath, publicKeyPath, registration } = await setupRelease('0.7.0')
    const registrationArgs = ['--uninstall-key', registration.uninstallKey, '--shortcut-path', registration.shortcutPath]
    await execFileAsync(process.execPath, [installer, 'install', '--root', root, '--release', releasePath,
      '--manifest', manifestPath, '--public-key', publicKeyPath, ...registrationArgs])
    const retained = join(root, 'data', 'sessions')
    const models = join(root, 'models')
    const model = join(models, 'locked.bin')
    await writeFile(join(retained, 'keep.txt'), 'retained', 'utf8')
    await writeFile(model, 'model', 'utf8')
    const script = `$ErrorActionPreference = 'Stop'; $stream = [System.IO.File]::Open('${model.replaceAll("'", "''")}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None); try { [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $stream.Dispose() }`
    const locker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let diagnostics = ''
    locker.stderr.setEncoding('utf8').on('data', (chunk: string) => { diagnostics += chunk })
    const closed = new Promise<number | null>((resolve) => { locker.once('close', resolve) })
    const ready = new Promise<void>((resolve, reject) => {
      let output = ''
      locker.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk
        if (output.trim() === 'ready') resolve()
      })
      locker.once('error', reject)
      locker.once('exit', (code, signal) => {
        reject(new Error(`Model lock helper exited before ready (${code ?? signal}): ${diagnostics}`))
      })
    })
    async function waitFor<T>(promise: Promise<T>, operation: string): Promise<T> {
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { reject(new Error(`Model lock helper ${operation} timed out: ${diagnostics}`)) }, 10000)
        })])
      } finally { if (timer !== undefined) clearTimeout(timer) }
    }
    try {
      await waitFor(ready, 'readiness')
      const failure = await failedUninstall(root, registration, ['--scope', 'app,models'])
      expect(failure).toMatchObject({ status: 'error', code: 'UNINSTALL_PARTIAL',
        completed: [join(root, 'app'), join(root, 'data', 'cache')], failedOperation: models,
      })
      if (typeof failure !== 'object' || failure === null || !('causeCode' in failure)) throw new Error('Missing OS failure code')
      expect(['EPERM', 'EACCES', 'EBUSY']).toContain(failure.causeCode)
      await expect(readFile(join(root, 'app', 'index.js'))).rejects.toThrow()
      expect(await readFile(join(retained, 'keep.txt'), 'utf8')).toBe('retained')
      await verifyWindowsRegistration(registration)
      locker.stdin.end('release\n')
      expect(await waitFor(closed, 'release')).toBe(0)
    } finally {
      if (locker.exitCode === null && locker.signalCode === null) locker.kill()
      await closed
    }
    expect(await readFile(model, 'utf8')).toBe('model')
    await execFileAsync(process.execPath, [installer, 'uninstall', '--root', root, '--silent',
      '--scope', 'app,models', ...registrationArgs])
    await expect(readFile(model)).rejects.toThrow()
    await expect(verifyWindowsRegistration(registration)).rejects.toThrow()
    expect(await readFile(join(retained, 'keep.txt'), 'utf8')).toBe('retained')
  })

  it('parses the native uninstall dialog without executing it', async () => {
    const script = fileURLToPath(new URL('../installer/uninstall-dialog.ps1', import.meta.url))
    const command = `$errors = $null; [System.Management.Automation.PSParser]::Tokenize((Get-Content -LiteralPath '${script.replaceAll("'", "''")}' -Raw), [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { throw $errors[0] }`
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])
  })
})
