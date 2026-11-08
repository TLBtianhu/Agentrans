import { describe, expect, it } from 'vitest'
import { getArtifactSourceCapabilities } from '../src/capabilities.ts'
import { normalizeSceneSpec, sceneCatalog } from '../src/scene.ts'
import type { ArtifactId, HtmlArtifactSnapshot, SceneArtifactSnapshot } from '../src/types.ts'

function scene(spec: unknown): SceneArtifactSnapshot {
  return {
    artifactId: 'capability-source' as ArtifactId, revision: 1, title: 'Capability source',
    format: 'scene', presentation: 'inline', spec: normalizeSceneSpec(spec),
  }
}

const nativeSources = [
  {
    kind: 'function-plot', functions: [{ id: 'x', expression: 'x' }], parameters: {},
    viewport: { x: [-1, 1], y: [-1, 1] }, trace: { x: 0, derivative: false, integral: false },
  },
  { kind: 'flowchart', nodes: [{ id: 'a', label: 'A', x: 0, y: 0 }], edges: [] },
  {
    kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 0, vx: 1, vy: 0, mass: 1 }],
    gravity: { x: 0, y: -1 }, timeStep: 0.1, trails: false,
  },
  { kind: 'timeline', events: [{ id: 'a', label: 'A', time: 0 }] },
  { kind: 'network-graph', nodes: [{ id: 'a', label: 'A', x: 0, y: 0 }], edges: [] },
  { kind: 'map', markers: [{ id: 'a', label: 'A', x: 0, y: 0 }] },
]

describe('Artifact source capabilities', () => {
  it.each(nativeSources)('declares source semantics for $kind without executing or changing its source', (spec) => {
    const snapshot = scene(spec)
    const before = JSON.stringify(snapshot)
    const capabilities = getArtifactSourceCapabilities(snapshot)
    const particle = snapshot.spec.kind === 'particle-system'
    expect(capabilities).toEqual({
      observe: particle ? 'particle' : 'unsupported',
      save: particle ? 'particle' : 'unsupported',
      restore: particle ? 'particle' : 'unsupported',
      compare: particle ? 'saved-particle-pair' : 'unsupported',
      questionContext: particle ? 'particle' : 'unsupported',
      exportHtml: particle ? 'particle-checkpoint-or-source-defaults' : 'source-defaults',
    })
    expect(capabilities).toBe(sceneCatalog[snapshot.spec.kind].sourceCapabilities)
    expect(getArtifactSourceCapabilities(snapshot)).toBe(capabilities)
    expect(Object.isFrozen(capabilities)).toBe(true)
    expect(JSON.stringify(snapshot)).toBe(before)
  })

  it('retains HTML reports as program claims without inferring Host calculations from authored code', () => {
    const snapshot: HtmlArtifactSnapshot = {
      artifactId: 'html-source' as ArtifactId, revision: 2, title: 'HTML source',
      format: 'html', presentation: 'inline',
      source: '<script>throw new Error("must not run");</script><p>Supports save, restore and deterministic replay</p>',
    }
    const before = JSON.stringify(snapshot)
    const capabilities = getArtifactSourceCapabilities(snapshot)
    expect(capabilities).toEqual({
      observe: 'unsupported', save: 'unsupported', restore: 'unsupported', compare: 'unsupported',
      questionContext: 'program-reported', exportHtml: 'unsupported',
    })
    expect(getArtifactSourceCapabilities({ ...snapshot, revision: 3, source: '<p>New source</p>' })).toBe(capabilities)
    expect(Object.isFrozen(capabilities)).toBe(true)
    expect(JSON.stringify(snapshot)).toBe(before)
  })
})
