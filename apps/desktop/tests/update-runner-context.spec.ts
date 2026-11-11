/** Qualification launchers prepare private product state before crossing a process boundary. */
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { parseProductLaunchContext } from '@agentrans/product-layout/launch-context'
import { configureDesktopProduct } from '../src/product-context.ts'

const { launched, allocated, electronPath } = vi.hoisted(() => ({
  launched: vi.fn((_command: string, _args: readonly string[], _options: { cwd: string; env: NodeJS.ProcessEnv }) => {}),
  allocated: [] as string[],
  electronPath: { value: '' },
}))

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: vi.fn(() => '24.15.0'),
  spawn: (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
    launched(command, args, options)
    const child = new EventEmitter()
    queueMicrotask(() => { child.emit('close', 0, null) })
    return child
  },
}))
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return Object.assign({}, actual, { createRequire: (...args: Parameters<typeof actual.createRequire>) => {
    const require = actual.createRequire(...args)
    const load = (name: string): unknown => require(name)
    return Object.assign((name: string) => name === 'electron' ? electronPath.value : load(name), require)
  } })
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    // Payload copies and dependency projections belong to artifact qualification, outside this launch test.
    cp: vi.fn(async () => {}), symlink: vi.fn(async () => {}),
    mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
      const root = await actual.mkdtemp(...args)
      if (typeof root !== 'string') throw new Error('Expected string qualification root')
      allocated.push(root)
      return root
    },
  }
})

const repo = resolve(import.meta.dirname, '../../..')
const verification = join(dirname(repo), '.dev-data/agentrans/verification')
const scratch: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.resetModules()
  for (const root of allocated.splice(0)) {
    expect(relative(verification, root)).toMatch(/^(?:host-updates-|electron-workspace-updates-)[^\\/]+$/u)
    await rm(root, { recursive: true, force: true })
  }
  for (const root of scratch.splice(0)) await rm(root, { recursive: true, force: true })
})

async function isolateEnvironment() {
  const { mkdtemp: allocate } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const root = await allocate(join(tmpdir(), 'desktop-runner-contract-'))
  scratch.push(root)
  const oldHome = join(root, 'old-home')
  await mkdir(oldHome)
  await writeFile(join(oldHome, 'keep.txt'), 'unrelated user data')
  vi.stubEnv('DSH_HOME', oldHome)
  vi.stubEnv('DSH_AGENTS_HOME', oldHome)
  vi.stubEnv('AGENTRANS_LAUNCH_CONTEXT', '{"unrelated":true}')
  return { root, oldHome }
}

function observeLaunch(codeRoot: (root: string) => string, resourcesRoot: string) {
  launched.mockImplementation((_command, _args, options) => {
    const context = parseProductLaunchContext(options.env.AGENTRANS_LAUNCH_CONTEXT!)
    expect(context.purpose).toBe('verification')
    expect(context.instanceRoot).toBe(join(options.cwd, 'state'))
    expect(context.codeRoot).toBe(codeRoot(options.cwd))
    expect(context.resourcesRoot).toBe(resourcesRoot)
    expect(relative(repo, context.instanceRoot)).toMatch(/^\.\.[\\/]/u)
    expect(options.env.DSH_HOME).toBe(context.paths.dshHomeDir)
    expect(options.env.DSH_AGENTS_HOME).toBe(context.paths.dshAgentsHomeDir)
    expect(JSON.parse(readFileSync(join(context.instanceRoot, '.agentrans-instance.json'), 'utf8')))
      .toMatchObject({ purpose: 'verification' })
    expect(existsSync(context.paths.electronUserDataDir)).toBe(true)
  })
}

it('starts Host qualification with an external verification instance and ignores inherited user roots', async () => {
  const current = await isolateEnvironment()
  observeLaunch(root => join(root, 'project'), await realpath(repo))
  await import('../scripts/test-host-updates.ts')
  expect(launched).toHaveBeenCalledOnce()
  expect(await readdir(current.oldHome)).toEqual(['keep.txt'])
  expect(await readFile(join(current.oldHome, 'keep.txt'), 'utf8')).toBe('unrelated user data')
  const root = launched.mock.calls[0]![2].cwd
  expect(existsSync(join(root, 'project'))).toBe(false)
})

it('passes an Electron-bound verification context whose prepared profile survives main-process validation', async () => {
  const current = await isolateEnvironment()
  const executable = process.platform === 'darwin'
    ? join(current.root, 'Electron.app/Contents/MacOS/Electron') : join(current.root, 'electron/electron.exe')
  const resources = process.platform === 'darwin'
    ? resolve(dirname(executable), '../Resources') : join(dirname(executable), 'resources')
  await mkdir(resources, { recursive: true })
  await mkdir(dirname(executable), { recursive: true })
  electronPath.value = executable
  observeLaunch(root => join(root, 'app'), await realpath(resources))
  const observe = launched.getMockImplementation()!
  launched.mockImplementation((command, args, options) => {
    observe(command, args, options)
    const context = parseProductLaunchContext(options.env.AGENTRANS_LAUNCH_CONTEXT!)
    const profile = join(context.paths.dshHomeDir, 'profiles', 'desktop')
    expect(existsSync(join(profile, 'package.json'))).toBe(true)
    expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).toContain('workspace-update-host.mjs')
    const app = { isPackaged: false, getAppPath: () => context.codeRoot, setPath: vi.fn() }
    expect(configureDesktopProduct(app, resources, repo, options.env)).toEqual(context)
    expect(app.setPath).toHaveBeenCalledWith('userData', context.paths.electronUserDataDir)
  })
  await import('../scripts/test-workspace-updates.ts')
  expect(launched).toHaveBeenCalledOnce()
  expect(await readdir(current.oldHome)).toEqual(['keep.txt'])
  expect(await readFile(join(current.oldHome, 'keep.txt'), 'utf8')).toBe('unrelated user data')
  const root = launched.mock.calls[0]![2].cwd
  expect(existsSync(join(root, 'app'))).toBe(false)
  expect(existsSync(join(root, 'state'))).toBe(true)
})
