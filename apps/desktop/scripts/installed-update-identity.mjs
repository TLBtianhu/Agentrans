/** Configure only a qualification package's identity before the production main entry loads. */
import { dirname, join, resolve } from 'node:path'
import { applyProductLaunchEnvironment, prepareProductState, resolveProductLaunchContext } from '@deepseek-ai/dsh-product-layout/launch-context'

/**
 * Keep test application data and journals outside the replaceable installation tree.
 * @param {{ getPath(name: string): string, setPath(name: string, path: string): void }} app Electron path API before readiness.
 * @param {{ id: string, versions: readonly string[] }} run Embedded qualification identity and version pair.
 * @param {{ version?: string, dshDesktopAppId?: string }} metadata Installed package metadata.
 * @param {NodeJS.ProcessEnv} environment Main-process environment modified before production imports.
 * @param {string} resourcesRoot Absolute package resources, or the explicit fixture resources.
 * @returns {{ root: string, userData: string, harnessHome: string, agentsHome: string, journals: string }} Shared paths for both versions.
 */
export function configureInstalledUpdateIdentity(app, run, metadata, environment, resourcesRoot) {
  if (!/^[a-f0-9]{24}$/u.test(run.id) || run.versions.length !== 2
    || metadata.dshDesktopAppId !== `com.deepseek.dsh.qualification.q${run.id}`
    || !run.versions.includes(metadata.version)) {
    throw new Error('installed update: qualification package identity does not match its bootstrap')
  }
  const root = join(app.getPath('appData'), 'dsh-update-qualification', run.id)
  const context = resolveProductLaunchContext({
    purpose: 'verification', instanceRoot: root,
    codeRoot: dirname(resolve(resourcesRoot)), resourcesRoot: resolve(resourcesRoot),
  })
  prepareProductState(context)
  const paths = {
    root, userData: context.paths.electronUserDataDir, harnessHome: context.paths.dshHomeDir,
    agentsHome: context.paths.dshAgentsHomeDir, journals: context.paths.updateJournalDir,
  }
  app.setPath('userData', paths.userData)
  app.setPath('sessionData', paths.userData)
  applyProductLaunchEnvironment(context, environment)
  environment.DSH_DESKTOP_UPDATE_JOURNAL_DIR = paths.journals
  return paths
}
