/** Explicit exceptions and Host packages for the published dependency policy. */

/** Packages treated as Client/Host packages without declaring `agentrans.client`. */
const CLIENT_FACE_INCLUDE: readonly string[] = []

/** Packages exempted from automatic Client/Host treatment despite declaring `agentrans.client`. */
const CLIENT_FACE_EXCLUDE: readonly string[] = [
  '@agentrans/api-session-controller',
  '@agentrans/api-workspace-controller',
]

/** Host-only packages whose peer relays are deliberately flattened. */
const HOST_DEPENDENCY_PACKAGES: readonly string[] = [
  '@agentrans/llm',
  '@agentrans/session',
]

/** Required Cordis services whose Host imports are type-only. */
const REQUIRED_SERVICE_PEERS = {
  '@agentrans/api-terminal-controller': ['@agentrans/subprocess'],
} as const satisfies Readonly<Record<string, readonly string[]>>

/** Development-only package relationships not represented by source imports. */
const CONFIGURATION_ONLY_DEV_DEPENDENCIES = {
  '@agentrans/client-locale': ['@agentrans/api-remotes'],
  '@agentrans/client-ui-conversation': [
    '@agentrans/api-remotes',
    '@agentrans/client-ui-workspace',
  ],
  '@agentrans/client-ui-model-selection': ['@agentrans/client-ui-input-trigger'],
  '@agentrans/client-ui-sidebar': ['@agentrans/client-ui-workspace'],
  '@agentrans/client-ui-subagent': ['@agentrans/client-ui-input-trigger'],
  '@agentrans/client-ui-theme': ['@agentrans/api-remotes'],
  '@agentrans/client-ui-tool': ['@agentrans/api-remotes'],
} as const satisfies Readonly<Record<string, readonly string[]>>

/** Workspace packages whose complete runtime surface is safe across duplicate installations. */
const DUPLICATE_SAFE_PACKAGES: readonly string[] = [
  '@agentrans/brand',
  '@agentrans/lazy-require',
  '@agentrans/typert-protocol',
  '@agentrans/util-code-language',
  '@agentrans/util-crypto',
  '@agentrans/util-values',
]

/**
 * Runtime exports whose values remain valid when npm installs another package copy.
 * New entries are forbidden by default. Automated agents must not add an
 * exception; every addition requires explicit human review and a dedicated,
 * prominent heading in the pull request description.
 */
const SAFE_HOST_DEPENDENCY_EXPORTS = {
  '@agentrans/atomic-write': ['withFileLock', 'writeFileAtomic'],
  '@agentrans/computer-use/brand': ['ComputerUseProviderName'],
  '@agentrans/credentials': ['credentialKey'],
  '@agentrans/deque': ['Deque'],
  // The Liveshare wire codec and identity helpers are stateless functions over caller-owned values.
  '@agentrans/experimental-liveshare-protocol': [
    'LIVESHARE_CAPABILITIES', 'LIVESHARE_PROTOCOL_VERSION', 'parseRelayFrame', 'parseShareAccessState',
    'parseTunnelWorkerCommand', 'parseTunnelWorkerEvent', 'rawText', 'sendFrame', 'unsupportedFrameRefusal',
    'viewerRequestFields', 'identityFromKey', 'identityKeyOf',
  ],
  '@agentrans/llm': ['callConfigEquals'],
  '@agentrans/session': ['SessionId'],
  '@agentrans/session-format': ['sessionFormatLogFilename'],
  '@agentrans/storage-domain': ['defineDomain'],
  '@agentrans/timeout': ['MAX_TIMER_DELAY_MS'],
  '@agentrans/schemastery': ['default'],
} as const satisfies HostDependencyExports

/** Runtime exports that require every consumer to resolve the provider's shared peer instance. */
const PEER_REQUIRED_HOST_EXPORTS = {
  // Profile settings must match the installed Node provider's configuration schema.
  '@agentrans/ptc-runtime-node/configuration': ['resolvePersistentExecution'],
  // CUA checks UserQuestionError and preserves AttachmentError from image admission.
  '@agentrans/attachment': ['admitEncodedImages'],
  '@agentrans/user-questions': ['UserQuestionError'],
  // `instanceof` checks need the translator's own class instance.
  '@agentrans/experimental-translator': ['TranslationError'],
  // Stateless; a safe classification would turn the forge panel's forge and worktree peers into dependencies.
  '@agentrans/experimental-forge': ['changeRequestKey'],
  '@agentrans/experimental-worktree': ['generatedWorktreeName'],
  // The forge panel matches ctx.fs failures with `instanceof FsError`.
  '@agentrans/fs': ['FsError'],
  '@agentrans/scope': ['carrierKeyOf', 'createScope', 'scopeOf', 'scopeTarget'],
  // appendPluginRecord writes through the Session class's private log; pluginRecordOf is stateless.
  '@agentrans/session': ['SESSION_FORMAT_VERSION', 'appendPluginRecord', 'pluginRecordOf'],
  '@agentrans/session-persistence': ['SessionPersistenceNotFoundError'],
  // Readers recognize a deadline's TimeoutReason only by `instanceof` against their own copy.
  '@agentrans/timeout': ['deadline'],
} as const satisfies HostDependencyExports

/** Exact import specifier to reviewed runtime exports. */
type HostDependencyExports = Readonly<Record<string, readonly string[]>>

/** Complete configurable input to package dependency classification. */
export interface PackageDependencyPolicy {
  readonly clientFaceInclude: readonly string[]
  readonly clientFaceExclude: readonly string[]
  readonly hostPackages: readonly string[]
  readonly requiredServicePeers?: Readonly<Record<string, readonly string[]>>
  readonly configurationOnlyDevDependencies: Readonly<Record<string, readonly string[]>>
  readonly duplicateSafePackages?: readonly string[]
  readonly safeHostDependencyExports: HostDependencyExports
  readonly peerRequiredHostExports: HostDependencyExports
}

/** Repository dependency policy consumed by verification and benchmarking. */
export const PACKAGE_DEPENDENCY_POLICY: PackageDependencyPolicy = {
  clientFaceInclude: CLIENT_FACE_INCLUDE,
  clientFaceExclude: CLIENT_FACE_EXCLUDE,
  hostPackages: HOST_DEPENDENCY_PACKAGES,
  requiredServicePeers: REQUIRED_SERVICE_PEERS,
  configurationOnlyDevDependencies: CONFIGURATION_ONLY_DEV_DEPENDENCIES,
  duplicateSafePackages: DUPLICATE_SAFE_PACKAGES,
  safeHostDependencyExports: SAFE_HOST_DEPENDENCY_EXPORTS,
  peerRequiredHostExports: PEER_REQUIRED_HOST_EXPORTS,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a package manifest declares a dynamically loaded Client entry. */
export function hasClientDeclaration(dshField: unknown): boolean {
  return isRecord(dshField) && Object.hasOwn(dshField, 'client')
}
