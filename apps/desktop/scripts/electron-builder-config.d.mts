import type { DesktopElectronBuilderConfig } from '../electron-builder.config.mjs'

/**
 * Build the shared configuration for one Desktop target.
 * @param env - Packaging environment.
 * @param hostPlatform - Platform of the machine running the build.
 * @param hostArch - Architecture of the machine running the build.
 * @returns electron-builder configuration for one target.
 */
export function createElectronBuilderConfig(env: NodeJS.ProcessEnv, hostPlatform: NodeJS.Platform, hostArch: string, preparedRuntime?: string, preparedRuntimeVersion?: string): DesktopElectronBuilderConfig

/**
 * Build the Agentrans installer configuration, which owns its product identity.
 * @param env - Packaging environment.
 * @param hostPlatform - Platform of the machine running the build.
 * @param hostArch - Architecture of the machine running the build.
 * @returns electron-builder configuration for the unsigned Windows installer.
 */
export function createAgentransInstallerBuilderConfig(env: NodeJS.ProcessEnv, hostPlatform: NodeJS.Platform, hostArch: string): DesktopElectronBuilderConfig
