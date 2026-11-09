/** Row-set comparison of two Cordis patch documents. */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { differences, rowsOf } from './compare-composition.ts'

/**
 * Write one patch document.
 * @param body - YAML text.
 * @returns its absolute path.
 */
function patch(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'compare-composition-'))
  const path = join(directory, 'cordis.patch.yml')
  writeFileSync(path, body)
  return path
}

describe('rowsOf', () => {
  it('reads inserted rows by id', () => {
    const rows = rowsOf(patch('- insert:\n    - id: alpha\n      name: "@scope/alpha"\n'))
    expect([...rows.keys()]).toEqual(['alpha'])
    expect(rows.get('alpha')?.name).toBe('@scope/alpha')
  })

  it('keeps a literal disabled flag and drops a conditional one to undefined', () => {
    const rows = rowsOf(patch('- insert:\n    - id: off\n      name: "@scope/off"\n      disabled: true\n'))
    expect(rows.get('off')?.disabled).toBe(true)
  })

  it('flattens a group under its parent id', () => {
    const rows = rowsOf(patch('- insert:\n    - id: outer\n      name: cordis:group\n      config:\n        - id: inner\n          name: "@scope/inner"\n'))
    expect([...rows.keys()]).toContain('outer/inner')
  })
})

describe('differences', () => {
  it('reports a name change and a mount change', () => {
    const ours = { name: '@scope/a', disabled: undefined, config: undefined }
    const theirs = { name: '@scope/b', disabled: true, config: undefined }
    expect(differences(ours, theirs)).toEqual(['name: @scope/a -> @scope/b', 'disabled: null -> true'])
  })

  it('names the config keys that differ', () => {
    const ours = { name: '@scope/a', disabled: undefined, config: { model: 'x', retries: 1 } }
    const theirs = { name: '@scope/a', disabled: undefined, config: { model: 'y', retries: 1 } }
    expect(differences(ours, theirs)).toEqual(['config: model'])
  })

  it('reports nothing for identical rows', () => {
    const row = { name: '@scope/a', disabled: true, config: { model: 'x' } }
    expect(differences(row, row)).toEqual([])
  })
})
