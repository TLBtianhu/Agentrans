/** Verify a hosted packaging run and stage its assets before the signing step. */

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { appendFile, copyFile, lstat, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'semver'
import { DESKTOP_UPDATE_REPOSITORY } from './desktop-release-environment.mjs'

const runGitHub = promisify(execFile)
const packageWorkflow = 'agentrans-hosted-package.yml'
const productRepository = `${DESKTOP_UPDATE_REPOSITORY.owner}/${DESKTOP_UPDATE_REPOSITORY.repo}`
const artifactsByTarget = {
  all: ['agentrans-win-x64', 'agentrans-mac'],
  'win-x64': ['agentrans-win-x64'],
  mac: ['agentrans-mac'],
  'mac-arm64': ['agentrans-mac-arm64'],
  'mac-x64': ['agentrans-mac-x64'],
} as const

type Channel = 'nightly' | 'latest'
type PackageTarget = keyof typeof artifactsByTarget
type PackageArtifact = (typeof artifactsByTarget)[PackageTarget][number]
const releaseTargets = ['win-x64', 'mac', 'mac-arm64', 'mac-x64'] as const
type ReleaseTarget = (typeof releaseTargets)[number]

/** Immutable archive identity obtained from the GitHub Actions API. */
interface HostedDesktopReleaseArchive {
  readonly target: ReleaseTarget
  readonly runId: string
  readonly artifactId: string
  readonly name: string
  readonly digest: string
  readonly size: number
}

/** Complete, same-source input to Desktop release preflight. */
export interface HostedDesktopReleasePlan {
  readonly version: string
  readonly channel: Channel
  readonly sourceSha: string
  readonly archives: readonly HostedDesktopReleaseArchive[]
}

interface HostedDesktopReleaseSource {
  readonly runId: string
  readonly run: unknown
  readonly archiveList: unknown
}

interface PackageRun {
  readonly sourceSha: string
  readonly target: PackageTarget
  readonly artifacts: readonly PackageArtifact[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProductRepository(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase() === productRepository.toLowerCase()
}

/**
 * Resolve the intended assets of a completed run from the authenticated Actions responses.
 * @param workflow - Response for the named packaging workflow in the product repository.
 * @param run - Response for the selected run in the product repository.
 * @param version - Product version requested for publication.
 * @param channel - Channel requested for publication.
 * @returns The source commit, target, and exact named artifacts to download.
 */
export function verifyHostedPackageRun(workflow: unknown, run: unknown, version: string, channel: Channel): PackageRun {
  if (!isRecord(workflow) || typeof workflow.id !== 'number' || !Number.isSafeInteger(workflow.id) || workflow.id <= 0
    || workflow.path !== `.github/workflows/${packageWorkflow}`
    || !isRecord(run) || run.workflow_id !== workflow.id || !isRecord(run.repository) || !isRecord(run.head_repository)
    || !isProductRepository(run.repository.full_name) || !isProductRepository(run.head_repository.full_name)
    || run.event !== 'workflow_dispatch' || run.status !== 'completed' || run.conclusion !== 'success'
    || typeof run.head_sha !== 'string' || !/^[a-f0-9]{40}$/u.test(run.head_sha)) {
    throw new Error(`desktop publish: select a successful hosted packaging run in ${productRepository}`)
  }
  const targets = Object.keys(artifactsByTarget) as PackageTarget[]
  const target = targets.find(candidate => run.display_title === `Package Agentrans · ${candidate} · ${channel} · ${version}`)
  if (target === undefined) {
    throw new Error(`desktop publish: the hosted run must record its target, channel ${channel}, and version ${version}; repackage with matching inputs`)
  }
  return { sourceSha: run.head_sha, target, artifacts: artifactsByTarget[target] }
}

function validateRunIds(runIds: readonly string[]): void {
  if (runIds.length < 1 || runIds.length > 3 || runIds.some(id => !/^[1-9][0-9]*$/u.test(id)) || new Set(runIds).size !== runIds.length) {
    throw new Error('desktop publish: provide one to three distinct numeric packaging run IDs')
  }
}

function readHostedArchive(record: unknown, name: string, runId: string, sourceSha: string): HostedDesktopReleaseArchive {
  if (!isRecord(record) || record.name !== name || typeof record.id !== 'number' || !Number.isSafeInteger(record.id) || record.id <= 0
    || record.expired !== false || (record.state !== undefined && record.state !== 'uploaded')
    || typeof record.size_in_bytes !== 'number' || !Number.isSafeInteger(record.size_in_bytes) || record.size_in_bytes <= 0
    || typeof record.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(record.digest)) {
    throw new Error(`desktop publish: invalid or expired ${name} archive in packaging run ${runId}`)
  }
  const linkedRun = record.workflow_run
  if ((record.run_id !== undefined && String(record.run_id) !== runId)
    || (linkedRun != null && (!isRecord(linkedRun)
      || (linkedRun.id !== undefined && String(linkedRun.id) !== runId)
      || (linkedRun.head_sha !== undefined && linkedRun.head_sha !== sourceSha)))) {
    throw new Error(`desktop publish: ${name} archive does not belong to packaging run ${runId} at ${sourceSha}`)
  }
  const target = releaseTargets.find(candidate => name === `agentrans-${candidate}`)
  if (target === undefined) throw new Error(`desktop publish: unsupported packaging archive ${name}`)
  return { target, runId, artifactId: String(record.id), name, digest: record.digest, size: record.size_in_bytes }
}

/**
 * Plan a complete Windows and macOS release without downloading archives or writing a Release.
 * @param workflow - GitHub Actions metadata for the repository's packaging workflow.
 * @param sources - Records fetched by run ID and their archive listings.
 * @param version - Exact canonical desktop installer version.
 * @param channel - Requested update channel.
 * @param sourceSha - Full commit shared by every packaging run.
 * @returns The verified archive identities in canonical platform order.
 */
export function planHostedDesktopRelease(
  workflow: unknown, sources: readonly HostedDesktopReleaseSource[], version: string, channel: Channel, sourceSha: string,
): HostedDesktopReleasePlan {
  const parsed = parse(version)
  if (parsed === null || parsed.version !== version || parsed.build.length !== 0
    || (channel !== 'nightly' && channel !== 'latest') || (channel === 'latest' && parsed.prerelease.length !== 0)
    || !/^[a-f0-9]{40}$/u.test(sourceSha)) {
    throw new Error('desktop publish: provide a canonical Desktop version, channel, and full source commit')
  }
  validateRunIds(sources.map(source => source.runId))
  const byTarget = new Map<ReleaseTarget, HostedDesktopReleaseArchive>()
  const artifactIds = new Set<string>()
  for (const { runId, run, archiveList } of sources) {
    if (!isRecord(run) || typeof run.id !== 'number' || !Number.isSafeInteger(run.id) || String(run.id) !== runId) {
      throw new Error(`desktop publish: unexpected response for packaging run ${runId}`)
    }
    const packageRun = verifyHostedPackageRun(workflow, run, version, channel)
    if (packageRun.sourceSha !== sourceSha) throw new Error(`desktop publish: packaging run ${runId} did not use ${sourceSha}`)
    if (!isRecord(archiveList) || !Array.isArray(archiveList.artifacts) || archiveList.total_count !== packageRun.artifacts.length
      || archiveList.artifacts.length !== packageRun.artifacts.length) {
      throw new Error(`desktop publish: packaging run ${runId} must contain exactly ${packageRun.artifacts.join(', ')}`)
    }
    const records: unknown[] = archiveList.artifacts
    for (const name of packageRun.artifacts) {
      const archive = readHostedArchive(records.find(record => isRecord(record) && record.name === name), name, runId, sourceSha)
      if (byTarget.has(archive.target) || artifactIds.has(archive.artifactId)) {
        throw new Error(`desktop publish: overlapping or duplicate packaging archive ${name}`)
      }
      byTarget.set(archive.target, archive)
      artifactIds.add(archive.artifactId)
    }
  }
  const completeMac = byTarget.has('mac') ? byTarget.size === 2 : byTarget.has('mac-arm64') && byTarget.has('mac-x64')
  if (!byTarget.has('win-x64') || !completeMac) {
    throw new Error('desktop publish: use one all run or combine Windows x64 with both macOS architectures exactly once')
  }
  const archives = releaseTargets.flatMap((target) => {
    const archive = byTarget.get(target)
    return archive === undefined ? [] : [archive]
  })
  return { version, channel, sourceSha, archives }
}

/**
 * Stage regular files from separate artifact directories without overwriting a basename.
 * @param downloads - Directories produced by the trusted packaging run.
 * @param destination - New flattened directory for the release publisher.
 * @returns When every asset has been copied.
 */
export async function stageHostedPackageAssets(downloads: readonly string[], destination: string): Promise<void> {
  const sources = new Map<string, { readonly name: string; readonly source: string }>()
  for (const directory of downloads) {
    if (!(await lstat(directory)).isDirectory()) throw new Error(`desktop publish: invalid packaging artifact directory ${directory}`)
    const entries = await readdir(directory, { withFileTypes: true })
    if (entries.length === 0) throw new Error(`desktop publish: empty packaging artifact ${directory}`)
    for (const entry of entries) {
      if (!entry.isFile()) throw new Error(`desktop publish: expected a regular asset file ${join(directory, entry.name)}`)
      const key = entry.name.toLowerCase()
      const source = join(directory, entry.name)
      const previous = sources.get(key)
      if (previous !== undefined) throw new Error(`desktop publish: duplicate asset ${entry.name} in ${previous.source} and ${source}`)
      sources.set(key, { name: entry.name, source })
    }
  }
  if (sources.size === 0) throw new Error('desktop publish: no packaged assets to stage')
  await mkdir(destination)
  for (const { name, source } of sources.values()) {
    await copyFile(source, join(destination, name), constants.COPYFILE_EXCL)
  }
}

async function githubRecord(endpoint: string): Promise<unknown> {
  const { stdout } = await runGitHub('gh', ['api', `repos/${productRepository}/${endpoint}`])
  return JSON.parse(stdout)
}

async function resolveReleasePlan(args: readonly string[]): Promise<void> {
  const [ids, version, channel, sourceSha, destination, ...extra] = args
  const output = process.env.GITHUB_OUTPUT
  if (ids === undefined || version === undefined || (channel !== 'latest' && channel !== 'nightly') || sourceSha === undefined
    || destination === undefined || !isAbsolute(destination) || extra.length !== 0 || output === undefined
    || !isProductRepository(process.env.GITHUB_REPOSITORY)) {
    throw new Error('desktop publish: resolve <run IDs> <version> <channel> <source SHA> <absolute plan path>')
  }
  const runIds = ids.split(',').map(id => id.trim())
  validateRunIds(runIds)
  const [workflow, sources] = await Promise.all([
    githubRecord(`actions/workflows/${packageWorkflow}`),
    Promise.all(runIds.map(async (runId) => {
      const [run, archiveList] = await Promise.all([
        githubRecord(`actions/runs/${runId}`),
        githubRecord(`actions/runs/${runId}/artifacts?per_page=100`),
      ])
      return { runId, run, archiveList }
    })),
  ])
  const plan = planHostedDesktopRelease(workflow, sources, version, channel, sourceSha)
  await Promise.all(plan.archives.map(async (archive) => {
    const current = readHostedArchive(await githubRecord(`actions/artifacts/${archive.artifactId}`),
      archive.name, archive.runId, plan.sourceSha)
    if (current.artifactId !== archive.artifactId || current.digest !== archive.digest || current.size !== archive.size) {
      throw new Error(`desktop publish: ${archive.name} archive changed while resolving the plan`)
    }
  }))
  await writeFile(destination, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' })
  const values = plan.archives.map(({ target, runId, artifactId }) => {
    const key = target === 'win-x64' ? 'windows' : target.replaceAll('-', '_')
    return `${key}_run=${runId}\n${key}_artifact=${artifactId}\n`
  })
  await appendFile(output, values.join(''))
}

async function main(): Promise<void> {
  const [runId, version, channel] = process.argv.slice(2)
  const output = process.env.GITHUB_OUTPUT
  if (runId === undefined || !/^[1-9][0-9]*$/u.test(runId) || version === undefined
    || (channel !== 'latest' && channel !== 'nightly') || output === undefined
    || !isProductRepository(process.env.GITHUB_REPOSITORY)) {
    throw new Error(`desktop publish: a numeric packaging run ID, version, and channel are required in ${productRepository}`)
  }
  const [workflow, run] = await Promise.all([
    githubRecord(`actions/workflows/${packageWorkflow}`),
    githubRecord(`actions/runs/${runId}`),
  ])
  const { artifacts, sourceSha, target } = verifyHostedPackageRun(workflow, run, version, channel)
  const root = await mkdtemp(join(tmpdir(), 'agentrans-desktop-release-'))
  const downloads = await Promise.all(artifacts.map(async (artifact) => {
    const directory = join(root, artifact)
    await runGitHub('gh', ['run', 'download', runId, '--repo', productRepository, '--name', artifact, '--dir', directory])
    return directory
  }))
  const destination = join(root, 'assets')
  await stageHostedPackageAssets(downloads, destination)
  await appendFile(output, `source_sha=${sourceSha}\npackage_target=${target}\nassets_dir=${destination}\n`)
}

if (import.meta.main) {
  if (process.argv[2] === 'resolve') await resolveReleasePlan(process.argv.slice(3))
  else await main()
}
