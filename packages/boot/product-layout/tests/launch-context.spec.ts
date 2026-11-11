import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyProductLaunchEnvironment,
  parseProductLaunchContext,
  prepareProductState,
  PRODUCT_LAUNCH_CONTEXT_ENV,
  productLaunchEnvironment,
  resolveDevelopmentLaunchContext,
  resolvePackagedLaunchContext,
  resolveProductLaunchContext,
  serializeProductLaunchContext,
  type ProductLaunchPurpose,
} from '../src/launch-context.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentrans-launch-'))
  roots.push(root)
  const codeRoot = join(root, 'source')
  const resourcesRoot = join(codeRoot, 'resources')
  await mkdir(resourcesRoot, { recursive: true })
  return { root, codeRoot, resourcesRoot, instanceRoot: join(root, 'state') }
}

describe('product launch context', () => {
  it('derives state from explicit roots without reading cwd or inherited Harness paths', async () => {
    const input = await fixture()
    vi.stubEnv('AGENTRANS_HOME', join(input.root, 'upstream-home'))
    vi.stubEnv('AGENTRANS_AGENTS_HOME', join(input.root, 'upstream-agents'))
    const cwd = vi.spyOn(process, 'cwd').mockImplementation(() => { throw new Error('cwd must not select product state') })
    let context
    try { context = resolveProductLaunchContext({ ...input, purpose: 'development' }) }
    finally { cwd.mockRestore() }
    expect(context.paths.dshHomeDir).toBe(join(input.instanceRoot, 'data', 'dsh', 'home'))
    expect(context.paths.dshAgentsHomeDir).toBe(join(input.instanceRoot, 'data', 'dsh', 'agents'))
    expect(context.paths.electronUserDataDir).toBe(join(input.instanceRoot, 'data', 'settings', 'electron'))
    expect(context.paths.logsDir).toBe(join(input.instanceRoot, 'data', 'logs'))
    expect(context.paths.crashDumpsDir).toBe(join(input.instanceRoot, 'data', 'cache', 'crash-dumps'))
    expect(context.paths.updateJournalDir).toBe(join(input.instanceRoot, 'data', 'install', 'update-journal'))
    expect(Object.isFrozen(context)).toBe(true)
    expect(Object.isFrozen(context.paths)).toBe(true)
    await expect(stat(input.instanceRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['development', 'verification', 'user'] as const)('rejects %s state inside code and resources', async (purpose) => {
    const input = await fixture()
    expect(() => resolveProductLaunchContext({ ...input, purpose, instanceRoot: join(input.codeRoot, '.desktop-build') }))
      .toThrow(expect.objectContaining({ code: 'STATE_CODE_OVERLAP' }))
    expect(() => resolveProductLaunchContext({ ...input, purpose, resourcesRoot: join(input.instanceRoot, 'models', 'bundled') }))
      .toThrow(expect.objectContaining({ code: 'STATE_CODE_OVERLAP' }))
    await expect(stat(input.instanceRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows a user installation to contain its app directory', async () => {
    const input = await fixture()
    for (const purpose of ['user'] as const) {
      const instanceRoot = join(input.root, purpose)
      const codeRoot = join(instanceRoot, 'app')
      const resourcesRoot = join(codeRoot, 'resources')
      await mkdir(resourcesRoot, { recursive: true })
      const context = resolveProductLaunchContext({ purpose, instanceRoot, codeRoot, resourcesRoot })
      prepareProductState(context)
      expect((await stat(context.paths.dshHomeDir)).isDirectory()).toBe(true)
      expect(await readdir(resourcesRoot)).toEqual([])
    }
  })

  it('rejects cwd-relative, empty, and filesystem-root instances before creating directories', async () => {
    const input = await fixture()
    for (const instanceRoot of ['relative-state', '', parse(input.root).root]) {
      expect(() => resolveProductLaunchContext({ ...input, instanceRoot, purpose: 'development' }))
        .toThrow(expect.objectContaining({ code: 'INVALID_LAUNCH_REQUEST' }))
    }
    await expect(stat(input.instanceRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('resolves the packaged payload independently of cwd and ambient overrides', async () => {
    const input = await fixture()
    const resourcesRoot = join(input.instanceRoot, 'app', 'resources')
    const context = resolvePackagedLaunchContext(resourcesRoot)
    expect(context.instanceRoot).toBe(input.instanceRoot)
    expect(context.codeRoot).toBe(join(input.instanceRoot, 'app'))
    expect(context.resourcesRoot).toBe(resourcesRoot)
    expect(context.purpose).toBe('user')
    expect(context.paths.dataDir).toBe(join(input.instanceRoot, 'data'))
  })

  it('binds an explicit verification root only to its own packaged code and resources', async () => {
    const input = await fixture()
    const resourcesRoot = join(input.root, 'installed', 'app', 'resources')
    const candidate = resolveProductLaunchContext({
      purpose: 'verification', instanceRoot: join(input.root, 'verification'),
      codeRoot: dirname(resourcesRoot), resourcesRoot,
    })
    expect(resolvePackagedLaunchContext(resourcesRoot, serializeProductLaunchContext(candidate))).toEqual(candidate)
    const foreign = resolveProductLaunchContext({ ...candidate, codeRoot: input.codeRoot, resourcesRoot: input.resourcesRoot })
    expect(() => resolvePackagedLaunchContext(resourcesRoot, serializeProductLaunchContext(foreign)))
      .toThrow(expect.objectContaining({ code: 'INVALID_LAUNCH_REQUEST' }))
  })

  it.each(['development', 'user'] as const)('ignores an inherited %s state root for a packaged payload', async (purpose) => {
    const input = await fixture()
    const resourcesRoot = join(input.root, 'installed', 'app', 'resources')
    const incoming = resolveProductLaunchContext({ ...input, purpose })
    expect(resolvePackagedLaunchContext(resourcesRoot, serializeProductLaunchContext(incoming)))
      .toEqual(resolvePackagedLaunchContext(resourcesRoot))
  })

  it('keeps one stable external development root per source tree and accepts an explicit instance', async () => {
    const input = await fixture()
    const first = resolveDevelopmentLaunchContext({ sourceRoot: input.codeRoot })
    const again = resolveDevelopmentLaunchContext({ sourceRoot: input.codeRoot })
    const trailing = resolveDevelopmentLaunchContext({ sourceRoot: input.codeRoot + sep })
    const other = resolveDevelopmentLaunchContext({ sourceRoot: join(input.root, 'another-source') })
    expect(first).toEqual(again)
    expect(first).toEqual(trailing)
    expect(dirname(first.instanceRoot)).toBe(join(input.root, '.dev-data', 'agentrans', 'dev'))
    expect(first.instanceRoot).not.toBe(other.instanceRoot)
    expect(first.codeRoot).toBe(input.codeRoot)
    expect(resolveDevelopmentLaunchContext({ sourceRoot: input.codeRoot, instanceRoot: input.instanceRoot }).instanceRoot)
      .toBe(input.instanceRoot)
    await expect(stat(first.instanceRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('product process environment', () => {
  it('replaces all Windows aliases for owned variables without changing unrelated values or the input', async () => {
    const input = await fixture()
    const context = resolveProductLaunchContext({ ...input, purpose: 'verification' })
    const inherited = { dsh_home: 'upstream', AGENTRANS_HOME: 'other', Dsh_Agents_Home: 'shared', agentrans_launch_context: 'foreign', PATH: 'tools', MODEL_KEY: 'fixture' }
    const environment = productLaunchEnvironment(context, inherited, 'win32')
    expect(environment).toEqual({ PATH: 'tools', MODEL_KEY: 'fixture', AGENTRANS_HOME: context.paths.dshHomeDir,
      AGENTRANS_AGENTS_HOME: context.paths.dshAgentsHomeDir, [PRODUCT_LAUNCH_CONTEXT_ENV]: serializeProductLaunchContext(context) })
    expect(inherited.dsh_home).toBe('upstream')
    expect(inherited.agentrans_launch_context).toBe('foreign')
  })

  it('keeps case-sensitive unrelated POSIX names and round-trips only independent roots', async () => {
    const input = await fixture()
    const context = resolveProductLaunchContext({ ...input, purpose: 'development' })
    expect(productLaunchEnvironment(context, { dsh_home: 'unrelated', AGENTRANS_HOME: 'upstream' }, 'linux').dsh_home).toBe('unrelated')
    const encoded = serializeProductLaunchContext(context)
    expect(Object.keys(JSON.parse(encoded) as Record<string, unknown>).sort()).toEqual(['codeRoot', 'instanceRoot', 'purpose', 'resourcesRoot'])
    expect(parseProductLaunchContext(encoded)).toEqual(context)
  })

  it('materializes the same instance in place while preserving all unrelated variables', async () => {
    const input = await fixture()
    const context = resolveProductLaunchContext({ ...input, purpose: 'verification' })
    const environment: NodeJS.ProcessEnv = { dsh_home: 'old', dsh_agents_home: 'shared', agentrans_launch_context: 'foreign', PATH: 'tools', MODEL_KEY: 'fixture' }
    const original = environment
    applyProductLaunchEnvironment(context, environment, 'win32')
    expect(environment).toBe(original)
    expect(environment).toEqual(productLaunchEnvironment(context, { PATH: 'tools', MODEL_KEY: 'fixture' }, 'win32'))
  })

  it('rejects malformed or forged wire fields instead of accepting caller-derived state paths', async () => {
    const input = await fixture()
    const request = { instanceRoot: input.instanceRoot, codeRoot: input.codeRoot, resourcesRoot: input.resourcesRoot, purpose: 'user' }
    for (const value of [null, [], { ...request, purpose: 'unsupported' }, { ...request, paths: { dshHomeDir: 'upstream' } }, { ...request, codeRoot: 123 }]) {
      expect(() => parseProductLaunchContext(JSON.stringify(value))).toThrow(expect.objectContaining({ code: 'INVALID_LAUNCH_REQUEST' }))
    }
    expect(() => parseProductLaunchContext('{')).toThrow(expect.objectContaining({ code: 'INVALID_LAUNCH_REQUEST' }))
  })
})

describe('product state preparation', () => {
  it('creates state directories without creating an app or changing code and existing data', async () => {
    const input = await fixture()
    const context = resolveProductLaunchContext({ ...input, purpose: 'development' })
    await writeFile(join(input.codeRoot, 'program.js'), 'immutable code')
    prepareProductState(context)
    await writeFile(join(context.paths.dshHomeDir, 'existing.txt'), 'preserved session')
    prepareProductState(context)
    expect(await readFile(join(context.paths.dshHomeDir, 'existing.txt'), 'utf8')).toBe('preserved session')
    expect(await readdir(input.codeRoot)).toEqual(['program.js', 'resources'])
    expect(await readdir(input.instanceRoot)).toEqual(['.agentrans-instance.json', 'data', 'models', 'runtime-envs'])
    expect(JSON.parse(await readFile(join(input.instanceRoot, '.agentrans-instance.json'), 'utf8')))
      .toEqual({ schemaVersion: 1, productId: 'agentrans', purpose: 'development' })
    await expect(stat(join(input.instanceRoot, 'app'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a state junction before creating any of the other state directories', async () => {
    const input = await fixture()
    const outside = join(input.root, 'outside')
    await mkdir(input.instanceRoot)
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'outside data')
    await symlink(outside, join(input.instanceRoot, 'models'), process.platform === 'win32' ? 'junction' : 'dir')
    const context = resolveProductLaunchContext({ ...input, purpose: 'verification' })
    expect(() => { prepareProductState(context) }).toThrow(expect.objectContaining({ code: 'STATE_PATH_LINK' }))
    expect(await readdir(input.instanceRoot)).toEqual(['models'])
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('outside data')
  })

  it('detects a code alias physically inside state before preparing other directories', async () => {
    const input = await fixture()
    const actualCode = join(input.instanceRoot, 'data', 'source')
    const alias = join(input.root, 'source-alias')
    await mkdir(actualCode, { recursive: true })
    await symlink(actualCode, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const context = resolveProductLaunchContext({ ...input, codeRoot: alias, resourcesRoot: alias, purpose: 'verification' })
    expect(() => { prepareProductState(context) }).toThrow(expect.objectContaining({ code: 'STATE_CODE_OVERLAP' }))
    expect(await readdir(input.instanceRoot)).toEqual(['data'])
  })

  it('rejects a linked update-journal ancestor before creating other state directories', async () => {
    const input = await fixture()
    const outside = join(input.root, 'outside-journals')
    await mkdir(join(input.instanceRoot, 'data'), { recursive: true })
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'outside journal data')
    await symlink(outside, join(input.instanceRoot, 'data', 'install'), process.platform === 'win32' ? 'junction' : 'dir')
    const context = resolveProductLaunchContext({ ...input, purpose: 'verification' })
    expect(() => { prepareProductState(context) }).toThrow(expect.objectContaining({ code: 'STATE_PATH_LINK' }))
    expect(await readdir(outside)).toEqual(['keep.txt'])
    expect(await readdir(input.instanceRoot)).toEqual(['data'])
    expect(await readdir(join(input.instanceRoot, 'data'))).toEqual(['install'])
  })

  it('rejects unavailable code and file-valued state ancestors without writing state', async () => {
    const input = await fixture()
    const missingCode = resolveProductLaunchContext({ ...input, codeRoot: join(input.root, 'missing-code'), purpose: 'user' })
    expect(() => { prepareProductState(missingCode) }).toThrow(expect.objectContaining({ code: 'CODE_ROOT_UNAVAILABLE' }))
    await expect(stat(input.instanceRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await mkdir(input.instanceRoot)
    await writeFile(join(input.instanceRoot, 'data'), 'not a directory')
    const context = resolveProductLaunchContext({ ...input, purpose: 'user' })
    expect(() => { prepareProductState(context) }).toThrow(expect.objectContaining({ code: 'STATE_PATH_NOT_DIRECTORY' }))
    expect(await readdir(input.instanceRoot)).toEqual(['data'])
  })

  it.each(['development', 'verification'] as const)('refuses %s takeover of an existing app payload before making state', async (purpose) => {
    const input = await fixture()
    await mkdir(join(input.instanceRoot, 'app'), { recursive: true })
    const context = resolveProductLaunchContext({ ...input, purpose })
    expect(() => { prepareProductState(context) }).toThrow(expect.objectContaining({ code: 'INSTANCE_PURPOSE_MISMATCH' }))
    expect(await readdir(input.instanceRoot)).toEqual(['app'])
  })

  it.each(['development', 'verification'] as const)('refuses %s takeover of unmarked retained data', async (purpose) => {
    const input = await fixture()
    const retained = join(input.instanceRoot, 'data', 'retained.txt')
    await mkdir(dirname(retained), { recursive: true })
    await writeFile(retained, 'keep retained data')
    const context = resolveProductLaunchContext({ ...input, purpose })
    expect(() => { prepareProductState(context) }).toThrow(expect.objectContaining({ code: 'INSTANCE_PURPOSE_MISMATCH' }))
    expect(await readdir(input.instanceRoot)).toEqual(['data'])
    expect(await readFile(retained, 'utf8')).toBe('keep retained data')
  })

  it('owns a verification root before preparing fixtures and refuses purpose changes', async () => {
    const input = await fixture()
    const context = resolveProductLaunchContext({ ...input, purpose: 'verification' })
    prepareProductState(context)
    const marker = join(input.instanceRoot, '.agentrans-instance.json')
    expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({ schemaVersion: 1, productId: 'agentrans', purpose: 'verification' })
    await writeFile(join(context.paths.dataDir, 'fixture.txt'), 'verification fixture')
    prepareProductState(context)
    expect(await readFile(join(context.paths.dataDir, 'fixture.txt'), 'utf8')).toBe('verification fixture')
    const development = resolveProductLaunchContext({ ...input, purpose: 'development' })
    expect(() => { prepareProductState(development) }).toThrow(expect.objectContaining({ code: 'INSTANCE_PURPOSE_MISMATCH' }))
    expect((JSON.parse(await readFile(marker, 'utf8')) as { purpose: string }).purpose).toBe('verification')
  })

  it.each([
    '{',
    JSON.stringify({ schemaVersion: 1, productId: 'foreign', purpose: 'development' }),
    JSON.stringify({ schemaVersion: 1, productId: 'agentrans', purpose: 'user' }),
    JSON.stringify({ schemaVersion: 2, productId: 'agentrans', purpose: 'development' }),
  ])('refuses an invalid or foreign instance marker without creating state', async (contents) => {
    const input = await fixture()
    await mkdir(input.instanceRoot)
    const marker = join(input.instanceRoot, '.agentrans-instance.json')
    await writeFile(marker, contents)
    const context = resolveProductLaunchContext({ ...input, purpose: 'development' })
    expect(() => { prepareProductState(context) }).toThrow(expect.objectContaining({ code: 'INSTANCE_PURPOSE_MISMATCH' }))
    expect(await readdir(input.instanceRoot)).toEqual(['.agentrans-instance.json'])
    expect(await readFile(marker, 'utf8')).toBe(contents)
  })

  it.each(['installed', 'portable', 'broken'])('refuses development takeover of a %s install manifest', async (channel) => {
    const input = await fixture()
    const directory = join(input.instanceRoot, 'data', 'install')
    await mkdir(directory, { recursive: true })
    const content = channel === 'broken' ? '{' : JSON.stringify({ productId: 'agentrans', channel })
    await writeFile(join(directory, 'manifest.json'), content)
    const context = resolveProductLaunchContext({ ...input, purpose: 'development' })
    expect(() => { prepareProductState(context) }).toThrow(expect.objectContaining({ code: 'INSTANCE_PURPOSE_MISMATCH' }))
    expect(await readdir(input.instanceRoot)).toEqual(['data'])
    expect(await readFile(join(directory, 'manifest.json'), 'utf8')).toBe(content)
  })

  it('accepts an explicitly recorded development instance', async () => {
    const input = await fixture()
    const directory = join(input.instanceRoot, 'data', 'install')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ productId: 'agentrans', channel: 'development' }))
    await writeFile(join(input.instanceRoot, '.agentrans-instance.json'), JSON.stringify({ schemaVersion: 1, productId: 'agentrans', purpose: 'development' }))
    const purpose: ProductLaunchPurpose = 'development'
    const context = resolveProductLaunchContext({ ...input, purpose })
    prepareProductState(context)
    expect((await stat(context.paths.dshAgentsHomeDir)).isDirectory()).toBe(true)
  })
})
