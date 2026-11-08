/** Desktop development starts a separate instance even in an inherited production environment. */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { parseProductLaunchContext, prepareProductState } from '@deepseek-ai/dsh-product-layout/launch-context'
import { resolveDesktopDevelopmentLaunch } from '../scripts/development-context.ts'

function fixture(): { root: string; source: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentrans-development-context-')))
  const source = join(root, 'source')
  mkdirSync(source)
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  return { root, source }
}

it('keeps default development state outside both source and build output while replacing inherited roots', () => {
  const { root, source } = fixture()
  const inherited = { DSH_HOME: join(root, 'official-home'), DSH_AGENTS_HOME: join(root, 'official-agents'),
    DSH_DESKTOP_USER_DATA_DIR: join(source, '.desktop-build', 'old-electron-data'),
    AGENTRANS_LAUNCH_CONTEXT: 'untrusted-inherited-context', MODEL_TEST_VALUE: 'retained' }
  const { context, environment } = resolveDesktopDevelopmentLaunch(source, inherited)
  expect(context.purpose).toBe('development')
  expect(dirname(context.instanceRoot)).toBe(join(root, '.dev-data', 'agentrans', 'dev'))
  expect(context.codeRoot).toBe(source)
  expect(context.resourcesRoot).toBe(source)
  expect(existsSync(context.instanceRoot)).toBe(false)
  expect(environment.DSH_HOME).toBe(context.paths.dshHomeDir)
  expect(environment.DSH_AGENTS_HOME).toBe(context.paths.dshAgentsHomeDir)
  expect(environment.MODEL_TEST_VALUE).toBe('retained')
  expect(inherited.DSH_HOME).toBe(join(root, 'official-home'))
  expect(context.paths.electronUserDataDir).not.toBe(inherited.DSH_DESKTOP_USER_DATA_DIR)
  expect(parseProductLaunchContext(environment.AGENTRANS_LAUNCH_CONTEXT!)).toEqual(context)
  expect(resolveDesktopDevelopmentLaunch(source, {}).context).toEqual(context)
  prepareProductState(context)
  expect(existsSync(context.paths.electronUserDataDir)).toBe(true)
  expect(existsSync(context.paths.dshHomeDir)).toBe(true)
  expect(existsSync(context.paths.dshAgentsHomeDir)).toBe(true)
  expect(existsSync(join(source, '.desktop-build'))).toBe(false)
  expect(existsSync(inherited.DSH_HOME)).toBe(false)
  expect(existsSync(inherited.DSH_AGENTS_HOME)).toBe(false)
})

it('accepts only the explicit development instance-root override', () => {
  const { root, source } = fixture()
  const instanceRoot = join(root, 'custom development state')
  const { context, environment } = resolveDesktopDevelopmentLaunch(source, {
    AGENTRANS_DEV_ROOT: instanceRoot,
    DSH_HOME: join(root, 'another-home'), DSH_AGENTS_HOME: join(root, 'another-agents'),
  })
  expect(context.instanceRoot).toBe(instanceRoot)
  expect(environment.DSH_HOME).toBe(join(instanceRoot, 'data', 'dsh', 'home'))
  expect(environment.DSH_AGENTS_HOME).toBe(join(instanceRoot, 'data', 'dsh', 'agents'))
})

it('rejects a development override inside build output before creating state', () => {
  const { source } = fixture()
  const instanceRoot = join(source, '.desktop-build', 'development')
  expect(() => resolveDesktopDevelopmentLaunch(source, { AGENTRANS_DEV_ROOT: instanceRoot })).toThrow('overlap')
  expect(existsSync(instanceRoot)).toBe(false)
})
