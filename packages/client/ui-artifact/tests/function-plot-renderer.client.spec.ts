// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FunctionPlotSpec } from '@deepseek-ai/dsh-artifact/scene'
import { resolveScenePalette } from '@deepseek-ai/dsh-artifact/scene-renderers'
import { renderFunctionPlot } from '../src/client/renderers/function-plot.ts'

afterEach(() => { vi.restoreAllMocks() })

/** Complete palette whose accent is recognizable in the recorded strokes. */
const palette = resolveScenePalette(token => token === '--dsw-alias-state-business-primary' ? '#123456' : '#888888')

describe('function-plot rendering at domain gaps', () => {
  it.each(['sqrt(x)', 'log(x)', '1/x'])('draws the finite portions of %s without non-finite canvas coordinates', (expression) => {
    const canvas = document.createElement('canvas')
    const strokes: { color: string; points: { kind: 'move' | 'line'; x: number; y: number }[] }[] = []
    let points: (typeof strokes)[number]['points'] = []
    const coordinate = (kind: 'move' | 'line', x: number, y: number): void => {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true)
      points.push({ kind, x, y })
    }
    const context: Partial<CanvasRenderingContext2D> = {
      strokeStyle: '',
      beginPath: () => { points = [] },
      moveTo: (x: number, y: number) => { coordinate('move', x, y) },
      lineTo: (x: number, y: number) => { coordinate('line', x, y) },
      stroke: () => { strokes.push({ color: typeof context.strokeStyle === 'string' ? context.strokeStyle : '', points: [...points] }) },
      clearRect: vi.fn(), fillRect: vi.fn(), closePath: vi.fn(), fill: vi.fn(), setLineDash: vi.fn(),
      arc: (x: number, y: number) => { expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true) },
      fillText: vi.fn(),
    }
    vi.spyOn(canvas, 'getContext').mockReturnValue(context as CanvasRenderingContext2D)
    const spec: FunctionPlotSpec = {
      kind: 'function-plot', functions: [{ id: 'domain', label: expression, expression }], parameters: {},
      viewport: { x: [-1, 1], y: [-2, 2] }, trace: { x: 0, derivative: true, integral: true },
    }
    renderFunctionPlot(spec, canvas, 200, 100, {
      traceX: 0, scale: 1, pan: 0, parameters: {}, showDerivative: true, showIntegral: true,
    }, palette)
    const curve = strokes.find(stroke => stroke.color === '#123456')
    expect(curve?.points.length).toBeGreaterThan(0)
    if (expression === '1/x') {
      const starts = curve?.points.filter(point => point.kind === 'move') ?? []
      expect(starts).toHaveLength(2)
      expect(starts[0]?.x).toBeLessThan(100)
      expect(starts[1]?.x).toBeGreaterThan(100)
    }
  })
})
