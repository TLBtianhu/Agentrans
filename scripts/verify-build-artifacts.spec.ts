import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  declaredRuntimeArtifacts,
  declaredRuntimePaths,
  missingRuntimeArtifacts,
  verifyBuildArtifacts,
} from './verify-build-artifacts.ts'

const roots: string[] = []

function fixture(manifests: Readonly<Record<string, unknown>>, files: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'build-artifacts-'))
  roots.push(root)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*/*'\n")
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-root', version: '0.0.0' }))
  for (const [directory, manifest] of Object.entries(manifests)) {
    mkdirSync(join(root, directory), { recursive: true })
    writeFileSync(join(root, directory, 'package.json'), JSON.stringify(manifest))
  }
  for (const path of files) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), '')
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('declared runtime paths', () => {
  it('collects main, bin, and every exports condition that names a lib runtime file', () => {
    expect(declaredRuntimePaths({
      main: 'lib/index.js',
      bin: { command: './lib/bin.cjs' },
      exports: {
        '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
        './profile-boot': './lib/profile-boot.mjs',
        './lib/*': './lib/*',
        './src/*': './src/*',
      },
    })).toEqual(['lib/bin.cjs', 'lib/index.js', 'lib/profile-boot.mjs'])
  })

  it('ignores unrelated manifests and non-runtime declarations', () => {
    expect(declaredRuntimePaths({ name: 'no-entry' })).toEqual([])
    expect(declaredRuntimePaths({ main: 'lib/index.d.ts' })).toEqual([])
    expect(declaredRuntimePaths({ main: 'lib/index.js.map' })).toEqual([])
    expect(declaredRuntimePaths(undefined)).toEqual([])
  })
})

describe('declared runtime artifacts', () => {
  it('lists each declared artifact with its declaring manifest', () => {
    const root = fixture({
      'packages/core/alpha': { name: '@agentrans/alpha', main: 'lib/index.js' },
      'packages/core/beta': { name: '@agentrans/beta', exports: { '.': './lib/index.mjs' } },
    }, ['packages/core/alpha/lib/index.js', 'packages/core/beta/lib/index.mjs'])
    expect(declaredRuntimeArtifacts(root)).toEqual([
      { path: 'packages/core/alpha/lib/index.js', declaredBy: 'packages/core/alpha/package.json' },
      { path: 'packages/core/beta/lib/index.mjs', declaredBy: 'packages/core/beta/package.json' },
    ])
    expect(missingRuntimeArtifacts(root)).toEqual([])
  })

  it('refuses a corpus with no declared runtime entry', () => {
    const root = fixture({ 'packages/core/alpha': { name: '@agentrans/alpha' } })
    expect(() => declaredRuntimeArtifacts(root)).toThrow('no workspace manifest declares a runtime entry')
  })
})

describe('build artifact verification', () => {
  it('reports every missing artifact and the absent client build record together', () => {
    const root = fixture({
      'packages/core/alpha': { name: '@agentrans/alpha', main: 'lib/index.js' },
      'packages/core/beta': { name: '@agentrans/beta', main: 'lib/index.js' },
    }, ['packages/core/alpha/lib/index.js'])
    expect(missingRuntimeArtifacts(root)).toEqual([
      { path: 'packages/core/beta/lib/index.js', declaredBy: 'packages/core/beta/package.json' },
    ])
    expect(() => verifyBuildArtifacts(root))
      .toThrow(/packages\/core\/beta\/lib\/index\.js \(declared by packages\/core\/beta\/package\.json\)/)
    expect(() => verifyBuildArtifacts(root)).toThrow('client build record .dsh-build/client-build-environment.json is missing')
    expect(() => verifyBuildArtifacts(root)).toThrow('Run a complete `pnpm run build`')
  })
})
