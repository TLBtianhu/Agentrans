import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { completeLockedDeploy, lockedDeployArgs } from './executable-packaging.ts'
import { materializeStagedLinks } from './build-exe-for-python-sdk-staging.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-exe-deploy-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const staging = join(root, 'staging')
  await mkdir(source)
  await mkdir(join(staging, 'node_modules'), { recursive: true })
  return { root, source, staging, modules: join(staging, 'node_modules') }
}

async function lockedDeploy(postinstall = 'node scripts/mark.mjs') {
  const test = await fixture()
  const workspace = test.root
  const setup = join(test.modules, '@fixture/setup')
  await mkdir(join(setup, 'scripts'), { recursive: true })
  await writeFile(join(workspace, 'pnpm-workspace.yaml'), "allowBuilds:\n  '@fixture/setup@file:packages/setup': true\n  other: true\n")
  await writeFile(join(test.staging, 'package.json'), JSON.stringify({ dependencies: { '@fixture/setup': 'workspace:*' } }))
  await writeFile(join(setup, 'package.json'), JSON.stringify({ name: '@fixture/setup', scripts: { postinstall } }))
  await writeFile(join(setup, 'scripts/mark.mjs'), "import { writeFileSync } from 'node:fs'\nwriteFileSync('ran', process.cwd())\n")
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) await writeFile(join(test.staging, file), 'lockfileVersion: 9.0\n')
  const identity = (directory: string) => `@fixture/setup@${pathToFileURL(join(workspace, directory)).href}`
  const ignore = (builds: string[]) => writeFile(join(test.modules, '.modules.yaml'), JSON.stringify({ ignoredBuilds: builds }))
  await ignore([identity('packages/setup')])
  return { ...test, workspace, setup, identity, ignore }
}

it('runs a reviewed workspace build script the locked deploy skipped and drops the deploy lock files', async () => {
  const test = await lockedDeploy()
  expect(await completeLockedDeploy(test.staging, test.workspace)).toEqual(['@fixture/setup'])
  expect(await readFile(join(test.setup, 'ran'), 'utf8')).toBe(test.setup)
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) expect(existsSync(join(test.staging, file))).toBe(false)
})

it('rejects skipped builds outside the workspace review, unsafe scripts, and missing direct dependencies', async () => {
  const test = await lockedDeploy()
  await test.ignore([test.identity('packages/elsewhere')])
  await expect(completeLockedDeploy(test.staging, test.workspace)).rejects.toThrow('unreviewed build scripts')
  await test.ignore(['other@1.0.0'])
  await expect(completeLockedDeploy(test.staging, test.workspace)).rejects.toThrow('unreviewed build scripts: other@1.0.0')
  expect(existsSync(join(test.setup, 'ran'))).toBe(false)
  const unsafe = await lockedDeploy('node scripts/mark.mjs && echo done')
  await expect(completeLockedDeploy(unsafe.staging, unsafe.workspace)).rejects.toThrow('must be "node <script>"')
  await writeFile(join(test.staging, 'package.json'), JSON.stringify({ dependencies: { absent: '1.0.0' } }))
  await expect(completeLockedDeploy(test.staging, test.workspace)).rejects.toThrow('omitted direct dependencies: absent')
})

it('builds pnpm arguments that reuse the shared lock instead of a legacy resolution', () => {
  expect(lockedDeployArgs('closure', 'out')).toEqual(['--filter', 'closure', 'deploy', '--prod',
    '--config.inject-workspace-packages=true', '--config.node-linker=hoisted', '--config.package-import-method=copy',
    '--config.strict-dep-builds=false', 'out'])
})

it('materializes a package junction without deleting its source and drops linked command directories', async () => {
  const test = await fixture()
  await mkdir(join(test.source, 'peer'))
  await writeFile(join(test.source, 'peer/index.js'), 'intact')
  await symlink(join(test.source, 'peer'), join(test.modules, 'peer'), 'junction')
  await symlink(join(test.source, 'peer'), join(test.modules, '.bin'), 'junction')
  await materializeStagedLinks(test.staging)
  expect((await lstat(join(test.modules, 'peer'))).isSymbolicLink()).toBe(false)
  expect(await readFile(join(test.modules, 'peer/index.js'), 'utf8')).toBe('intact')
  expect(await readFile(join(test.source, 'peer/index.js'), 'utf8')).toBe('intact')
  await expect(lstat(join(test.modules, '.bin'))).rejects.toThrow('ENOENT')
})
