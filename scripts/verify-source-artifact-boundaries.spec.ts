/** Source checks distinguish loader-shadowing output from authored assets and never clean files themselves. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it, onTestFinished } from 'vitest'
import { assertSourceArtifactBoundaries, sourceArtifactBoundaryViolations } from './verify-source-artifact-boundaries.ts'

function write(root: string, path: string, text = 'fixture'): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-source-artifacts-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  write(root, 'package.json', '{}')
  write(root, 'pnpm-workspace.yaml', 'packages: [packages/*/*]\n')
  write(root, 'packages/core/example/package.json', '{}')
  return root
}

it('reports every emitted sibling without deleting or rewriting any file', () => {
  const root = fixture()
  write(root, 'packages/core/example/src/index.ts')
  const paths = ['.js', '.js.map', '.d.ts', '.d.ts.map'].map(suffix => `packages/core/example/src/index${suffix}`)
  for (const path of paths) write(root, path)
  expect(sourceArtifactBoundaryViolations(root)).toEqual(paths.toSorted())
  expect(() => { assertSourceArtifactBoundaries(root) }).toThrow('move verified build residue outside src')
  for (const path of paths) expect(readFileSync(join(root, path), 'utf8')).toBe('fixture')
})

it('preserves standalone authored JavaScript, declaration companions, built output and historical fixtures', () => {
  const root = fixture()
  for (const path of ['src/manual.js', 'src/manual.d.ts', 'src/styles.d.ts', 'src/source.ts',
    'lib/types/source.js', 'tests/fixtures/history.ts', 'tests/fixtures/history.js',
    'src/node_modules/dependency/index.ts', 'src/node_modules/dependency/index.js']) write(root, `packages/core/example/${path}`)
  expect(sourceArtifactBoundaryViolations(root)).toEqual([])
})

it('checks business source nested under a directory named lib', () => {
  const root = fixture()
  write(root, 'packages/core/example/src/lib/output.ts')
  write(root, 'packages/core/example/src/lib/output.js')
  expect(sourceArtifactBoundaryViolations(root)).toEqual(['packages/core/example/src/lib/output.js'])
})

it('exempts only the two generator-owned JavaScript programs, retaining map and declaration refusals', () => {
  const root = fixture()
  write(root, 'packages/artifact/artifact/package.json', '{}')
  for (const stem of ['scene-expr', 'scene-renderers']) {
    write(root, `packages/artifact/artifact/src/${stem}.generated.ts`)
    write(root, `packages/artifact/artifact/src/${stem}.generated.js`)
  }
  expect(sourceArtifactBoundaryViolations(root)).toEqual([])
  const rejected = ['packages/artifact/artifact/src/scene-expr.generated.js.map',
    'packages/artifact/artifact/src/scene-renderers.generated.d.ts',
    'packages/artifact/artifact/src/scene-renderers.generated.d.ts.map']
  for (const path of rejected) write(root, path)
  expect(sourceArtifactBoundaryViolations(root)).toEqual(rejected.toSorted())
})

it('rejects arbitrary generated-looking collisions and supports module-specific TypeScript extensions', () => {
  const root = fixture()
  for (const name of ['other.generated.ts', 'other.generated.js', 'module.mts', 'module.mjs', 'common.cts', 'common.cjs']) {
    write(root, `packages/core/example/src/${name}`)
  }
  expect(sourceArtifactBoundaryViolations(root)).toEqual(['common.cjs', 'module.mjs', 'other.generated.js']
    .map(name => `packages/core/example/src/${name}`))
})

it('does not follow linked source roots or descendant directories', () => {
  const root = fixture()
  const outside = fixture()
  write(outside, 'linked/index.ts')
  write(outside, 'linked/index.js')
  mkdirSync(join(root, 'packages/core/example/src'))
  symlinkSync(join(outside, 'linked'), join(root, 'packages/core/example/src/link'), process.platform === 'win32' ? 'junction' : 'dir')
  write(root, 'packages/core/linked/package.json', '{}')
  symlinkSync(join(outside, 'linked'), join(root, 'packages/core/linked/src'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(sourceArtifactBoundaryViolations(root)).toEqual([])
  expect(readFileSync(join(outside, 'linked/index.js'), 'utf8')).toBe('fixture')
})

it('honors workspace exclusions without ignoring source collisions in included packages', () => {
  const root = fixture()
  write(root, 'pnpm-workspace.yaml', 'packages: [packages/*/*, "!packages/core/excluded"]\n')
  write(root, 'packages/core/excluded/package.json', '{}')
  write(root, 'packages/core/excluded/src/index.ts')
  write(root, 'packages/core/excluded/src/index.js')
  expect(sourceArtifactBoundaryViolations(root)).toEqual([])
})

it('runs the standalone source check under native Node without a loader', () => {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, 'verify-source-artifact-boundaries.ts')],
    { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('no conflicting build output')
})

it('fails the native CLI before a conflicting artifact can be consumed and leaves that artifact intact', () => {
  const root = fixture()
  write(root, 'packages/core/example/src/index.ts')
  write(root, 'packages/core/example/src/index.js', 'throw new Error("stale artifact was executed")')
  const result = spawnSync(process.execPath,
    [resolve(import.meta.dirname, 'verify-source-artifact-boundaries.ts'), '--root', root], { encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('packages/core/example/src/index.js')
  expect(result.stderr).not.toContain('stale artifact was executed')
  expect(readFileSync(join(root, 'packages/core/example/src/index.js'), 'utf8')).toContain('stale artifact was executed')
})
