import type { DesktopElectronBuilderConfig } from '../electron-builder.config.mjs'

/** Explicit Agentrans identity and local-only output over the shared unsigned Windows configuration. */
export interface AgentransInstallerConfig extends Omit<DesktopElectronBuilderConfig,
  'protocols' | 'extraMetadata' | 'files' | 'extraResources' | 'nsis'> {
  readonly productName: string
  readonly protocols: readonly []
  readonly extraMetadata: DesktopElectronBuilderConfig['extraMetadata'] & {
    readonly name: 'agentrans'
    readonly agentransAppId: 'com.agentrans.app'
    readonly agentransChannel: 'nightly' | 'latest'
  }
  readonly files: readonly DesktopElectronBuilderConfig['files'][number][]
  readonly extraResources: readonly { readonly from: string; readonly to: string }[]
  readonly nsis: Omit<DesktopElectronBuilderConfig['nsis'], 'uninstallDisplayName' | 'shortcutName'> & {
    readonly uninstallDisplayName: string
    readonly shortcutName: string
    readonly artifactName: string
  }
  /** The product's own feed; the build never uploads, so a publisher attaches the artifacts. */
  readonly publish: NonNullable<DesktopElectronBuilderConfig['publish']>
}

/**
 * Bind one unsigned Windows artifact to its product identity and remove ambient signing credentials.
 * @param environment - Parent environment, never modified or loaded from dotenv.
 * @returns Explicit product settings; conflicting target, policy or release settings are refused.
 */
export function agentransInstallerEnvironment(environment: NodeJS.ProcessEnv, target?: 'win-x64' | 'mac-arm64'): NodeJS.ProcessEnv

/**
 * Resolve product metadata and versioned output through the shared unsigned builder.
 * @param options - Parent environment and output roots; the builder owns version resolution.
 * @returns Configuration with the product's own feed and no dsh protocol registration.
 */
export function createAgentransInstallerConfig(options: {
  readonly environment: NodeJS.ProcessEnv
  readonly output: string
  readonly repositoryRoot: string
  /** Release target; the Windows NSIS installer when omitted. */
  readonly target?: 'win-x64' | 'mac-arm64'
}): AgentransInstallerConfig
