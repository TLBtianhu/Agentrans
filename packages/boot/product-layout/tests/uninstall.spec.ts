import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
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
  UninstallHookError,
  UninstallPathError,
} from '../src/index.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentrans-uninstall-'))
  roots.push(root)
  return root
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
    try {
      await executeUninstallPlan(plan, { removeRegistration: async () => { throw new Error('registry failed') } })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(UninstallExecutionError)
    if (failure instanceof UninstallExecutionError) {
      expect(failure.completed).toContain(layout.appDir)
      expect(failure.completed).toContain(join(layout.dataDir, 'cache'))
    }
    expect(await exists(layout.appDir)).toBe(false)
    expect(await exists(join(layout.dataDir, 'sessions', 'keep.txt'))).toBe(true)
  })
})
