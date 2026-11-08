/**
 * The scene renderers draw from one resolved palette and from nothing else.
 *
 * This gate exists because the failure it prevents is invisible: a renderer that
 * reads its own colors still draws, it just stops following the theme, and an
 * exported document that carries no palette draws transparent ink instead of
 * failing. Both mistakes are checked here by reading the renderer sources.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SCENE_PALETTE_ROLES, SCENE_STYLE_PALETTES } from '../src/scene-palette.ts'
import { SCENE_STYLES } from '../src/scene.ts'

const RENDERER_DIRECTORY = fileURLToPath(new URL('../src/renderers/', import.meta.url))

/** Renderer sources keyed by file name. */
function rendererSources(): ReadonlyMap<string, string> {
  return new Map(readdirSync(RENDERER_DIRECTORY)
    .filter(name => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    .map(name => [name, readFileSync(join(RENDERER_DIRECTORY, name), 'utf8')]))
}

/** Renderers that own a deliberate palette for their self-contained style. */
const SELF_CONTAINED_PALETTE_FILES = ['flowchart.ts', 'function-plot.ts', 'network-graph.ts', 'particle-system.ts', 'timeline.ts']

describe('scene renderer palette contract', () => {
  it('never reads the document for colors', () => {
    for (const [name, source] of rendererSources()) {
      expect(source, name).not.toContain('getComputedStyle')
      expect(source, name).not.toContain('--dsw-')
    }
  })

  it('keeps literal colors inside files that own a self-contained style', () => {
    for (const [name, source] of rendererSources()) {
      if (SELF_CONTAINED_PALETTE_FILES.includes(name)) continue
      expect(source.match(/#[0-9a-f]{3,8}\b/giu) ?? [], name).toEqual([])
    }
  })

  it('declares palette ownership for every style the spec layer accepts', () => {
    expect(Object.keys(SCENE_STYLE_PALETTES).sort()).toEqual([...SCENE_STYLES].sort())
    const declared = new Set(Object.values(SCENE_STYLE_PALETTES))
    expect([...declared].sort()).toEqual(['host', 'self-contained'])
  })

  it('exposes the role table the deliverers resolve against', () => {
    expect([...SCENE_PALETTE_ROLES]).toContain('series1')
    expect(new Set(SCENE_PALETTE_ROLES).size).toBe(SCENE_PALETTE_ROLES.length)
  })
})
