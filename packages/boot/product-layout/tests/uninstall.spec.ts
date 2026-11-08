import { afterEach, describe, expect, it, vi } from 'vitest'
import * as filesystem from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ALL_UNINSTALL_SCOPE,
  APP_ONLY_UNINSTALL_SCOPE,
  assertOwnedPaths,
  executeUninstallPlan,
  planUninstall,
  ProductLayout,
  UninstallConfirmationError,
  UninstallExecutionError,
  UninstallFilesystemError,
  UninstallHookError,
  UninstallPathError,
} from '../src/index.ts'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

const roots: string[] = []
const links: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const link of links.splice(0).reverse()) {
    let entry
    try { entry = await lstat(link) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    if (entry.isSymbolicLink()) await unlink(link)
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentrans-uninstall-')))
  roots.push(root)
  return root
}

async function directoryLink(target: string, link: string): Promise<void> {
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  links.push(link)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function seed(layout: ProductLayout): Promise<void> {
  await mkdir(layout.appDir, { recursive: true })
  await mkdir(join(layout.dataDir, 'sessions'), { recursive: true })
  await mkdir(join(layout.dataDir, 'settings'), { recursive: true })
  await mkdir(join(layout.dataDir, 'exports'), { recursive: true })
  await mkdir(join(layout.dataDir, 'cache'), { recursive: true })
  await mkdir(layout.modelsDir, { recursive: true })
  await mkdir(layout.runtimesDir, { recursive: true })
  await writeFile(join(layout.appDir, 'index.js'), 'app', 'utf8')
  await writeFile(join(layout.dataDir, 'sessions', 'keep.txt'), 'session', 'utf8')
  await writeFile(join(layout.dataDir, 'settings', 'settings.json'), '{}', 'utf8')
  await writeFile(join(layout.dataDir, 'exports', 'result.txt'), 'export', 'utf8')
  await writeFile(join(layout.dataDir, 'cache', 'cache.txt'), 'cache', 'utf8')
  await writeFile(join(layout.modelsDir, 'model.bin'), 'model', 'utf8')
  await writeFile(join(layout.runtimesDir, 'runtime.bin'), 'runtime', 'utf8')
}

describe('uninstall planning', () => {
  it('defaults to app-only removal and preserves user data and assets', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    const plan = planUninstall(layout)
    expect(plan.remove).toEqual([layout.appDir, join(layout.dataDir, 'cache')])
    expect(plan.preserve).toContain(join(layout.dataDir, 'sessions'))
    expect(plan.preserve).toContain(layout.modelsDir)
    expect(plan.preserve).toContain(layout.runtimesDir)
    expect(plan.requiresConfirmation).toBe(false)
    expect(plan.externalOperations).toEqual(['windows:remove-uninstall-entry', 'windows:remove-start-menu-shortcut'])
  })

  it('requires explicit confirmation for the all-categories scope', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    expect(() => planUninstall(layout, ALL_UNINSTALL_SCOPE)).toThrow(UninstallConfirmationError)
    const plan = planUninstall(layout, ALL_UNINSTALL_SCOPE, { allConfirmed: true })
    expect(plan.requiresConfirmation).toBe(true)
    expect(plan.externalOperations[0]).toBe('windows:remove-uninstall-entry')
    expect(plan.externalOperations).toContain('windows:remove-uninstall-entry')
  })

  it('keeps every planned removal inside the installation root', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    for (const scope of [APP_ONLY_UNINSTALL_SCOPE, ALL_UNINSTALL_SCOPE]) {
      const plan = planUninstall(layout, scope, { allConfirmed: true })
      expect(() => { assertOwnedPaths(layout.root, plan.remove) }).not.toThrow()
    }
  })

  it('rejects a removal path that leaves the installation root', () => {
    const root = join(tmpdir(), 'agentrans-owned-root')
    expect(() => { assertOwnedPaths(root, [join(root, '..', 'outside')]) }).toThrow(UninstallPathError)
    expect(() => { assertOwnedPaths(root, [root]) }).toThrow(UninstallPathError)
    expect(() => { assertOwnedPaths(root, [join(root, 'data', 'settings')]) }).not.toThrow()
  })
})

describe('uninstall execution', () => {
  it('removes selected categories before Windows registration cleanup', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    await seed(layout)
    const operations: string[] = []
    const plan = planUninstall(layout, { ...APP_ONLY_UNINSTALL_SCOPE, models: true })
    const result = await executeUninstallPlan(plan, {
      removeRegistration: async () => { operations.push('registration') },
    })
    expect(operations).toEqual(['registration'])
    expect(result.completed[0]).toBe(layout.appDir)
    expect(result.completed.at(-1)).toBe('windows:remove-registration')
    expect(await exists(layout.appDir)).toBe(false)
    expect(await exists(layout.modelsDir)).toBe(false)
    expect(await exists(join(layout.dataDir, 'sessions', 'keep.txt'))).toBe(true)
    expect(await exists(join(layout.dataDir, 'settings', 'settings.json'))).toBe(true)
    expect(await exists(join(layout.dataDir, 'exports', 'result.txt'))).toBe(true)
    expect(await exists(join(layout.dataDir, 'cache'))).toBe(false)
  })

  it('removes actual DSH session and settings paths when selected', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    await mkdir(join(layout.dshHomeDir, 'sessions'), { recursive: true })
    await mkdir(join(layout.dshHomeDir, 'profiles', 'desktop'), { recursive: true })
    await mkdir(join(layout.dshHomeDir, 'storages'), { recursive: true })
    await mkdir(layout.dshAgentsHomeDir, { recursive: true })
    await writeFile(join(layout.dshHomeDir, 'sessions', 'session.jsonl'), 'session', 'utf8')
    await writeFile(join(layout.dshHomeDir, 'profiles', 'desktop', 'cordis.yml'), '[]', 'utf8')
    await writeFile(join(layout.dshHomeDir, '.credentials.yaml'), 'secret: local', 'utf8')
    await writeFile(join(layout.dshHomeDir, '.anonymous-user-id'), 'id', 'utf8')
    await writeFile(join(layout.dshHomeDir, 'storages', 'workspace.json'), '{}', 'utf8')
    await writeFile(join(layout.dshAgentsHomeDir, 'agent.json'), '{}', 'utf8')
    await executeUninstallPlan(planUninstall(layout, ALL_UNINSTALL_SCOPE, { allConfirmed: true }), {
      removeRegistration: async () => {},
    })
    expect(await exists(join(layout.dshHomeDir, 'sessions'))).toBe(false)
    expect(await exists(join(layout.dshHomeDir, 'profiles'))).toBe(false)
    expect(await exists(join(layout.dshHomeDir, '.credentials.yaml'))).toBe(false)
    expect(await exists(join(layout.dshHomeDir, '.anonymous-user-id'))).toBe(false)
    expect(await exists(join(layout.dshHomeDir, 'storages'))).toBe(false)
    expect(await exists(layout.dshAgentsHomeDir)).toBe(false)
  })

  it('fails before deleting anything when the Windows registration hook is missing', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    await seed(layout)
    const plan = planUninstall(layout)
    await expect(executeUninstallPlan(plan)).rejects.toThrow(UninstallHookError)
    expect(await exists(layout.appDir)).toBe(true)
  })

  it('reports completed operations when registration fails after app removal', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    await seed(layout)
    const plan = planUninstall(layout)
    let failure: unknown
    const cause = new Error('registry failed')
    try {
      await executeUninstallPlan(plan, { removeRegistration: async () => { throw cause } })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(UninstallExecutionError)
    if (failure instanceof UninstallExecutionError) {
      expect(failure.completed).toContain(layout.appDir)
      expect(failure.completed).toContain(join(layout.dataDir, 'cache'))
      expect(failure.failedOperation).toBe('windows:remove-registration')
      expect(failure.cause).toBe(cause)
    }
    expect(await exists(layout.appDir)).toBe(false)
    expect(await exists(join(layout.dataDir, 'sessions', 'keep.txt'))).toBe(true)
  })

  it.each(['selected-root', 'intermediate-directory'])('refuses a %s link before deleting earlier categories', async (kind) => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    const outside = await tempRoot()
    await mkdir(layout.appDir)
    await writeFile(join(layout.appDir, 'keep.txt'), 'application')
    await mkdir(join(outside, 'cache'))
    const sentinel = join(outside, 'cache', 'keep.txt')
    await writeFile(sentinel, 'outside')
    if (kind === 'selected-root') await mkdir(layout.dataDir)
    const link = kind === 'selected-root' ? join(layout.dataDir, 'cache') : layout.dataDir
    await directoryLink(kind === 'selected-root' ? join(outside, 'cache') : outside, link)
    const removeRegistration = vi.fn<() => Promise<void>>()
    await expect(executeUninstallPlan(planUninstall(layout), { removeRegistration })).rejects.toMatchObject({
      code: 'UNINSTALL_PATH_UNSAFE', path: link, reason: 'LINK',
    })
    expect(await readFile(join(layout.appDir, 'keep.txt'), 'utf8')).toBe('application')
    expect(await readFile(sentinel, 'utf8')).toBe('outside')
    expect(removeRegistration).not.toHaveBeenCalled()
  })

  it.each(['root', 'ancestor'])('refuses an installation %s link', async (kind) => {
    const parent = await tempRoot()
    const outside = await tempRoot()
    const actualRoot = kind === 'root' ? outside : join(outside, 'installation')
    const actual = ProductLayout.fromRoot(actualRoot, 'portable')
    await seed(actual)
    const link = join(parent, 'alias')
    await directoryLink(outside, link)
    const layout = ProductLayout.fromRoot(kind === 'root' ? link : join(link, 'installation'), 'portable')
    await expect(executeUninstallPlan(planUninstall(layout))).rejects.toMatchObject({
      code: 'UNINSTALL_PATH_UNSAFE', path: link, reason: 'LINK',
    })
    expect(await readFile(join(actual.appDir, 'index.js'), 'utf8')).toBe('app')
    expect(await readFile(join(actual.dataDir, 'cache', 'cache.txt'), 'utf8')).toBe('cache')
  })

  it('unlinks nested dependency and dangling directory links without visiting their targets', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'portable')
    const outside = await tempRoot()
    await seed(layout)
    await writeFile(join(outside, 'keep.txt'), 'external dependency')
    await mkdir(join(layout.appDir, 'node_modules'))
    await directoryLink(outside, join(layout.appDir, 'node_modules', 'dependency'))
    await directoryLink(join(outside, 'absent'), join(layout.appDir, 'dangling'))
    await executeUninstallPlan(planUninstall(layout))
    expect(await exists(layout.appDir)).toBe(false)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('external dependency')
    expect(await exists(join(layout.dataDir, 'sessions', 'keep.txt'))).toBe(true)
  })

  it('completes repeatedly when selected paths and some ancestors are missing', async () => {
    const layout = ProductLayout.fromRoot(join(await tempRoot(), 'absent'), 'portable')
    const plan = planUninstall(layout, ALL_UNINSTALL_SCOPE, { allConfirmed: true })
    expect((await executeUninstallPlan(plan)).completed).toEqual(plan.remove)
    expect((await executeUninstallPlan(plan)).completed).toEqual(plan.remove)
  })

  it('refuses a non-directory ancestor without removing an earlier category', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'portable')
    await mkdir(layout.appDir)
    await writeFile(layout.dataDir, 'not a directory')
    await expect(executeUninstallPlan(planUninstall(layout))).rejects.toMatchObject({
      code: 'UNINSTALL_PATH_UNSAFE', path: layout.dataDir, reason: 'NOT_DIRECTORY',
    })
    expect(await exists(layout.appDir)).toBe(true)
    expect(await readFile(layout.dataDir, 'utf8')).toBe('not a directory')
  })

  it('rechecks a forged plan before deleting any selected path', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'portable')
    const outside = await tempRoot()
    await seed(layout)
    await writeFile(join(outside, 'keep.txt'), 'outside')
    const plan = { ...planUninstall(layout), remove: [layout.appDir, outside] }
    await expect(executeUninstallPlan(plan)).rejects.toBeInstanceOf(UninstallPathError)
    expect(await readFile(join(layout.appDir, 'index.js'), 'utf8')).toBe('app')
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('outside')
  })

  it('rechecks a later selected root after an earlier removal and reports partial completion', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'portable')
    const outside = await tempRoot()
    await mkdir(layout.appDir)
    await mkdir(layout.dataDir)
    await writeFile(join(outside, 'keep.txt'), 'outside')
    const cache = join(layout.dataDir, 'cache')
    const remove = filesystem.rmdirSync
    vi.spyOn(filesystem, 'rmdirSync').mockImplementation((path) => {
      remove(path)
      if (path === layout.appDir) {
        filesystem.symlinkSync(outside, cache, process.platform === 'win32' ? 'junction' : 'dir')
        links.push(cache)
      }
    })
    await expect(executeUninstallPlan(planUninstall(layout))).rejects.toMatchObject({
      code: 'UNINSTALL_PARTIAL', completed: [layout.appDir], failedOperation: cache,
      cause: { code: 'UNINSTALL_PATH_UNSAFE', path: cache, reason: 'LINK' },
    })
    expect(await exists(layout.appDir)).toBe(false)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('outside')
  })

  it('uses the captured removal list when a caller mutates its plan during deletion', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'portable')
    const outside = await tempRoot()
    await mkdir(layout.appDir)
    await writeFile(join(outside, 'keep.txt'), 'outside')
    const paths = [...planUninstall(layout).remove]
    const plan = { ...planUninstall(layout), remove: paths }
    const remove = filesystem.rmdirSync
    vi.spyOn(filesystem, 'rmdirSync').mockImplementation((path) => {
      remove(path)
      if (path === layout.appDir) paths.push(outside)
    })
    expect((await executeUninstallPlan(plan)).completed).toEqual([layout.appDir, join(layout.dataDir, 'cache')])
    expect(paths).toContain(outside)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('outside')
  })

  it('preserves inspection failures as a refusal before deletion', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'portable')
    await seed(layout)
    const cause = Object.assign(new Error('inspection denied'), { code: 'EACCES' })
    vi.spyOn(filesystem, 'lstatSync').mockImplementationOnce(() => { throw cause })
    const execution = executeUninstallPlan(planUninstall(layout))
    await expect(execution).rejects.toBeInstanceOf(UninstallFilesystemError)
    await expect(execution).rejects.toMatchObject({ code: 'UNINSTALL_PATH_UNSAFE', reason: 'INSPECTION_FAILED', cause })
    expect(await readFile(join(layout.appDir, 'index.js'), 'utf8')).toBe('app')
  })

  it('reports the affected removal and original filesystem error without deregistration', async () => {
    const layout = ProductLayout.fromRoot(await tempRoot(), 'installed')
    await seed(layout)
    const cause = Object.assign(new Error('file is locked'), { code: 'EBUSY' })
    vi.spyOn(filesystem, 'unlinkSync').mockImplementationOnce(() => { throw cause })
    const removeRegistration = vi.fn<() => Promise<void>>()
    await expect(executeUninstallPlan(planUninstall(layout), { removeRegistration })).rejects.toMatchObject({
      code: 'UNINSTALL_PARTIAL', completed: [], failedOperation: layout.appDir, cause,
    })
    expect(removeRegistration).not.toHaveBeenCalled()
    expect(await exists(join(layout.dataDir, 'cache', 'cache.txt'))).toBe(true)
    expect(cause.code).toBe('EBUSY')
  })
})
