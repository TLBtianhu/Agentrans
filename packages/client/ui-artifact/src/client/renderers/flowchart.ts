/** Framework-free flowchart renderer shared by the conversation preview and the animation exporter. */
import type { FlowchartSpec } from '@deepseek-ai/dsh-artifact/scene'

/** Mutable view state for a flowchart render. */
export interface FlowchartRenderState {
  readonly selected: string
  readonly pathIndex: number
}

/**
 * Render a validated Flowchart SceneSpec onto a canvas.
 * @param spec - Flowchart SceneSpec to draw.
 * @param canvas - Canvas element to draw on.
 * @param width - Canvas width in pixels.
 * @param height - Canvas height in pixels.
 * @param state - Selected node and current path position.
 */
export function renderFlowchart(
  spec: FlowchartSpec,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  state: FlowchartRenderState,
): void {
  const context = canvas.getContext('2d')
  if (!context) return
  const { selected, pathIndex } = state
  const path = spec.path ?? []
  const currentId = path[pathIndex] ?? selected
  const xs = spec.nodes.map(node => node.x)
  const ys = spec.nodes.map(node => node.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const spanX = maxX - minX || 1
  const spanY = maxY - minY || 1
  const nodes = spec.nodes.map(node => ({
    ...node,
    nx: (node.x - minX) / spanX,
    ny: (node.y - minY) / spanY,
  }))
  const position = (node: (typeof nodes)[number]): { x: number; y: number } => ({
    x: 70 + node.nx * (width - 140),
    y: 60 + node.ny * (height - 120),
  })
  const style = getComputedStyle(canvas)
  const ink = style.getPropertyValue('--dsw-alias-label-primary').trim()
  const muted = style.getPropertyValue('--dsw-alias-label-tertiary').trim()
  const accent = style.getPropertyValue('--dsw-alias-state-business-primary').trim()
  const good = style.getPropertyValue('--dsw-alias-state-success-primary').trim()
  const surface = style.getPropertyValue('--dsw-alias-bg-base').trim()
  context.clearRect(0, 0, width, height)
  for (const edge of spec.edges) {
    const from = nodes.find(node => node.id === edge.from)
    const to = nodes.find(node => node.id === edge.to)
    if (!from || !to) continue
    const a = position(from)
    const b = position(to)
    const active = currentId === edge.from || currentId === edge.to
    context.strokeStyle = active ? accent : muted
    context.globalAlpha = active ? 0.9 : 0.45
    context.lineWidth = active ? 2 : 1
    context.beginPath()
    context.moveTo(a.x, a.y)
    context.lineTo(b.x, b.y)
    context.stroke()
    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    context.beginPath()
    context.moveTo(b.x, b.y)
    context.lineTo(b.x - 10 * Math.cos(angle - Math.PI / 6), b.y - 10 * Math.sin(angle - Math.PI / 6))
    context.lineTo(b.x - 10 * Math.cos(angle + Math.PI / 6), b.y - 10 * Math.sin(angle + Math.PI / 6))
    context.closePath()
    context.fillStyle = active ? accent : muted
    context.fill()
    if (edge.label) {
      context.fillStyle = muted
      context.font = '10px ui-sans-serif, system-ui'
      context.fillText(edge.label, (a.x + b.x) / 2 + 6, (a.y + b.y) / 2 - 6)
    }
  }
  context.globalAlpha = 1
  for (const node of nodes) {
    const { x, y } = position(node)
    const isCurrent = node.id === currentId
    const isSelected = node.id === selected
    const nodeWidth = Math.max(88, node.label.length * 7 + 22)
    const nodeHeight = 38
    context.beginPath()
    context.roundRect(x - nodeWidth / 2, y - nodeHeight / 2, nodeWidth, nodeHeight, 8)
    context.fillStyle = isCurrent ? accent : surface
    context.fill()
    context.lineWidth = isSelected ? 2 : 1
    context.strokeStyle = isCurrent ? accent : muted
    context.stroke()
    context.fillStyle = isCurrent ? surface : ink
    context.font = '12px ui-sans-serif, system-ui'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(node.label, x, y)
    if (isCurrent && good) {
      context.beginPath()
      context.arc(x + nodeWidth / 2 - 8, y - nodeHeight / 2 + 8, 3.5, 0, Math.PI * 2)
      context.fillStyle = good
      context.fill()
    }
  }
  context.textAlign = 'start'
}
