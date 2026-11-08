import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createInstalledUpdateRun, readInstalledUpdateRun } from '../scripts/installed-update-qualification.ts'
import { prepareInstalledUpdateBootstrap } from '../scripts/prepare-installed-update-bootstrap.ts'
import { configureInstalledUpdateIdentity } from '../scripts/installed-update-identity.mjs'

const versions = ['0.1.6-nightly.20260914.1', '0.1.6-nightly.20260914.2'] as const
const source = { version: '0.1.5-rc.2', commit: 'a'.repeat(40), dirtyFiles: [] }

async function fixture<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-update-bootstrap-'))
  try { return await body(directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

describe('installed-update bootstrap', () => {
  it('executes the generated entry for both versions with isolated persistent paths before main imports', async () => {
    await fixture(async (directory) => {
      const run = await createInstalledUpdateRun(directory, versions, source)
      const bootstrap = await prepareInstalledUpdateBootstrap(join(run.root, 'run.json'))
      await mkdir(join(bootstrap, 'node_modules/electron'), { recursive: true })
      await mkdir(join(bootstrap, 'lib'))
      await writeFile(join(bootstrap, 'node_modules/electron/package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }))
      await writeFile(join(bootstrap, 'node_modules/electron/index.mjs'), `
export const app = {
  paths: {},
  getAppPath: () => ${JSON.stringify(bootstrap)},
  getPath: () => ${JSON.stringify(join(directory, 'application-data'))},
  setPath(name, value) { this.paths[name] = value }
}
`)
      await writeFile(join(bootstrap, 'lib/main.js'), `
import { app } from 'electron'
console.log(JSON.stringify({ paths: app.paths, home: process.env.DSH_HOME, agents: process.env.DSH_AGENTS_HOME,
  journals: process.env.DSH_DESKTOP_UPDATE_JOURNAL_DIR, context: JSON.parse(process.env.AGENTRANS_LAUNCH_CONTEXT) }))
`)
      const oldHome = join(directory, 'old-user-home')
      await mkdir(oldHome)
      await writeFile(join(oldHome, 'keep.txt'), 'existing user data')
      const results = []
      for (const version of versions) {
        await writeFile(join(bootstrap, 'package.json'), JSON.stringify({ type: 'module', version, dshDesktopAppId: run.appId }))
        const payloadFiles = (await readdir(bootstrap, { recursive: true })).sort()
        const { stdout, stderr } = await promisify(execFile)(process.execPath, [join(bootstrap, 'qualification-bootstrap.mjs')], {
          windowsHide: true, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
            DSH_HOME: oldHome, DSH_AGENTS_HOME: oldHome, DSH_DESKTOP_UPDATE_JOURNAL_DIR: oldHome },
        })
        expect(stderr).toBe('')
        expect((await readdir(bootstrap, { recursive: true })).sort()).toEqual(payloadFiles)
        results.push(JSON.parse(stdout))
      }
      const root = join(directory, 'application-data/dsh-update-qualification', run.id)
      expect(results).toEqual([0, 1].map(() => ({ paths: { userData: join(root, 'data/settings/electron'), sessionData: join(root, 'data/settings/electron') },
        home: join(root, 'data/dsh/home'), agents: join(root, 'data/dsh/agents'), journals: join(root, 'data/install/update-journal'),
        context: { purpose: 'verification', instanceRoot: root, codeRoot: dirname(bootstrap), resourcesRoot: bootstrap } })))
      expect((await readdir(root)).sort()).toEqual(['.agentrans-instance.json', 'data', 'models', 'runtime-envs'])
      expect(await readdir(oldHome)).toEqual(['keep.txt'])
      expect(await readFile(join(oldHome, 'keep.txt'), 'utf8')).toBe('existing user data')
      const identity = await readFile(join(bootstrap, 'installed-update-identity.mjs'), 'utf8')
      const imports = [...identity.matchAll(/from ["']([^"']+)["']/gu)].map(match => match[1]!)
      expect(imports.every(specifier => specifier.startsWith('node:'))).toBe(true)
      await expect(prepareInstalledUpdateBootstrap(join(run.root, 'run.json'))).rejects.toMatchObject({ code: 'EEXIST' })
    })
  })

  it('rejects unavailable payload roots before writing state or changing process paths', async () => {
    await fixture(async (directory) => {
      const env = { DSH_HOME: 'existing', DSH_AGENTS_HOME: 'existing-agents' }
      const app = { getPath: () => directory, setPath: (): never => { throw new Error('unexpected path change') } }
      const id = 'a'.repeat(24)
      expect(() => configureInstalledUpdateIdentity(app, { id, versions },
        { version: versions[0], dshDesktopAppId: `com.deepseek.dsh.qualification.q${id}` }, env,
        join(directory, 'payload', 'missing-resources'))).toThrow('not available')
      expect(await readdir(directory)).toEqual([])
      expect(env).toEqual({ DSH_HOME: 'existing', DSH_AGENTS_HOME: 'existing-agents' })
    })
  })

  it('refuses to adopt retained unmarked state before altering its contents', async () => {
    await fixture(async (directory) => {
      const id = 'a'.repeat(24)
      const appData = join(directory, 'application-data')
      const state = join(appData, 'dsh-update-qualification', id)
      const resources = join(directory, 'payload', 'resources')
      await mkdir(join(state, 'data'), { recursive: true })
      await mkdir(resources, { recursive: true })
      await writeFile(join(state, 'data', 'keep.txt'), 'unclaimed user state')
      const env = { DSH_HOME: 'existing' }
      const app = { getPath: () => appData, setPath: (): never => { throw new Error('unexpected path change') } }
      expect(() => configureInstalledUpdateIdentity(app, { id, versions },
        { version: versions[0], dshDesktopAppId: `com.deepseek.dsh.qualification.q${id}` }, env, resources)).toThrow('unmarked')
      expect(await readdir(state)).toEqual(['data'])
      expect(await readdir(join(state, 'data'))).toEqual(['keep.txt'])
      expect(await readFile(join(state, 'data', 'keep.txt'), 'utf8')).toBe('unclaimed user state')
      expect(env).toEqual({ DSH_HOME: 'existing' })
    })
  })

  it('refuses foreign metadata before creating any data directory or changing the environment', async () => {
    await fixture(async (directory) => {
      const env = { DSH_HOME: 'existing' }
      const app = { getPath: () => directory, setPath: (): never => { throw new Error('unexpected path change') } }
      expect(() => configureInstalledUpdateIdentity(app, { id: 'a'.repeat(24), versions },
        { version: versions[0], dshDesktopAppId: 'com.deepseek.dsh' }, env, directory)).toThrow('identity')
      expect(await readdir(directory)).toEqual([])
      expect(env).toEqual({ DSH_HOME: 'existing' })
    })
  })

  it.each(['origin', 'bucket', 'appId', 'root', 'feedKey', 'binPrefix', 'versions', 'source'])(
    'rejects altered %s in a retained manifest', async (field) => {
      await fixture(async (directory) => {
        const run = await createInstalledUpdateRun(directory, versions, source)
        const path = join(run.root, 'run.json')
        const changed = { ...run, [field]: field === 'versions' ? [...versions].reverse() : 'unexpected' }
        await writeFile(path, JSON.stringify(changed))
        await expect(readInstalledUpdateRun(path)).rejects.toThrow()
        expect(await readdir(dirname(path))).toEqual(['run.json'])
      })
    },
  )

  it('loads the original manifest without adding credential fields to bootstrap output', async () => {
    await fixture(async (directory) => {
      const run = await createInstalledUpdateRun(directory, versions, source)
      expect(await readInstalledUpdateRun(join(run.root, 'run.json'))).toEqual(run)
      const bootstrap = await prepareInstalledUpdateBootstrap(join(run.root, 'run.json'))
      const entry = await readFile(join(bootstrap, 'qualification-bootstrap.mjs'), 'utf8')
      expect(entry).not.toContain('SECRET')
      expect(entry).not.toContain('TOKEN')
      expect(entry).toContain(run.id)
    })
  })
})
