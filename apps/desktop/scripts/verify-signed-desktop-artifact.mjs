/** Inspect the release files with platform verification tools without launching them. */

import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, realpath, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESKTOP_PRODUCT_NAME } from './desktop-product-identity.mjs'
import { AGENTRANS_DESKTOP_APP_ID, DESKTOP_UPDATE_REPOSITORY, resolveMacOSSigningEnvironment } from './desktop-release-environment.mjs'
import { verifyMacOSAppUpdateConfig } from './macos-app-update-config.mjs'
import { verifyMacOSDiskImage, verifyMacOSNotarizedApplication, verifyMacOSSignature } from './verify-macos-signature.mjs'

const verifyWindowsScript = fileURLToPath(new URL('./verify-published-windows.ps1', import.meta.url))

function runNative(command, args, label) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    throw new Error(`desktop signed preflight: ${label} failed: ${error.message}`, { cause: error })
  }
}

function verifyWindowsInstaller(installer, version, thumbprint) {
  if (!/^[a-f0-9]{40}$/iu.test(thumbprint ?? '')) {
    throw new Error('desktop signed preflight: configure the expected 40-digit Windows certificate thumbprint')
  }
  runNative('pwsh', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', verifyWindowsScript,
    '-Installer', resolve(installer), '-Thumbprint', thumbprint,
    '-ExpectedProductName', DESKTOP_PRODUCT_NAME, '-ExpectedProductVersion', version,
  ], 'Windows Authenticode and installer version verification')
}

async function bundledApp(directory) {
  const app = join(directory, `${DESKTOP_PRODUCT_NAME}.app`)
  const entry = await lstat(app)
  if (!entry.isDirectory()) {
    throw new Error(`desktop signed preflight: ${app} must be an application directory`)
  }
  return app
}

async function verifyBundleDetails(app, { version, channel }, arch) {
  const plist = join(app, 'Contents', 'Info.plist')
  const field = name => runNative('/usr/bin/plutil', ['-extract', name, 'raw', '-o', '-', plist], name)
  if (field('CFBundleIdentifier') !== AGENTRANS_DESKTOP_APP_ID) {
    throw new Error(`desktop signed preflight: expected bundle identifier ${AGENTRANS_DESKTOP_APP_ID} in ${app}`)
  }
  if (field('CFBundleShortVersionString') !== version) {
    throw new Error(`desktop signed preflight: expected bundle version ${version} in ${app}`)
  }

  const executable = field('CFBundleExecutable')
  if (!executable || executable === '.' || executable === '..' || executable.includes('/')) {
    throw new Error(`desktop signed preflight: invalid CFBundleExecutable in ${app}`)
  }
  const binary = join(app, 'Contents', 'MacOS', executable)
  const found = runNative('/usr/bin/lipo', ['-archs', binary], 'macOS executable architecture check')
  if (found !== arch) {
    throw new Error(`desktop signed preflight: expected ${arch} in ${binary}, found ${found}`)
  }
  await verifyMacOSAppUpdateConfig(app, { provider: 'github', ...DESKTOP_UPDATE_REPOSITORY, channel })
}

async function verifyMacDiskImage(dmg, expected, request, arch) {
  verifyMacOSDiskImage(dmg, expected)
  const scratch = await mkdtemp(join(await realpath(tmpdir()), 'agentrans-signed-dmg-'))
  const mount = join(scratch, 'volume')
  let attached = false
  try {
    await mkdir(mount)
    runNative('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg], 'macOS disk image mount')
    attached = true
    const app = await bundledApp(mount)
    // The sealed disk image carries the ticket for this copy of the signed app.
    verifyMacOSSignature(app, expected)
    await verifyBundleDetails(app, request, arch)
  } finally {
    if (attached) runNative('/usr/bin/hdiutil', ['detach', mount], 'macOS disk image detach')
    await rmdir(mount).catch(error => { if (error.code !== 'ENOENT') throw error })
    await rmdir(scratch)
  }
}

async function verifyMacZip(zip, expected, request, arch) {
  const scratch = await mkdtemp(join(await realpath(tmpdir()), 'agentrans-signed-zip-'))
  try {
    runNative('/usr/bin/ditto', ['-x', '-k', zip, scratch], 'macOS update ZIP extraction')
    const app = await bundledApp(scratch)
    verifyMacOSNotarizedApplication(app, expected)
    await verifyBundleDetails(app, request, arch)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Require the original installer or both macOS distribution files to match the trusted identity.
 * @param {'win-x64' | 'mac-arm64' | 'mac-x64'} target Build target.
 * @param {{ installer?: string, dmg?: string, zip?: string }} paths Absolute or working-directory-relative artifact paths.
 * @param {{ version: string, channel: 'nightly' | 'latest' }} request Expected release version and update channel.
 * @param {{ windowsThumbprint?: string, macTeamId?: string, macSigningIdentity?: string }} identity Trusted public certificate identity.
 * @returns {Promise<void>} Resolves once the native verification tools and artifact checks succeed.
 */
export async function verifySignedDesktopArtifact(target, paths, request, identity) {
  if (target === 'win-x64') {
    if (process.platform !== 'win32') throw new Error('desktop signed preflight: Windows verification requires a Windows host')
    if (!paths.installer) throw new Error('desktop signed preflight: a Windows installer path is required')
    verifyWindowsInstaller(paths.installer, request.version, identity.windowsThumbprint)
    return
  }

  if (target !== 'mac-arm64' && target !== 'mac-x64') {
    throw new Error(`desktop signed preflight: unsupported target ${target}`)
  }
  if (process.platform !== 'darwin') throw new Error('desktop signed preflight: macOS verification requires a macOS host')
  if (!paths.dmg || !paths.zip) throw new Error('desktop signed preflight: macOS requires both a DMG and a ZIP path')
  const expected = resolveMacOSSigningEnvironment({
    AGENTRANS_DESKTOP_MACOS_SIGNING_IDENTITY: identity.macSigningIdentity,
    AGENTRANS_DESKTOP_MACOS_TEAM_ID: identity.macTeamId,
  })
  const arch = target === 'mac-arm64' ? 'arm64' : 'x86_64'
  await verifyMacDiskImage(resolve(paths.dmg), expected, request, arch)
  await verifyMacZip(resolve(paths.zip), expected, request, arch)
}
