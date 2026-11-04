/** Production install/uninstall entry point using the shared product-layout lifecycle. */
import { createPublicKey } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALL_UNINSTALL_SCOPE,
  APP_ONLY_UNINSTALL_SCOPE,
  executeUninstallPlan,
  installSignedRelease,
  planUninstall,
  planWindowsRegistration,
  ProductLayout,
  readInstallManifest,
  removeWindowsRegistration,
} from '../../../packages/boot/product-layout/lib/index.js'

const execFileAsync = promisify(execFile)
const installerDir = dirname(fileURLToPath(import.meta.url))
const publicKeyPathDefault = join(installerDir, '../../../distribution/keys/agentrans-update-ed25519-public.pem')
const usage = `Usage:
  node agentrans-installer.mjs install --root <dir> --release <zip> --manifest <json> [--public-key <pem>] [--product-name <name>] [--publisher <name>] [--version <version>] [--uninstall-key <key>] [--shortcut-path <lnk>]
  node agentrans-installer.mjs uninstall --root <dir> [--silent] [--all] [--scope app,sessions,settings,models,runtimes,exports] [--product-name <name>] [--uninstall-key <key>] [--shortcut-path <lnk>]

Install verifies the signed release before installing. Uninstall defaults to app-only and never opens a dialog in silent mode.`

function required(options, name) {
  const value = options[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing required --${name}`)
  return value
}

function optional(options, name) {
  const value = options[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function scopeFromText(value) {
  if (value === undefined) return APP_ONLY_UNINSTALL_SCOPE
  const scope = { app: false, sessions: false, settings: false, models: false, runtimes: false, exports: false }
  for (const name of value.split(',')) {
    if (!(name in scope)) throw new Error(`Unknown uninstall scope: ${name}`)
    scope[name] = true
  }
  return scope
}

function isEnoent(error) {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

async function install(options) {
  const layout = ProductLayout.fromRoot(required(options, 'root'), 'installed')
  const releasePath = required(options, 'release')
  const manifest = JSON.parse(await readFile(required(options, 'manifest'), 'utf8'))
  const publicKey = createPublicKey(await readFile(optional(options, 'public-key') ?? publicKeyPathDefault, 'utf8'))
  const result = await installSignedRelease({
    layout,
    releasePath,
    manifest,
    publicKey,
    registration: {
      productName: optional(options, 'product-name') ?? 'Agentrans',
      version: optional(options, 'version') ?? manifest.version,
      publisher: optional(options, 'publisher') ?? 'Agentrans',
      ...optional(options, 'uninstall-key') === undefined ? {} : { uninstallKey: optional(options, 'uninstall-key') },
      ...optional(options, 'shortcut-path') === undefined ? {} : { shortcutPath: optional(options, 'shortcut-path') },
    },
  })
  console.log(JSON.stringify({ status: 'installed', root: layout.root, appVersion: result.install.manifest.appVersion, registration: result.registration?.uninstallKey }))
}

async function uninstall(options) {
  const layout = ProductLayout.fromRoot(required(options, 'root'), 'installed')
  const productName = optional(options, 'product-name') ?? 'Agentrans'
  let scope = scopeFromText(optional(options, 'scope'))
  let allConfirmed = options.all === true
  if (options.all === true) scope = ALL_UNINSTALL_SCOPE

  if (options.silent !== true) {
    const dialog = join(installerDir, 'uninstall-dialog.ps1')
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', dialog, '-ProductName', productName])
    const answer = JSON.parse(stdout)
    if (answer === null) {
      console.log(JSON.stringify({ status: 'cancelled' }))
      return
    }
    scope = answer.scope ?? scope
    allConfirmed = answer.allConfirmed === true
  }

  const plan = planUninstall(layout, scope, { allConfirmed })
  const result = await executeUninstallPlan(plan, {
    removeRegistration: async () => {
      let version = '0.0.0'
      try {
        version = (await readInstallManifest(layout.installManifestPath)).appVersion
      } catch (error) {
        if (!isEnoent(error)) throw error
      }
      await removeWindowsRegistration(planWindowsRegistration(layout, {
        productName,
        version,
        publisher: 'Agentrans',
        ...optional(options, 'uninstall-key') === undefined ? {} : { uninstallKey: optional(options, 'uninstall-key') },
        ...optional(options, 'shortcut-path') === undefined ? {} : { shortcutPath: optional(options, 'shortcut-path') },
      }))
    },
  })
  console.log(JSON.stringify({ status: 'uninstalled', completed: result.completed }))
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  if (command === '--help' || command === '-h' || command === undefined) {
    console.log(usage)
    return
  }
  const options = {}
  for (let index = 1; index < args.length; index++) {
    const token = args[index]
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`)
    const name = token.slice(2)
    const next = args[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      options[name] = next
      index++
    } else {
      options[name] = true
    }
  }
  if (command === 'install') await install(options)
  else if (command === 'uninstall') await uninstall(options)
  else throw new Error(`Unknown command: ${command}`)
}

try {
  await main()
} catch (error) {
  const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'ERROR'
  const message = error instanceof Error ? error.message : String(error)
  console.error(JSON.stringify({ status: 'error', code, message }))
  process.exitCode = 1
}
