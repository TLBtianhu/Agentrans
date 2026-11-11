/** Resolve desktop development state independently of build output and inherited Harness locations. */
import { realpathSync } from 'node:fs'
import {
  productLaunchEnvironment,
  resolveDevelopmentLaunchContext,
  type ProductLaunchContext,
} from '@agentrans/product-layout/launch-context'

/** Development identity and the environment passed to Electron and its Host. */
export interface DesktopDevelopmentLaunch {
  readonly context: ProductLaunchContext
  readonly environment: NodeJS.ProcessEnv
}

/**
 * Resolve one stable instance for a workspace; only AGENTRANS_DEV_ROOT overrides its state location.
 * @param repositoryRoot - Existing source checkout; symbolic path aliases are canonicalized before hashing.
 * @param inherited - Parent environment, including model credentials and optional development settings.
 * @returns A development context and an environment whose Harness roots come from that context.
 */
export function resolveDesktopDevelopmentLaunch(repositoryRoot: string, inherited: NodeJS.ProcessEnv): DesktopDevelopmentLaunch {
  const context = resolveDevelopmentLaunchContext({
    sourceRoot: realpathSync(repositoryRoot),
    ...(inherited.AGENTRANS_DEV_ROOT === undefined ? {} : { instanceRoot: inherited.AGENTRANS_DEV_ROOT }),
  })
  return { context, environment: productLaunchEnvironment(context, inherited) }
}
