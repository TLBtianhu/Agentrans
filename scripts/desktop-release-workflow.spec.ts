import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { expect, it, onTestFinished } from 'vitest'
import { DESKTOP_UPDATE_REPOSITORY } from '../apps/desktop/scripts/desktop-release-environment.mjs'
import { stageHostedPackageAssets, verifyHostedPackageRun } from '../apps/desktop/scripts/stage-hosted-desktop-release.ts'

interface Workflow {
  'run-name'?: string
  on: Record<string, unknown>
  permissions: Record<string, string>
  concurrency?: Record<string, string | boolean>
  jobs: Record<string, {
    'runs-on': string
    env?: Record<string, string>
    steps: Array<{
      id?: string
      name?: string
      uses?: string
      run?: string
      shell?: string
      env?: Record<string, string>
      with?: Record<string, string>
    }>
  }>
}

function readWorkflow(name: string): Workflow {
  return yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows', name), 'utf8')) as Workflow
}

const workflow = readWorkflow('desktop-release.yml')
const hosted = readWorkflow('agentrans-hosted-package.yml')

it('stages only a dispatched packaging run and names the version it carries', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  expect(workflow.on.workflow_dispatch).toMatchObject({ inputs: {
    package_run_id: { type: 'string', required: true },
    version: { type: 'string', required: true },
    channel: { type: 'choice', required: true, options: ['nightly', 'latest'] },
  } })
})

it('uses contents write for drafts and actions read for artifacts', () => {
  expect(workflow.permissions).toEqual({ contents: 'write', actions: 'read' })
})

it('serializes draft runs for the same release version', () => {
  expect(workflow.concurrency).toEqual({ group: 'agentrans-desktop-release-${{ inputs.version }}', 'cancel-in-progress': false })
})

it('stages verified assets before signing, then forwards the checked target and source commit', () => {
  const { env, steps } = workflow.jobs.publish!
  expect(env).toEqual({ PACKAGE_RUN_ID: '${{ inputs.package_run_id }}', PACKAGE_VERSION: '${{ inputs.version }}', PACKAGE_CHANNEL: '${{ inputs.channel }}' })
  const stage = steps.find(step => step.id === 'package')!
  const publish = steps.find(step => step.name === 'Sign and stage the Desktop draft')!
  expect(steps.indexOf(stage)).toBeLessThan(steps.indexOf(publish))
  expect(stage.run).toBe('node --import tsx apps/desktop/scripts/stage-hosted-desktop-release.ts "$PACKAGE_RUN_ID" "$PACKAGE_VERSION" "$PACKAGE_CHANNEL"')
  expect(stage.env).toEqual({ GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' })
  expect(publish.env).toEqual({
    GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    AGENTRANS_UPDATE_SIGNING_KEY: '${{ secrets.AGENTRANS_UPDATE_SIGNING_KEY }}',
    AGENTRANS_DESKTOP_PACKAGE_SHA: '${{ steps.package.outputs.source_sha }}',
    AGENTRANS_DESKTOP_PACKAGE_TARGET: '${{ steps.package.outputs.package_target }}',
    PACKAGE_ASSETS_DIR: '${{ steps.package.outputs.assets_dir }}',
  })
})

it('always stages the verified release as a draft', () => {
  expect(workflow.on.workflow_dispatch).not.toHaveProperty('inputs.draft_only')
  const upload = workflow.jobs.publish!.steps.find(step => step.name === 'Sign and stage the Desktop draft')!
  expect(upload.shell).toBe('bash')
  expect(upload.run).toBe('node --import tsx apps/desktop/scripts/publish-github-release.ts "$PACKAGE_ASSETS_DIR" "$PACKAGE_VERSION" "$PACKAGE_CHANNEL" --draft-only')
})

it('records the hosted run intent and uploads only packaged files at the artifact root', () => {
  const job = hosted.jobs.package!
  expect(hosted['run-name']).toBe('Package Agentrans · ${{ inputs.target }} · ${{ inputs.channel }} · ${{ inputs.version }}')
  const upload = job.steps.find(step => step.name === 'Publish the packaged files for this run')
  expect(upload?.with?.name).toBe('agentrans-${{ matrix.target }}')
  expect(upload?.with?.path?.trim().split('\n')).toEqual([
    ...['exe', 'dmg', 'zip', 'blockmap', 'yml'].map(extension => `apps/desktop/artifacts/agentrans-installer/*.${extension}`),
    '!apps/desktop/artifacts/agentrans-installer/builder-debug.yml',
  ])
  expect(job.env?.AGENTRANS_DESKTOP_BUILD_VERSION).toBe('${{ inputs.version }}')
  expect(job.env?.AGENTRANS_DESKTOP_UPDATE_CHANNEL).toBe('${{ inputs.channel }}')
  expect(job.steps.some(step => step.run?.includes('${{ inputs.version }}'))).toBe(false)
})

it('leaves installer building, operating system signing, and notarization to packaging', () => {
  const commands = workflow.jobs.publish!.steps.flatMap(step => step.run === undefined ? [] : [step.run])
  for (const command of commands) expect(command).not.toMatch(/package-target|signtool|codesign|notarytool|notarize/u)
})

const repository = { full_name: `${DESKTOP_UPDATE_REPOSITORY.owner}/${DESKTOP_UPDATE_REPOSITORY.repo}` }
const packaging = { id: 321, path: '.github/workflows/agentrans-hosted-package.yml' }
const packageRun = {
  workflow_id: packaging.id,
  repository,
  head_repository: repository,
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  head_sha: '0123456789abcdef0123456789abcdef01234567',
  display_title: 'Package Agentrans · all · latest · 0.1.0',
}

it.each([
  ['all', ['agentrans-win-x64', 'agentrans-mac']],
  ['win-x64', ['agentrans-win-x64']],
  ['mac', ['agentrans-mac']],
  ['mac-arm64', ['agentrans-mac-arm64']],
  ['mac-x64', ['agentrans-mac-x64']],
] as const)('verifies the %s run and requires each requested artifact', (target, artifacts) => {
  const title = hosted['run-name']!.replace('${{ inputs.target }}', target).replace('${{ inputs.channel }}', 'latest')
    .replace('${{ inputs.version }}', '0.1.0')
  expect(verifyHostedPackageRun(packaging, { ...packageRun, display_title: title }, '0.1.0', 'latest'))
    .toEqual({ target, sourceSha: packageRun.head_sha, artifacts })
})

it.each([
  { workflow_id: 999 },
  { repository: { full_name: 'another-org/Agentrans' } },
  { head_repository: { full_name: 'another-org/Agentrans' } },
  { event: 'pull_request' },
  { status: 'in_progress' },
  { conclusion: 'failure' },
  { head_sha: 'main' },
])('rejects an ineligible packaging run with %j', (patch) => {
  expect(() => verifyHostedPackageRun(packaging, { ...packageRun, ...patch }, '0.1.0', 'latest'))
    .toThrow('select a successful hosted packaging run')
})

it.each([
  'Package Agentrans · hosted',
  'Package Agentrans · all · nightly · 0.1.0',
  'Package Agentrans · all · latest · 0.1.1',
  'Package Agentrans · unknown · latest · 0.1.0',
])('requires matching recorded publishing inputs in %s', (display_title) => {
  expect(() => verifyHostedPackageRun(packaging, { ...packageRun, display_title }, '0.1.0', 'latest'))
    .toThrow('repackage with matching inputs')
})

async function stagingRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentrans-stage-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

it('stages files from each target without changing their contents', async () => {
  const root = await stagingRoot()
  const windows = join(root, 'windows')
  const mac = join(root, 'mac')
  const destination = join(root, 'assets')
  await Promise.all([mkdir(windows), mkdir(mac)])
  await Promise.all([writeFile(join(windows, 'latest.yml'), 'windows feed'), writeFile(join(mac, 'latest-mac.yml'), 'mac feed')])
  await stageHostedPackageAssets([windows, mac], destination)
  expect((await readdir(destination)).sort()).toEqual(['latest-mac.yml', 'latest.yml'])
  expect(await readFile(join(destination, 'latest.yml'), 'utf8')).toBe('windows feed')
  expect(await readFile(join(destination, 'latest-mac.yml'), 'utf8')).toBe('mac feed')
})

it('rejects a basename collision before creating the flattened directory', async () => {
  const root = await stagingRoot()
  const first = join(root, 'first')
  const second = join(root, 'second')
  const destination = join(root, 'assets')
  await Promise.all([mkdir(first), mkdir(second)])
  await Promise.all([writeFile(join(first, 'latest.yml'), 'one feed'), writeFile(join(second, 'latest.yml'), 'a different feed')])
  await expect(stageHostedPackageAssets([first, second], destination)).rejects.toThrow('duplicate asset latest.yml')
  expect((await readdir(root)).sort()).toEqual(['first', 'second'])
})

it('requires files in every requested artifact directory', async () => {
  const root = await stagingRoot()
  const empty = join(root, 'empty')
  const nested = join(root, 'nested')
  const destination = join(root, 'assets')
  await Promise.all([mkdir(empty), mkdir(join(nested, 'unpacked'), { recursive: true })])
  await expect(stageHostedPackageAssets([empty], destination)).rejects.toThrow('empty packaging artifact')
  await expect(stageHostedPackageAssets([nested], destination)).rejects.toThrow('expected a regular asset file')
})
