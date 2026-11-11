/** Framework-free function-plot renderer shared by the conversation preview and the animation exporter. */
import { parseExpression } from '@agentrans/util-values'
import { analyzeFunction, evaluateFunction } from './function-analysis.ts'
import type { FunctionPlotSpec } from '../scene.ts'
import type { ScenePalette } from '../scene-palette.ts'

const COLUMNS = 6
const ROWS = 4

/** Mutable view state for a function-plot render. */
export interface FunctionPlotRenderState {
  readonly traceX: number
  readonly scale: number
  readonly pan: number
  readonly parameters: Readonly<Record<string, number>>
  readonly currentFunctionId?: string
  readonly showDerivative: boolean
  readonly showIntegral: boolean
}

/**
 * Render a validated FunctionPlot SceneSpec onto a canvas.
 * @param spec - Function-plot SceneSpec to draw.
 * @param canvas - Canvas element to draw on.
 * @param width - Canvas width in pixels.
 * @param height - Canvas height in pixels.
 * @param state - Trace position, zoom, pan, parameters, and analysis toggles.
 * @param palette - Resolved drawing roles; the proof-lecture style overrides them.
 */
export function renderFunctionPlot(
  spec: FunctionPlotSpec,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  state: FunctionPlotRenderState,
  palette: ScenePalette,
): void {
  const context = canvas.getContext('2d')
  if (!context) return
  const functions = spec.functions.map(fn => ({ ...fn, node: parseExpression(fn.expression, Object.keys(spec.parameters)) }))
  const currentFunction = functions.find(fn => fn.id === state.currentFunctionId) ?? functions[0]
  if (!currentFunction) return
  const { traceX, scale, pan, parameters, showDerivative, showIntegral } = state
  const evaluateAt = (fn: (typeof functions)[number], x: number): number | null => evaluateFunction(fn.node, parameters, x)
  const { ink, inkMuted: muted, accent, success: good, grid } = palette
  const isProofLecture = spec.style === 'math-proof-lecture'
  const primaryInk = isProofLecture ? '#c7c7c9' : ink
  const secondaryInk = isProofLecture ? '#6f7480' : muted
  const subjectColor = isProofLecture ? '#fed74b' : accent
  const baselineColor = isProofLecture ? '#5ac4dc' : good
  const gridColor = isProofLecture ? 'rgba(199,199,201,0.08)' : grid
  if (isProofLecture) {
    context.fillStyle = '#0a0b0f'
    context.fillRect(0, 0, width, height)
  }
  const [xMin, xMax] = spec.viewport.x
  const [yMin, yMax] = spec.viewport.y
  const xRange = (xMax - xMin) / scale
  const yRange = (yMax - yMin) / scale
  const centerX = (xMin + xMax) / 2 + pan
  const centerY = (yMin + yMax) / 2
  const xToPixel = (x: number): number => ((x - (centerX - xRange / 2)) / xRange) * width
  const yToPixel = (y: number): number => height - ((y - (centerY - yRange / 2)) / yRange) * height
  const pixelToX = (pixel: number): number => centerX - xRange / 2 + (pixel / width) * xRange
  const analysis = analyzeFunction(currentFunction.node, parameters, traceX)
  const currentValue = analysis.value

  context.clearRect(0, 0, width, height)
  context.strokeStyle = gridColor
  context.lineWidth = 1
  for (let index = 0; index <= COLUMNS; index++) {
    const x = centerX - xRange / 2 + (index / COLUMNS) * xRange
    context.beginPath(); context.moveTo(xToPixel(x), 0); context.lineTo(xToPixel(x), height); context.stroke()
  }
  for (let index = 0; index <= ROWS; index++) {
    const y = centerY - yRange / 2 + (index / ROWS) * yRange
    context.beginPath(); context.moveTo(0, yToPixel(y)); context.lineTo(width, yToPixel(y)); context.stroke()
  }
  context.strokeStyle = secondaryInk
  context.globalAlpha = 0.55
  context.beginPath(); context.moveTo(0, yToPixel(0)); context.lineTo(width, yToPixel(0)); context.stroke()
  context.beginPath(); context.moveTo(xToPixel(0), 0); context.lineTo(xToPixel(0), height); context.stroke()
  context.globalAlpha = 1

  if (showIntegral && analysis.integral !== null) {
    context.fillStyle = baselineColor
    context.globalAlpha = 0.1
    context.beginPath()
    context.moveTo(xToPixel(0), yToPixel(0))
    for (let pixel = 0; pixel <= width; pixel++) {
      const x = pixelToX(pixel)
      if (x > traceX) break
      const y = evaluateAt(currentFunction, x)
      if (y === null || !Number.isFinite(yToPixel(y))) continue
      context.lineTo(pixel, yToPixel(y))
    }
    context.lineTo(xToPixel(traceX), yToPixel(0))
    context.closePath()
    context.fill()
    context.globalAlpha = 1
  }

  for (const [index, fn] of functions.entries()) {
    context.strokeStyle = index === 0 ? subjectColor : baselineColor
    context.lineWidth = fn.id === currentFunction.id ? 2.5 : 1.5
    context.globalAlpha = fn.id === currentFunction.id ? 1 : 0.45
    context.beginPath()
    let drawing = false
    for (let pixel = 0; pixel <= width; pixel++) {
      const y = evaluateAt(fn, pixelToX(pixel))
      if (y === null || !Number.isFinite(yToPixel(y))) {
        drawing = false
        continue
      }
      if (drawing) context.lineTo(pixel, yToPixel(y))
      else {
        context.moveTo(pixel, yToPixel(y))
        drawing = true
      }
    }
    context.stroke()
  }
  context.globalAlpha = 1

  if (showDerivative && currentValue !== null && analysis.derivative !== null) {
    const slope = analysis.derivative
    context.strokeStyle = subjectColor
    context.globalAlpha = 0.7
    context.setLineDash([4, 4])
    context.beginPath()
    for (let pixel = 0; pixel <= width; pixel++) {
      const x = pixelToX(pixel)
      const y = currentValue + slope * (x - traceX)
      if (!Number.isFinite(y) || !Number.isFinite(yToPixel(y))) continue
      if (pixel === 0) context.moveTo(pixel, yToPixel(y))
      else context.lineTo(pixel, yToPixel(y))
    }
    context.stroke()
    context.setLineDash([])
    context.globalAlpha = 1
  }

  context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  context.fillStyle = secondaryInk
  context.textBaseline = 'bottom'
  for (let index = 0; index <= COLUMNS; index++) {
    const x = centerX - xRange / 2 + (index / COLUMNS) * xRange
    const pixel = xToPixel(x)
    if (pixel < 16 || pixel > width - 24) continue
    context.fillText(x.toFixed(1), pixel + 4, height - 4)
  }
  context.textBaseline = 'middle'
  for (let index = 0; index <= ROWS; index++) {
    const y = centerY - yRange / 2 + (index / ROWS) * yRange
    const pixel = yToPixel(y)
    if (pixel < 14 || pixel > height - 14) continue
    context.fillText(y.toFixed(1), 5, pixel - 7)
  }

  context.strokeStyle = secondaryInk
  context.globalAlpha = 0.5
  context.setLineDash([3, 3])
  context.beginPath()
  context.moveTo(xToPixel(traceX), 0)
  context.lineTo(xToPixel(traceX), height)
  context.stroke()
  context.setLineDash([])
  context.globalAlpha = 1

  if (currentValue !== null && Number.isFinite(yToPixel(currentValue))) {
    context.beginPath()
    context.arc(xToPixel(traceX), yToPixel(currentValue), 4.5, 0, Math.PI * 2)
    context.fillStyle = baselineColor
    context.fill()
    context.strokeStyle = primaryInk
    context.lineWidth = 1
    context.stroke()
  }

  context.fillStyle = primaryInk
  context.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
  context.textBaseline = 'middle'
  const traceTag = `x ${traceX.toFixed(2)}`
  const traceTagX = Math.min(width - 62, xToPixel(traceX) + 8)
  context.fillText(traceTag, traceTagX, 14)
}
