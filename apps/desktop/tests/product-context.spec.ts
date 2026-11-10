import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import {
  PRODUCT_LAUNCH_CONTEXT_ENV, resolveProductLaunchContext, serializeProductLaunchContext,
} from '@deepseek-ai/dsh-product-layout/launch-context'
import { configureDesktopProduct } from '../src/product-context.ts'

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentrans-desktop-context-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const source = join(root, 'source')
  const instance = join(root, 'installed')
  const resources = join(instance, 'app', 'resources')
  const appPath = join(resources, 'app.asar')
  mkdirSync(source)
  mkdirSync(appPath, { recursive: true })
  const app = { isPackaged: true, getAppPath: () => appPath, setPath: vi.fn() }
  return { root, source, instance, resources, appPath, app }
}

it('binds a packaged GUI and Chromium to the same instance as the bundled CLI', () => {
  const f = fixture()
  const environment = { DSH_HOME: join(f.root, 'foreign-home'), DSH_AGENTS_HOME: join(f.root, 'foreign-agents') }
  const context = configureDesktopProduct(f.app, f.resources, f.source, environment, 'win32')
  expect(environment.DSH_HOME).toBe(join(f.instance, 'data', 'dsh', 'home'))
  expect(environment.DSH_AGENTS_HOME).toBe(join(f.instance, 'data', 'dsh', 'agents'))
  expect(f.app.setPath.mock.calls).toEqual([
    ['userData', context.paths.electronUserDataDir], ['sessionData', context.paths.electronUserDataDir],
    ['logs', context.paths.logsDir], ['crashDumps', context.paths.crashDumpsDir],
  ])
  expect(readdirSync(f.resources)).toEqual(['app.asar'])
})

it('uses an explicit source instance without reading inherited Harness homes or a foreign context', () => {
  const f = fixture()
  f.app.isPackaged = false
  writeFileSync(join(f.source, 'unchanged.txt'), 'source')
  const environment: NodeJS.ProcessEnv = {
    DSH_HOME: join(f.root, 'foreign-home'), DSH_AGENTS_HOME: join(f.root, 'foreign-agents'),
    AGENTRANS_DEV_ROOT: join(f.root, 'development'),
    [PRODUCT_LAUNCH_CONTEXT_ENV]: serializeProductLaunchContext(resolveProductLaunchContext({
      purpose: 'user', instanceRoot: f.instance, codeRoot: join(f.instance, 'app'), resourcesRoot: f.resources,
    })),
  }
  const context = configureDesktopProduct(f.app, f.resources, f.source, environment)
  expect(context.purpose).toBe('development')
  expect(context.instanceRoot).toBe(join(f.root, 'development'))
  expect(readFileSync(join(f.source, 'unchanged.txt'), 'utf8')).toBe('source')
  expect(readdirSync(f.source)).toEqual(['unchanged.txt'])
})

it('retains an explicitly isolated verification instance for the same packaged payload', () => {
  const f = fixture()
  const candidate = resolveProductLaunchContext({
    purpose: 'verification', instanceRoot: join(f.root, 'verification'),
    codeRoot: join(f.instance, 'app'), resourcesRoot: f.resources,
  })
  const environment: NodeJS.ProcessEnv = { [PRODUCT_LAUNCH_CONTEXT_ENV]: serializeProductLaunchContext(candidate) }
  const context = configureDesktopProduct(f.app, f.resources, f.source, environment)
  expect(context.instanceRoot).toBe(candidate.instanceRoot)
  expect(environment.DSH_HOME).toBe(candidate.paths.dshHomeDir)
  expect(readdirSync(f.instance)).toEqual(['app'])
  expect(readdirSync(f.appPath)).toEqual([])
})

it('rejects a verification override from a different payload before writing state', () => {
  const f = fixture()
  const candidate = resolveProductLaunchContext({
    purpose: 'verification', instanceRoot: join(f.root, 'verification'),
    codeRoot: f.source, resourcesRoot: f.source,
  })
  const environment: NodeJS.ProcessEnv = {
    [PRODUCT_LAUNCH_CONTEXT_ENV]: serializeProductLaunchContext(candidate),
    DSH_HOME: join(f.root, 'foreign-home'), DSH_AGENTS_HOME: join(f.root, 'foreign-agents'),
  }
  const before = { ...environment }
  expect(() => configureDesktopProduct(f.app, f.resources, f.source, environment))
    .toThrow(expect.objectContaining({ code: 'INVALID_LAUNCH_REQUEST' }))
  expect(readdirSync(f.instance)).toEqual(['app'])
  expect(existsSync(candidate.instanceRoot)).toBe(false)
  expect(existsSync(environment.DSH_HOME!)).toBe(false)
  expect(environment).toEqual(before)
  expect(f.app.setPath).not.toHaveBeenCalled()
})

it('binds an unpackaged verification app to its own code and resource anchors', () => {
  const f = fixture()
  f.app.isPackaged = false
  const candidate = resolveProductLaunchContext({
    purpose: 'verification', instanceRoot: join(f.root, 'verification'),
    codeRoot: f.appPath, resourcesRoot: f.resources,
  })
  const environment: NodeJS.ProcessEnv = {
    [PRODUCT_LAUNCH_CONTEXT_ENV]: serializeProductLaunchContext(candidate),
    AGENTRANS_DEV_ROOT: join(f.root, 'unrelated-development'),
  }
  const context = configureDesktopProduct(f.app, f.resources, f.source, environment, 'darwin')
  expect(context).toEqual(candidate)
  expect(environment.DSH_HOME).toBe(candidate.paths.dshHomeDir)
  expect(f.app.setPath.mock.calls).toEqual([
    ['userData', candidate.paths.electronUserDataDir], ['sessionData', candidate.paths.electronUserDataDir],
    ['logs', candidate.paths.logsDir], ['crashDumps', candidate.paths.crashDumpsDir],
  ])
  expect(existsSync(environment.AGENTRANS_DEV_ROOT!)).toBe(false)
  expect(readdirSync(f.appPath)).toEqual([])
})

it.each(['code', 'resources'])('rejects an unpackaged verification context with a foreign %s anchor before effects', (anchor) => {
  const f = fixture()
  f.app.isPackaged = false
  const candidate = resolveProductLaunchContext({
    purpose: 'verification', instanceRoot: join(f.root, 'verification'),
    codeRoot: anchor === 'code' ? f.source : f.appPath,
    resourcesRoot: anchor === 'resources' ? f.source : f.resources,
  })
  const environment: NodeJS.ProcessEnv = { [PRODUCT_LAUNCH_CONTEXT_ENV]: serializeProductLaunchContext(candidate) }
  const before = { ...environment }
  expect(() => configureDesktopProduct(f.app, f.resources, f.source, environment))
    .toThrow(expect.objectContaining({ code: 'INVALID_LAUNCH_REQUEST' }))
  expect(existsSync(candidate.instanceRoot)).toBe(false)
  expect(environment).toEqual(before)
  expect(f.app.setPath).not.toHaveBeenCalled()
})

it('does not apply the Windows user-package layout to a macOS application bundle', () => {
  const f = fixture()
  expect(() => configureDesktopProduct(f.app, f.resources, f.source, {}, 'darwin')).toThrow('platform-specific')
  expect(readdirSync(f.instance)).toEqual(['app'])
  expect(f.app.setPath).not.toHaveBeenCalled()
})
