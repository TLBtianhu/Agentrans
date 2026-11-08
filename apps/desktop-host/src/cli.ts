/** Public dsh commands using the immutable runtime carried by the Desktop installation. */

import { delimiter, dirname, join, resolve } from 'node:path'
import {
  PRODUCT_LAUNCH_CONTEXT_ENV, ProductLaunchError,
  applyProductLaunchEnvironment, prepareProductState, resolvePackagedLaunchContext,
} from '@deepseek-ai/dsh-product-layout/launch-context'
import { installOfficeEngineResolution, runtimeArchivePath } from './office-engine.ts'

/**
 * Run the ordinary CLI with Desktop's bundled package manager and reserved-profile plugin access.
 * @param runtimeDir - Prepared or ASAR-contained production DSH package tree.
 * @param supportDir - Physical Desktop runtime directory containing the primary-runtime payload and Node launchers.
 * @returns Completion of the selected CLI command; profile plugins own their process lifetime.
 */
export async function runDesktopCli(runtimeDir: string, supportDir: string): Promise<void> {
  const context = resolvePackagedLaunchContext(dirname(resolve(supportDir)), process.env[PRODUCT_LAUNCH_CONTEXT_ENV])
  if (process.platform !== 'win32' && context.purpose !== 'verification') {
    throw new ProductLaunchError('INVALID_LAUNCH_REQUEST', 'Packaged user CLI requires a platform-specific product layout')
  }
  prepareProductState(context)
  applyProductLaunchEnvironment(context, process.env)
  installOfficeEngineResolution(runtimeDir)
  const { runCli } = await import('@deepseek-ai/dsh/lib/bin.js')
  await runCli({
    manageDesktopProfile: true,
    packageManager: {
      command: process.execPath,
      args: ['--expose-internals', join(supportDir, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: `${join(supportDir, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
      },
    },
  })
}

if (import.meta.main) {
  if (process.platform === 'win32') {
    const { installWindowsCliSignals } = await import('./windows-cli-signals.ts')
    await installWindowsCliSignals()
  }
  const runtimeDir = resolve(import.meta.dirname, '../../../..')
  await runDesktopCli(runtimeDir, join(dirname(runtimeArchivePath(runtimeDir) ?? runtimeDir), 'runtime'))
}
