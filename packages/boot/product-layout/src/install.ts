/** File-level portable and installed packaging with preserved user-owned subdirectories. */
import { cp, readdir, rename, rm, stat } from 'node:fs/promises'
import { ensureProductLayout, type ProductLayout } from './layout.ts'
import { createInstallManifest, readInstallManifest, writeInstallManifest, type InstallManifest } from './manifest.ts'

/** Preview of one install or upgrade operation before any file is changed. */
export interface InstallPlan {
  readonly layout: ProductLayout
  readonly appVersion: string
  readonly create: readonly string[]
  readonly replace: readonly string[]
  readonly preserve: readonly string[]
  readonly remove: readonly string[]
  readonly externalOperations: readonly string[]
  readonly requiresAdmin: boolean
}

/** Inputs needed to execute an InstallPlan from a clean application payload. */
export interface InstallExecutionOptions {
  readonly sourceDir: string
  readonly productId?: string
  readonly now?: Date
}

/** Result of a completed file-level install, including external operations still to perform. */
export interface InstallResult {
  readonly manifest: InstallManifest
  readonly externalOperations: readonly string[]
}

/**
 * Preview an install without changing files.
 * @param layout - Single-root destination layout.
 * @param appVersion - Version of the application payload to install.
 * @returns The paths to create, replace, preserve, and externally register.
 */
export async function planInstall(layout: ProductLayout, appVersion: string): Promise<InstallPlan> {
  if (appVersion.trim().length === 0) throw new TypeError('Install appVersion must be non-empty')
  return {
    layout,
    appVersion,
    create: [
      layout.appDir, layout.dataDir, layout.modelsDir, layout.runtimesDir,
      layout.dshHomeDir, layout.dshAgentsHomeDir,
    ],
    replace: [layout.appDir],
    preserve: [layout.dataDir, layout.modelsDir, layout.runtimesDir],
    remove: [],
    externalOperations: layout.channel === 'installed'
      ? ['windows:register-uninstall-entry', 'windows:register-start-menu-shortcut']
      : [],
    requiresAdmin: false,
  }
}

function isEnoent(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

async function assertAppPayload(sourceDir: string): Promise<void> {
  const info = await stat(sourceDir)
  if (!info.isDirectory()) throw new Error(`Application payload is not a directory: ${sourceDir}`)
  const forbidden = new Set(['data', 'models', 'runtime-envs', 'integrations', '.env', 'credentials', 'private-key.pem', 'id_rsa'])
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (forbidden.has(entry.name)) throw new Error(`Application payload must not contain ${entry.name}`)
  }
}

/**
 * Execute a prepared install with a staged app replacement and preserved data/assets.
 * @param plan - Preview previously returned by planInstall.
 * @param options - Clean app payload and manifest metadata.
 * @returns The durable manifest and external operations still to perform.
 */
export async function executeInstallPlan(plan: InstallPlan, options: InstallExecutionOptions): Promise<InstallResult> {
  const { layout } = plan
  await assertAppPayload(options.sourceDir)

  let previous: InstallManifest | undefined
  try {
    previous = await readInstallManifest(layout.installManifestPath)
  } catch (error) {
    if (!isEnoent(error)) throw error
  }

  await ensureProductLayout(layout)
  const staging = `${layout.appDir}.staging`
  await rm(staging, { recursive: true, force: true })
  try {
    await cp(options.sourceDir, staging, { recursive: true })
    await rm(layout.appDir, { recursive: true, force: true })
    await rename(staging, layout.appDir)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }

  const now = options.now ?? new Date()
  const manifest = previous === undefined
    ? createInstallManifest(layout, plan.appVersion, { now, ...options.productId === undefined ? {} : { productId: options.productId } })
    : {
      ...previous,
      appVersion: plan.appVersion,
      updatedAt: now.toISOString(),
      ...options.productId === undefined ? {} : { productId: options.productId },
    }
  await writeInstallManifest(layout.installManifestPath, manifest)
  return { manifest, externalOperations: plan.externalOperations }
}

/**
 * Package a portable instance without system registration.
 * @param layout - Portable single-root destination.
 * @param appVersion - Application version.
 * @param options - Clean app payload and manifest metadata.
 * @returns The completed portable install result.
 */
export async function packPortable(layout: ProductLayout, appVersion: string, options: InstallExecutionOptions): Promise<InstallResult> {
  if (layout.channel !== 'portable') throw new Error('packPortable requires a portable ProductLayout')
  return executeInstallPlan(await planInstall(layout, appVersion), options)
}

/**
 * Package an installed instance and report required Windows registration operations.
 * @param layout - Installed single-root destination.
 * @param appVersion - Application version.
 * @param options - Clean app payload and manifest metadata.
 * @returns The completed file-level install result; registration remains explicit external work.
 */
export async function packInstalled(layout: ProductLayout, appVersion: string, options: InstallExecutionOptions): Promise<InstallResult> {
  if (layout.channel !== 'installed') throw new Error('packInstalled requires an installed ProductLayout')
  return executeInstallPlan(await planInstall(layout, appVersion), options)
}
