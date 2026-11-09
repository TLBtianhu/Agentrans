import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'

const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/desktop-release.yml'), 'utf8')) as {
  on: Record<string, unknown>
  permissions: Record<string, string>
  jobs: Record<string, {
    'runs-on': string
    steps: Array<{ name?: string; uses?: string; run?: string; env?: Record<string, string> }>
  }>
}

it('publishes only a dispatched packaging run and names the version it carries', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  expect(workflow.on.workflow_dispatch).toMatchObject({ inputs: {
    package_run_id: { type: 'string', required: true },
    version: { type: 'string', required: true },
    channel: { type: 'choice', required: true, options: ['nightly', 'latest'] },
  } })
})

it('writes releases and reads the artifacts it was told to publish', () => {
  expect(workflow.permissions).toEqual({ contents: 'write', actions: 'read' })
})

it('flattens the packaging run into one directory before publishing it', () => {
  const steps = workflow.jobs.publish!.steps
  const download = steps.find(step => step.name === 'Download packaged artifacts')
  expect(download?.run).toContain('gh run download "${{ inputs.package_run_id }}"')
  expect(download?.run).toContain('find .desktop-download -mindepth 2 -maxdepth 2 -type f')
  expect(download?.env?.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}')
})

it('attaches the flattened assets through the uploader that owns the tag and channel', () => {
  const publish = workflow.jobs.publish!.steps.find(step => step.name === 'Attach the assets to the release')
  expect(publish?.run).toBe('node --import tsx apps/desktop/scripts/publish-github-release.ts .desktop-assets "${{ inputs.version }}" "${{ inputs.channel }}"')
  expect(publish?.env?.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}')
})

it('builds, signs, and notarizes nothing: packaging owns those steps', () => {
  const commands = workflow.jobs.publish!.steps.flatMap(step => step.run === undefined ? [] : [step.run])
  for (const command of commands) expect(command).not.toMatch(/package-target|signtool|codesign|notarytool|notarize/u)
})
