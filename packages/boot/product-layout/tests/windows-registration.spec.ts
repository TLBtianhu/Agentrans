import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  planWindowsRegistration,
  registerWindowsRegistration,
  removeWindowsRegistration,
  verifyWindowsRegistration,
  WindowsRegistrationError,
  type WindowsCommandRunner,
  type WindowsRegistrationPlan,
} from '../src/index.ts'
import { ProductLayout } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => {
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
    await registerWindowsRegistration(current, runner)
    expect(calls.filter(call => call.file === 'reg.exe' && call.args[0] === 'add')).toHaveLength(6)
    const shell = calls.find(call => call.file === 'powershell.exe')
    expect(shell).toBeDefined()
    expect(shell?.args.join(' ')).toContain('WScript.Shell')
    await writeFile(current.shortcutPath, 'shortcut', 'utf8')
    await verifyWindowsRegistration(current, runner)
    expect(calls.filter(call => call.file === 'reg.exe' && call.args[0] === 'query')).toHaveLength(6)
    await removeWindowsRegistration(current, runner)
    expect(calls.some(call => call.file === 'reg.exe' && call.args[0] === 'delete')).toBe(true)
    await expect(stat(current.shortcutPath)).rejects.toThrow()
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
      await registerWindowsRegistration(current, runner)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(WindowsRegistrationError)
    if (failure instanceof WindowsRegistrationError) expect(failure.completed).toEqual([])
    expect(calls.some(call => call.file === 'reg.exe' && call.args[0] === 'delete')).toBe(true)
  })

  it('treats an already missing registry key as removed', async () => {
    const current = await plan()
    const runner: WindowsCommandRunner = async () => { throw new Error('unable to find the specified registry key') }
    await expect(removeWindowsRegistration(current, runner)).resolves.toBeUndefined()
  })
})
