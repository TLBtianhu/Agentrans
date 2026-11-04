/** Scoped uninstall planning and ordered execution with explicit external-operation hooks. */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProductLayout } from './layout.ts'

/** Asset and data categories a user may choose to remove. */
export interface UninstallScope {
  readonly app: boolean
  readonly sessions: boolean
  readonly settings: boolean
  readonly models: boolean
  readonly runtimes: boolean
  readonly exports: boolean
}

/** Default scope: remove the application and regenerable cache, preserve user data and assets. */
export const APP_ONLY_UNINSTALL_SCOPE: UninstallScope = {
  app: true, sessions: false, settings: false, models: false, runtimes: false, exports: false,
}

/** Scope that selects every removable category; execution requires explicit confirmation. */
export const ALL_UNINSTALL_SCOPE: UninstallScope = {
  app: true, sessions: true, settings: true, models: true, runtimes: true, exports: true,
}

/** Preview of one scoped uninstall before any deletion or external operation. */
export interface UninstallPlan {
  readonly layout: ProductLayout
  readonly scope: UninstallScope
  readonly remove: readonly string[]
  readonly preserve: readonly string[]
  readonly externalOperations: readonly string[]
  readonly requiresConfirmation: boolean
}

/** Formal host operations required by the selected scope. */
export interface UninstallHooks {
  /** Remove Windows uninstall and shortcut registrations through the installer backend. */
  readonly removeRegistration?: () => Promise<void>
}

/** Completed operations in one uninstall execution. */
export interface UninstallResult {
  readonly completed: readonly string[]
}

/** Raised when full deletion was not explicitly confirmed. */
export class UninstallConfirmationError extends Error {
  /** Stable machine-readable code for an unconfirmed full deletion. */
  readonly code = 'UNINSTALL_CONFIRMATION_REQUIRED'

  constructor() {
    super('Full uninstall requires explicit confirmation')
    this.name = 'UninstallConfirmationError'
  }
}

/** Raised before deletion when a required official external-operation callback is absent. */
export class UninstallHookError extends Error {
  /** Stable machine-readable code for a missing official-operation callback. */
  readonly code = 'UNINSTALL_HOOK_REQUIRED'

  constructor(message: string) {
    super(message)
    this.name = 'UninstallHookError'
  }
}

/** Raised after a partial uninstall; completed operations remain inspectable. */
export class UninstallExecutionError extends Error {
  /** Stable machine-readable code for an uninstall that stopped partway through. */
  readonly code = 'UNINSTALL_PARTIAL'

  constructor(readonly completed: readonly string[], options?: ErrorOptions) {
    super('Uninstall stopped before all selected operations completed', options)
    this.name = 'UninstallExecutionError'
  }
}

/**
 * Preview a scoped uninstall without touching files or external registration state.
 * @param layout - Single-root installation to uninstall.
 * @param scope - Categories selected for deletion.
 * @param options - Confirmation for the all-categories scope.
 * @returns Paths to remove, preserve, and externally deregister.
 * @throws {UninstallConfirmationError} When every category is selected without confirmation.
 */
export function planUninstall(
  layout: ProductLayout,
  scope: UninstallScope = APP_ONLY_UNINSTALL_SCOPE,
  options: { readonly allConfirmed?: boolean } = {},
): UninstallPlan {
  if (Object.values(scope).every(Boolean) && options.allConfirmed !== true) throw new UninstallConfirmationError()
  const remove: string[] = []
  const preserve: string[] = [layout.dataDir]
  if (scope.app) {
    remove.push(layout.appDir, join(layout.dataDir, 'cache'))
  } else {
    preserve.push(layout.appDir, join(layout.dataDir, 'cache'))
  }
  if (scope.sessions) remove.push(join(layout.dataDir, 'sessions'), join(layout.dshHomeDir, 'sessions'))
  else preserve.push(join(layout.dataDir, 'sessions'), join(layout.dshHomeDir, 'sessions'))
  if (scope.settings) {
    remove.push(
      join(layout.dataDir, 'settings'),
      join(layout.dataDir, 'install'),
      join(layout.dshHomeDir, 'profiles'),
      join(layout.dshHomeDir, '.credentials.yaml'),
      join(layout.dshHomeDir, '.anonymous-user-id'),
      join(layout.dshHomeDir, 'storages'),
      layout.dshAgentsHomeDir,
    )
  } else {
    preserve.push(join(layout.dataDir, 'settings'), join(layout.dataDir, 'install'), layout.dshAgentsHomeDir)
  }
  if (scope.models) remove.push(layout.modelsDir)
  else preserve.push(layout.modelsDir)
  if (scope.runtimes) remove.push(layout.runtimesDir)
  else preserve.push(layout.runtimesDir)
  if (scope.exports) remove.push(join(layout.dataDir, 'exports'))
  else preserve.push(join(layout.dataDir, 'exports'))

  const externalOperations: string[] = []
  if (scope.app && layout.channel === 'installed') {
    externalOperations.push('windows:remove-uninstall-entry', 'windows:remove-start-menu-shortcut')
  }
  return {
    layout,
    scope,
    remove,
    preserve,
    externalOperations,
    requiresConfirmation: scope.sessions || scope.settings || scope.models || scope.runtimes || scope.exports,
  }
}

/**
 * Execute an uninstall in selected paths → registration order.
 * @param plan - Preview previously returned by planUninstall.
 * @param hooks - Windows registration callback required by the installed app scope.
 * @returns Completed operations in execution order.
 * @throws {UninstallHookError} Before deletion when a required callback is missing.
 * @throws {UninstallExecutionError} With completed operations when a later operation fails.
 */
export async function executeUninstallPlan(plan: UninstallPlan, hooks: UninstallHooks = {}): Promise<UninstallResult> {
  if (plan.scope.app && plan.layout.channel === 'installed' && hooks.removeRegistration === undefined) {
    throw new UninstallHookError('Windows registration removal requires the installer callback')
  }

  const completed: string[] = []
  try {
    for (const path of plan.remove) {
      await rm(path, { recursive: true, force: true })
      completed.push(path)
    }
    if (plan.scope.app && plan.layout.channel === 'installed') {
      await hooks.removeRegistration?.()
      completed.push('windows:remove-registration')
    }
  } catch (error) {
    throw new UninstallExecutionError(completed, { cause: error })
  }
  return { completed }
}
