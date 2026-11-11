/** The installed CLI uses the shared pnpm distribution with Electron's package-operation environment. */

import { delimiter, join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import {
  PRODUCT_LAUNCH_CONTEXT_ENV, parseProductLaunchContext, resolveProductLaunchContext, serializeProductLaunchContext,
} from '@agentrans/product-layout/launch-context'
import { runCli } from '@agentrans/cli/lib/bin.js'
import { runDesktopCli } from '../../desktop-host/src/cli.ts'
import { installOfficeEngineResolution } from '../../desktop-host/src/office-engine.ts'
import { configureDesktopProduct } from '../src/product-context.ts'

vi.mock('@agentrans/cli/lib/bin.js', () => ({ runCli: vi.fn() }))
vi.mock('../../desktop-host/src/office-engine.ts', () => ({ installOfficeEngineResolution: vi.fn() }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it.skipIf(process.platform !== 'win32').each(['system-bin', undefined])('dispatches with bundled pnpm when PATH is %s', async (path) => {
  vi.stubEnv('PATH', path)
  vi.stubEnv('AGENTRANS_HOME', 'must-not-use-upstream-home')
  vi.stubEnv('AGENTRANS_AGENTS_HOME', 'must-not-use-upstream-agents')
  vi.stubEnv(PRODUCT_LAUNCH_CONTEXT_ENV, undefined)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentrans-cli-instance-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const instance = join(root, 'Application 中文 with spaces')
  const resources = join(instance, 'app', 'resources')
  mkdirSync(resources, { recursive: true })
  const runtime = join(resources, 'app.asar', 'dsh')
  const support = join(resources, 'runtime')

  await runDesktopCli(runtime, support)

  expect(process.env.AGENTRANS_HOME).toBe(join(instance, 'data', 'dsh', 'home'))
  expect(process.env.AGENTRANS_AGENTS_HOME).toBe(join(instance, 'data', 'dsh', 'agents'))
  expect(parseProductLaunchContext(process.env[PRODUCT_LAUNCH_CONTEXT_ENV]!)).toMatchObject({
    purpose: 'user', instanceRoot: instance, codeRoot: join(instance, 'app'), resourcesRoot: resources,
  })

  expect(installOfficeEngineResolution).toHaveBeenCalledExactlyOnceWith(runtime)
  expect(runCli).toHaveBeenCalledExactlyOnceWith({
    manageDesktopProfile: true,
    packageManager: {
      command: process.execPath,
      args: ['--expose-internals', join(support, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        AGENTRANS_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: `${join(support, 'bin')}${delimiter}${path ?? ''}`,
      },
    },
  })
})

it('shares one verification instance with the packaged GUI without writing payload or foreign homes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentrans-cli-verification-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const instance = join(root, 'Application 中文 with spaces')
  const resources = join(instance, 'app', 'resources')
  const appPath = join(resources, 'app.asar')
  mkdirSync(appPath, { recursive: true })
  const payload = join(appPath, 'payload.txt')
  writeFileSync(payload, 'immutable payload')
  const context = resolveProductLaunchContext({
    purpose: 'verification', instanceRoot: join(root, 'verification-state'),
    codeRoot: join(instance, 'app'), resourcesRoot: resources,
  })
  const inherited = {
    AGENTRANS_HOME: join(root, 'foreign-home'), AGENTRANS_AGENTS_HOME: join(root, 'foreign-agents'),
    [PRODUCT_LAUNCH_CONTEXT_ENV]: serializeProductLaunchContext(context),
  }
  for (const [key, value] of Object.entries(inherited)) vi.stubEnv(key, value)
  const guiEnvironment = { ...inherited }
  const app = { isPackaged: true, getAppPath: () => appPath, setPath: vi.fn() }
  const guiContext = configureDesktopProduct(app, resources, root, guiEnvironment)
  const runtime = join(appPath, 'dsh')
  await runDesktopCli(runtime, join(resources, 'runtime'))
  expect(parseProductLaunchContext(process.env[PRODUCT_LAUNCH_CONTEXT_ENV]!)).toEqual(guiContext)
  expect(process.env.AGENTRANS_HOME).toBe(guiEnvironment.AGENTRANS_HOME)
  expect(process.env.AGENTRANS_AGENTS_HOME).toBe(guiEnvironment.AGENTRANS_AGENTS_HOME)
  expect(app.setPath.mock.calls).toEqual([
    ['userData', context.paths.electronUserDataDir], ['sessionData', context.paths.electronUserDataDir],
    ['logs', context.paths.logsDir], ['crashDumps', context.paths.crashDumpsDir],
  ])
  expect(readFileSync(payload, 'utf8')).toBe('immutable payload')
  expect(readdirSync(instance)).toEqual(['app'])
  expect(readdirSync(resources)).toEqual(['app.asar'])
  expect(readdirSync(appPath)).toEqual(['payload.txt'])
  expect(existsSync(inherited.AGENTRANS_HOME)).toBe(false)
  expect(existsSync(inherited.AGENTRANS_AGENTS_HOME)).toBe(false)
  expect(installOfficeEngineResolution).toHaveBeenCalledExactlyOnceWith(runtime)
  expect(runCli).toHaveBeenCalledOnce()
})

it('rejects a foreign verification payload before changing paths or creating state', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentrans-cli-foreign-payload-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const instance = join(root, 'Application')
  const resources = join(instance, 'app', 'resources')
  const foreignCode = join(root, 'foreign-payload')
  mkdirSync(resources, { recursive: true })
  mkdirSync(foreignCode)
  const context = resolveProductLaunchContext({
    purpose: 'verification', instanceRoot: join(root, 'verification-state'),
    codeRoot: foreignCode, resourcesRoot: foreignCode,
  })
  const foreignHome = join(root, 'foreign-home')
  vi.stubEnv('AGENTRANS_HOME', foreignHome)
  vi.stubEnv('AGENTRANS_AGENTS_HOME', join(root, 'foreign-agents'))
  vi.stubEnv(PRODUCT_LAUNCH_CONTEXT_ENV, serializeProductLaunchContext(context))
  await expect(runDesktopCli(join(resources, 'app.asar', 'dsh'), join(resources, 'runtime')))
    .rejects.toMatchObject({ code: 'INVALID_LAUNCH_REQUEST' })
  expect(process.env.AGENTRANS_HOME).toBe(foreignHome)
  expect(parseProductLaunchContext(process.env[PRODUCT_LAUNCH_CONTEXT_ENV]!)).toEqual(context)
  expect(existsSync(context.instanceRoot)).toBe(false)
  expect(existsSync(foreignHome)).toBe(false)
  expect(readdirSync(instance)).toEqual(['app'])
  expect(readdirSync(resources)).toEqual([])
  expect(readdirSync(foreignCode)).toEqual([])
  expect(installOfficeEngineResolution).not.toHaveBeenCalled()
  expect(runCli).not.toHaveBeenCalled()
})
