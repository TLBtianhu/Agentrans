/** Agentrans's unsigned Windows artifact configuration: its own release feed, and no credential files. */
import { join } from 'node:path'
import { createAgentransInstallerBuilderConfig } from './electron-builder-config.mjs'
import { AGENTRANS_DESKTOP_APP_ID } from './desktop-release-environment.mjs'
import { DESKTOP_ARTIFACT_SLUG, DESKTOP_PRODUCT_NAME } from './desktop-product-identity.mjs'
import { scrubWindowsSigningEnvironment } from './windows-sign.mjs'

const PRODUCT_NAME = DESKTOP_PRODUCT_NAME
const TARGET_SETTINGS = {
  DSH_DESKTOP_APP_ID: AGENTRANS_DESKTOP_APP_ID,
  DSH_DESKTOP_TARGET_PLATFORM: 'win32',
  DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_DESKTOP_UNSIGNED: '1',
}

/**
 * Bind one unsigned Windows artifact to its product identity and remove ambient signing credentials.
 * Conflicting target settings are refused instead of silently changing their meaning, and the
 * update channel follows the product's own feed.
 * @param {NodeJS.ProcessEnv} environment - Parent process environment; never modified or loaded from dotenv.
 * @returns {NodeJS.ProcessEnv} Explicit product settings for configuration and the builder process.
 */
export function agentransInstallerEnvironment(environment) {
  const settings = new Map()
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || /^DSH_DESKTOP_WINDOWS_/iu.test(name)) continue
    const key = /^DSH_DESKTOP_/iu.test(name) ? name.toUpperCase() : name
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
 * Resolve product metadata and versioned output through the shared unsigned Windows builder.
 * @param {{ environment: NodeJS.ProcessEnv, output: string, repositoryRoot: string }} options - Prepared product environment and output roots.
 * @returns {import('./agentrans-installer-config.mjs').AgentransInstallerConfig} Configuration that cannot publish or register dsh protocols.
 */
export function createAgentransInstallerConfig({ environment, output, repositoryRoot }) {
  const base = createAgentransInstallerBuilderConfig(agentransInstallerEnvironment(environment), 'win32', 'x64')
  const artifactName = `${DESKTOP_ARTIFACT_SLUG}-\${version}-win-x64-unsigned.\${ext}`
  return {
    ...base,
    appId: AGENTRANS_DESKTOP_APP_ID,
    productName: PRODUCT_NAME,
    artifactName,
    directories: { output },
    protocols: [],
    extraMetadata: { ...base.extraMetadata, agentransAppId: AGENTRANS_DESKTOP_APP_ID,
      agentransChannel: base.extraMetadata.dshDesktopUpdateChannel, name: 'agentrans' },
    files: [...base.files, 'installer/**/*'],
    extraResources: [
      ...base.extraResources,
      { from: join(repositoryRoot, 'packages/boot/product-layout'), to: 'packages/boot/product-layout' },
      { from: join(repositoryRoot, 'distribution/keys'), to: 'distribution/keys' },
    ],
    nsis: { ...base.nsis, uninstallDisplayName: PRODUCT_NAME, shortcutName: PRODUCT_NAME, artifactName,
      allowToChangeInstallationDirectory: false },
  }
}
