/** Resolved fields required to embed a macOS updater feed. */
export interface MacOSAppUpdateFeed {
  readonly provider: 'github'
  readonly owner: string
  readonly repo: string
  readonly channel?: 'nightly' | 'latest'
}

/** Packaged electron-updater configuration for macOS. */
export interface MacOSAppUpdateConfig {
  readonly provider: 'github'
  readonly owner: string
  readonly repo: string
  readonly channel: 'nightly' | 'latest'
  readonly updaterCacheDirName: string
}

/** Resolve the GitHub feed from the final electron-builder configuration. */
export function resolveMacOSAppUpdateFeed(publish: unknown): MacOSAppUpdateFeed

/** Create the electron-updater configuration embedded before code signing. */
export function createMacOSAppUpdateConfig(
  update: MacOSAppUpdateFeed,
  updaterCacheDirName: string,
): MacOSAppUpdateConfig

/** Write the updater configuration into an assembled App before signing. */
export function writeMacOSAppUpdateConfig(
  resourcesDir: string,
  update: MacOSAppUpdateFeed,
  updaterCacheDirName: string,
): Promise<void>

/** Verify the updater configuration inside an assembled macOS App. */
export function verifyMacOSAppUpdateConfig(
  appPath: string,
  update: MacOSAppUpdateFeed,
  updaterCacheDirName?: string,
): Promise<void>
