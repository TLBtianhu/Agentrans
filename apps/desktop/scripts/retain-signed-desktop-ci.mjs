/** Retain the exact files and source provenance of a production signed Desktop build. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, copyFile, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'

// The workflow copies this helper out of its own checkout before checking out the build source.
// Keep it independent of the source tree and any workspace dependencies.
const appId = 'com.agentrans.app'
const product = { owner: 'TLBtianhu', repo: 'Agentrans', slug: 'agentrans' }
const shaPattern = /^[0-9a-f]{40}$/u
const versionPattern = /^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){2}(?:-([0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*)?$/u

function requiredPath(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\r\n\0]/u.test(value)) {
    throw new Error(`signed Desktop retention: ${name} must be an absolute path`)
  }
  return value
}

function runNumber(value, name) {
  const number = Number(value)
  if (String(number) !== value || !Number.isSafeInteger(number) || number < 1) {
    throw new Error(`signed Desktop retention: ${name} must be a positive integer`)
  }
  return number
}

async function checkProductionAppId(configDirectory) {
  const path = join(requiredPath(configDirectory, 'AGENTRANS_PACKAGING_CONFIG_DIR'), 'presets', 'production.env')
  let settings
  try {
    // Follow the packaging adapter's dotenv and BOM handling. Only the public preset is read.
    settings = parseEnv((await readFile(path, 'utf8')).replace(/^\uFEFF/u, ''))
  } catch {
    throw new Error('signed Desktop retention: cannot read the production preset')
  }
  if (settings.AGENTRANS_DESKTOP_APP_ID?.trim() !== appId) {
    throw new Error(`signed Desktop retention: production preset must select ${appId}`)
  }
}

async function copyAsset(source, destination) {
  const status = await lstat(source)
  if (!status.isFile() || status.size === 0) throw new Error(`signed Desktop retention: expected a nonempty regular file at ${source}`)
  await copyFile(source, destination)
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(destination)) {
    hash.update(chunk)
    bytes += chunk.length
  }
  if (bytes !== status.size) throw new Error(`signed Desktop retention: file size changed while copying ${source}`)
  return { bytes, sha256: hash.digest('hex') }
}

/**
 * Preserve qualified packages before the workflow uploads its Actions artifact.
 * @param {string | undefined} target - Exact target selected by the trusted workflow step.
 * @param {NodeJS.ProcessEnv} env - Actions settings, selected source checkout, and production config directory.
 * @returns {Promise<string>} Fresh directory containing release files and their production build record.
 */
export async function retainSignedDesktopCi(target, env) {
  const windows = target === 'win-x64'
  if (!windows && target !== 'mac-arm64' && target !== 'mac-x64') throw new Error('signed Desktop retention: invalid target')
  const qualified = windows ? env.PACKAGE_SIGNING === 'signed' : env.PACKAGE_SKIP_NOTARIZATION === 'false'
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.AGENTRANS_PACKAGING_PRESET !== 'production' || !qualified) {
    throw new Error('signed Desktop retention: requires a production signed Windows or notarized macOS dispatch')
  }
  const sourceRef = env.PACKAGE_SOURCE_REF
  if (sourceRef !== 'main' && sourceRef !== 'master' && (sourceRef === undefined || !/^dsh-v[0-9][0-9A-Za-z.-]*$/u.test(sourceRef))) {
    throw new Error('signed Desktop retention: production source must be main, master or a dsh-v tag')
  }
  const version = env.PACKAGE_VERSION
  const channel = env.AGENTRANS_DESKTOP_UPDATE_CHANNEL
  const versionMatch = typeof version === 'string' ? versionPattern.exec(version) : null
  if (versionMatch === null || versionMatch[0] !== version || (channel !== 'nightly' && channel !== 'latest')
    || (channel === 'latest' && versionMatch[1] !== undefined)) {
    throw new Error('signed Desktop retention: invalid version or update channel')
  }
  const runId = runNumber(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID')
  const runAttempt = runNumber(env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT')
  const workflowSha = env.GITHUB_WORKFLOW_SHA
  if (workflowSha === undefined || !shaPattern.test(workflowSha)) throw new Error('signed Desktop retention: invalid workflow SHA')
  const workspace = requiredPath(env.GITHUB_WORKSPACE, 'GITHUB_WORKSPACE')
  const temporary = requiredPath(env.RUNNER_TEMP, 'RUNNER_TEMP')
  const output = requiredPath(env.GITHUB_OUTPUT, 'GITHUB_OUTPUT')
  await checkProductionAppId(env.AGENTRANS_PACKAGING_CONFIG_DIR)

  const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim()
  const commit = git('rev-parse', '--verify', 'HEAD^{commit}')
  if (!shaPattern.test(commit)) throw new Error('signed Desktop retention: invalid source commit')
  if (sourceRef.startsWith('dsh-v')) {
    const sourcePackage = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'))
    if (sourceRef !== `dsh-v${sourcePackage.version}` || git('rev-parse', '--verify', `refs/tags/${sourceRef}^{commit}`) !== commit) {
      throw new Error('signed Desktop retention: selected tag does not match the checked-out product version and commit')
    }
  } else if (git('rev-parse', '--abbrev-ref', 'HEAD') !== sourceRef) {
    throw new Error('signed Desktop retention: selected branch does not match the source checkout')
  }
  const source = join(workspace, 'apps', 'desktop', '.desktop-build', 'targets', target, 'artifacts')
  if (!(await lstat(source)).isDirectory()) throw new Error('signed Desktop retention: invalid signed artifact directory')
  const directory = await mkdtemp(join(temporary, `retained-signed-${target}-${runId}-${runAttempt}-`))
  try {
    const buildRecordName = `${target}-release.json`
    const buildRecordPath = join(directory, buildRecordName)
    const buildRecordAsset = await copyAsset(join(source, buildRecordName), buildRecordPath)
    const build = JSON.parse(await readFile(buildRecordPath, 'utf8'))
    if (build?.schemaVersion !== 1 || build.target !== target || build.version !== version || build.channel !== channel
      || build.provider !== 'github' || build.owner !== product.owner || build.repo !== product.repo
      || build.commit !== commit || build.dirty !== false) {
      throw new Error('signed Desktop retention: release record does not match the clean production source, target, version, or update feed')
    }
    const stem = `${product.slug}-${version}-${target}`
    const filenames = windows ? [`${stem}.exe`, `${stem}.exe.blockmap`] : [`${stem}.dmg`, `${stem}.zip`, `${stem}.zip.blockmap`]
    filenames.push(`${versionMatch[1] ?? 'latest'}${windows ? '' : '-mac'}.yml`)
    const assets = { [buildRecordName]: buildRecordAsset }
    for (const filename of filenames) assets[filename] = await copyAsset(join(source, filename), join(directory, filename))
    await writeFile(join(directory, 'desktop-signed-build.json'), `${JSON.stringify({
      schemaVersion: 1, target, commit, version, channel, appId, preset: 'production', sourceRef, runId, runAttempt, workflowSha, assets,
    }, null, 2)}\n`)
    await appendFile(output, `directory=${directory}\n`)
    return directory
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  await retainSignedDesktopCi(process.argv[2], process.env)
}
