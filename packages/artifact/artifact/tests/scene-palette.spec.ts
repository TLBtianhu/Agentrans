/** The scene palette is the whole color contract a renderer reads. */
import { describe, expect, it } from 'vitest'
import {
  SCENE_PALETTE_ROLES, SCENE_PALETTE_TOKENS, SCENE_STYLE_PALETTES, ScenePaletteError,
  resolveScenePalette, scenePaletteOwnership, type ScenePalette,
} from '../src/scene-palette.ts'
import { SCENE_STYLES } from '../src/scene.ts'
/** A complete palette with recognizable values. */
function palette(): ScenePalette {
  return resolveScenePalette(token => `value${token}`)
}

describe('scene palette roles', () => {
  it('resolves every role from the token names it declares', () => {
    const resolved = resolveScenePalette(token => ` ${token} `)
    for (const role of SCENE_PALETTE_ROLES) {
      expect(resolved[role]).toBe(SCENE_PALETTE_TOKENS[role])
    }
    expect(Object.isFrozen(resolved)).toBe(true)
  })

  it('names the role and its token when a surface supplies no value', () => {
    const read = (token: string): string => token === SCENE_PALETTE_TOKENS.series2 ? '' : 'x'
    expect(() => resolveScenePalette(read)).toThrow(ScenePaletteError)
    try {
      resolveScenePalette(read)
      expect.unreachable('a partial palette must not resolve')
    } catch (error) {
      expect(error).toBeInstanceOf(ScenePaletteError)
      const failure = error as ScenePaletteError
      expect(failure.role).toBe('series2')
      expect(failure.code).toBe('SCENE_PALETTE')
      expect(failure.message).toContain(SCENE_PALETTE_TOKENS.series2)
    }
  })

  it('declares a palette owner for every scene style and defaults to editorial', () => {
    expect(Object.keys(SCENE_STYLE_PALETTES).sort()).toEqual([...SCENE_STYLES].sort())
    expect(scenePaletteOwnership(undefined)).toBe('host')
    expect(scenePaletteOwnership('editorial')).toBe('host')
    for (const style of ['transit-map', 'blueprint', 'math-proof-lecture', 'particles'] as const) {
      expect(scenePaletteOwnership(style)).toBe('self-contained')
    }
  })
})

describe('scene palette delivery', () => {
  it('keeps role values independent between two resolved palettes', () => {
    const light = palette()
    const dark = resolveScenePalette(() => '#000000')
    expect(light.ink).not.toBe(dark.ink)
    expect(dark.ink).toBe('#000000')
  })
})
