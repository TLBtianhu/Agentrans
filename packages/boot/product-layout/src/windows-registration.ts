/** User-level Windows uninstall and Start Menu registration. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { ProductLayout } from './layout.ts'

/** Command execution seam used by tests and by the real Windows backend. */
export type WindowsCommandRunner = (file: string, args: readonly string[]) => Promise<void>

const execFileAsync = promisify(execFile)

async function defaultRunner(file: string, args: readonly string[]): Promise<void> {
  await execFileAsync(file, [...args], { windowsHide: true, timeout: 10_000 })
}

/** Complete registration plan; no registry or shortcut is changed while planning. */
export interface WindowsRegistrationPlan {
  readonly layout: ProductLayout
  readonly uninstallKey: string
  readonly shortcutPath: string
  readonly appExePath: string
  readonly uninstallExePath: string
  readonly displayName: string
  readonly displayVersion: string
  readonly publisher: string
  readonly installLocation: string
  readonly uninstallCommand: string
  readonly operations: readonly string[]
  readonly requiresAdmin: false
}

/** Inputs for a user-level Windows registration plan. */
export interface WindowsRegistrationOptions {
  readonly productName?: string
  readonly version: string
  readonly publisher: string
  readonly uninstallKey?: string
  readonly shortcutPath?: string
  readonly appExePath?: string
  readonly uninstallExePath?: string
}

/** Failure with the registration phases that completed before the error. */
export class WindowsRegistrationError extends Error {
  /** Stable machine-readable code for a failed Windows registration operation. */
  readonly code = 'WINDOWS_REGISTRATION_FAILED'

  constructor(readonly completed: readonly string[], options?: ErrorOptions) {
    super('Windows registration operation failed', options)
    this.name = 'WindowsRegistrationError'
  }
}

function quoteWindowsArg(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function isMissingRegistry(error: unknown): boolean {
  const text = String(error).toLowerCase()
  return text.includes('unable to find') || text.includes('cannot find') || text.includes('not exist')
}

/**
 * Build a user-level registration plan without changing Windows state.
 * @param layout - Installed product layout.
 * @param options - Product identity and optional test-specific key/shortcut overrides.
 * @returns The registration operations and all paths used by them.
 */
export function planWindowsRegistration(layout: ProductLayout, options: WindowsRegistrationOptions): WindowsRegistrationPlan {
  if (options.version.trim().length === 0 || options.publisher.trim().length === 0) {
    throw new TypeError('Windows registration version and publisher must be non-empty')
  }
  const productName = options.productName ?? 'Agentrans'
  const appExePath = options.appExePath ?? join(layout.appDir, 'Agentrans.exe')
  const uninstallExePath = options.uninstallExePath ?? join(layout.appDir, 'uninstall.exe')
  const shortcutPath = options.shortcutPath ?? join(
    process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', `${productName}.lnk`,
  )
  return {
    layout,
    uninstallKey: options.uninstallKey ?? 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Agentrans',
    shortcutPath,
    appExePath,
    uninstallExePath,
    displayName: productName,
    displayVersion: options.version,
    publisher: options.publisher,
    installLocation: layout.root,
    uninstallCommand: quoteWindowsArg(uninstallExePath),
    operations: ['windows:register-uninstall-entry', 'windows:register-start-menu-shortcut'],
    requiresAdmin: false,
  }
}

function registryValues(plan: WindowsRegistrationPlan): readonly { readonly name: string; readonly value: string }[] {
  return [
    { name: 'DisplayName', value: plan.displayName },
    { name: 'DisplayVersion', value: plan.displayVersion },
    { name: 'Publisher', value: plan.publisher },
    { name: 'InstallLocation', value: plan.installLocation },
    { name: 'UninstallString', value: plan.uninstallCommand },
    { name: 'DisplayIcon', value: plan.appExePath },
  ]
}

/**
 * Register uninstall metadata and a Start Menu shortcut through user-level Windows APIs.
 * @param plan - Plan returned by planWindowsRegistration.
 * @param runner - Optional command runner used by tests.
 * @returns The same plan after all operations complete.
 * @throws {WindowsRegistrationError} With completed phases and best-effort rollback.
 */
export async function registerWindowsRegistration(
  plan: WindowsRegistrationPlan,
  runner: WindowsCommandRunner = defaultRunner,
): Promise<WindowsRegistrationPlan> {
  const completed: string[] = []
  try {
    await mkdir(dirname(plan.shortcutPath), { recursive: true })
    for (const entry of registryValues(plan)) {
      await runner('reg.exe', ['add', plan.uninstallKey, '/v', entry.name, '/t', 'REG_SZ', '/d', entry.value, '/f'])
    }
    completed.push('windows:register-uninstall-entry')
    const script = [
      '$w = New-Object -ComObject WScript.Shell',
      `$s = $w.CreateShortcut(${psQuote(plan.shortcutPath)})`,
      `$s.TargetPath = ${psQuote(plan.appExePath)}`,
      `$s.WorkingDirectory = ${psQuote(plan.layout.appDir)}`,
      `$s.IconLocation = ${psQuote(plan.appExePath)}`,
      '$s.Save()',
    ].join('; ')
    await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    completed.push('windows:register-start-menu-shortcut')
    return plan
  } catch (error) {
    try {
      await removeWindowsRegistration(plan, runner)
    } catch (rollbackError) {
      // Rollback is best-effort and must not hide the original registration failure.
      void rollbackError
    }
    throw new WindowsRegistrationError(completed, { cause: error })
  }
}

/**
 * Verify all required registry values and the Start Menu shortcut without writing.
 * @param plan - Registration plan to inspect.
 * @param runner - Optional command runner used by tests.
 * @returns Nothing when all required state exists.
 */
export async function verifyWindowsRegistration(
  plan: WindowsRegistrationPlan,
  runner: WindowsCommandRunner = defaultRunner,
): Promise<void> {
  for (const entry of registryValues(plan)) {
    await runner('reg.exe', ['query', plan.uninstallKey, '/v', entry.name])
  }
  const shortcut = await stat(plan.shortcutPath)
  if (!shortcut.isFile()) throw new Error(`Windows Start Menu shortcut is missing: ${plan.shortcutPath}`)
}

/**
 * Remove the Start Menu shortcut and uninstall registry entry; missing state is idempotent.
 * @param plan - Registration plan to remove.
 * @param runner - Optional command runner used by tests.
 * @returns Nothing after cleanup completes.
 */
export async function removeWindowsRegistration(
  plan: WindowsRegistrationPlan,
  runner: WindowsCommandRunner = defaultRunner,
): Promise<void> {
  await rm(plan.shortcutPath, { force: true })
  try {
    await runner('reg.exe', ['delete', plan.uninstallKey, '/f'])
  } catch (error) {
    if (!isMissingRegistry(error)) throw error
  }
}
