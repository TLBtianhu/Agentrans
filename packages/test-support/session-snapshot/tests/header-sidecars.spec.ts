import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveSystemPromptSnapshotPath,
  resolveToolSchemasSnapshotPath,
  systemPromptSnapshotFilename,
  toolSchemasSnapshotFilename,
} from '../src/header-sidecars.ts'
import type { SnapshotHeaderManifest } from '../src/manifest.ts'

describe.each([
  { name: 'tool schemas', field: 'toolSchemas', shared: 'tool-schemas.expected.json', variant: 'tool-schemas.win32.expected.json',
    select: toolSchemasSnapshotFilename, resolve: resolveToolSchemasSnapshotPath },
  { name: 'system prompt', field: 'systemPrompt', shared: 'system-prompt.expected.md', variant: 'system-prompt.win32.expected.md',
    select: systemPromptSnapshotFilename, resolve: resolveSystemPromptSnapshotPath },
])('$name platform sidecars', ({ field, shared, variant, select, resolve }) => {
  const header: SnapshotHeaderManifest = { class: 'default', toolSchemasVariants: ['win32'], systemPromptVariants: ['win32'] }

  it.each(['linux', 'darwin', 'freebsd'] as const)('keeps the shared oracle on %s', (platform) => {
    expect(select(header, platform)).toBe(shared)
  })

  it('selects Windows only when its owner explicitly declares the variant', () => {
    expect(select(header, 'win32')).toBe(variant)
    expect(select({}, 'win32')).toBe(shared)
    expect(select(undefined, 'win32')).toBe(shared)
    expect(select(header)).toBe(select(header, process.platform))
  })

  it('inherits variants from an explicit cross-profile owner through local references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-header-owner-'))
    const directory = (name: string): string => join(root, name)
    const manifest = async (name: string, metadata: string): Promise<void> => {
      await mkdir(directory(name), { recursive: true })
      await writeFile(join(directory(name), 'snapshot.yml'), `version: 1\nprofile: headless\nheader:\n  class: default\n${metadata}`)
    }
    try {
      await manifest('session/owner', `  ${field}Variants: [win32]\n`)
      await manifest('sdk/local', `  ${field}Source: session/owner\n`)
      await manifest('sdk/borrower', `  ${field}Source: local\n`)
      await writeFile(join(directory('session/owner'), shared), 'shared independent oracle')
      const selected = await resolve(directory('sdk/borrower'), 'win32')
      expect(selected).toBe(join(directory('session/owner'), variant))
      await expect(readFile(selected, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(await resolve(directory('sdk/borrower'), 'darwin'), 'utf8'))
        .toBe('shared independent oracle')
      await writeFile(selected, 'Windows independent oracle')
      expect(await readFile(await resolve(directory('sdk/borrower'), 'win32'), 'utf8'))
        .toBe('Windows independent oracle')
      expect(await readFile(await resolve(directory('sdk/borrower'), 'linux'), 'utf8'))
        .toBe('shared independent oracle')

      await manifest('sdk/self', `  ${field}Source: self\n  ${field}Variants: [win32]\n`)
      expect(await resolve(directory('sdk/self'), 'win32')).toBe(join(directory('sdk/self'), variant))
      await manifest('sdk/borrower', `  ${field}Source: local\n  ${field}Variants: [win32]\n`)
      await expect(resolve(directory('sdk/borrower'), 'win32')).rejects.toThrow(`${field}Variants requires ownership`)
      await manifest('sdk/borrower', `  ${field}Source: local\n`)
      await manifest('sdk/local', `  ${field}Source: borrower\n`)
      await expect(resolve(directory('sdk/borrower'), 'win32')).rejects.toThrow('cyclic')
      await manifest('sdk/local', `  ${field}Source: missing\n`)
      await expect(resolve(directory('sdk/borrower'), 'win32')).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(join(directory('sdk/local'), 'snapshot.yml'), `version: 1\nprofile: headless\nheader:\n  class: default\n  ${field}Variants: [linux]\n`)
      await expect(resolve(directory('sdk/borrower'), 'win32')).rejects.toThrow(`${field}Variants must be a non-empty array`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
