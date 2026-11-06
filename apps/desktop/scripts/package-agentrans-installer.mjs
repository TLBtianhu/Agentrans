/** Build the Agentrans Windows installer with the shared Electron/NSIS production configuration. */
import { build, Platform, Arch } from 'electron-builder'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElectronBuilderConfig } from './electron-builder-config.mjs'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const output = process.argv[2] ?? join(repositoryRoot, 'artifacts', 'agentrans-installer')
await mkdir(output, { recursive: true })

Object.assign(process.env, {
  DSH_DESKTOP_APP_ID: 'com.agentrans.app',
  DSH_DESKTOP_TARGET_PLATFORM: 'win32',
  DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_DESKTOP_UNSIGNED: '1',
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  ELECTRON_BUILDER_7Z_FILTER: 'BCJ',
  DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://test.example.com',
  DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
})

const base = createElectronBuilderConfig()
const config = {
  ...base,
  appId: 'com.agentrans.app',
  productName: 'Agentrans',
  artifactName: 'agentrans-0.1.0-win-x64.${ext}',
  directories: { output },
  protocols: [],
  extraMetadata: { agentransAppId: 'com.agentrans.app', agentransChannel: 'nightly', name: 'agentrans' },
  files: [...base.files, 'installer/**/*'],
  extraResources: [
    ...base.extraResources,
    { from: join(repositoryRoot, 'packages/boot/product-layout'), to: 'packages/boot/product-layout' },
    { from: join(repositoryRoot, 'distribution/keys'), to: 'distribution/keys' },
  ],
  nsis: {
    ...base.nsis,
    uninstallDisplayName: 'Agentrans',
    shortcutName: 'Agentrans',
    artifactName: 'agentrans-0.1.0-win-x64.${ext}',
    allowToChangeInstallationDirectory: false,
  },
}

await build({
  projectDir: appRoot,
  targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  publish: 'never',
  config,
})
console.log(JSON.stringify({ output, productName: config.productName, appId: config.appId }))
