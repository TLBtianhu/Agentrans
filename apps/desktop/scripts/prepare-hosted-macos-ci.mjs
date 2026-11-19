/** Prepare and check a run-owned configuration for hosted macOS packaging. */

import { execFileSync } from 'node:child_process'
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseEnv } from 'node:util'
import { resolveDesktopPackagingUpdateConfig, resolveDesktopUpdateChannel } from './desktop-auto-update-environment.mjs'
import { desktopCiVersion } from './desktop-ci-version.mjs'
import { loadDesktopPackageEnvironment, validateDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { AGENTRANS_DESKTOP_APP_ID, resolveMacOSSigningEnvironment } from './desktop-release-environment.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const markerName = '.hosted-macos-config'
const markerContents = 'Agentrans hosted macOS packaging configuration\n'

function targetArchitecture(environment) {
  const arch = environment.AGENTRANS_DESKTOP_TARGET_ARCH
  if (environment.AGENTRANS_DESKTOP_TARGET_PLATFORM !== 'darwin' || (arch !== 'arm64' && arch !== 'x64')) {
    throw new Error('hosted macOS packaging requires a macOS arm64 or x64 target')
  }
  return arch
}

function absolutePath(environment, name) {
  const path = environment[name]
  if (!path || !isAbsolute(path) || /[\0\r\n]/u.test(path)) throw new Error(`hosted macOS packaging requires an absolute ${name}`)
  return path
}

function configPath(environment) {
  const arch = targetArchitecture(environment)
  const { GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt } = environment
  if (!/^[1-9]\d*$/u.test(runId ?? '') || !/^[1-9]\d*$/u.test(attempt ?? '')) {
    throw new Error('hosted macOS packaging requires positive run and attempt numbers')
  }
  const workspace = realpathSync(absolutePath(environment, 'GITHUB_WORKSPACE'))
  const temporary = realpathSync(absolutePath(environment, 'RUNNER_TEMP'))
  const outsideWorkspace = relative(workspace, temporary)
  if (outsideWorkspace === '' || (!isAbsolute(outsideWorkspace) && outsideWorkspace !== '..' && !outsideWorkspace.startsWith(`..${sep}`))) {
    throw new Error('hosted macOS packaging requires RUNNER_TEMP outside the checkout')
  }
  return join(temporary, `agentrans-hosted-macos-${runId}-${attempt}-${arch}`)
}

function ownedConfigPath(environment, allowMissing = false) {
  const path = configPath(environment)
  const configured = environment.AGENTRANS_PACKAGING_CONFIG_DIR
  if ((!allowMissing || configured !== undefined) && configured !== path) {
    throw new Error('hosted macOS packaging configuration does not match this run')
  }
  const directory = lstatSync(path, { throwIfNoEntry: false })
  if (directory === undefined && allowMissing) return undefined
  const owner = process.getuid?.()
  if (!directory?.isDirectory() || (owner !== undefined && (directory.uid !== owner || (directory.mode & 0o077) !== 0))) {
    throw new Error('hosted macOS packaging configuration must be a private run-owned directory')
  }
  const marker = join(path, markerName)
  if (!lstatSync(marker, { throwIfNoEntry: false })?.isFile() || readFileSync(marker, 'utf8') !== markerContents) {
    throw new Error('hosted macOS packaging configuration has no matching ownership marker')
  }
  return path
}

function writePrivate(path, contents) {
  writeFileSync(path, contents, { flag: 'wx', mode: 0o600 })
}

function preparePublicConfiguration(environment) {
  if (environment.AGENTRANS_PACKAGING_PRESET !== 'production' || environment.PACKAGE_SKIP_NOTARIZATION !== 'false') {
    throw new Error('hosted macOS packaging requires the production preset and notarization enabled')
  }
  resolveDesktopUpdateChannel(environment)
  const product = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
  const version = desktopCiVersion(environment, product.version)
  const output = absolutePath(environment, 'GITHUB_ENV')
  const path = configPath(environment)
  mkdirSync(path, { mode: 0o700 })
  try {
    writePrivate(join(path, markerName), markerContents)
    const presets = join(path, 'presets')
    mkdirSync(presets, { mode: 0o700 })
    writePrivate(join(presets, 'production.env'), `AGENTRANS_DESKTOP_APP_ID=${AGENTRANS_DESKTOP_APP_ID}\n`)
    const settings = loadDesktopPackageEnvironment('darwin', { ...environment, AGENTRANS_PACKAGING_CONFIG_DIR: path }, appRoot, { unsigned: true })
    validateDesktopPackageEnvironment(settings, { platform: 'darwin', arch: targetArchitecture(environment) }, { unsigned: true })
    const { channel } = resolveDesktopPackagingUpdateConfig(settings)
    appendFileSync(output, `AGENTRANS_PACKAGING_CONFIG_DIR=${path}\nPACKAGE_VERSION=${version}\n`)
    console.log(`Hosted macOS production configuration verified for ${version} on ${channel}.`)
  } catch (error) {
    rmSync(path, { recursive: true, force: true })
    throw error
  }
}

function decodeBase64(environment, name) {
  const value = environment[name]
  if (!value || !/^[A-Za-z0-9+/]+=*$/u.test(value) || value.length % 4 !== 0) {
    throw new Error(`hosted macOS packaging requires canonical Base64 in ${name}`)
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error(`hosted macOS packaging requires canonical Base64 in ${name}`)
  return bytes
}

function dotenvSetting(name, value) {
  if (value.includes('\0')) throw new Error(`hosted macOS packaging cannot store ${name} in the signing configuration`)
  for (const quote of ["'", '`', '"']) {
    if (value.includes(quote)) continue
    const line = `${name}=${quote}${value}${quote}\n`
    if (parseEnv(line)[name] === value) return line
  }
  throw new Error(`hosted macOS packaging cannot store ${name} in the signing configuration`)
}

function prepareSigningCredentials(environment) {
  const path = ownedConfigPath(environment)
  const certificate = decodeBase64(environment, 'MACOS_DEVELOPER_ID_P12_BASE64')
  const key = decodeBase64(environment, 'MACOS_NOTARIZATION_KEY_P8_BASE64')
  const exportPassword = environment.MACOS_DEVELOPER_ID_P12_PASSWORD
  const keyId = environment.MACOS_NOTARIZATION_KEY_ID
  const issuer = environment.MACOS_NOTARIZATION_ISSUER_ID
  if (exportPassword === undefined) throw new Error('hosted macOS packaging requires MACOS_DEVELOPER_ID_P12_PASSWORD')
  if (!/^[A-Z0-9]{10}$/u.test(keyId ?? '')) throw new Error('hosted macOS packaging requires a valid MACOS_NOTARIZATION_KEY_ID')
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(issuer ?? '')) {
    throw new Error('hosted macOS packaging requires a valid MACOS_NOTARIZATION_ISSUER_ID')
  }
  const { signingIdentity, teamId } = resolveMacOSSigningEnvironment({
    AGENTRANS_DESKTOP_MACOS_SIGNING_IDENTITY: environment.DESKTOP_MACOS_SIGNING_IDENTITY,
    AGENTRANS_DESKTOP_MACOS_TEAM_ID: environment.DESKTOP_MACOS_TEAM_ID,
  })
  const settings = [
    dotenvSetting('AGENTRANS_DESKTOP_MACOS_SIGNING_IDENTITY', signingIdentity),
    dotenvSetting('AGENTRANS_DESKTOP_MACOS_TEAM_ID', teamId),
    'CSC_LINK=../certificates/developer-id.p12\n',
    dotenvSetting('CSC_KEY_PASSWORD', exportPassword),
    'APPLE_API_KEY=../certificates/notarization.p8\n',
    dotenvSetting('APPLE_API_KEY_ID', keyId),
    dotenvSetting('APPLE_API_ISSUER', issuer),
  ].join('')
  const certificates = join(path, 'certificates')
  const secrets = join(path, 'secrets')
  mkdirSync(certificates, { mode: 0o700 })
  mkdirSync(secrets, { mode: 0o700 })
  writePrivate(join(certificates, 'developer-id.p12'), certificate)
  writePrivate(join(certificates, 'notarization.p8'), key)
  writePrivate(join(secrets, 'macos-signing.env'), settings)
}

function checkNativeToolchain(environment) {
  const arch = targetArchitecture(environment)
  if (process.platform !== 'darwin' || process.arch !== arch) {
    throw new Error(`hosted macOS packaging requires a native macOS ${arch} runner`)
  }
  const path = ownedConfigPath(environment)
  const tools = [
    ['/usr/bin/xcode-select', '-p'],
    ['/usr/bin/xcrun', '--sdk', 'macosx', '--show-sdk-path'],
    ['/usr/bin/xcrun', '--find', 'notarytool'],
    ['/usr/bin/xcrun', '--find', 'stapler'],
    ['/usr/bin/security', 'list-keychains', '-d', 'user'],
    ['/usr/bin/codesign', '--display', '/usr/bin/true'],
    ['/usr/bin/hdiutil', 'info'],
  ]
  const run = (tool, args, input) => {
    try {
      execFileSync(tool, args, { input, stdio: ['pipe', 'ignore', 'pipe'], timeout: 30_000 })
    } catch {
      throw new Error(`hosted macOS packaging toolchain probe failed for ${tool} ${args.join(' ')}`)
    }
  }
  for (const [tool, ...args] of tools) run(tool, args)
  const temporary = mkdtempSync(join(path, 'toolchain-'))
  try {
    const probe = join(temporary, 'probe')
    run('/usr/bin/xcrun', ['--sdk', 'macosx', 'clang', '-x', 'c', '-', '-o', probe], 'int main(void) { return 0; }\n')
    run(probe, [])
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  console.log(`Native macOS ${arch} Xcode and Apple packaging tools verified without signing credentials.`)
}

const [command, ...extra] = process.argv.slice(2)
if (extra.length !== 0) throw new Error('usage: node prepare-hosted-macos-ci.mjs public|check|credentials|cleanup')
switch (command) {
  case 'public': preparePublicConfiguration(process.env); break
  case 'check': checkNativeToolchain(process.env); break
  case 'credentials': prepareSigningCredentials(process.env); break
  case 'cleanup': {
    const path = ownedConfigPath(process.env, true)
    if (path !== undefined) rmSync(path, { recursive: true, force: true })
    break
  }
  default: throw new Error('usage: node prepare-hosted-macos-ci.mjs public|check|credentials|cleanup')
}
