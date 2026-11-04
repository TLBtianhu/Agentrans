/** Single-root Agentrans distribution layout and lifecycle primitives. @module @deepseek-ai/dsh-product-layout */
export {
  PRODUCT_LAYOUT_VERSION,
  ProductLayout,
  ensureProductLayout,
  type ProductChannel,
} from './layout.ts'
export {
  createInstallManifest,
  readInstallManifest,
  writeInstallManifest,
  type AssetRecord,
  type AssetState,
  type InstallManifest,
} from './manifest.ts'
export {
  assertIntegrationUsable,
  inspectIntegrationState,
  IntegrationStateError,
  type IntegrationState,
} from './integration.ts'
export {
  activateRuntime,
  relocatePyvenv,
  RuntimeActivationError,
  type RuntimeActivationErrorCode,
  type RuntimeActivationInput,
} from './runtime.ts'
export {
  executeInstallPlan,
  packInstalled,
  packPortable,
  planInstall,
  type InstallExecutionOptions,
  type InstallPlan,
  type InstallResult,
} from './install.ts'
export {
  ALL_UNINSTALL_SCOPE,
  APP_ONLY_UNINSTALL_SCOPE,
  executeUninstallPlan,
  planUninstall,
  UninstallConfirmationError,
  UninstallExecutionError,
  UninstallHookError,
  type UninstallHooks,
  type UninstallPlan,
  type UninstallResult,
  type UninstallScope,
} from './uninstall.ts'
