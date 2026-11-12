import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertClaudeMirrors, claudeMirrorViolations, requiredMirrors } from './verify-claude-mirror.ts'

const roots: string[] = []

function fixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-mirror-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('CLAUDE mirror', () => {
  it('accepts identical copies at any depth', () => {
    const root = fixture({
      'AGENTS.md': 'root rules\n',
      'CLAUDE.md': 'root rules\n',
      'packages/AGENTS.md': 'package rules\n',
      'packages/CLAUDE.md': 'package rules\n',
    })
    expect(requiredMirrors(root).map(check => check.mirror)).toEqual(['CLAUDE.md', 'packages/CLAUDE.md'])
    expect(claudeMirrorViolations(root)).toEqual([])
    expect(() => assertClaudeMirrors(root)).not.toThrow()
  })

  it('reports a drifted copy with both paths', () => {
    const root = fixture({ 'AGENTS.md': 'root rules\n', 'CLAUDE.md': 'root rules\nand one more\n' })
    expect(claudeMirrorViolations(root)).toEqual(['CLAUDE.md differs from AGENTS.md; edit one and copy it over the other'])
    expect(() => assertClaudeMirrors(root)).toThrow('CLAUDE.md differs from AGENTS.md')
  })

  it('reports a mirror that lost its original', () => {
    const root = fixture({ 'packages/CLAUDE.md': 'package rules\n' })
    expect(claudeMirrorViolations(root)).toEqual(['packages/CLAUDE.md has no sibling packages/AGENTS.md; a mirror cannot stand alone'])
  })

  it('refuses an empty corpus', () => {
    const root = fixture({ 'AGENTS.md': 'root rules\n' })
    expect(() => requiredMirrors(root)).toThrow('the repository carries no CLAUDE.md')
  })
})
