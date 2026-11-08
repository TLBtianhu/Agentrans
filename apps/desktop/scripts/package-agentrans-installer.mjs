/** Build the Agentrans Windows installer with the shared Electron/NSIS production configuration. */
import { build, Platform, Arch } from 'electron-builder'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentransInstallerEnvironment, createAgentransInstallerConfig } from './agentrans-installer-config.mjs'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const output = process.argv[2] ?? join(repositoryRoot, 'artifacts', 'agentrans-installer')

const environment = agentransInstallerEnvironment(process.env)
const config = createAgentransInstallerConfig({ environment, output, repositoryRoot })
await mkdir(output, { recursive: true })
for (const name of Object.keys(process.env)) {
  if (!Object.hasOwn(environment, name)) delete process.env[name]
}
Object.assign(process.env, environment)

await build({
  projectDir: appRoot,
  targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  publish: 'never',
  config,
})
console.log(JSON.stringify({ output, productName: config.productName, appId: config.appId, version: config.extraMetadata.version }))
