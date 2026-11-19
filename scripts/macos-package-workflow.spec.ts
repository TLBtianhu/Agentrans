import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  readonly id?: string
  readonly name?: string
  readonly if?: string
  readonly uses?: string
  readonly run?: string
  readonly env?: Record<string, string>
  readonly with?: Record<string, unknown>
}

interface Job {
  readonly 'runs-on': string | string[]
  readonly name?: string
  readonly if?: string
  readonly uses?: string
  readonly needs?: string
  readonly environment?: string
  readonly outputs?: Record<string, string>
  readonly env: Record<string, string>
  readonly steps: Step[]
  readonly with?: Record<string, unknown>
}

interface Workflow {
  readonly on: Record<string, unknown>
  readonly permissions: Record<string, string>
  readonly concurrency: { group: string; 'cancel-in-progress': boolean }
  readonly jobs: Record<string, Job>
}

function readWorkflow(filename: string): Workflow {
  return yaml.load(readFileSync(resolve(import.meta.dirname, `../.github/workflows/${filename}`), 'utf8')) as Workflow
}

describe.each(['arm64', 'x64'])('macOS %s packaging', (arch) => {
  const filename = arch === 'arm64' ? 'macos-package.yml' : 'macos-intel-package.yml'
  const workflow = readWorkflow(filename)

  it('keeps the dedicated Apple Silicon route as the manual default', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    expect(workflow.jobs.package).not.toHaveProperty('name')
    expect(workflow.on.workflow_dispatch).toMatchObject({ inputs: {
      test_release_id: { type: 'string', default: '', required: false },
      runner_mode: { type: 'choice', options: ['self-hosted', 'hosted-check', 'hosted-sign'], default: 'self-hosted' },
      source_sha: { type: 'string', default: '', required: false },
    } })
    expect(workflow.on.workflow_dispatch).not.toHaveProperty('inputs.publish')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency).toEqual({
      group: `\${{ inputs.runner_mode == 'self-hosted' && 'macos-desktop-package' || 'macos-hosted-${arch}' }}`,
      'cancel-in-progress': false,
    })
    expect(workflow.jobs.package?.if).toBe("inputs.runner_mode == 'self-hosted'")
    expect(workflow.jobs.package!['runs-on']).toEqual(['self-hosted', 'macOS', 'ARM64', 'dsh-mac-package-trial'])
    const steps = workflow.jobs.package!.steps
    expect(steps.find(step => step.id === 'checkout')?.with).toMatchObject({ 'persist-credentials': false, clean: true })
    for (const step of steps) expect(step.run ?? '').not.toContain('${{ inputs.')
    const uploads = steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'))
    expect(uploads).toHaveLength(2)
    expect(uploads[0]?.if).toBe("always() && steps.checkout.outcome == 'success'")
    expect(uploads[1]?.if).toBe('success()')
    expect(uploads[1]?.with?.path).toBe('${{ steps.retained_production.outputs.directory || steps.retained.outputs.directory }}/*')
    expect(uploads[1]?.with?.['compression-level']).toBe(0)
  })

  it('defaults to notarization and labels the explicit debugging option', () => {
    expect(workflow.on.workflow_dispatch).toMatchObject({ inputs: { skip_notarization: {
      type: 'boolean', default: false,
      description: '跳过公证和 stapling：仅限内部调试，禁止发布到 test / production 或用于自动更新；需要发布请勿勾选',
    } } })
    const steps = workflow.jobs.package!.steps
    expect(steps.filter(step => step.run?.includes('args+=(--skip-notarization)'))).toHaveLength(2)
    expect(steps.find(step => step.name === 'Retain installers for the selected mode')?.with?.name).toContain('${{ steps.settings.outputs.mode }}')
  })

  it('retains build inputs outside checkout and run-specific pnpm installations', () => {
    const env = workflow.jobs.package!.env
    expect(JSON.stringify(env)).not.toContain('runner.')
    const steps = workflow.jobs.package!.steps
    const cache = steps.find(step => step.name === 'Configure persistent package caches')!
    expect(cache.env?.AGENTRANS_DESKTOP_PACKAGE_CACHE_DIR).toBe('${{ runner.tool_cache }}/dsh-desktop-package-cache')
    expect(cache.run).toContain('PNPM_CONFIG_STORE_DIR=$AGENTRANS_DESKTOP_PACKAGE_CACHE_DIR/workspace-pnpm-store')
    expect(cache.run).toContain('AGENTRANS_DESKTOP_PACKAGE_CACHE_DIR=$AGENTRANS_DESKTOP_PACKAGE_CACHE_DIR')
    expect(steps.indexOf(cache)).toBeLessThan(steps.findIndex(step => step.name === 'Install locked dependencies'))
  })

  it('offers ZIP compression choices with a fast default', () => {
    expect(workflow.on.workflow_dispatch).toMatchObject({ inputs: { compression_level: {
      type: 'choice', options: ['3', '7'], default: '3', required: true,
    } } })
    expect(workflow.jobs.package!.env.PACKAGE_MACOS_ZIP_COMPRESSION_LEVEL).toBe('${{ inputs.compression_level }}')
  })

  it('passes the same target to preparation, packaging and retention', () => {
    const job = workflow.jobs.package!
    expect(job.env.AGENTRANS_DESKTOP_TARGET_PLATFORM).toBe('darwin')
    expect(job.env.AGENTRANS_DESKTOP_TARGET_ARCH).toBe(arch)
    const builds = job.steps.filter(step => step.run?.includes('pnpm run package:desktop:mac:'))
    expect(builds).toHaveLength(2)
    for (const step of builds) expect(step.run).toContain(`package:desktop:mac:${arch}`)
    expect(job.steps.find(step => step.name === 'Retain installers for the selected mode')?.with?.name).toContain(`macos-${arch}-`)
    if (arch === 'x64') {
      const rosetta = job.steps.findIndex(step => step.run === 'arch -x86_64 /usr/bin/true')
      expect(rosetta).toBeGreaterThan(-1)
      expect(rosetta).toBeLessThan(job.steps.findIndex(step => step.name === 'Install locked dependencies'))
    }
  })

  it('dispatches the no-credential hosted check at the selected commit without passing secrets', () => {
    expect(workflow.jobs.hosted).toMatchObject({
      if: "inputs.runner_mode == 'hosted-check' || inputs.runner_mode == 'hosted-sign'",
      uses: './.github/workflows/macos-hosted-package.yml',
      with: {
        arch,
        runner_mode: '${{ inputs.runner_mode }}',
        source_ref: '${{ inputs.source_ref }}',
        source_sha: '${{ inputs.source_sha }}',
        skip_notarization: '${{ inputs.skip_notarization }}',
      },
    })
    expect(workflow.jobs.hosted).not.toHaveProperty('environment')
    expect(workflow.jobs.hosted).not.toHaveProperty('secrets')
  })

  it('requires the approved signing environment, checked version and authenticated source on the native runner', () => {
    const job = workflow.jobs.hosted_sign!
    expect(job).toMatchObject({
      needs: 'hosted',
      'runs-on': arch === 'arm64' ? 'macos-26' : 'macos-26-intel',
      environment: 'macos-production-signing',
      env: {
        AGENTRANS_DESKTOP_TARGET_ARCH: arch,
        AGENTRANS_PACKAGING_PRESET: 'production',
        PACKAGE_SKIP_NOTARIZATION: 'false',
        PACKAGE_SOURCE_REF: 'main',
        PACKAGE_SOURCE_SHA: '${{ inputs.source_sha }}',
        PACKAGE_VERSION_MODE: 'manual',
        PACKAGE_BUILD_VERSION: '${{ needs.hosted.outputs.version }}',
      },
    })
    for (const guard of [
      "inputs.runner_mode == 'hosted-sign'",
      "github.event_name == 'workflow_dispatch'",
      "github.ref == 'refs/heads/main'",
      "inputs.source_ref == 'main'",
      'inputs.source_sha == github.sha',
      "inputs.preset == 'production'",
      "inputs.version_mode != 'auto'",
      '!inputs.skip_notarization',
      "inputs.test_release_id == ''",
    ]) expect(job.if).toContain(guard)
    expect(job).not.toHaveProperty('permissions')
    expect(job.steps[0]?.with).toMatchObject({ ref: '${{ github.sha }}', 'persist-credentials': false })
    expect(job.steps[1]?.run).toContain('[[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]]')
  })

  it('stages Apple credentials in one step and removes them before retaining the signed package', () => {
    const { steps } = workflow.jobs.hosted_sign!
    const credentialSteps = steps.filter(step => JSON.stringify(step).includes('${{ secrets.'))
    expect(credentialSteps).toHaveLength(1)
    const credentials = credentialSteps[0]!
    expect(credentials.run).toBe('node apps/desktop/scripts/prepare-hosted-macos-ci.mjs credentials')
    expect(credentials.env).toEqual({
      MACOS_DEVELOPER_ID_P12_BASE64: '${{ secrets.MACOS_DEVELOPER_ID_P12_BASE64 }}',
      MACOS_DEVELOPER_ID_P12_PASSWORD: '${{ secrets.MACOS_DEVELOPER_ID_P12_PASSWORD }}',
      MACOS_NOTARIZATION_KEY_P8_BASE64: '${{ secrets.MACOS_NOTARIZATION_KEY_P8_BASE64 }}',
      MACOS_NOTARIZATION_KEY_ID: '${{ secrets.MACOS_NOTARIZATION_KEY_ID }}',
      MACOS_NOTARIZATION_ISSUER_ID: '${{ secrets.MACOS_NOTARIZATION_ISSUER_ID }}',
      DESKTOP_MACOS_TEAM_ID: '${{ vars.DESKTOP_MACOS_TEAM_ID }}',
      DESKTOP_MACOS_SIGNING_IDENTITY: '${{ vars.DESKTOP_MACOS_SIGNING_IDENTITY }}',
    })
    expect(steps.map(step => step.run).join('\n')).not.toContain('gh release')
    const cleanup = steps.find(step => step.run?.endsWith('prepare-hosted-macos-ci.mjs cleanup'))
    expect(cleanup?.if).toBe("always() && steps.config.outcome == 'success'")
    const uploads = steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'))
    expect(uploads).toHaveLength(1)
    expect(steps.indexOf(cleanup!)).toBeLessThan(steps.indexOf(uploads[0]!))
    expect(uploads[0]?.with).toMatchObject({
      name: `macos-${arch}-signed-\${{ needs.hosted.outputs.version }}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
      path: '${{ steps.retained.outputs.directory }}/*',
      'if-no-files-found': 'error',
    })
  })
})

describe('reusable macOS hosted packaging check', () => {
  const workflow = readWorkflow('macos-hosted-package.yml')

  it('checks the exact commit on native runners and exports the selected build version', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_call'])
    expect(workflow.on.workflow_call).toMatchObject({
      outputs: { version: { value: '${{ jobs.check.outputs.version }}' } },
    })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(workflow.jobs)).toEqual(['check'])
    const { check } = workflow.jobs
    expect(check?.['runs-on']).toBe("${{ inputs.arch == 'arm64' && 'macos-26' || 'macos-26-intel' }}")
    expect(check?.outputs).toMatchObject({ version: '${{ steps.check_package.outputs.version }}' })
    expect(check?.steps.find(step => step.uses?.startsWith('actions/checkout@'))?.with).toMatchObject({
      ref: '${{ github.sha }}',
      'persist-credentials': false,
    })
    expect(check?.steps.find(step => step.id === 'check_package')?.run).toContain('--unsigned --check --build-version "$PACKAGE_VERSION"')
  })

  it('fails an ineligible signing dispatch before checkout and never uses signing secrets or uploads', () => {
    expect(workflow.on.workflow_call).not.toHaveProperty('secrets')
    const check = workflow.jobs.check!
    expect(check).not.toHaveProperty('environment')
    expect(JSON.stringify(workflow)).not.toContain('${{ secrets.')
    expect(check.steps.some(step => step.uses?.startsWith('actions/upload-artifact@'))).toBe(false)
    const validate = check.steps[0]?.run
    expect(validate).toContain('"$GITHUB_REF" != refs/heads/main')
    expect(validate).toContain('"$REQUESTED_SOURCE_SHA" != "$GITHUB_SHA"')
    expect(validate).toContain('"$PACKAGE_VERSION_MODE" == auto')
  })
})
