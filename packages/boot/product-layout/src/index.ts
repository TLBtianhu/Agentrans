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
export {
  canonicalReleaseContent,
  computeReleaseDigest,
  fingerprintPublicKey,
  signReleaseManifest,
  verifyReleaseManifest,
  ReleaseVerificationError,
  type ReleaseDigest,
  type ReleaseManifest,
  type ReleaseSignOptions,
  type ReleaseVerification,
  type ReleaseVerificationErrorCode,
} from './release-manifest.ts'
export {
  planWindowsRegistration,
  registerWindowsRegistration,
  removeWindowsRegistration,
  verifyWindowsRegistration,
  WindowsRegistrationError,
  type WindowsCommandRunner,
  type WindowsRegistrationOptions,
  type WindowsRegistrationPlan,
} from './windows-registration.ts'
export {
  installSignedRelease,
  SignedReleaseInstallError,
  type SignedReleaseInstallOptions,
  type SignedReleaseInstallResult,
} from './signed-install.ts'
