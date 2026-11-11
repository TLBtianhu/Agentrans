/** Runtime qualification prepares an owned verification instance before any child process starts. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { parseProductLaunchContext, resolvePackagedLaunchContext } from '@agentrans/product-layout/launch-context'
import { smokeDesktopRuntime } from '../scripts/smoke-runtime.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const { payload, stop, hostArguments, allocated } = vi.hoisted(() => ({
  payload: vi.fn(async (_file: string, _args: readonly string[], _options: { cwd: string; env: NodeJS.ProcessEnv }) => ({ stdout: '' })),
  stop: vi.fn(async () => {}),
  hostArguments: vi.fn(),
  allocated: [] as string[],
}))

vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util')
  return { ...await importOriginal<typeof import('node:child_process')>(),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: payload }) }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, mkdtempSync: (...args: Parameters<typeof actual.mkdtempSync>) => {
    const path = actual.mkdtempSync(...args)
    if (typeof path !== 'string') throw new Error('Expected string temporary path')
    allocated.push(path)
    return path
  } }
})
vi.mock('../src/host-process.ts', () => ({ DesktopHostProcess: class {
  constructor(...args: unknown[]) { hostArguments(...args) }
  stop = stop
} }))

const roots: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  for (const root of allocated.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'dsh-desktop-smoke-'))) throw new Error('Unexpected smoke cleanup root')
    await rm(root, { recursive: true, force: true })
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-smoke-isolation-'))
  roots.push(root)
  const resources = join(root, 'payload', 'resources')
  const runtime = join(resources, 'runtime')
  await mkdir(runtime, { recursive: true })
  const dsh = join(resources, 'dsh')
  const descriptor = runtimeFixture(dsh)
  const oldHome = join(root, 'old-home')
  await mkdir(oldHome)
  await writeFile(join(oldHome, 'keep.txt'), 'unrelated user data')
  return { root, resources, runtime, dsh, descriptor, oldHome }
}

async function files(root: string) {
  const result: Record<string, string> = {}
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()!
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) result[relative(root, path)] = (await readFile(path)).toString('base64')
      else throw new Error('Unexpected entry in runtime fixture')
    }
  }
  return result
}

it('binds CLI and Host to one verification root while preserving payload and old home files', async () => {
  const current = await fixture()
  const before = await files(join(current.root, 'payload'))
  const failure = new Error('stop at the child-process boundary')
  let preparedProfile = false
  payload.mockImplementationOnce(async (_node, _args, options) => {
    const context = parseProductLaunchContext(options.env.AGENTRANS_LAUNCH_CONTEXT!)
    preparedProfile = existsSync(join(context.paths.dshHomeDir, 'profiles', 'desktop', 'package.json'))
    throw failure
  })
  await expect(smokeDesktopRuntime(current.dsh, 'test-electron', current.descriptor, {
    AGENTRANS_HOME: current.oldHome, AGENTRANS_AGENTS_HOME: current.oldHome,
    AGENTRANS_LAUNCH_CONTEXT: '{"foreign":true}', npm_config_userconfig: 'old-npmrc',
  }, current.runtime)).rejects.toBe(failure)

  const options = payload.mock.calls[0]![2]
  const environment = options.env
  const context = parseProductLaunchContext(environment.AGENTRANS_LAUNCH_CONTEXT!)
  expect(context.purpose).toBe('verification')
  expect(context.resourcesRoot).toBe(current.resources)
  expect(context.codeRoot).toBe(dirname(current.resources))
  expect(resolvePackagedLaunchContext(current.resources, environment.AGENTRANS_LAUNCH_CONTEXT)).toEqual(context)
  expect(environment.AGENTRANS_HOME).toBe(context.paths.dshHomeDir)
  expect(environment.AGENTRANS_AGENTS_HOME).toBe(context.paths.dshAgentsHomeDir)
  expect(environment.AGENTRANS_DESKTOP_UPDATE_JOURNAL_DIR).toBe(context.paths.updateJournalDir)
  expect(environment.HOME).toBe(context.instanceRoot)
  expect(environment.USERPROFILE).toBe(context.instanceRoot)
  expect(environment.XDG_CONFIG_HOME).toBe(context.instanceRoot)
  expect(environment.APPDATA).toBe(context.instanceRoot)
  expect(environment.npm_config_userconfig).toBe(join(context.instanceRoot, 'npmrc'))
  expect(preparedProfile).toBe(true)
  expect(hostArguments.mock.calls[0]![2]).toBe(join(context.paths.dshHomeDir, 'profiles', 'desktop'))
  expect(hostArguments.mock.calls[0]![4]).toEqual(expect.objectContaining({
    AGENTRANS_LAUNCH_CONTEXT: environment.AGENTRANS_LAUNCH_CONTEXT,
  }))
  expect(stop).toHaveBeenCalledOnce()
  expect(existsSync(context.instanceRoot)).toBe(false)
  expect(await files(join(current.root, 'payload'))).toEqual(before)
  expect(await readdir(current.oldHome)).toEqual(['keep.txt'])
  expect(await readFile(join(current.oldHome, 'keep.txt'), 'utf8')).toBe('unrelated user data')
})

it('cleans its empty temporary root after preflight failure without starting any process', async () => {
  const current = await fixture()
  await expect(smokeDesktopRuntime(current.dsh, 'test-electron', current.descriptor, {},
    join(current.root, 'missing-payload', 'resources', 'runtime'))).rejects.toMatchObject({ code: 'CODE_ROOT_UNAVAILABLE' })
  expect(payload).not.toHaveBeenCalled()
  expect(hostArguments).not.toHaveBeenCalled()
  expect(stop).not.toHaveBeenCalled()
  expect(allocated).toHaveLength(1)
  expect(existsSync(resolve(allocated[0]!))).toBe(false)
  expect(await readdir(current.oldHome)).toEqual(['keep.txt'])
})
