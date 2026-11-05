/** Framework-free timeline renderer shared by the conversation preview and the animation exporter. */
import type { TimelineSpec } from '@deepseek-ai/dsh-artifact/scene'

/** Mutable view state for a timeline render. */
export interface TimelineRenderState {
  readonly playhead: number
}

/**
 * Render a validated Timeline SceneSpec onto a canvas.
 * @param spec - Timeline SceneSpec to draw.
 * @param canvas - Canvas element to draw on.
 * @param width - Canvas width in pixels.
 * @param height - Canvas height in pixels.
 * @param state - Current playhead time.
 */
export function renderTimeline(
  spec: TimelineSpec,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  state: TimelineRenderState,
): void {
  const context = canvas.getContext('2d')
  if (!context) return
  const { playhead } = state
  const times = spec.events.map(event => event.time)
  const minTime = Math.min(...times)
  const maxTime = Math.max(...times)
  const span = maxTime - minTime || 1
  const style = getComputedStyle(canvas)
  const ink = style.getPropertyValue('--dsw-alias-label-primary').trim()
  const muted = style.getPropertyValue('--dsw-alias-label-tertiary').trim()
  const accent = style.getPropertyValue('--dsw-alias-state-business-primary').trim()
  const good = style.getPropertyValue('--dsw-alias-state-success-primary').trim()
  const xToPixel = (time: number): number => 60 + ((time - minTime) / span) * (width - 120)
  const axisY = height / 2
  context.clearRect(0, 0, width, height)
  context.strokeStyle = muted
  context.lineWidth = 1
  context.beginPath()
  context.moveTo(40, axisY)
  context.lineTo(width - 40, axisY)
  context.stroke()
  for (const event of spec.events) {
    const x = xToPixel(event.time)
    const isCurrent = event.time <= playhead
      && (spec.events.find(other => other.time > playhead) === undefined
        || event.time === Math.max(...spec.events.filter(other => other.time <= playhead).map(other => other.time)))
    context.beginPath()
    context.moveTo(x, axisY - 12)
    context.lineTo(x, axisY + 12)
    context.strokeStyle = isCurrent ? accent : muted
    context.stroke()
    context.beginPath()
    context.arc(x, axisY, isCurrent ? 6 : 4, 0, Math.PI * 2)
    context.fillStyle = isCurrent ? accent : muted
    context.fill()
    context.fillStyle = ink
    context.font = '11px ui-sans-serif, system-ui'
    context.textAlign = 'center'
    context.textBaseline = 'top'
    context.fillText(event.label, x, axisY + 18)
    if (event.description) {
      context.fillStyle = muted
      context.font = '10px ui-sans-serif, system-ui'
      context.fillText(event.description, x, axisY + 34)
    }
  }
  const playheadX = xToPixel(playhead)
  context.strokeStyle = good
  context.setLineDash([4, 4])
  context.beginPath()
  context.moveTo(playheadX, 30)
  context.lineTo(playheadX, height - 30)
  context.stroke()
  context.setLineDash([])
  context.fillStyle = good
  context.beginPath()
  context.arc(playheadX, axisY, 7, 0, Math.PI * 2)
  context.fill()
  context.fillStyle = ink
  context.font = '10px ui-monospace, monospace'
  context.textAlign = 'left'
  context.textBaseline = 'bottom'
  context.fillText(`t = ${playhead.toFixed(2)}`, playheadX + 10, axisY - 16)
}
