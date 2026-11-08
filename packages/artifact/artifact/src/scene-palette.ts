/**
 * Drawing roles a scene renderer draws with, and the delivery of their values.
 *
 * A renderer is a pure function of its spec, its view state, and one resolved
 * palette. It never reads the document itself: the conversation preview resolves
 * the palette from the live theme, and the exported HTML resolves it from the
 * pinned palette it carries, so both draw with the same role names.
 *
 * Styles that own a deliberate palette (`blueprint`, `transit-map`,
 * `math-proof-lecture`, `particles`) declare that ownership here instead of
 * quietly opting out of the theme inside a renderer.
 * @module scene-palette
 */

import type { SceneStyle } from './scene.ts'

/** Color roles every scene renderer draws with. */
export const SCENE_PALETTE_ROLES = [
  'ink', 'inkMuted', 'accent', 'success', 'surface', 'grid', 'highlight',
  'series1', 'series2', 'series3', 'series4',
] as const

/** One drawing role in {@link ScenePalette}. */
export type ScenePaletteRole = typeof SCENE_PALETTE_ROLES[number]

/**
 * CSS custom property each role reads in a document that owns the theme.
 * The names are the delivery contract: a surface that carries none of them
 * cannot render a scene, and resolving fails instead of drawing invisible ink.
 */
export const SCENE_PALETTE_TOKENS: Readonly<Record<ScenePaletteRole, string>> = {
  ink: '--dsw-alias-label-primary',
  inkMuted: '--dsw-alias-label-tertiary',
  accent: '--dsw-alias-state-business-primary',
  success: '--dsw-alias-state-success-primary',
  surface: '--dsw-alias-bg-base',
  grid: '--dsw-alias-border-l2',
  highlight: '--dsw-alias-data-highlight',
  series1: '--dsw-alias-data-series-1',
  series2: '--dsw-alias-data-series-2',
  series3: '--dsw-alias-data-series-3',
  series4: '--dsw-alias-data-series-4',
}

/** Resolved role values a renderer draws with. */
export type ScenePalette = Readonly<Record<ScenePaletteRole, string>>

/** A surface did not supply a role the renderer needs. */
export class ScenePaletteError extends Error {
  /** Stable machine-readable refusal. */
  readonly code = 'SCENE_PALETTE'

  /**
   * @param role - Role whose value was empty or missing.
   * @param token - CSS custom property the role reads.
   */
  constructor(readonly role: ScenePaletteRole, readonly token: string) {
    super(`scene palette role "${role}" has no value: ${token} is unset in this surface`)
    this.name = 'ScenePaletteError'
  }
}

/**
 * Resolve every role from a document or element that carries the theme.
 * @param read - Returns the CSS custom property value for a token name.
 * @returns the resolved palette.
 * @throws {ScenePaletteError} When a role has no value.
 */
export function resolveScenePalette(read: (token: string) => string): ScenePalette {
  const palette = {} as Record<ScenePaletteRole, string>
  for (const role of SCENE_PALETTE_ROLES) {
    const token = SCENE_PALETTE_TOKENS[role]
    const value = read(token).trim()
    if (value === '') throw new ScenePaletteError(role, token)
    palette[role] = value
  }
  return Object.freeze(palette)
}

/** Which owner supplies the colors a style draws with. */
export type ScenePaletteOwnership = 'host' | 'self-contained'

/**
 * Palette ownership of every scene style.
 *
 * `host` means the renderer draws only from the resolved palette, so it follows
 * the application theme. `self-contained` means the style draws its own fixed
 * palette on purpose; the host keeps its frame and controls in the theme and
 * must not assume the drawing area follows it.
 */
export const SCENE_STYLE_PALETTES: Readonly<Record<SceneStyle, ScenePaletteOwnership>> = {
  editorial: 'host',
  'transit-map': 'self-contained',
  blueprint: 'self-contained',
  'math-proof-lecture': 'self-contained',
  particles: 'self-contained',
}

/**
 * Read the palette ownership a style draws with; an omitted style is `editorial`.
 * @param style - Style declared by the spec, when any.
 * @returns the declared palette ownership.
 */
export function scenePaletteOwnership(style: SceneStyle | undefined): ScenePaletteOwnership {
  return SCENE_STYLE_PALETTES[style ?? 'editorial']
}
