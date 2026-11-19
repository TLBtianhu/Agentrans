/** Agentrans installer identity for hosted tests and supervised signed packaging. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopTargetPlatform, resolveDesktopBuildTarget } from './desktop-build-paths.mjs'
import { createAgentransInstallerBuilderConfig } from './electron-builder-config.mjs'
import { AGENTRANS_DESKTOP_APP_ID, resolveDesktopAppId } from './desktop-release-environment.mjs'
import { DESKTOP_ARTIFACT_SLUG, DESKTOP_PRODUCT_NAME } from './desktop-product-identity.mjs'
import { scrubWindowsSigningEnvironment } from './windows-sign.mjs'

const PRODUCT_NAME = DESKTOP_PRODUCT_NAME
/** Platform and architecture each supported target builds for. */
const TARGETS = {
  'win-x64': { platform: 'win32', arch: 'x64' },
  'mac-arm64': { platform: 'darwin', arch: 'arm64' },
  'mac-x64': { platform: 'darwin', arch: 'x64' },
}

/**
 * Bind one unsigned Windows artifact to its product identity and remove ambient signing credentials.
 * Conflicting target settings are refused instead of silently changing their meaning, and the
 * update channel follows the product's own feed.
 * @param {NodeJS.ProcessEnv} environment - Parent process environment; never modified or loaded from dotenv.
 * @returns {NodeJS.ProcessEnv} Explicit product settings for configuration and the builder process.
 */
export function agentransInstallerEnvironment(environment, target = 'win-x64') {
  const selected = TARGETS[target]
  if (selected === undefined) throw new Error(`Agentrans installer does not support target ${String(target)}`)
  const TARGET_SETTINGS = {
    AGENTRANS_DESKTOP_APP_ID: AGENTRANS_DESKTOP_APP_ID,
    AGENTRANS_DESKTOP_TARGET_PLATFORM: selected.platform,
    AGENTRANS_DESKTOP_TARGET_ARCH: selected.arch,
    AGENTRANS_DESKTOP_UNSIGNED: '1',
  }
  const settings = new Map()
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || /^AGENTRANS_DESKTOP_WINDOWS_/iu.test(name)) continue
    const key = /^AGENTRANS_DESKTOP_/iu.test(name) ? name.toUpperCase() : name
    if (settings.has(key) && settings.get(key) !== value) {
      throw new Error(`Agentrans installer received conflicting environment aliases for ${key}`)
    }
    settings.set(key, value)
  }
  const normalized = Object.fromEntries(settings)
  for (const [name, expected] of Object.entries(TARGET_SETTINGS)) {
    if (normalized[name] !== undefined && normalized[name] !== expected) {
      throw new Error(`Agentrans installer requires ${name}=${expected}`)
    }
  }
  return {
    ...Object.fromEntries(Object.entries(scrubWindowsSigningEnvironment(normalized))
      .filter(([name]) => !/^(?:(?:WIN_)?CSC_|APPLE_)/iu.test(name))),
    ...TARGET_SETTINGS,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    ELECTRON_BUILDER_7Z_FILTER: 'BCJ',
  }
}

/**
 * Resolve product metadata and versioned output through the hosted unsigned builder.
 * @param {{ environment: NodeJS.ProcessEnv, output: string, repositoryRoot: string, target?: keyof typeof TARGETS }} options - Prepared product environment and output roots.
 * @returns {import('./agentrans-installer-config.mjs').AgentransInstallerConfig} Unsigned configuration with the product feed.
 */
export function createAgentransInstallerConfig({ environment, output, repositoryRoot, target = 'win-x64' }) {
  if (target !== 'win-x64' && target !== 'mac-arm64' && target !== 'mac-x64') {
    throw new Error(`Agentrans installer does not support target ${String(target)}`)
  }
  const platform = TARGETS[target].platform
  const arch = TARGETS[target].arch
  const base = createAgentransInstallerBuilderConfig(agentransInstallerEnvironment(environment, target), platform, arch)
  const artifactName = `${DESKTOP_ARTIFACT_SLUG}-\${version}-${target}-unsigned.\${ext}`
  const config = withAgentransIdentity({ ...base, artifactName, directories: { output } }, target, repositoryRoot)
  if (target !== 'win-x64') {
    // Hosted unsigned builds do not use a Developer ID signing identity or notarization.
    return { ...config, mac: { ...config.mac, identity: null, notarize: false } }
  }
  return config
}

/**
 * Keep the supervisor's signed builder hooks and target-owned outputs under the product identity.
 * @param {NodeJS.ProcessEnv} environment - Signed environment selected by the packaging supervisor.
 * @param {NodeJS.Platform} hostPlatform - Platform used when the supervisor does not supply a target.
 * @param {string} hostArch - Architecture used when the supervisor does not supply a target.
 * @returns {import('./agentrans-installer-config.mjs').AgentransInstallerConfig} Signed Agentrans builder configuration.
 */
export function createAgentransSignedInstallerConfig(environment = process.env, hostPlatform = process.platform, hostArch = process.arch) {
  if (resolveDesktopAppId(environment) !== AGENTRANS_DESKTOP_APP_ID) {
    throw new Error(`Agentrans signed installer requires AGENTRANS_DESKTOP_APP_ID=${AGENTRANS_DESKTOP_APP_ID}`)
  }
  if (environment.AGENTRANS_DESKTOP_UNSIGNED !== '0') {
    throw new Error('Agentrans signed installer requires AGENTRANS_DESKTOP_UNSIGNED=0')
  }
  const target = resolveDesktopBuildTarget(environment, hostPlatform, hostArch)
  const { platform, arch } = desktopTargetPlatform(target)
  const base = createAgentransInstallerBuilderConfig({
    ...environment, AGENTRANS_DESKTOP_TARGET_PLATFORM: platform, AGENTRANS_DESKTOP_TARGET_ARCH: arch,
  }, platform, arch)
  return withAgentransIdentity(base, target, fileURLToPath(new URL('../../..', import.meta.url)))
}

function withAgentransIdentity(base, target, repositoryRoot) {
  const { nsis: baseNsis, ...baseWithoutNsis } = base
  const shared = {
    ...baseWithoutNsis,
    appId: AGENTRANS_DESKTOP_APP_ID,
    productName: PRODUCT_NAME,
    protocols: [],
    extraMetadata: { ...base.extraMetadata, agentransAppId: AGENTRANS_DESKTOP_APP_ID,
      agentransChannel: base.extraMetadata.dshDesktopUpdateChannel, name: 'agentrans' },
    files: [...base.files, 'installer/**/*'],
    extraResources: [
      ...base.extraResources,
      { from: join(repositoryRoot, 'packages/boot/product-layout'), to: 'packages/boot/product-layout' },
      { from: join(repositoryRoot, 'distribution/keys'), to: 'distribution/keys' },
    ],
  }
  if (target !== 'win-x64') return shared
  return {
    ...shared,
    nsis: { ...baseNsis, uninstallDisplayName: PRODUCT_NAME, shortcutName: PRODUCT_NAME, artifactName: base.artifactName,
      allowToChangeInstallationDirectory: false },
  }
}
