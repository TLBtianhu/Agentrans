/** App and DSH integration presence states used by install and repair flows. */
import { stat } from 'node:fs/promises'
import type { ProductLayout } from './layout.ts'

/** Four complete local states; integration-only is an error, not a standalone installation. */
export type IntegrationState = 'ready' | 'app-only' | 'empty' | 'integration-only'

/** Raised when an integration package exists without the application it requires. */
export class IntegrationStateError extends Error {
  /** Stable machine-readable error code for an integration-only installation. */
  readonly code = 'INTEGRATION_WITHOUT_APP'

  constructor() {
    super('DSH integration requires the Agentrans application to be installed first')
    this.name = 'IntegrationStateError'
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Inspect only the application and integration package directories; no DSH profile is read or changed.
 * @param layout - Single-root product layout to inspect.
 * @returns One of the four local integration states.
 */
export async function inspectIntegrationState(layout: ProductLayout): Promise<IntegrationState> {
  const [app, integration] = await Promise.all([
    isDirectory(layout.appDir),
    isDirectory(layout.integrationPackageDir),
  ])
  if (app && integration) return 'ready'
  if (app) return 'app-only'
  if (integration) return 'integration-only'
  return 'empty'
}

/**
 * Reject an integration-only state before enabling or removing a DSH integration.
 * @param state - State returned by inspectIntegrationState.
 * @returns Nothing when the state can proceed.
 * @throws {IntegrationStateError} When only the integration package exists.
 */
export function assertIntegrationUsable(state: IntegrationState): void {
  if (state === 'integration-only') throw new IntegrationStateError()
}
