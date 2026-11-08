/** Scoped uninstall planning and ordered execution with explicit external-operation hooks. */
import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
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

  /**
   * @param completed - Operations that finished before the failure.
   * @param failedOperation - Removal target or Windows registration operation that did not complete.
   * @param options - Original failure, including filesystem or registration details.
   */
  constructor(readonly completed: readonly string[], readonly failedOperation: string, options?: ErrorOptions) {
    super('Uninstall stopped before all selected operations completed', options)
    this.name = 'UninstallExecutionError'
  }
}

/** A filesystem condition that prevents establishing a selected path's ownership. */
export type UninstallFilesystemFailure = 'LINK' | 'NOT_DIRECTORY' | 'UNSUPPORTED_ENTRY' | 'INSPECTION_FAILED'

/** Refuses deletion through an unsafe existing filesystem component. */
export class UninstallFilesystemError extends Error {
  /** Stable identity for an unsafe or unreadable uninstall path. */
  readonly code = 'UNINSTALL_PATH_UNSAFE'

  /**
   * @param path - Existing component whose ownership or entry kind could not be established.
   * @param reason - Machine-readable refusal classification.
   * @param options - Original filesystem inspection failure, when present.
   */
  constructor(readonly path: string, readonly reason: UninstallFilesystemFailure, options?: ErrorOptions) {
    super(`Cannot establish uninstall path ownership: ${path} (${reason})`, options)
    this.name = 'UninstallFilesystemError'
  }
}

/** Raised when a planned removal resolves outside the installation root. */
export class UninstallPathError extends Error {
  /** Stable machine-readable code for a removal outside the product root. */
  readonly code = 'UNINSTALL_PATH_OUTSIDE_ROOT'

  /** @param path - The rejected removal path. */
  constructor(readonly path: string) {
    super(`Uninstall path is outside the installation root: ${path}`)
    this.name = 'UninstallPathError'
  }
}

/**
 * Reject removals that would leave the single installation root.
 * @param root - Installation root that owns every removable path.
 * @param paths - Candidate removal paths.
 * @throws {UninstallPathError} When a path is the root itself or resolves outside it.
 */
export function assertOwnedPaths(root: string, paths: readonly string[]): void {
  const absoluteRoot = resolve(root)
  for (const path of paths) {
    const offset = relative(absoluteRoot, resolve(path))
    if (offset === '' || isAbsolute(offset) || offset.split(sep)[0] === '..') throw new UninstallPathError(path)
  }
}

function inspect(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path, { throwIfNoEntry: false }) }
  catch (error) { throw new UninstallFilesystemError(path, 'INSPECTION_FAILED', { cause: error }) }
}

function assertFilesystemOwnership(path: string): void {
  const absolute = resolve(path)
  const ancestors: string[] = []
  for (let current = dirname(absolute); ; current = dirname(current)) {
    ancestors.push(current)
    if (current === parse(current).root) break
  }
  for (const current of [...ancestors.reverse(), absolute]) {
    const entry = inspect(current)
    if (entry === undefined) continue
    if (entry.isSymbolicLink()) throw new UninstallFilesystemError(current, 'LINK')
    if (current !== absolute && !entry.isDirectory()) throw new UninstallFilesystemError(current, 'NOT_DIRECTORY')
    if (current === absolute && !entry.isDirectory() && !entry.isFile()) {
      throw new UninstallFilesystemError(current, 'UNSUPPORTED_ENTRY')
    }
  }
}

function removeEntry(path: string): void {
  const entry = inspect(path)
  if (entry === undefined) return
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    unlinkSync(path)
    return
  }
  for (const name of readdirSync(path)) removeEntry(join(path, name))
  rmdirSync(path)
}

/**
 * Preview a scoped uninstall without touching files or external registration state.
 * @param layout - Single-root installation to uninstall.
 * @param scope - Categories selected for deletion.
 * @param options - Confirmation for the all-categories scope.
 * @returns Paths to remove, preserve, and externally deregister.
 * @throws {UninstallConfirmationError} When every category is selected without confirmation.
 * @throws {UninstallPathError} When a layout path resolves outside the installation root.
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
  assertOwnedPaths(layout.root, remove)
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
 * Selected roots and ancestors must be ordinary entries; nested links are unlinked without visiting their targets.
 * Checks do not provide handle-relative isolation against concurrent filesystem replacement by other processes.
 * @param plan - Preview previously returned by planUninstall.
 * @param hooks - Windows registration callback required by the installed app scope.
 * @returns Completed operations in execution order.
 * @throws {UninstallHookError} Before deletion when a required callback is missing.
 * @throws {UninstallPathError} Before deletion when any selected path escapes the installation root.
 * @throws {UninstallFilesystemError} Before deletion when a selected path or ancestor is linked or unreadable.
 * @throws {UninstallExecutionError} With completed operations when a later operation fails.
 */
export async function executeUninstallPlan(plan: UninstallPlan, hooks: UninstallHooks = {}): Promise<UninstallResult> {
  const root = resolve(plan.layout.root)
  const paths = [...plan.remove].map(path => resolve(path))
  const removeRegistration = plan.scope.app && plan.layout.channel === 'installed' ? hooks.removeRegistration : undefined
  if (plan.scope.app && plan.layout.channel === 'installed' && removeRegistration === undefined) {
    throw new UninstallHookError('Windows registration removal requires the installer callback')
  }
  assertOwnedPaths(root, paths)
  for (const path of paths) assertFilesystemOwnership(path)
  const completed: string[] = []
  let failedOperation = paths[0] ?? 'windows:remove-registration'
  try {
    for (const path of paths) {
      failedOperation = path
      assertFilesystemOwnership(path)
      removeEntry(path)
      completed.push(path)
    }
    if (removeRegistration !== undefined) {
      failedOperation = 'windows:remove-registration'
      await removeRegistration()
      completed.push('windows:remove-registration')
    }
  } catch (error) {
    throw new UninstallExecutionError(completed, failedOperation, { cause: error })
  }
  return { completed }
}
