import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { generateSceneBundles, watchSceneBundles } from './generate-scene-bundles.ts'
import { StageSupervisor } from './dev-web.ts'
import { compileReferencedProjects } from './compile-referenced-projects.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentrans-scene-generation-'))
  const artifact = join(root, 'packages/artifact/artifact/src')
  const values = join(root, 'packages/util/values/src')
  mkdirSync(join(artifact, 'renderers'), { recursive: true })
  mkdirSync(values, { recursive: true })
  writeFileSync(join(values, 'index.ts'), 'export const answer = 42\n')
  writeFileSync(join(artifact, 'scene-renderers.ts'), 'export { label } from "./renderers/helper.ts"\n')
  writeFileSync(join(artifact, 'renderers/helper.ts'), 'export const label = "before"\n')
  writeFileSync(join(root, 'packages/artifact/artifact/package.json'), '{"type":"module"}\n')
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  return { root, artifact, renderer: join(artifact, 'scene-renderers.generated.ts') }
}

describe('scene export program generation', () => {
  it('compiles the Host Artifact consumer from a clean tree without Client sources', () => {
    const { root, artifact } = fixture()
    writeFileSync(join(artifact, 'consumer.ts'), [
      'import { sceneExprBundle } from "./scene-expr.generated.ts"',
      'import { sceneRenderersBundle } from "./scene-renderers.generated.ts"',
      'export const programs: readonly string[] = [sceneExprBundle, sceneRenderersBundle]',
    ].join('\n'))
    writeFileSync(join(artifact, '../tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, composite: true, module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2024',
        types: [], rewriteRelativeImportExtensions: true, declaration: true, rootDir: 'src', outDir: 'lib/types' },
      include: ['src'],
    }))
    writeFileSync(join(root, 'tsconfig.host.json'), JSON.stringify({
      compilerOptions: { noEmit: true }, files: [], references: [{ path: './packages/artifact/artifact' }],
    }))
    expect(existsSync(join(root, 'packages/client'))).toBe(false)
    compileReferencedProjects(root, 'host')
    expect(readFileSync(join(artifact, '../lib/types/consumer.js'), 'utf8')).toContain('sceneRenderersBundle')
    expect(existsSync(join(root, 'packages/client'))).toBe(false)
  })

  it('generates missing script constants before the clean Artifact consumer can type-check', () => {
    const { root, artifact } = fixture()
    writeFileSync(join(artifact, 'consumer.ts'), [
      'import { sceneExprBundle } from "./scene-expr.generated.ts"',
      'import { sceneRenderersBundle } from "./scene-renderers.generated.ts"',
      'export const programs: readonly string[] = [sceneExprBundle, sceneRenderersBundle]',
    ].join('\n'))
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2024',
        types: [], allowImportingTsExtensions: true, noEmit: true },
      files: ['./packages/artifact/artifact/src/consumer.ts'],
    }))
    const compile = () => spawnSync(process.execPath, [fileURLToPath(import.meta.resolve('typescript/bin/tsc')),
      '-p', join(root, 'tsconfig.json')], { cwd: root, encoding: 'utf8' })
    expect(existsSync(join(artifact, 'scene-expr.generated.ts'))).toBe(false)
    expect(existsSync(join(artifact, 'scene-renderers.generated.ts'))).toBe(false)
    const missing = compile()
    expect(missing.status).not.toBe(0)
    expect(missing.stdout).toContain('Cannot find module')
    generateSceneBundles(root)
    const generated = compile()
    expect(generated.status, generated.stdout + generated.stderr).toBe(0)
    expect(readFileSync(join(artifact, 'scene-expr.generated.js'), 'utf8')).toContain('SceneExpr')
    expect(readFileSync(join(artifact, 'scene-renderers.generated.js'), 'utf8')).toContain('SceneRenderers')
  })

  it('refreshes the embedded program when a renderer source dependency changes', async () => {
    const { root, artifact, renderer } = fixture()
    const watcher = await watchSceneBundles(root)
    try {
      expect(readFileSync(renderer, 'utf8')).toContain('before')
      writeFileSync(join(artifact, 'renderers/helper.ts'), 'export const label = "after"\n')
      await expect.poll(() => readFileSync(renderer, 'utf8'), { timeout: 10_000 }).toContain('after')
    } finally { await watcher.dispose() }
    expect(await watcher.exited).toBe(0)
  })

  it('stops both source watchers after a generation error', async () => {
    const { root, artifact } = fixture()
    const watcher = await watchSceneBundles(root)
    const stale = Promise.withResolvers<{ name: string; code: number | null }>()
    const companionExit = Promise.withResolvers<number | null>()
    const signals: NodeJS.Signals[] = []
    const supervisor = new StageSupervisor((name, code) => { stale.resolve({ name, code }) })
    supervisor.add({ name: 'Scene export programs', exited: watcher.exited, kill() { void watcher.dispose() } })
    supervisor.add({ name: 'compiler', exited: companionExit.promise, kill(signal) { signals.push(signal); companionExit.resolve(null) } })
    try {
      writeFileSync(join(artifact, 'renderers/helper.ts'), 'export const label = (\n')
      await expect.poll(async () => await Promise.race([watcher.exited, Promise.resolve('pending')]),
        { timeout: 10_000 }).toBe(1)
      expect(await stale.promise).toEqual({ name: 'Scene export programs', code: 1 })
      await supervisor.stop({ signal: 'SIGTERM', graceMs: 20 })
      expect(signals).toEqual(['SIGTERM'])
    } finally { await supervisor.stop({ signal: 'SIGTERM', graceMs: 20 }); await watcher.dispose() }
    expect(await watcher.exited).toBe(1)
  })
})
