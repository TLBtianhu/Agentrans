import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'

interface Step {
  name?: string
  uses?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, string>
}

interface Job {
  'runs-on': string
  if?: string
  needs?: string
  permissions?: Record<string, string>
  steps: Step[]
}

const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/desktop-release.yml'), 'utf8')) as {
  on: {
    workflow_dispatch: { inputs: Record<string, Record<string, unknown>> }
    workflow_call: { inputs: Record<string, Record<string, unknown>>; secrets: Record<string, unknown> }
  }
  permissions: Record<string, string>
  jobs: Record<string, Job>
}

const RELEASE_INPUTS = ['package_run_ids', 'source_sha', 'version', 'channel', 'operation']

function steps(job: string): Step[] {
  const found = workflow.jobs[job]
  if (found === undefined) throw new Error(`desktop-release.yml has no ${job} job`)
  return found.steps
}

it('runs only on demand or from the packaging workflow, with the same release inputs', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch', 'workflow_call'])
  expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(RELEASE_INPUTS)
  expect(Object.keys(workflow.on.workflow_call.inputs)).toEqual(RELEASE_INPUTS)
  expect(workflow.on.workflow_dispatch.inputs.channel).toMatchObject({ type: 'choice', required: true, options: ['nightly', 'latest'] })
  expect(workflow.on.workflow_dispatch.inputs.operation).toMatchObject({
    type: 'choice', options: ['preflight', 'review', 'stage-draft'], default: 'preflight',
  })
  expect(workflow.on.workflow_call.inputs.operation).toMatchObject({ default: 'preflight' })
  expect(workflow.on.workflow_call.secrets).toEqual({ AGENTRANS_UPDATE_SIGNING_KEY: { required: true } })
})

it('grants nothing by default and writes releases only while staging a draft after a preflight', () => {
  expect(workflow.permissions).toEqual({})
  expect(workflow.jobs.preflight?.permissions).toEqual({ actions: 'read', contents: 'read' })
  expect(workflow.jobs['stage-draft']).toMatchObject({
    if: "inputs.operation == 'stage-draft'",
    needs: 'preflight',
    permissions: { actions: 'read', contents: 'write' },
  })
})

it('reads the exact packaged build through the shared input action in both jobs', () => {
  for (const job of ['preflight', 'stage-draft']) {
    expect(steps(job).find(step => step.name === 'Download the exact three-platform build')).toMatchObject({
      uses: './.github/actions/desktop-release-inputs',
      with: {
        package_run_ids: '${{ inputs.package_run_ids }}',
        version: '${{ inputs.version }}',
        channel: '${{ inputs.channel }}',
        source_sha: '${{ inputs.source_sha }}',
      },
    })
  }
})

it('stages a draft only from the report and signatures its preflight retained', () => {
  const retained = steps('preflight').find(step => step.name === 'Retain the preflight report and detached signatures')
  expect(retained).toMatchObject({ uses: 'actions/upload-artifact@v7.0.1', with: { 'if-no-files-found': 'error' } })
  const proof = steps('stage-draft').find(step => step.name === 'Download the successful preflight report and signatures')
  expect(proof).toMatchObject({
    uses: 'actions/download-artifact@v8.0.1',
    with: { 'artifact-ids': '${{ needs.preflight.outputs.proof_id }}', 'digest-mismatch': 'error' },
  })
  const stage = steps('stage-draft').find(step => step.name === 'Verify the signed bytes, stage the draft and review its inventory')
  expect(stage?.run).toContain('apps/desktop/scripts/prepare-desktop-release.ts stage-draft')
  expect(stage?.env?.GH_TOKEN).toBe('${{ github.token }}')
})

it('builds, signs, and notarizes no platform package: packaging owns those steps', () => {
  const commands = Object.keys(workflow.jobs).flatMap(job => steps(job).flatMap(step => step.run === undefined ? [] : [step.run]))
  expect(commands.length).toBeGreaterThan(0)
  for (const command of commands) expect(command).not.toMatch(/package-target|signtool|codesign|notarytool|notarize/u)
})
