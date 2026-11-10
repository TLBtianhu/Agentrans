/** Source-launch initialization in isolated worktrees without starting an application or service. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const repository = resolve(import.meta.dirname, '..')
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
const roots: string[] = []

afterEach(async () => {
  const temporary = await realpath(tmpdir())
  for (const root of roots.splice(0)) {
    if (dirname(root) !== temporary || !basename(root).startsWith('agentrans-source-bootstrap-')) throw new Error('Unexpected fixture cleanup root')
    await rm(root, { recursive: true, force: true })
  }
})

async function sourceFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentrans-source-bootstrap-')))
  roots.push(root)
  const source = join(root, 'source')
  // The source contract is relocation: execute byte-identical launcher sources in a temporary worktree.
  for (const file of ['scripts/agentrans-bootstrap.ts', 'packages/boot/product-layout/src/launch-context.ts']) {
    await mkdir(dirname(join(source, file)), { recursive: true })
    await copyFile(join(repository, file), join(source, file))
  }
  await writeFile(join(source, 'package.json'), '{"type":"module"}\n')
  const cwd = join(root, 'workspace')
  const upstream = join(root, 'upstream-state')
  await mkdir(cwd)
  await mkdir(upstream)
  await writeFile(join(upstream, 'keep.txt'), 'unrelated product data')
  await writeFile(join(cwd, '.env'), `DSH_HOME=${upstream}\nDSH_AGENTS_HOME=${upstream}\n`)
  return { root, source, cwd, upstream }
}

async function fileRecord(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()!
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else result[relative(root, path)] = createHash('sha256').update(await readFile(path)).digest('hex')
    }
  }
  return result
}

async function probe(source: string, cwd: string, upstream: string, instanceRoot?: string) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (['AGENTRANS_DEV_ROOT', 'AGENTRANS_LAUNCH_CONTEXT', 'DSH_HOME', 'DSH_AGENTS_HOME'].includes(key.toUpperCase())) {
      Reflect.deleteProperty(environment, key)
    }
  }
  Object.assign(environment, {
    DSH_HOME: upstream,
    DSH_AGENTS_HOME: upstream,
    AGENTRANS_LAUNCH_CONTEXT: '{"unexpected":"inherited-context"}',
    ...(instanceRoot === undefined ? {} : { AGENTRANS_DEV_ROOT: instanceRoot }),
  })
  const { stdout } = await run(process.execPath, [
    '--import', tsxImport,
    '--import', pathToFileURL(join(source, 'scripts/agentrans-bootstrap.ts')).href,
    '--input-type=module', '--eval',
    'console.log(JSON.stringify({ home: process.env.DSH_HOME, agents: process.env.DSH_AGENTS_HOME, context: JSON.parse(process.env.AGENTRANS_LAUNCH_CONTEXT) }))',
  ], { cwd, env: environment, timeout: 15_000 })
  const result = JSON.parse(stdout) as {
    home: string
    agents: string
    context: { purpose: string; instanceRoot: string; codeRoot: string; resourcesRoot: string }
  }
  return result
}

describe('Agentrans source bootstrap', () => {
  it('keeps one worktree root across cwd changes and ignores inherited Harness paths', async () => {
    const fixture = await sourceFixture()
    const before = await fileRecord(fixture.source)
    const first = await probe(fixture.source, fixture.cwd, fixture.upstream)
    const secondCwd = join(fixture.root, 'another-workspace')
    await mkdir(secondCwd)
    const second = await probe(fixture.source, secondCwd, fixture.upstream)

    expect(second).toEqual(first)
    expect(first.context).toMatchObject({ purpose: 'development', codeRoot: fixture.source, resourcesRoot: fixture.source })
    expect(dirname(first.context.instanceRoot)).toBe(join(fixture.root, '.dev-data', 'agentrans', 'dev'))
    expect(first.home).toBe(join(first.context.instanceRoot, 'data', 'dsh', 'home'))
    expect(first.agents).toBe(join(first.context.instanceRoot, 'data', 'dsh', 'agents'))
    expect((await stat(first.home)).isDirectory()).toBe(true)
    expect((await stat(first.agents)).isDirectory()).toBe(true)
    expect(await fileRecord(fixture.source)).toEqual(before)
    expect(await readdir(fixture.upstream)).toEqual(['keep.txt'])
    expect(await readFile(join(fixture.upstream, 'keep.txt'), 'utf8')).toBe('unrelated product data')
  })

  it('uses the explicit development instance without changing source files', async () => {
    const fixture = await sourceFixture()
    const before = await fileRecord(fixture.source)
    const instance = join(fixture.root, 'chosen-instance')
    const actual = await probe(fixture.source, fixture.cwd, fixture.upstream, instance)

    expect(actual.context.instanceRoot).toBe(instance)
    expect(actual.home).toBe(join(instance, 'data', 'dsh', 'home'))
    expect(actual.agents).toBe(join(instance, 'data', 'dsh', 'agents'))
    expect(await fileRecord(fixture.source)).toEqual(before)
  })

  it('rejects a state root inside source before creating application state', async () => {
    const fixture = await sourceFixture()
    const before = await fileRecord(fixture.source)
    await expect(probe(fixture.source, fixture.cwd, fixture.upstream, join(fixture.source, '.state'))).rejects.toThrow()
    expect(await fileRecord(fixture.source)).toEqual(before)
    expect(await readdir(fixture.source)).toEqual(expect.arrayContaining(['package.json', 'packages', 'scripts']))
    await expect(stat(join(fixture.source, '.state'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['installed', 'portable'])('refuses to take over an existing %s instance', async (channel) => {
    const fixture = await sourceFixture()
    const instance = join(fixture.root, 'user-instance')
    await mkdir(join(instance, 'data', 'install'), { recursive: true })
    await writeFile(join(instance, 'data', 'install', 'manifest.json'), JSON.stringify({ productId: 'agentrans', channel }))
    await writeFile(join(instance, 'data', 'keep.txt'), 'existing user data')
    const before = await fileRecord(instance)
    await expect(probe(fixture.source, fixture.cwd, fixture.upstream, instance)).rejects.toThrow()
    expect(await fileRecord(instance)).toEqual(before)
    expect(await readdir(join(instance, 'data'))).toEqual(['install', 'keep.txt'])
  })

  it('refuses an unmarked application directory before creating development data', async () => {
    const fixture = await sourceFixture()
    const instance = join(fixture.root, 'unmarked-install')
    await mkdir(join(instance, 'app'), { recursive: true })
    await writeFile(join(instance, 'app', 'program.txt'), 'existing application')
    const before = await fileRecord(instance)
    await expect(probe(fixture.source, fixture.cwd, fixture.upstream, instance)).rejects.toThrow()
    expect(await fileRecord(instance)).toEqual(before)
    await expect(stat(join(instance, 'data'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses unmarked data-only roots without changing their files', async () => {
    const fixture = await sourceFixture()
    const instance = join(fixture.root, 'user-data-only')
    await mkdir(join(instance, 'data'), { recursive: true })
    await writeFile(join(instance, 'data', 'keep.txt'), 'retained user data')
    const before = await fileRecord(instance)
    await expect(probe(fixture.source, fixture.cwd, fixture.upstream, instance)).rejects.toThrow()
    expect(await fileRecord(instance)).toEqual(before)
    expect(await readdir(instance)).toEqual(['data'])
  })
})
