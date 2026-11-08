/**
 * Install the scene drawing roles that the ui-theme package delivers in the app.
 *
 * Native artifact views resolve their palette from the DOM (`resolveScenePalette`
 * over computed custom properties) and fail loudly when a surface carries none.
 * jsdom has no ui-theme, so every DOM test would fail on that explicit refusal
 * rather than on the behavior it checks. Recording the values here keeps the
 * product contract intact and makes the test DOM a themed surface.
 */
import { beforeAll } from 'vitest'
import { SCENE_PALETTE_ROLES, SCENE_PALETTE_TOKENS } from '@deepseek-ai/dsh-artifact/scene-renderers'

/** Values mirror the light palette; tests assert behavior, not exact tint. */
const ROLE_VALUES: Record<(typeof SCENE_PALETTE_ROLES)[number], string> = {
  ink: '#17202b',
  inkMuted: '#647184',
  accent: '#4f56c7',
  success: '#147a5b',
  surface: '#f4f5f7',
  grid: 'rgba(82,96,128,0.14)',
  highlight: '#b45309',
  series1: '#2f6fd0',
  series2: '#b45309',
  series3: '#147a5b',
  series4: '#5b52c9',
}

beforeAll(() => {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const role of SCENE_PALETTE_ROLES) root.style.setProperty(SCENE_PALETTE_TOKENS[role], ROLE_VALUES[role])
})
