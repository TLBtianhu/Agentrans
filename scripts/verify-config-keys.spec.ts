import { describe, expect, it } from 'vitest'
import { collectConfigKeyViolations, configOwnerPackage, unknownConfigKeys } from './verify-config-keys.ts'

describe('config key verification', () => {
  it('accepts declared keys and reports the rest', () => {
    expect(unknownConfigKeys({ model: 'x', limit: 3 }, ['model', 'limit', 'agents[].id'])).toEqual([])
    expect(unknownConfigKeys({ model: 'x', modle: 'typo' }, ['model'])).toEqual(['modle'])
  })

  it('ignores nested schema paths when comparing top-level keys', () => {
    expect(unknownConfigKeys({ agents: [] }, ['agents[].id', 'agents[].model'])).toEqual([])
  })

  it('resolves the owning package of a Loader row', () => {
    expect(configOwnerPackage('@agentrans/agent-loop')).toBe('@agentrans/agent-loop')
    expect(configOwnerPackage('@agentrans/plugin-manager/tools')).toBe('@agentrans/plugin-manager')
    expect(configOwnerPackage('cordis-plugin-timer')).toBe('cordis-plugin-timer')
    expect(configOwnerPackage('./local/plugin.ts')).toBeUndefined()
  })

  it('finds no undeclared key in the shipped composition', () => {
    const { violations, checkedRows } = collectConfigKeyViolations()
    expect(violations).toEqual([])
    // Bundle patches and presets supply most rows; a walk that stopped at the
    // top-level array would see a handful of test fixtures instead.
    expect(checkedRows).toBeGreaterThan(50)
  })
})
