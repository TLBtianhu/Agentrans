import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { assembleMacRelease, mergeMacMetadataDocuments } from '../scripts/merge-mac-metadata.mjs'
import type { MacMetadataDocument, MacMetadataFile } from '../scripts/merge-mac-metadata.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function document(version: string, files: MacMetadataFile[], releaseDate?: string): MacMetadataDocument {
  const [first] = files
  return { version, files, path: first?.url ?? '', ...(first === undefined ? {} : { sha512: first.sha512 }), ...(releaseDate === undefined ? {} : { releaseDate }) }
}

describe('mergeMacMetadataDocuments', () => {
  it('lists both architectures so the updater can pick one', () => {
    const merged = mergeMacMetadataDocuments([
      document('0.1.0', [{ url: 'agentrans-0.1.0-mac-arm64-unsigned.zip', sha512: 'arm', size: 2 }]),
      document('0.1.0', [{ url: 'agentrans-0.1.0-mac-x64-unsigned.zip', sha512: 'x64', size: 3 }]),
    ])
    expect(merged.files.map(file => file.url)).toEqual([
      'agentrans-0.1.0-mac-arm64-unsigned.zip',
      'agentrans-0.1.0-mac-x64-unsigned.zip',
    ])
    expect(merged.path).toBe('agentrans-0.1.0-mac-arm64-unsigned.zip')
    expect(merged.sha512).toBe('arm')
  })

  it('refuses documents from different versions', () => {
    expect(() => mergeMacMetadataDocuments([
      document('0.1.0', [{ url: 'a.zip', sha512: 'a', size: 1 }]),
      document('0.2.0', [{ url: 'b.zip', sha512: 'b', size: 1 }]),
    ])).toThrow(/versions disagree/u)
  })

  it('refuses one url carrying two digests', () => {
    expect(() => mergeMacMetadataDocuments([
      document('0.1.0', [{ url: 'same.zip', sha512: 'one', size: 1 }]),
      document('0.1.0', [{ url: 'same.zip', sha512: 'two', size: 1 }]),
    ])).toThrow(/different digests/u)
  })

  it('keeps the newest release date', () => {
    const merged = mergeMacMetadataDocuments([
      document('0.1.0', [{ url: 'a.zip', sha512: 'a', size: 1 }], '2026-01-01T00:00:00.000Z'),
      document('0.1.0', [{ url: 'b.zip', sha512: 'b', size: 1 }], '2026-02-01T00:00:00.000Z'),
    ])
    expect(merged.releaseDate).toBe('2026-02-01T00:00:00.000Z')
  })
})

describe('assembleMacRelease', () => {
  it('copies each architecture artifact and writes one metadata file', () => {
    const root = mkdtempSync(join(tmpdir(), 'mac-release-'))
    roots.push(root)
    const arm = join(root, 'arm')
    const x64 = join(root, 'x64')
    const out = join(root, 'out')
    for (const directory of [arm, x64]) mkdirSync(directory, { recursive: true })
    writeFileSync(join(arm, 'agentrans-0.1.0-mac-arm64-unsigned.zip'), 'arm-archive')
    writeFileSync(join(arm, 'agentrans-0.1.0-mac-arm64-unsigned.dmg'), 'arm-disk')
    writeFileSync(join(x64, 'agentrans-0.1.0-mac-x64-unsigned.zip'), 'x64-archive')
    writeFileSync(join(arm, 'latest-mac.yml'), yaml.dump(document('0.1.0', [
      { url: 'agentrans-0.1.0-mac-arm64-unsigned.zip', sha512: 'arm', size: 11 },
      { url: 'agentrans-0.1.0-mac-arm64-unsigned.dmg', sha512: 'armdmg', size: 4 },
    ])))
    writeFileSync(join(x64, 'latest-mac.yml'), yaml.dump(document('0.1.0', [
      { url: 'agentrans-0.1.0-mac-x64-unsigned.zip', sha512: 'x64', size: 11 },
    ])))

    const result = assembleMacRelease([arm, x64], out)

    expect(result.copied).toBe(3)
    expect(readdirSync(out).sort()).toEqual([
      'agentrans-0.1.0-mac-arm64-unsigned.dmg',
      'agentrans-0.1.0-mac-arm64-unsigned.zip',
      'agentrans-0.1.0-mac-x64-unsigned.zip',
      'latest-mac.yml',
    ])
    const merged = yaml.load(readFileSync(result.metadata, 'utf8')) as { files: { url: string }[] }
    expect(merged.files.map(file => file.url)).toEqual([
      'agentrans-0.1.0-mac-arm64-unsigned.dmg',
      'agentrans-0.1.0-mac-arm64-unsigned.zip',
      'agentrans-0.1.0-mac-x64-unsigned.zip',
    ])
  })
})
