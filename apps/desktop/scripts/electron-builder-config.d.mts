/** Import the factory without evaluating an ordinary release configuration. */
export { createElectronBuilderConfig } from '../electron-builder.config.mjs'

/**
 * Create an explicitly unsigned Windows artifact without a remote mandatory-update policy or update feed.
 * @param env - Packaging environment with DSH_DESKTOP_UNSIGNED=1.
 * @param hostPlatform - Build host when no target platform override exists.
 * @param hostArch - Build host architecture when no target override exists.
 * @returns Windows artifact configuration; signed and non-Windows requests are refused.
 */
export function createUnsignedWindowsConfigWithoutPolicy(
  env?: NodeJS.ProcessEnv,
  hostPlatform?: NodeJS.Platform,
  hostArch?: string,
): import('../electron-builder.config.mjs').DesktopElectronBuilderConfig
