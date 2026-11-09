import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { desktopCiArtifactDirectory, retainDesktopCi } from '../scripts/retain-desktop-ci.ts'

const roots: string[] = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-retain-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('CI package retention', () => {
  it('selects the artifact directory matching the produced qualification', () => {
    expect(desktopCiArtifactDirectory('win-x64', 'unsigned')).toMatch(/unsigned-artifacts$/u)
    expect(desktopCiArtifactDirectory('mac-arm64', 'unnotarized')).toMatch(/unnotarized-artifacts$/u)
    expect(desktopCiArtifactDirectory('mac-arm64', 'notarized')).toMatch(/[\\/]artifacts$/u)
  })

  it('rejects an empty artifact directory instead of reporting a successful retention', async () => {
    const root = await fixture()
    await mkdir(join(root, 'targets', 'win-x64', 'unsigned-artifacts'), { recursive: true })
    await expect(retainDesktopCi({
      DSH_DESKTOP_TARGET: 'win-x64', PACKAGE_SIGNING: 'unsigned', DSH_DESKTOP_PACKAGE_CACHE_DIR: root, RUNNER_TEMP: root,
    }, { artifacts: join(root, 'targets', 'win-x64', 'unsigned-artifacts'), retained: join(root, 'retained') })).rejects.toThrow(/contains no artifacts/u)
  })

  it('copies every artifact outside the checkout and reports the directory to the workflow', async () => {
    const root = await fixture()
    const artifacts = join(root, 'targets', 'win-x64', 'artifacts')
    await mkdir(artifacts, { recursive: true })
    await writeFile(join(artifacts, 'installer.exe'), 'signed content')
    await writeFile(join(artifacts, 'latest.yml'), 'version: 1.2.3')
    const output = join(root, 'github-output')
    await writeFile(output, '')
    const summary = join(root, 'summary')
    await writeFile(summary, '')
    const retained = await retainDesktopCi({
      DSH_DESKTOP_TARGET: 'win-x64',
      PACKAGE_SIGNING: 'signed',
      DSH_DESKTOP_PACKAGE_CACHE_DIR: root,
      RUNNER_TEMP: join(root, 'runner-temp'),
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
    }, { artifacts, retained: join(root, 'retained') })
    expect(await readFile(join(retained, 'installer.exe'), 'utf8')).toBe('signed content')
    expect(await readFile(join(retained, 'latest.yml'), 'utf8')).toBe('version: 1.2.3')
    expect(await readFile(output, 'utf8')).toBe(`directory=${retained}\n`)
    expect(await readFile(summary, 'utf8')).toContain('Publish with publish-github-release')
  })
})
