/** The accepted function-only SceneSpec remains readable while new families retain explicit discriminants. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import {
  normalizeFunctionPlot, normalizeSceneSpec, SceneValidationError, type FunctionPlotSpec, type SceneSpec,
} from '@agentrans/artifact/scene'
import { parsePersistenceSnapshot } from './persistence-changes.ts'
import type { CanonicalSchema } from './persistence-schema-model.ts'

function propertyType(schema: CanonicalSchema, index: number, name: string): number {
  const node = schema.nodes[index]
  if (node?.kind !== 'object') throw new Error('Expected an accepted object schema')
  const property = node.properties.find(property => property.name === name)
  if (property === undefined) throw new Error(`Accepted schema lacks ${name}`)
  return property.type
}

function literalValue(schema: CanonicalSchema, index: number) {
  const node = schema.nodes[index]
  if (node?.kind !== 'literal') throw new Error('Expected an accepted literal discriminator')
  return node.value
}

it('keeps the accepted SceneSpec discriminator explicitly function-plot rather than an open string', () => {
  const snapshot = parsePersistenceSnapshot(readFileSync(new URL(
    '../docs/persistence-changes/2026-11-04-artifact-scene-spec.schema.json', import.meta.url,
  ), 'utf8'))
  const root = snapshot.roots.find(root => root.key === 'event:artifact/upsert')
  if (root === undefined) throw new Error('Accepted Artifact schema is missing')
  const { schema } = root
  const data = schema.nodes[propertyType(schema, schema.root, 'data')]
  if (data?.kind !== 'union') throw new Error('Expected HTML and SceneSpec alternatives')
  const scene = data.types.find(index => literalValue(schema, propertyType(schema, index, 'format')) === 'scene')
  if (scene === undefined) throw new Error('Accepted SceneSpec alternative is missing')
  const spec = propertyType(schema, scene, 'spec')
  expect(literalValue(schema, propertyType(schema, spec, 'kind'))).toBe('function-plot')
})

const acceptedFunction: FunctionPlotSpec = {
  kind: 'function-plot', functions: [{ id: 'wave', label: 'Wave', expression: 'a*sin(x)' }],
  parameters: { a: { value: 1, min: 0, max: 2, step: 0.1 } },
  viewport: { x: [-2, 2], y: [-2, 2] }, trace: { x: 0, derivative: true, integral: false },
  timeline: { duration: 3, fps: 30 },
}

it('reads an accepted function-plot source with the current catalog without changing its calculation fields', () => {
  const normalized = normalizeSceneSpec(acceptedFunction)
  expect(normalized).toMatchObject(acceptedFunction)
  expect(normalized.kind).toBe('function-plot')
  expect(normalizeFunctionPlot(acceptedFunction)).toEqual(normalized)
})

const additionalKinds: readonly Exclude<SceneSpec, FunctionPlotSpec>[] = [
  { kind: 'flowchart', nodes: [{ id: 'start', label: 'Start', x: 0, y: 0 }], edges: [] },
  {
    kind: 'particle-system', particles: [{ id: 'alpha', x: 1, y: 1, vx: 3, vy: 8, mass: 1 }],
    gravity: { x: 0, y: -9.8 }, timeStep: 1 / 30, trails: true,
  },
  { kind: 'timeline', events: [{ id: 'start', label: 'Start', time: 0 }] },
  { kind: 'network-graph', nodes: [{ id: 'start', label: 'Start', x: 0, y: 0 }], edges: [] },
  { kind: 'map', markers: [{ id: 'start', label: 'Start', x: 0, y: 0 }] },
]

it.each(additionalKinds)('keeps $kind out of the function-only validator and accepts it through the current catalog', (spec) => {
  let failure: unknown
  try {
    normalizeFunctionPlot(spec)
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(SceneValidationError)
  expect(failure).toMatchObject({ path: '/kind' })
  expect(normalizeSceneSpec(spec)).toMatchObject(spec)
})
