import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assertSingleWorkspaceCopies, materializeStagedLinks } from './build-exe-for-python-sdk-staging.ts'

const temporaryDirectories: string[] = []
const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir'

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(prefix: string) {
  const workspace = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(workspace)
  return workspace
}

/** List every symbolic link below a directory. */
async function listSymlinks(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) return [path]
    if (entry.isDirectory()) return listSymlinks(path)
    return []
  }))
  return nested.flat()
}

it('drops the deploy root link that points back into the payload', async () => {
  const workspace = await fixture('dsh-python-staging-root-')
  const project = join(workspace, 'python', 'sdk-runtime')
  const staging = join(project, 'src', 'runtime', 'node')
  await mkdir(join(staging, 'node_modules'), { recursive: true })
  await writeFile(join(project, 'package.json'), '{"name":"dsh-python-runtime-closure"}\n')
  await symlink(project, join(staging, 'node_modules', 'dsh-python-runtime-closure'), directoryLinkType)

  await materializeStagedLinks(staging)

  expect(existsSync(join(staging, 'node_modules', 'dsh-python-runtime-closure'))).toBe(false)
  await expect(readFile(join(project, 'package.json'), 'utf8')).resolves.toContain('dsh-python-runtime-closure')
})

it('copies workspace package links as files and removes command shims', async () => {
  const workspace = await fixture('dsh-python-staging-packages-')
  const staging = join(workspace, 'runtime', 'node')
  const packageDirectory = join(workspace, 'packages', 'dsh-base')
  await mkdir(join(packageDirectory, 'lib'), { recursive: true })
  await writeFile(join(packageDirectory, 'package.json'), '{"name":"@agentrans/base"}\n')
  await writeFile(join(packageDirectory, 'lib', 'index.js'), 'export {}\n')
  await mkdir(join(staging, 'node_modules', '@agentrans'), { recursive: true })
  await mkdir(join(staging, 'node_modules', '.bin'), { recursive: true })
  await writeFile(join(staging, 'package.json'), '{"name":"dsh-python-runtime-closure"}\n')
  await symlink(packageDirectory, join(staging, 'node_modules', '@agentrans', 'base'), directoryLinkType)
  await symlink(packageDirectory, join(staging, 'node_modules', '.bin', 'dsh'), directoryLinkType)

  await materializeStagedLinks(staging)

  expect(existsSync(join(staging, 'node_modules', '.bin'))).toBe(false)
  await expect(readFile(join(staging, 'node_modules', '@agentrans', 'base', 'lib', 'index.js'), 'utf8'))
    .resolves.toBe('export {}\n')
  expect(await listSymlinks(staging)).toEqual([])
})

it('accepts one staged copy of each workspace package beside repeated third-party copies', async () => {
  const staging = await fixture('dsh-python-staging-single-')
  const modules = join(staging, 'node_modules')
  for (const directory of ['@fixture/tools', 'app', 'app/node_modules/external', 'external']) await mkdir(join(modules, directory), { recursive: true })
  await writeFile(join(modules, '.modules.yaml'), JSON.stringify({ hoistedLocations: {
    '@fixture/tools@file:///workspace/packages/tools': [join('node_modules', '@fixture', 'tools')],
    'app@file:///workspace/packages/app': [join('node_modules', 'app')],
    'external@1.0.0': [join('node_modules', 'external'), join('node_modules', 'app', 'node_modules', 'external')],
  } }))

  await expect(assertSingleWorkspaceCopies(staging)).resolves.toBeUndefined()
})

it('rejects a second copy or peer variant of a workspace package and invalid metadata', async () => {
  const staging = await fixture('dsh-python-staging-duplicate-')
  const modules = join(staging, 'node_modules')
  for (const directory of ['tools', 'app/node_modules/tools']) await mkdir(join(modules, directory), { recursive: true })
  const root = join('node_modules', 'tools')
  const nested = join('node_modules', 'app', 'node_modules', 'tools')
  for (const [metadata, message] of [
    [{ hoistedLocations: { 'tools@file:packages/tools': [root, nested] } }, 'exactly one staged copy: tools'],
    [{ hoistedLocations: { 'tools@file:packages/tools(peer@1)': [root], 'tools@file:packages/tools(peer@2)': [nested] } }, 'exactly one staged copy: tools'],
    [{}, 'hoistedLocations must map'],
    [{ hoistedLocations: { invalid: [42] } }, 'hoistedLocations must map'],
    [{ hoistedLocations: { 'tools@file:packages/tools': [join('..', 'source')] } }, 'outside deployed node_modules'],
    [{ hoistedLocations: { 'external@1.0.0': [root] } }, 'records no workspace packages'],
  ] as const) {
    await writeFile(join(modules, '.modules.yaml'), JSON.stringify(metadata))
    await expect(assertSingleWorkspaceCopies(staging)).rejects.toThrow(message)
  }
})
