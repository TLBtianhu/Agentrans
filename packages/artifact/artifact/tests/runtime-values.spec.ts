import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { snapshotJsonValue } from '@agentrans/util-values'
import {
  ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES, isArtifactBfsCheckpoint, isArtifactHalfAdderCheckpoint,
  isArtifactHtmlCheckpoint, isBoundedArtifactJson,
} from '../src/runtime-values.ts'

const valid = (value: unknown) => isBoundedArtifactJson(value, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES)

describe('bounded Artifact JSON', () => {
  it('accepts lossless plain data, null-prototype records and shared references', () => {
    const shared = { value: ['x', true, null, 0, -2.5] }
    const prototypeNames: unknown = JSON.parse('{"__proto__":{"safe":true},"constructor":"data"}')
    for (const value of [null, true, false, 0, -2.5, 'text', [], {}, { first: shared, second: shared },
      Object.assign(Object.create(null), { value: 1 }), prototypeNames]) {
      expect(valid(value)).toBe(true)
      expect(snapshotJsonValue(value)).toEqual(value)
    }
  })

  it('accepts intrinsic plain objects and arrays from another realm', () => {
    const foreign: unknown = runInNewContext('({state:[1,{ok:true}]})')
    expect(valid(foreign)).toBe(true)
    expect(snapshotJsonValue(foreign)).toEqual(foreign)
  })

  it.each([undefined, -0, Number.NaN, Number.POSITIVE_INFINITY, () => 1, 1n, Symbol('value'), new Date(0),
    new Map(), new Set(), Object.create({ inherited: 1 }), [undefined], { missing: undefined }, { value: -0 },
  ])('rejects data JSON would change or discard %#', (value) => {
    expect(valid(value)).toBe(false)
  })

  it('rejects sparse arrays, array properties, symbols and non-enumerable data', () => {
    const sparse = Array.from({ length: 2 }, () => null)
    Reflect.deleteProperty(sparse, '0')
    const extra = [1]
    Object.defineProperty(extra, 'extra', { value: 2, enumerable: true })
    const symbol = { [Symbol('key')]: 1 }
    const hidden = Object.defineProperty({}, 'hidden', { value: 1 })
    const index = Object.defineProperty([1], '0', { value: 1, enumerable: false })
    class CustomArray extends Array<number> {}
    for (const value of [sparse, extra, symbol, hidden, index, new CustomArray(1)]) expect(valid(value)).toBe(false)
  })

  it('rejects accessors without reading them and contains failed reflection traps', () => {
    let reads = 0
    const object = Object.defineProperty({}, 'value', { enumerable: true, get: () => { reads++; return 1 } })
    const array = Object.defineProperty([0], '0', { enumerable: true, get: () => { reads++; return 1 } })
    expect(valid(object)).toBe(false)
    expect(valid(array)).toBe(false)
    expect(reads).toBe(0)
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    expect(valid(revoked.proxy)).toBe(false)
  })

  it('accepts exact depth and node limits and rejects one additional value', () => {
    let nested: unknown = null
    for (let depth = 1; depth < ARTIFACT_JSON_MAX_DEPTH; depth++) nested = { nested }
    expect(valid(nested)).toBe(true)
    expect(valid({ nested })).toBe(false)
    expect(valid(Array.from({ length: ARTIFACT_JSON_MAX_NODES - 1 }, () => null))).toBe(true)
    expect(valid(Array.from({ length: ARTIFACT_JSON_MAX_NODES }, () => null))).toBe(false)
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    expect(valid(cycle)).toBe(false)
  })

  it('executes the serialized validator without module bindings', () => {
    const foreign: unknown = runInNewContext(`(${isBoundedArtifactJson.toString()})({values:[1,true,null]},32,2048)`)
    expect(foreign).toBe(true)
    expect(runInNewContext(`(${isBoundedArtifactJson.toString()})({values:[-0]},32,2048)`)).toBe(false)
  })
})

describe('BFS checkpoint shape', () => {
  it('accepts the ordered traversal data when serialized into a sandbox', () => {
    const state = { kind: 'bfs-checkpoint', current: 'B', queue: ['D', 'C'], visited: ['A', 'B'] }
    expect(runInNewContext(`(${isArtifactBfsCheckpoint.toString()})(${JSON.stringify(state)})`)).toBe(true)
    expect(isArtifactBfsCheckpoint({ ...state, current: null, queue: [], visited: [] })).toBe(true)
  })

  it('rejects incomplete, ambiguous and oversized traversal states', () => {
    const state = { kind: 'bfs-checkpoint', current: 'B', queue: ['D', 'C'], visited: ['A', 'B'] }
    for (const invalid of [{ ...state, current: 'C' }, { ...state, queue: ['D', 'D'] }, { ...state, visited: ['B', 'B'] },
      { ...state, queue: ['node X'] }, { ...state, queue: ['x'.repeat(33)] },
      { ...state, queue: Array.from({ length: 65 }, (_, index) => `node${index}`) }, { ...state, extras: [] }]) {
      expect(isArtifactBfsCheckpoint(invalid)).toBe(false)
    }
  })
})

describe('half-adder checkpoint', () => {
  it.each([[0, 0, 0, 0], [0, 1, 1, 0], [1, 0, 1, 0], [1, 1, 0, 1]])('accepts truth table row %i %i', (a, b, sum, carry) => {
    const state = { kind: 'half-adder-checkpoint', a, b, sum, carry }
    expect(isArtifactHtmlCheckpoint(state)).toBe(true)
    expect(runInNewContext(`(${isArtifactHalfAdderCheckpoint.toString()})(${JSON.stringify(state)})`)).toBe(true)
    expect(isArtifactHtmlCheckpoint({ ...state, carry: 1 - carry })).toBe(false)
    expect(isArtifactHtmlCheckpoint({ ...state, sum: 1 - sum })).toBe(false)
    expect(isArtifactHtmlCheckpoint({ ...state, a: String(a) })).toBe(false)
    expect(isArtifactHtmlCheckpoint({ ...state, extra: 0 })).toBe(false)
  })
})
