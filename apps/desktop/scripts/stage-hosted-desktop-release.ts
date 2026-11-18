/** Verify a hosted packaging run and stage its assets before the signing step. */

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { appendFile, copyFile, lstat, mkdir, mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
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

if (import.meta.main) await main()
