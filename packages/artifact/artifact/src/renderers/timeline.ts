/** Framework-free timeline renderer shared by the conversation preview and the animation exporter. */
import type { TimelineSpec } from '../scene.ts'
import type { ScenePalette } from '../scene-palette.ts'

/** Mutable view state for a timeline render. */
export interface TimelineRenderState {
  readonly playhead: number
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): readonly string[] {
  const lines: string[] = []
  let current = ''
  for (const character of text) {
    const next = current + character
    if (context.measureText(next).width > maxWidth && current.length > 0) {
      lines.push(current)
      current = character
    } else {
      current = next
    }
  }
  if (current.length > 0) lines.push(current)
  return lines
}

/**
 * Render a validated Timeline SceneSpec onto a canvas.
 * A horizontal timeline sits above a detail card for the current event, so each
 * playhead position explains one event the way a historical timeline does.
 * @param spec - Timeline SceneSpec to draw.
 * @param canvas - Canvas element to draw on.
 * @param width - Canvas width in pixels.
 * @param height - Canvas height in pixels.
 * @param state - Current playhead time.
 * @param palette - Resolved drawing roles; a self-contained style overrides them.
 */
export function renderTimeline(
  spec: TimelineSpec,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  state: TimelineRenderState,
  palette: ScenePalette,
): void {
  const context = canvas.getContext('2d')
  if (!context) return
  const { playhead } = state
  const times = spec.events.map(event => event.time)
  const minTime = Math.min(...times)
  const maxTime = Math.max(...times)
  const span = maxTime - minTime || 1
  const { ink, inkMuted: muted, accent, success: good, surface, grid: border } = palette
  const isTransitMap = spec.style === 'transit-map'
  const primaryInk = isTransitMap ? '#1d1d22' : ink
  const secondaryInk = isTransitMap ? '#6f6a60' : muted
  const routeColor = isTransitMap ? '#d9774f' : accent
  const signColor = isTransitMap ? '#1f2a44' : accent
  if (isTransitMap) {
    context.fillStyle = '#f4f0e6'
    context.fillRect(0, 0, width, height)
  }
  const currentEvent = spec.events.filter(event => event.time <= playhead).at(-1) ?? spec.events[0]
  const xToPixel = (time: number): number => 60 + ((time - minTime) / span) * (width - 120)
  const axisY = 84
  context.clearRect(0, 0, width, height)

  // Timeline strip: the route with station-like markers and a moving playhead.
  context.strokeStyle = routeColor
  context.lineWidth = 2
  context.beginPath()
  context.moveTo(40, axisY)
  context.lineTo(width - 40, axisY)
  context.stroke()
  for (const event of spec.events) {
    const x = xToPixel(event.time)
    const isCurrent = event.id === currentEvent?.id
    context.beginPath()
    context.moveTo(x, axisY - 10)
    context.lineTo(x, axisY + 10)
    context.strokeStyle = isCurrent ? routeColor : secondaryInk
    context.lineWidth = isCurrent ? 2 : 1
    context.stroke()
    context.beginPath()
    context.arc(x, axisY, isCurrent ? 7 : 4, 0, Math.PI * 2)
    context.fillStyle = isCurrent ? routeColor : surface
    context.fill()
    context.strokeStyle = isCurrent ? routeColor : secondaryInk
    context.lineWidth = 1.5
    context.stroke()
    context.fillStyle = isCurrent ? primaryInk : secondaryInk
    context.font = isCurrent ? '600 11px ui-sans-serif, system-ui' : '11px ui-sans-serif, system-ui'
    context.textAlign = 'center'
    context.textBaseline = 'top'
    context.fillText(event.label, x, axisY + 16)
  }
  const playheadX = xToPixel(playhead)
  context.strokeStyle = good
  context.setLineDash([4, 4])
  context.beginPath()
  context.moveTo(playheadX, 30)
  context.lineTo(playheadX, 116)
  context.stroke()
  context.setLineDash([])
  context.fillStyle = good
  context.beginPath()
  context.arc(playheadX, axisY, 5, 0, Math.PI * 2)
  context.fill()

  // Detail card: zoom in to explain the current event.
  const cardTop = 146
  const cardHeight = height - cardTop - 20
  const cardLeft = 40
  const cardWidth = width - 80
  context.beginPath()
  context.roundRect(cardLeft, cardTop, cardWidth, cardHeight, 10)
  context.fillStyle = surface
  context.fill()
  context.strokeStyle = border
  context.lineWidth = 1
  context.stroke()
  if (currentEvent) {
    const step = spec.events.indexOf(currentEvent) + 1
    context.fillStyle = signColor
    context.beginPath()
    context.arc(cardLeft + 34, cardTop + 34, 16, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = isTransitMap ? '#f4f0e6' : surface
    context.font = '600 13px ui-monospace, monospace'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(String(step).padStart(2, '0'), cardLeft + 34, cardTop + 34)
    context.textAlign = 'left'
    context.textBaseline = 'top'
    context.fillStyle = primaryInk
    context.font = '600 20px ui-sans-serif, system-ui'
    context.fillText(currentEvent.label, cardLeft + 64, cardTop + 22)
    context.fillStyle = secondaryInk
    context.font = '11px ui-monospace, monospace'
    context.fillText(`t = ${currentEvent.time.toFixed(2)}`, cardLeft + 64, cardTop + 50)
    if (currentEvent.description) {
      context.fillStyle = secondaryInk
      context.font = '12px ui-sans-serif, system-ui'
      const lines = wrapText(context, currentEvent.description, cardWidth - 64)
      lines.slice(0, 5).forEach((line, index) => {
        context.fillText(line, cardLeft + 64, cardTop + 78 + index * 18)
      })
    }
    context.fillStyle = secondaryInk
    context.font = '10px ui-monospace, monospace'
    context.textAlign = 'right'
    context.textBaseline = 'bottom'
    context.fillText(`${step} / ${spec.events.length}`, cardLeft + cardWidth - 16, cardTop + cardHeight - 14)
  }
  context.textAlign = 'start'
}
