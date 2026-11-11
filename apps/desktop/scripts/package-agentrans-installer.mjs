/** Build the Agentrans installer for one target with the shared unsigned production configuration. */
import { build, Platform, Arch } from 'electron-builder'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentransInstallerEnvironment, createAgentransInstallerConfig } from './agentrans-installer-config.mjs'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const target = process.argv[3] ?? 'win-x64'
// electron-builder resolves its output directory against the Electron project, so the same
// absolute path is created here and packaged there; a relative path used to split the two.
const output = resolve(appRoot, process.argv[2] ?? join(repositoryRoot, 'artifacts', 'agentrans-installer'))

const environment = agentransInstallerEnvironment(process.env, target)
const config = createAgentransInstallerConfig({ environment, output, repositoryRoot, target })
await mkdir(output, { recursive: true })
for (const name of Object.keys(process.env)) {
  if (!Object.hasOwn(environment, name)) delete process.env[name]
}
Object.assign(process.env, environment)

const targets = target === 'mac-arm64'
  ? Platform.MAC.createTarget(['dmg', 'zip'], Arch.arm64)
  : target === 'mac-x64'
    ? Platform.MAC.createTarget(['dmg', 'zip'], Arch.x64)
    : Platform.WINDOWS.createTarget(['nsis'], Arch.x64)
await build({ projectDir: appRoot, targets, publish: 'never', config })
console.log(JSON.stringify({ output, productName: config.productName, appId: config.appId, version: config.extraMetadata.version }))
