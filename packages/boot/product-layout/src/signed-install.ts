/** Signed release verification, archive installation, and optional Windows registration. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { KeyObject } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureProductLayout, type ProductLayout } from './layout.ts'
import { packInstalled, packPortable, type InstallExecutionOptions, type InstallResult } from './install.ts'
import { verifyReleaseManifest, type ReleaseDigest, type ReleaseManifest } from './release-manifest.ts'
import {
  planWindowsRegistration,
  assertWindowsRegistrationOwnership,
  registerWindowsRegistration,
  WindowsRegistrationError,
  WindowsRegistrationOwnershipError,
  type WindowsCommandRunner,
  type WindowsRegistrationOptions,
  type WindowsRegistrationReader,
  type WindowsRegistrationPlan,
} from './windows-registration.ts'

const execFileAsync = promisify(execFile)

async function defaultRunner(file: string, args: readonly string[]): Promise<void> {
  await execFileAsync(file, [...args], { windowsHide: true, timeout: 10_000 })
}

/** Inputs for verified archive installation. */
export interface SignedReleaseInstallOptions {
  readonly layout: ProductLayout
  readonly releasePath: string
  readonly manifest: ReleaseManifest
  readonly publicKey: KeyObject
  readonly productId?: string
  readonly now?: Date
  /** Defaults to true for installed layouts; portable layouts never register. */
  readonly register?: boolean
  /** Required when Windows registration is enabled. */
  readonly registration?: WindowsRegistrationOptions
  /** Optional command runner for archive extraction and registration. */
  readonly runner?: WindowsCommandRunner
  /** Optional ownership reader paired with a custom registration command runner. */
  readonly registrationReader?: WindowsRegistrationReader
}

/** Result of a completed signed release install. */
export interface SignedReleaseInstallResult {
  readonly digest: ReleaseDigest
  readonly install: InstallResult
  readonly registration?: WindowsRegistrationPlan
}

/** Raised when the app is installed but the subsequent registration fails. */
export class SignedReleaseInstallError extends Error {
  /** Stable machine-readable code for a partially completed signed install. */
  readonly code = 'SIGNED_RELEASE_INSTALL_FAILED'

  constructor(
    readonly install: InstallResult,
    readonly registrationError: WindowsRegistrationError | WindowsRegistrationOwnershipError,
    options?: ErrorOptions,
  ) {
    super('Signed release installed, but Windows registration failed', options)
    this.name = 'SignedReleaseInstallError'
  }
}

/**
 * Verify a signed release, unpack it inside the product root, install it, and optionally register Windows state.
 * @param options - Release, trusted public key, destination, and optional registration.
 * @returns The verified digest, install result, and optional registration plan.
 * @throws {ReleaseVerificationError} Before any file is changed when verification fails.
 * @throws {SignedReleaseInstallError} When installation succeeded but registration failed.
 */
export async function installSignedRelease(options: SignedReleaseInstallOptions): Promise<SignedReleaseInstallResult> {
  const { layout } = options
  const shouldRegister = layout.channel === 'installed' && options.register !== false
  if (shouldRegister && options.registration === undefined) {
    throw new TypeError('Windows registration options are required for installed releases')
  }
  const verification = await verifyReleaseManifest(options.releasePath, options.manifest, options.publicKey)
  const registrationPlan = shouldRegister && options.registration !== undefined
    ? planWindowsRegistration(layout, options.registration) : undefined
  if (registrationPlan !== undefined) await assertWindowsRegistrationOwnership(registrationPlan, options.registrationReader)
  await ensureProductLayout(layout)
  const staging = await mkdtemp(join(layout.dataDir, 'install', 'release-'))
  const runner = options.runner ?? defaultRunner
  try {
    await runner('tar.exe', ['-xf', options.releasePath, '-C', staging])
    const installOptions: InstallExecutionOptions = {
      sourceDir: staging,
      ...options.productId === undefined ? {} : { productId: options.productId },
      ...options.now === undefined ? {} : { now: options.now },
    }
    const install = layout.channel === 'installed'
      ? await packInstalled(layout, options.manifest.version, installOptions)
      : await packPortable(layout, options.manifest.version, installOptions)
    if (registrationPlan === undefined) return { digest: verification.digest, install }
    try {
      const registration = await registerWindowsRegistration(
        registrationPlan,
        runner,
        options.registrationReader,
      )
      return { digest: verification.digest, install, registration }
    } catch (error) {
      if (error instanceof WindowsRegistrationError || error instanceof WindowsRegistrationOwnershipError) {
        throw new SignedReleaseInstallError(install, error, { cause: error })
      }
      throw error
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
