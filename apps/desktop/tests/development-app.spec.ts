/** Cold-start launcher preserves workspace paths without evaluating shell syntax. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { resolveDevelopmentLaunchContext, resolveProductLaunchContext, serializeProductLaunchContext } from '@agentrans/product-layout/launch-context'
import { developmentBundleMetadata, developmentLauncher } from '../scripts/development-app.ts'
import { configureDesktopProduct } from '../src/product-context.ts'

it('omits product protocol associations from the generated development bundle', () => {
  expect(developmentBundleMetadata('/source/desktop').CFBundleURLTypes).toEqual([])
})

it('persists both Harness roots and the same instance identity in the cold-start script', () => {
  const root = join(tmpdir(), 'agentrans-development-script')
  const context = resolveProductLaunchContext({
    purpose: 'development', instanceRoot: join(root, 'instance'), codeRoot: join(root, 'source'), resourcesRoot: join(root, 'source'),
  })
  const script = developmentLauncher({ electron: join(root, 'Electron'), appRoot: context.codeRoot,
    directory: join(root, 'build'), context, mainPort: 9229, rendererPort: 9222, hostPort: 9230, openDevtools: '0' }, join(root, 'Dev.app'))
  expect(script).toContain(`export DSH_HOME='${context.paths.dshHomeDir}'`)
  expect(script).toContain(`export AGENTRANS_DEV_ROOT='${context.instanceRoot}'`)
  expect(script).toContain(`export DSH_AGENTS_HOME='${context.paths.dshAgentsHomeDir}'`)
  expect(script).toContain(`export AGENTRANS_LAUNCH_CONTEXT='${serializeProductLaunchContext(context)}'`)
  expect(script).toContain(`'--user-data-dir=${context.paths.electronUserDataDir}'`)
})

it('retains a custom instance when the generated cold-start environment reaches the GUI', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentrans-development-cold-start-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const sourceRoot = join(root, 'source')
  mkdirSync(sourceRoot)
  const context = resolveDevelopmentLaunchContext({ sourceRoot, instanceRoot: join(root, 'custom development state') })
  const script = developmentLauncher({ electron: join(root, 'Electron'), appRoot: join(sourceRoot, 'apps', 'desktop'),
    directory: join(root, 'build'), context, mainPort: 9229, rendererPort: 9222, hostPort: 9230, openDevtools: '0' }, join(root, 'Dev.app'))
  // These fixture paths contain no apostrophes; the POSIX subprocess case covers shell escaping.
  const environment: NodeJS.ProcessEnv = Object.fromEntries([...script.matchAll(/^export (\w+)='([^']*)'$/gm)]
    .map(match => [match[1]!, match[2]!]))
  const app = { isPackaged: false, getAppPath: () => join(sourceRoot, 'apps', 'desktop'), setPath: vi.fn() }
  expect(configureDesktopProduct(app, sourceRoot, sourceRoot, environment, 'darwin')).toEqual(context)
  expect(environment.AGENTRANS_DEV_ROOT).toBe(context.instanceRoot)
  expect(environment.DSH_HOME).toBe(context.paths.dshHomeDir)
  expect(environment.DSH_AGENTS_HOME).toBe(context.paths.dshAgentsHomeDir)
  expect(app.setPath.mock.calls).toEqual([
    ['userData', context.paths.electronUserDataDir], ['sessionData', context.paths.electronUserDataDir],
    ['logs', context.paths.logsDir], ['crashDumps', context.paths.crashDumpsDir],
  ])
  expect(existsSync(resolveDevelopmentLaunchContext({ sourceRoot }).instanceRoot)).toBe(false)
})

it.skipIf(process.platform === 'win32')('passes literal workspace paths and cold-start settings to Electron', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-development-app-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const bundle = join(root, "Harness ' $(false).app")
  const binary = join(bundle, 'Contents', 'MacOS', 'Electron')
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$AGENTRANS_DEV_ROOT" "$DSH_HOME" "$DSH_AGENTS_HOME" "$AGENTRANS_LAUNCH_CONTEXT" "$DSH_DESKTOP_DEV_APP" "$DSH_DESKTOP_OPEN_DEVTOOLS" "$@"\n', { mode: 0o755 })
  const launcher = join(root, 'launcher')
  const context = resolveProductLaunchContext({ purpose: 'development', instanceRoot: join(root, "instance ' $(false)"),
    codeRoot: join(root, 'source'), resourcesRoot: join(root, 'source') })
  writeFileSync(launcher, developmentLauncher({ electron: binary, appRoot: root, directory: root,
    context, mainPort: 9229, rendererPort: 9222, hostPort: 9230, openDevtools: '0' }, bundle))
  const result = execFileSync('/bin/sh', [launcher, '--test-launch-argument'], { encoding: 'utf8' })
  expect(result.trimEnd().split('\n')).toEqual([context.instanceRoot, context.paths.dshHomeDir, context.paths.dshAgentsHomeDir,
    serializeProductLaunchContext(context), '1', '0', '--inspect=127.0.0.1:9229',
    '--remote-debugging-port=9222', `--user-data-dir=${context.paths.electronUserDataDir}`, root, '--test-launch-argument'])
})
