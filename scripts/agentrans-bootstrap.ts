/** Initialize an isolated source-development instance before loading the dsh application. */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  prepareProductState,
  applyProductLaunchEnvironment,
  resolveDevelopmentLaunchContext,
} from '../packages/boot/product-layout/src/launch-context.ts'

const sourceRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const instanceRoot = process.env.AGENTRANS_DEV_ROOT
const context = resolveDevelopmentLaunchContext({
  sourceRoot,
  ...(instanceRoot === undefined ? {} : { instanceRoot }),
})
prepareProductState(context)
applyProductLaunchEnvironment(context, process.env)
