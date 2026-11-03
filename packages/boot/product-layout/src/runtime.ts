/** Runtime relocation, verification, self-test, and activation gate. */
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { AssetRecord } from './manifest.ts'
import type { ProductLayout } from './layout.ts'

/** Failure stage of runtime activation. */
export type RuntimeActivationErrorCode = 'RUNTIME_VERIFY_FAILED' | 'RUNTIME_RELOCATE_FAILED' | 'RUNTIME_SELF_TEST_FAILED'

/** Error raised before an active-runtime marker may be written. */
export class RuntimeActivationError extends Error {
  constructor(readonly code: RuntimeActivationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RuntimeActivationError'
  }
}

/** Inputs required to activate one runtime directory. */
export interface RuntimeActivationInput {
  readonly layout: ProductLayout
  readonly id: string
  readonly version: string
  readonly sha256: string
  readonly runtimeDir?: string
  readonly now?: Date
  /** Verify the runtime bytes and expected hash before changing configuration. */
  readonly verify: (runtimeDir: string, sha256: string) => Promise<void>
  /** Run the actual interpreter self-test after relocation. */
  readonly selfTest: (executable: string) => Promise<void>
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Rewrite the paths that a relocated Python runtime needs, preserving unrelated metadata.
 * @param source - Existing pyvenv.cfg contents.
 * @param runtimeRoot - Actual runtime directory after relocation.
 * @returns Configuration whose home and executable point at the current runtime.
 */
export function relocatePyvenv(source: string, runtimeRoot: string): string {
  const scripts = join(runtimeRoot, 'Scripts')
  const executable = join(scripts, 'python.exe')
  let hasHome = false
  let hasExecutable = false
  let hasSystemPackages = false
  const lines = source.split(/\r?\n/).map((line) => {
    if (/^home\s*=/.test(line)) {
      hasHome = true
      return `home = ${scripts}`
    }
    if (/^executable\s*=/.test(line)) {
      hasExecutable = true
      return `executable = ${executable}`
    }
    if (/^include-system-site-packages\s*=/.test(line)) {
      hasSystemPackages = true
      return 'include-system-site-packages = false'
    }
    return line
  })
  if (!hasHome) lines.push(`home = ${scripts}`)
  if (!hasExecutable) lines.push(`executable = ${executable}`)
  if (!hasSystemPackages) lines.push('include-system-site-packages = false')
  return lines.join('\n')
}

/**
 * Verify, relocate, self-test, and only then activate a runtime asset.
 * @param input - Runtime identity, layout, and verification callbacks.
 * @returns The active asset record with a product-root-relative location.
 * @throws {RuntimeActivationError} Before active-runtime.json is written when any gate fails.
 */
export async function activateRuntime(input: RuntimeActivationInput): Promise<AssetRecord> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id)) throw new TypeError('Runtime id must be a lowercase identifier')
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new TypeError('Runtime sha256 must be 64 lowercase hexadecimal characters')
  const runtimeDir = input.runtimeDir ?? join(input.layout.runtimesDir, input.id)
  try {
    await input.verify(runtimeDir, input.sha256)
  } catch (error) {
    throw new RuntimeActivationError('RUNTIME_VERIFY_FAILED', `Runtime ${input.id} failed hash verification`, { cause: error })
  }

  const configPath = join(runtimeDir, 'pyvenv.cfg')
  const scripts = join(runtimeDir, 'Scripts')
  const executable = join(scripts, 'python.exe')
  try {
    const config = relocatePyvenv(await readFile(configPath, 'utf8'), runtimeDir)
    await writeFile(configPath, config, 'utf8')
  } catch (error) {
    throw new RuntimeActivationError('RUNTIME_RELOCATE_FAILED', `Runtime ${input.id} could not be relocated`, { cause: error })
  }
  if (!await fileExists(executable)) {
    throw new RuntimeActivationError('RUNTIME_RELOCATE_FAILED', `Runtime interpreter does not exist: ${executable}`)
  }
  try {
    await input.selfTest(executable)
  } catch (error) {
    throw new RuntimeActivationError('RUNTIME_SELF_TEST_FAILED', `Runtime ${input.id} failed its interpreter self-test`, { cause: error })
  }

  const record: AssetRecord = {
    id: input.id,
    version: input.version,
    sha256: input.sha256,
    location: relative(input.layout.root, runtimeDir),
    state: 'active',
  }
  const active = {
    ...record,
    home: scripts,
    executable,
    activatedAt: (input.now ?? new Date()).toISOString(),
  }
  await writeFile(join(runtimeDir, 'active-runtime.json'), `${JSON.stringify(active, null, 2)}\n`, 'utf8')
  return record
}
