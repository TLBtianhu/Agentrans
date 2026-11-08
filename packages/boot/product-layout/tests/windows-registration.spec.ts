import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  assertWindowsRegistrationOwnership,
  planWindowsRegistration,
  registerWindowsRegistration,
  removeWindowsRegistration,
  verifyWindowsRegistration,
  WindowsRegistrationError,
  WindowsRegistrationOwnershipError,
  type WindowsCommandRunner,
  type WindowsRegistrationReader,
  type WindowsRegistrationPlan,
} from '../src/index.ts'
import { ProductLayout } from '../src/index.ts'

const roots: string[] = []
const registrations: WindowsRegistrationPlan[] = []
const missing: WindowsRegistrationReader = async () => ({ registry: 'missing', shortcut: 'missing' })
afterEach(async () => {
  for (const registration of registrations.splice(0)) await removeWindowsRegistration(registration)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function plan(): Promise<WindowsRegistrationPlan> {
  const root = await mkdtemp(join(tmpdir(), 'agentrans-windows-'))
  roots.push(root)
  const layout = ProductLayout.fromRoot(root, 'installed')
  return planWindowsRegistration(layout, {
    productName: 'Agentrans Test',
    version: '0.1.0',
    publisher: 'Agentrans',
    uninstallKey: 'HKCU\\Software\\AgentransTest',
    shortcutPath: join(root, 'Agentrans Test.lnk'),
  })
}

describe('Windows registration backend', () => {
  it('plans user-level registration and executes registry and shortcut operations', async () => {
    const current = await plan()
    const calls: { file: string; args: readonly string[] }[] = []
    const runner: WindowsCommandRunner = async (file, args) => { calls.push({ file, args }) }
    expect(current.requiresAdmin).toBe(false)
    expect(current.uninstallCommand).toBe(`"${current.uninstallExePath}"`)
    await registerWindowsRegistration(current, runner, missing)
    expect(calls.filter(call => call.file === 'reg.exe' && call.args[0] === 'add')).toHaveLength(6)
    expect(calls[0]?.args).toContain('InstallLocation')
    const shell = calls.find(call => call.file === 'powershell.exe')
    expect(shell).toBeDefined()
    expect(shell?.args.join(' ')).toContain('WScript.Shell')
    await writeFile(current.shortcutPath, 'shortcut', 'utf8')
    await verifyWindowsRegistration(current, runner)
    expect(calls.filter(call => call.file === 'reg.exe' && call.args[0] === 'query')).toHaveLength(6)
    await removeWindowsRegistration(current, runner, missing)
    expect(calls.at(-1)?.args).toContain('-EncodedCommand')
  })

  it('rolls back a partially registered uninstall entry after a failure', async () => {
    const current = await plan()
    const calls: { file: string; args: readonly string[] }[] = []
    const runner: WindowsCommandRunner = async (file, args) => {
      calls.push({ file, args })
      if (calls.length === 2) throw new Error('registry write failed')
    }
    let failure: unknown
    try {
      await registerWindowsRegistration(current, runner, missing)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(WindowsRegistrationError)
    if (failure instanceof WindowsRegistrationError) expect(failure.completed).toEqual([])
    expect(calls.some(call => call.file === 'powershell.exe' && call.args.includes('-EncodedCommand'))).toBe(true)
  })

  it('does not infer missing registration from an English process failure', async () => {
    const current = await plan()
    const failure = new Error('unable to find the specified registry key')
    const runner: WindowsCommandRunner = async () => { throw failure }
    await expect(removeWindowsRegistration(current, runner, missing)).rejects.toBe(failure)
  })

  it.each(['registry', 'shortcut'] as const)('refuses a foreign %s before either resource is removed', async (component) => {
    const current = await plan()
    const calls: string[] = []
    const error = new WindowsRegistrationOwnershipError(component, current.uninstallKey, 'FOREIGN')
    const reader: WindowsRegistrationReader = async () => { throw error }
    await expect(assertWindowsRegistrationOwnership(current, reader)).rejects.toBe(error)
    await expect(removeWindowsRegistration(current, async (file) => { calls.push(file) }, reader)).rejects.toBe(error)
    expect(calls).toEqual([])
  })

  it('preserves a foreign registration discovered during registration rollback', async () => {
    const current = await plan()
    const calls: string[] = []
    let inspections = 0
    const reader: WindowsRegistrationReader = async () => {
      if (inspections++ > 0) throw new WindowsRegistrationOwnershipError('registry', current.uninstallKey, 'FOREIGN')
      return { registry: 'missing', shortcut: 'missing' }
    }
    await expect(registerWindowsRegistration(current, async (file) => {
      calls.push(file)
      throw new Error('registration failed')
    }, reader)).rejects.toMatchObject({ rollbackError: { code: 'WINDOWS_REGISTRATION_OWNERSHIP' } })
    expect(calls).toEqual(['reg.exe'])
  })

  it('does not unregister existing owned resources after an update fails', async () => {
    const current = await plan()
    const calls: string[] = []
    const reader: WindowsRegistrationReader = async () => ({ registry: 'owned', shortcut: 'owned' })
    await expect(registerWindowsRegistration(current, async (file) => {
      calls.push(file)
      throw new Error('update failed')
    }, reader)).rejects.toBeInstanceOf(WindowsRegistrationError)
    expect(calls).toEqual(['reg.exe'])
  })
})

async function realPlan(): Promise<WindowsRegistrationPlan> {
  const current = await plan()
  return { ...current, uninstallKey: `HKCU\\Software\\AgentransRegistrationTest-${randomUUID()}` }
}

describe.runIf(process.platform === 'win32')('real registration ownership', () => {
  it('removes owned resources and repeats cleanup when both resources are missing', async () => {
    const current = await realPlan()
    registrations.push(current)
    await registerWindowsRegistration(current)
    await assertWindowsRegistrationOwnership(current)
    await removeWindowsRegistration(current)
    await expect(stat(current.shortcutPath)).rejects.toThrow()
    await expect(removeWindowsRegistration(current)).resolves.toBeUndefined()
  }, 30_000)

  it('keeps both installations when a stale root names the other registry and shortcut', async () => {
    const first = await realPlan()
    const second = await realPlan()
    registrations.push(first, second)
    await registerWindowsRegistration(first)
    await registerWindowsRegistration(second)
    const stale = { ...second, uninstallKey: first.uninstallKey, shortcutPath: first.shortcutPath }
    await expect(removeWindowsRegistration(stale)).rejects.toMatchObject({
      code: 'WINDOWS_REGISTRATION_OWNERSHIP', component: 'registry', reason: 'FOREIGN',
    })
    await assertWindowsRegistrationOwnership(first)
    await assertWindowsRegistrationOwnership(second)
  }, 30_000)

  it('does not remove an owned entry when its shortcut points to another installation', async () => {
    const first = await realPlan()
    const second = await realPlan()
    registrations.push(first, second)
    await registerWindowsRegistration(first)
    await registerWindowsRegistration(second)
    await expect(removeWindowsRegistration({ ...first, shortcutPath: second.shortcutPath })).rejects.toMatchObject({
      code: 'WINDOWS_REGISTRATION_OWNERSHIP', component: 'shortcut', reason: 'FOREIGN',
    })
    await assertWindowsRegistrationOwnership(first)
    await assertWindowsRegistrationOwnership(second)
  }, 30_000)

  it('does not let a missing key authorize removing another installation shortcut', async () => {
    const first = await realPlan()
    const second = await realPlan()
    registrations.push(first)
    await registerWindowsRegistration(first)
    await expect(removeWindowsRegistration({ ...second, shortcutPath: first.shortcutPath })).rejects.toMatchObject({
      component: 'shortcut', reason: 'FOREIGN',
    })
    await assertWindowsRegistrationOwnership(first)
  }, 30_000)

  it('refuses an otherwise matching shortcut with extra executable arguments', async () => {
    const current = await realPlan()
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
    const source = `$shell = New-Object -ComObject WScript.Shell; $link = $shell.CreateShortcut(${quote(current.shortcutPath)}); `
      + `$link.TargetPath = ${quote(current.appExePath)}; $link.WorkingDirectory = ${quote(current.layout.appDir)}; `
      + "$link.Arguments = '--foreign-mode'; $link.Save()"
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true })
    await expect(removeWindowsRegistration(current)).rejects.toMatchObject({ component: 'shortcut', reason: 'FOREIGN' })
    expect((await stat(current.shortcutPath)).isFile()).toBe(true)
  }, 30_000)
})
