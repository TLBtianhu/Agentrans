import { describe, expect, it } from 'vitest'
import {
  bundlePatchLayers,
  collectBundleOverrideViolations,
  droppedOverrideKeys,
  patchRows,
} from './verify-bundle-overrides.ts'

describe('bundle override verification', () => {
  it('reports the keys an override drops and nothing else', () => {
    expect(droppedOverrideKeys(new Set(['a', 'b']), new Set(['a', 'b', 'c']))).toEqual([])
    expect(droppedOverrideKeys(new Set(['a', 'b']), new Set(['b']))).toEqual(['a'])
  })

  it('reads rows from insert lists and groups', () => {
    const rows = patchRows('packages/bundle/base/cordis.patch.yml')
    expect(rows.length).toBeGreaterThan(10)
    expect(rows.every(row => typeof row.id === 'string')).toBe(true)
  })

  it('resolves every workspace bundle to its patch layers', () => {
    const layers = bundlePatchLayers()
    expect(layers.get('@agentrans/base')?.length).toBeGreaterThan(0)
  })

  it('accepts the shipped profiles', () => {
    const { violations, overridesChecked } = collectBundleOverrideViolations()
    expect(violations).toEqual([])
    // Mode bundles restate a handful of base rows; a walk that missed the base
    // layer would compare nothing at all.
    expect(overridesChecked).toBeGreaterThanOrEqual(6)
  })
})
