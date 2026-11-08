/** Framework-free map renderer shared by the conversation preview and the animation exporter. */
import type { MapSpec } from '../scene.ts'

/** Mutable view state for a map render. */
export interface MapRenderState {
  readonly selected?: string
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

function pinPath(context: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  context.beginPath()
  context.arc(x, y - radius, radius, 0, Math.PI * 2)
  context.moveTo(x - radius * 0.6, y - radius * 0.3)
  context.lineTo(x, y + radius * 0.9)
  context.lineTo(x + radius * 0.6, y - radius * 0.3)
  context.closePath()
}

/**
 * Render a validated Map SceneSpec onto a canvas.
 * A stylized grid background carries positioned markers, and the selected marker
 * is highlighted with a detail card for its label and description.
 * @param spec - Map SceneSpec to draw.
 * @param canvas - Canvas element to draw on.
 * @param width - Canvas width in pixels.
 * @param height - Canvas height in pixels.
 * @param state - Currently selected marker id, if any.
 */
export function renderMap(
  spec: MapSpec,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  state: MapRenderState,
): void {
  const context = canvas.getContext('2d')
  if (!context) return
  const { selected } = state
  const xs = spec.markers.map(marker => marker.x)
  const ys = spec.markers.map(marker => marker.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const spanX = maxX - minX || 1
  const spanY = maxY - minY || 1
  const style = getComputedStyle(canvas)
  const ink = style.getPropertyValue('--dsw-alias-label-primary').trim()
  const muted = style.getPropertyValue('--dsw-alias-label-tertiary').trim()
  const accent = style.getPropertyValue('--dsw-alias-state-business-primary').trim()
  const surface = style.getPropertyValue('--dsw-alias-bg-base').trim()
  const border = style.getPropertyValue('--dsw-alias-border-l2').trim()
  const xToPixel = (value: number): number => 60 + ((value - minX) / spanX) * (width - 120)
  const yToPixel = (value: number): number => 60 + ((value - minY) / spanY) * (height - 120)
  context.clearRect(0, 0, width, height)
  context.strokeStyle = border
  context.lineWidth = 1
  for (let index = 0; index <= 8; index++) {
    const x = 40 + (index / 8) * (width - 80)
    context.beginPath(); context.moveTo(x, 30); context.lineTo(x, height - 30); context.stroke()
  }
  for (let index = 0; index <= 6; index++) {
    const y = 30 + (index / 6) * (height - 60)
    context.beginPath(); context.moveTo(40, y); context.lineTo(width - 40, y); context.stroke()
  }
  for (const marker of spec.markers) {
    const x = xToPixel(marker.x)
    const y = yToPixel(marker.y)
    const isSelected = marker.id === selected
    const radius = isSelected ? 12 : 8
    pinPath(context, x, y, radius)
    context.fillStyle = isSelected ? accent : surface
    context.fill()
    context.lineWidth = isSelected ? 2 : 1.5
    context.strokeStyle = isSelected ? accent : muted
    context.stroke()
    context.fillStyle = isSelected ? surface : ink
    context.font = isSelected ? '600 11px ui-sans-serif, system-ui' : '11px ui-sans-serif, system-ui'
    context.textAlign = 'center'
    context.textBaseline = 'top'
    context.fillText(marker.label, x, y + radius + 8)
  }
  const current = spec.markers.find(marker => marker.id === selected) ?? spec.markers[0]
  if (current) {
    const cardTop = height - 108
    const cardLeft = 40
    const cardWidth = width - 80
    context.beginPath()
    context.roundRect(cardLeft, cardTop, cardWidth, 88, 10)
    context.fillStyle = surface
    context.fill()
    context.strokeStyle = border
    context.lineWidth = 1
    context.stroke()
    context.fillStyle = accent
    context.beginPath()
    context.arc(cardLeft + 24, cardTop + 26, 12, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = surface
    context.font = '600 11px ui-monospace, monospace'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(String(spec.markers.indexOf(current) + 1).padStart(2, '0'), cardLeft + 24, cardTop + 26)
    context.textAlign = 'left'
    context.textBaseline = 'top'
    context.fillStyle = ink
    context.font = '600 14px ui-sans-serif, system-ui'
    context.fillText(current.label, cardLeft + 46, cardTop + 16)
    context.fillStyle = muted
    context.font = '10px ui-monospace, monospace'
    context.fillText(`(${current.x.toFixed(2)}, ${current.y.toFixed(2)})`, cardLeft + 46, cardTop + 38)
    if (current.description) {
      context.fillStyle = muted
      context.font = '11px ui-sans-serif, system-ui'
      const lines = wrapText(context, current.description, cardWidth - 64)
      lines.slice(0, 2).forEach((line, index) => {
        context.fillText(line, cardLeft + 46, cardTop + 56 + index * 14)
      })
    }
  }
}
