/** Platform-neutral assembly of generated Host Remote contributions. */

import type { Context } from '@agentrans/cordis'
import productAnalyticsRemote from '@agentrans/client-product-analytics/remote'
export type {} from '@agentrans/client-product-analytics/remote'
import agentPresetsRemote from '@agentrans/agent-preset-registry/remote'
import userQuestionsRemote from '@agentrans/user-questions/remote'
import artifactRemote from '@agentrans/artifact/remote'
import artifactBranchRemote from '@agentrans/artifact-branch/remote'
import artifactExportRemote from '@agentrans/artifact-export/remote'
import artifactRuntimeRemote from '@agentrans/artifact-runtime/remote'
import commandsRemote from '@agentrans/commands/remote'
import settingsControllerRemote from '@agentrans/api-settings-controller/remote'
import officeToPdfRemote from '@agentrans/office-to-pdf/remote'
import goalsRemote from '@agentrans/goal/remote'
import scheduleRemote from '@agentrans/schedule/remote'
import llmRemote from '@agentrans/llm/remote'
import dynamicRemote from '@agentrans/cordis-host-runner/remote'
import pluginManagerRemote from '@agentrans/plugin-manager/remote'
import toolResultsRemote from '@agentrans/client-ui-trajectory/remote'
import pluginRegistryProbeRemote from '@agentrans/client-ui-plugin-manager/remote'
import pluginMarketRemote from '@agentrans/plugin-market/remote'
import pluginInventoryRemote from '@agentrans/host-plugin-inventory/remote'
import messageFeedbackRemote from '@agentrans/message-feedback/remote'
import permissionPresetsRemote from '@agentrans/permission-presets/remote'
import sessionFeedbackRemote from '@agentrans/command-feedback/remote'
import fileUploadsRemote from '@agentrans/client-file-upload/remote'
import sessionReferencesRemote from '@agentrans/session-reference/remote'
import subagentsRemote from '@agentrans/subagent/remote'
import sessionRemote from '@agentrans/api-session-controller/remote'
import jobRemote from '@agentrans/api-job-controller/remote'
import workspaceRemote from '@agentrans/api-workspace-controller/remote'
import terminalRemote from '@agentrans/api-terminal-controller/remote'
import workspaceFilesRemote from '@agentrans/api-workspace-files/remote'
import type { ClientRemote } from '@agentrans/api-gateway/client'

export type { ClientRemote } from '@agentrans/api-gateway/client'
export type {
  BundleDetail, BundleInfo, BundleRowInfo, ChangeResult, IncompatiblePlugin, InspectOptions, InstallBundleOptions, InstallSpecKind,
  ManagementError, PackageResult,
  PluginChange, PluginEntryId, PluginInfo, PluginInspectProblem, PluginInstallCancellation, PluginInstallFailureKind,
  PluginInstallLogChunk, PluginInstallProgress, PluginInstallRequestId, PluginRegistries, PluginSpecInspection,
  PluginUpdateProgress, PluginUpdateResult, PluginUpdateStep, PluginVersion, PluginVersionList, RegistryAttempt,
  ReadOnlyReason, Registry, RestartReason,
} from '@agentrans/plugin-manager/types'
export type {} from '@agentrans/plugin-manager/remote'
export type {} from '@agentrans/client-ui-plugin-manager/remote'
export type {} from '@agentrans/client-ui-trajectory/remote'
export type {} from '@agentrans/plugin-market/remote'
export type {
  MarketCompatibility, MarketIndexSummary, MarketInstallation, MarketInstallationStatus, MarketListingEntry, MarketListingVersion,
  MarketQuery, MarketSearchResult, MarketSort, PluginDetail, PluginDetailDocumentId, PluginDetailOrigin,
} from '@agentrans/plugin-market/types'
export type { PluginInventorySnapshot } from '@agentrans/host-plugin-inventory/types'
export type {} from '@agentrans/agent-preset-registry/remote'
export type {} from '@agentrans/user-questions/remote'
export type {} from '@agentrans/artifact/remote'
export type {} from '@agentrans/artifact-branch/remote'
export type {} from '@agentrans/artifact-export/remote'
export type {} from '@agentrans/artifact-runtime/remote'
export type {} from '@agentrans/commands/remote'
export type {} from '@agentrans/api-settings-controller/remote'
export type {} from '@agentrans/goal/remote'
export type {} from '@agentrans/schedule/remote'
export type {} from '@agentrans/office-to-pdf/remote'
export type {} from '@agentrans/llm/remote'
export type {} from '@agentrans/host-plugin-inventory/remote'
export type {} from '@agentrans/message-feedback/remote'
export type {} from '@agentrans/permission-presets/remote'
export type {} from '@agentrans/command-feedback/remote'
export type {} from '@agentrans/client-file-upload/remote'
export type {} from '@agentrans/session-reference/remote'
export type {} from '@agentrans/subagent/remote'
export type * from '@agentrans/subagent/client'
export type {} from '@agentrans/api-session-controller/remote'
export type * from '@agentrans/api-session-controller/types'
export type {} from '@agentrans/api-job-controller/remote'
export type * from '@agentrans/api-job-controller/types'
export type {} from '@agentrans/api-workspace-controller/remote'
export type * from '@agentrans/api-workspace-controller/types'
export type {} from '@agentrans/api-workspace-files/remote'
export type * from '@agentrans/api-workspace-files/types'
export type {} from '@agentrans/api-terminal-controller/remote'
export type * from '@agentrans/api-terminal-controller/types'
// The forwarded-event allowlist's selection seat: without it in the consumer's
// compilation face `TypertRemoteEvent` is `never` and every `$on` call fails.
export type { ApiRemoteForwardedEvent } from '../types.ts'
// The owner packages' client-safe `./types` exports supply the `Events`
// signatures `$on` hands to a listener, so a consumer reads the very
// declaration the Host emits rather than a flattened restatement of it.
export type {} from '@agentrans/commands/types'
export type {} from '@agentrans/cordis-host-runner/types'
export type {} from '@agentrans/credentials/types'
export type {} from '@agentrans/llm/types'
export type {} from '@agentrans/agent-preset-registry/types'
export type {} from '@agentrans/permission-presets/types'
export type {} from '@agentrans/settings/types'
export type {} from '@agentrans/user-approval/types'
export type {} from '@agentrans/user-questions/types'
export type {} from '@agentrans/api-session-controller/types'

/**
 * The carrier's Client-facing types, re-exported so a business package names one
 * assembly package instead of both this facade and the Connection plugin. Type-only:
 * the carrier's runtime values stay behind their own module edge.
 */
export type {
  ConnectionHandle, ConnectionSinks, ContentBlock,
  MessageId,
  RpcId, RpcRequest, RpcResponse, RpcResult, SessionId,
  StreamChunk,
} from '@agentrans/client-connection/client'
export type {} from '@agentrans/api-gateway/client'
export type {} from '@agentrans/cordis-host-runner/remote'

// The payload vocabulary of the selected namespaces, re-exported so a Client
// contribution can name what it sends and receives without importing a Host
// package: this assembly is the one place both planes legitimately meet.
export type {
  ApprovalRequestId,
  CordisHalfState,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  CordisDynamicRunMode,
  CordisInspectMethodManifest,
  CordisInspectPlatform,
  CordisInspectProviderManifest,
  CordisInspectProviderView,
  CordisInspectQueryRequest,
  CordisInspectQueryResolution,
  CordisInspectQueryResolved,
  CordisInspectRequestId,
  CordisInspectResolveAck,
  CordisRunDiagnostic,
  CordisRunStatus,
  DynamicCordisClientSource,
  DynamicCordisHostHalfResult,
  DynamicCordisInventoryRow,
  DynamicCordisInvokeResult,
  DynamicCordisPackage,
  DynamicCordisRequestResolved,
  DynamicCordisResolveAck,
  DynamicCordisRetracted,
  DynamicCordisRunRequest,
  DynamicCordisRunResolution,
  DynamicCordisRunAttempt,
  DynamicCordisRunResponse,
  DynamicCordisStopResponse,
  DynamicCordisUndefineReceipt,
  RequestRunOutcome,
} from '@agentrans/cordis-host-runner/types'
// Credential state vocabulary for the credentials namespace (values never ride it).
export type { CredentialInfo } from '@agentrans/credentials/types'
// Redacted namespace vocabulary for the settings namespace (secrets never ride
// it). It travels with its seam, whose `./types` the Client face already reads.
export type {
  SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
} from '@agentrans/settings/types'
// Provider registry and discovery vocabulary for the llm namespace.
export type {
  LlmConfigurableProvider, LlmDiscoveredModel,
  LlmModelDiscoveryRequest, LlmNativeAuth, LlmProviderInfo,
} from '@agentrans/llm/types'
// Reference-discovery result vocabulary for the fileReferences and
// sessionReferenceResolver namespaces.
export type { FileReferenceCandidate } from '@agentrans/file-reference/types'
export type { SessionReferenceMentionCandidate } from '@agentrans/session-reference/types'

// The Remote failure vocabulary, re-exported so business packages keep naming
// this assembly alone. Types only: a value export would make spec imports load
// this module's owner /remote artifacts; specs take RemoteError from
// dsh-client-test-runtime instead.
export type {
  RemoteErrorCode, RemoteErrorDetailsMap, RemoteFailure, RemoteResult,
} from '@agentrans/typert-protocol'
export type { RemoteHostFacts } from '@agentrans/api-gateway/client'

declare module '@agentrans/cordis' {
  interface Context {
    /** Generated Remote namespaces selected by this Client assembly. */
    remote: ClientRemote
  }
}

/** Required service: the typed Client Remote contribution mount. */
export const inject = ['remote']

/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 * @returns disposer after every selected Remote namespace is ready.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const contribution of [
      productAnalyticsRemote, agentPresetsRemote, commandsRemote, settingsControllerRemote,
      goalsRemote, llmRemote, dynamicRemote, scheduleRemote,
      pluginInventoryRemote, pluginManagerRemote, pluginMarketRemote, pluginRegistryProbeRemote, toolResultsRemote,
      messageFeedbackRemote, sessionFeedbackRemote,
      fileUploadsRemote, sessionReferencesRemote,
      permissionPresetsRemote, subagentsRemote, sessionRemote, jobRemote, workspaceRemote, workspaceFilesRemote, terminalRemote,
      officeToPdfRemote, userQuestionsRemote, artifactRemote, artifactBranchRemote, artifactExportRemote, artifactRuntimeRemote,
    ]) {
      disposers.push(await ctx.remote.$mount(contribution))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) await dispose()
    throw error
  }
  // Unwound in reverse mount order, so a namespace never outlives one mounted
  // after it.
  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
}
