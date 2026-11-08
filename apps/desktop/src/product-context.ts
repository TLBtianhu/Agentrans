/** Resolve Desktop product state before application modules or Chromium can use ambient paths. */
import { realpathSync } from 'node:fs'
import { relative } from 'node:path'
import {
  PRODUCT_LAUNCH_CONTEXT_ENV, ProductLaunchError, applyProductLaunchEnvironment,
  parseProductLaunchContext, prepareProductState, resolveDevelopmentLaunchContext,
  resolvePackagedLaunchContext, type ProductLaunchContext,
} from '@deepseek-ai/dsh-product-layout/launch-context'

/** Electron operations available before application readiness. */
interface DesktopProductApplication {
  readonly isPackaged: boolean
  getAppPath(): string
  setPath(name: 'userData' | 'sessionData' | 'logs' | 'crashDumps', path: string): void
}

/**
 * Bind a source or packaged Desktop to its own state before any application import.
 * @param app - Electron application before readiness.
 * @param resourcesRoot - Absolute packaged resource directory.
 * @param sourceRoot - Absolute repository root for an unpackaged launch.
 * @param environment - Process environment; only product-owned fields are replaced.
 * @param platform - Platform whose packaged layout is supported; defaults to the host.
 * @returns The resolved context also inherited by the private Host.
 * @throws {ProductLaunchError} For unsafe paths, a foreign payload anchor, or an unsupported user package layout.
 */
export function configureDesktopProduct(
  app: DesktopProductApplication,
  resourcesRoot: string,
  sourceRoot: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): ProductLaunchContext {
  let context: ProductLaunchContext
  if (app.isPackaged) {
    context = resolvePackagedLaunchContext(realpathSync(resourcesRoot), environment[PRODUCT_LAUNCH_CONTEXT_ENV])
    if (platform !== 'win32' && context.purpose !== 'verification') {
      throw new ProductLaunchError('INVALID_LAUNCH_REQUEST', 'Packaged user startup requires a platform-specific product layout')
    }
  } else {
    const encoded = environment[PRODUCT_LAUNCH_CONTEXT_ENV]
    const candidate = encoded === undefined ? undefined : parseProductLaunchContext(encoded)
    if (candidate?.purpose === 'verification') {
      if (relative(candidate.codeRoot, realpathSync(app.getAppPath())) !== ''
        || relative(candidate.resourcesRoot, realpathSync(resourcesRoot)) !== '') {
        throw new ProductLaunchError('INVALID_LAUNCH_REQUEST', 'Verification context does not match the current development application')
      }
      context = candidate
    } else {
      context = resolveDevelopmentLaunchContext({
        sourceRoot: realpathSync(sourceRoot),
        ...(environment.AGENTRANS_DEV_ROOT === undefined ? {} : { instanceRoot: environment.AGENTRANS_DEV_ROOT }),
      })
    }
  }
  prepareProductState(context)
  applyProductLaunchEnvironment(context, environment)
  app.setPath('userData', context.paths.electronUserDataDir)
  app.setPath('sessionData', context.paths.electronUserDataDir)
  app.setPath('logs', context.paths.logsDir)
  app.setPath('crashDumps', context.paths.crashDumpsDir)
  return context
}
