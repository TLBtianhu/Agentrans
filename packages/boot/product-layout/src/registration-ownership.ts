/** Read and remove only Windows registration resources owned by one installation root. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { WindowsRegistrationPlan } from './windows-registration.ts'

/** Registration resources checked before an uninstall or registration update. */
export interface WindowsRegistrationState {
  readonly registry: 'owned' | 'missing'
  readonly shortcut: 'owned' | 'missing'
}

/**
 * Inspect registration ownership without changing registry or shortcut state.
 * @param plan - Exact registry key, shortcut and installation paths to inspect.
 * @returns Owned or missing resources; foreign and unreadable resources reject.
 */
export type WindowsRegistrationReader = (plan: WindowsRegistrationPlan) => Promise<WindowsRegistrationState>

/** A shared registration resource cannot be attributed to the requested installation. */
export class WindowsRegistrationOwnershipError extends Error {
  /** Stable machine-readable refusal before deleting registration resources. */
  readonly code = 'WINDOWS_REGISTRATION_OWNERSHIP'

  /**
   * @param component - Registry entry or shortcut that failed ownership inspection.
   * @param path - Resource that remains untouched after this refusal.
   * @param reason - Foreign ownership or inability to inspect the resource safely.
   * @param options - Original inspection or child-process failure, when present.
   */
  constructor(readonly component: 'registry' | 'shortcut', readonly path: string,
    readonly reason: 'FOREIGN' | 'UNREADABLE', options?: ErrorOptions) {
    super(`Windows registration ${component} ownership was refused: ${path} (${reason})`, options)
    this.name = 'WindowsRegistrationOwnershipError'
  }
}

const execute = promisify(execFile)

// Both inspection and execution use these checks. Removal inspects every resource before its first mutation.
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
function Refuse([string]$component, [string]$path, [string]$reason) {
  [Console]::Out.WriteLine((@{status='refused'; component=$component; path=$path; reason=$reason} | ConvertTo-Json -Compress))
  exit 23
}
function Matches([object]$value, [string]$expected) {
  if ($value -isnot [string] -or $value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))') { return $false }
  try { return [String]::Equals([IO.Path]::GetFullPath($value).TrimEnd('\'), [IO.Path]::GetFullPath($expected).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) }
  catch { return $false }
}
function RegistryState {
  try { $key = Get-Item -LiteralPath $p.registryPath -ErrorAction Stop }
  catch [System.Management.Automation.ItemNotFoundException] { return 'missing' }
  catch { Refuse 'registry' $p.uninstallKey 'UNREADABLE' }
  try { $location = $key.GetValue('InstallLocation', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  catch { Refuse 'registry' $p.uninstallKey 'UNREADABLE' }
  finally { $key.Close() }
  if (-not (Matches $location $p.root)) { Refuse 'registry' $p.uninstallKey 'FOREIGN' }
  return 'owned'
}
function ShortcutState {
  try { $item = Get-Item -LiteralPath $p.shortcut -Force -ErrorAction Stop }
  catch [System.Management.Automation.ItemNotFoundException] { return 'missing' }
  catch { Refuse 'shortcut' $p.shortcut 'UNREADABLE' }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer) { Refuse 'shortcut' $p.shortcut 'UNREADABLE' }
  try {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($p.shortcut)
    if (-not (Matches $link.TargetPath $p.executable) -or -not (Matches $link.WorkingDirectory $p.app) -or $link.Arguments -ne '') {
      Refuse 'shortcut' $p.shortcut 'FOREIGN'
    }
  } catch { Refuse 'shortcut' $p.shortcut 'UNREADABLE' }
  return 'owned'
}
$registry = RegistryState
$shortcut = ShortcutState
if ($p.remove) {
  if ($shortcut -eq 'owned') { Remove-Item -LiteralPath $p.shortcut -Force -ErrorAction Stop }
  if ($registry -eq 'owned') { Remove-Item -LiteralPath $p.registryPath -Recurse -Force -ErrorAction Stop }
}
[Console]::Out.WriteLine((@{status='ok'; registry=$registry; shortcut=$shortcut} | ConvertTo-Json -Compress))
`

/**
 * Build one encoded inspection/removal command; the executor must preserve a failed child process.
 * @param plan - Exact installation and registration resources.
 * @param remove - Whether to remove resources after all ownership checks pass.
 * @returns PowerShell arguments whose JSON data never becomes executable syntax.
 */
export function registrationOwnershipArguments(plan: WindowsRegistrationPlan, remove: boolean): string[] {
  const prefix = 'HKCU\\'
  if (!plan.uninstallKey.toUpperCase().startsWith(prefix)) {
    throw new WindowsRegistrationOwnershipError('registry', plan.uninstallKey, 'UNREADABLE')
  }
  const payload = Buffer.from(JSON.stringify({
    registryPath: `Registry::HKEY_CURRENT_USER\\${plan.uninstallKey.slice(prefix.length)}`,
    uninstallKey: plan.uninstallKey, shortcut: plan.shortcutPath, executable: plan.appExePath,
    app: plan.layout.appDir, root: plan.installLocation, remove,
  }), 'utf8').toString('base64')
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script.replace('__PAYLOAD__', payload), 'utf16le').toString('base64')]
}

function refusal(value: unknown, cause?: unknown): WindowsRegistrationOwnershipError | undefined {
  if (typeof value !== 'object' || value === null || !('status' in value) || value.status !== 'refused'
    || !('component' in value) || (value.component !== 'registry' && value.component !== 'shortcut')
    || !('path' in value) || typeof value.path !== 'string' || !('reason' in value)
    || (value.reason !== 'FOREIGN' && value.reason !== 'UNREADABLE')) return undefined
  return new WindowsRegistrationOwnershipError(value.component, value.path, value.reason, { cause })
}

/**
 * Restore a typed refusal from the owned PowerShell process; other failures retain their original identity.
 * @param error - Failed command with its machine-readable stdout, when available.
 * @returns A declared ownership failure, or undefined for other command errors.
 */
export function registrationOwnershipFailure(error: unknown): WindowsRegistrationOwnershipError | undefined {
  if (typeof error !== 'object' || error === null || !('stdout' in error) || typeof error.stdout !== 'string') return undefined
  let value: unknown
  try { value = JSON.parse(error.stdout.trim()) }
  catch (parseError) { void parseError; return undefined }
  return refusal(value, error)
}

/**
 * Inspect the actual registry and COM shortcut once without writing either resource.
 * @param plan - Exact resources expected to belong to this installation.
 * @returns Owned or missing resources; unreadable or foreign resources reject.
 * @throws {WindowsRegistrationOwnershipError} For a foreign or unreadable registry entry or shortcut.
 */
export async function readWindowsRegistrationOwnership(plan: WindowsRegistrationPlan): Promise<WindowsRegistrationState> {
  let output: string
  try {
    output = (await execute('powershell.exe', registrationOwnershipArguments(plan, false),
      { windowsHide: true, timeout: 10_000 })).stdout
  } catch (error) {
    throw registrationOwnershipFailure(error)
      ?? new WindowsRegistrationOwnershipError('registry', plan.uninstallKey, 'UNREADABLE', { cause: error })
  }
  let value: unknown
  try { value = JSON.parse(output.trim()) }
  catch (error) { throw new WindowsRegistrationOwnershipError('registry', plan.uninstallKey, 'UNREADABLE', { cause: error }) }
  if (typeof value !== 'object' || value === null || !('status' in value) || value.status !== 'ok'
    || !('registry' in value) || (value.registry !== 'owned' && value.registry !== 'missing')
    || !('shortcut' in value) || (value.shortcut !== 'owned' && value.shortcut !== 'missing')) {
    throw new WindowsRegistrationOwnershipError('registry', plan.uninstallKey, 'UNREADABLE')
  }
  return { registry: value.registry, shortcut: value.shortcut }
}
