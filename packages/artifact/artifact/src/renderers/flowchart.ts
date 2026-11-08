/** Framework-free flowchart renderer shared by the conversation preview and the animation exporter. */
import type { FlowchartSpec } from '../scene.ts'

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
  const isTransitMap = spec.style === 'transit-map'
  const isBlueprint = spec.style === 'blueprint'
  const background = isTransitMap ? '#f4f0e6' : isBlueprint ? '#17508c' : surface
  const primaryInk = isTransitMap ? '#1d1d22' : isBlueprint ? '#eef4fb' : ink
  const secondaryInk = isTransitMap ? '#6f6a60' : isBlueprint ? 'rgba(238,244,251,0.45)' : muted
  const routeColor = isTransitMap ? '#d9774f' : accent
  const alternateColor = isTransitMap ? '#23408e' : good
  const highlightColor = isBlueprint ? '#ffd166' : accent
  context.fillStyle = background
  context.fillRect(0, 0, width, height)
  for (const edge of spec.edges) {
    const from = nodes.find(node => node.id === edge.from)
    const to = nodes.find(node => node.id === edge.to)
    if (!from || !to) continue
    const a = position(from)
    const b = position(to)
    const active = currentId === edge.from || currentId === edge.to
    context.strokeStyle = active ? routeColor : secondaryInk
    context.globalAlpha = active ? 0.9 : 0.45
    context.lineWidth = isTransitMap ? (active ? 4 : 2) : (active ? 2 : 1)
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
    context.fillStyle = active ? routeColor : secondaryInk
    context.fill()
    if (edge.label) {
      context.fillStyle = secondaryInk
      context.font = '10px ui-sans-serif, system-ui'
      context.fillText(edge.label, (a.x + b.x) / 2 + 6, (a.y + b.y) / 2 - 6)
    }
  }
  context.globalAlpha = 1
  for (const [index, node] of nodes.entries()) {
    const { x, y } = position(node)
    const isCurrent = node.id === currentId
    const isSelected = node.id === selected
    if (isTransitMap) {
      context.beginPath()
      context.arc(x, y, 10, 0, Math.PI * 2)
      context.fillStyle = isCurrent ? routeColor : background
      context.fill()
      context.lineWidth = isCurrent ? 3 : 2
      context.strokeStyle = isCurrent ? routeColor : secondaryInk
      context.stroke()
      context.fillStyle = primaryInk
      context.font = '11px ui-sans-serif, system-ui'
      context.textAlign = 'center'
      context.textBaseline = 'top'
      context.fillText(node.label, x, y + 16)
      continue
    }
    const nodeWidth = Math.max(88, node.label.length * 7 + 22)
    const nodeHeight = 38
    context.beginPath()
    context.roundRect(x - nodeWidth / 2, y - nodeHeight / 2, nodeWidth, nodeHeight, isBlueprint ? 0 : 8)
    context.fillStyle = isCurrent ? highlightColor : background
    context.fill()
    context.lineWidth = isSelected ? 2 : 1
    context.strokeStyle = isCurrent ? highlightColor : secondaryInk
    context.stroke()
    context.fillStyle = isCurrent ? background : primaryInk
    context.font = isBlueprint ? '12px ui-monospace, monospace' : '12px ui-sans-serif, system-ui'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(node.label, x, y)
    if (isBlueprint) {
      context.beginPath()
      context.arc(x - nodeWidth / 2 + 10, y - nodeHeight / 2 - 10, 10, 0, Math.PI * 2)
      context.strokeStyle = highlightColor
      context.lineWidth = 1
      context.stroke()
      context.fillStyle = highlightColor
      context.font = '10px ui-monospace, monospace'
      context.textBaseline = 'middle'
      context.fillText(String(index + 1).padStart(2, '0'), x - nodeWidth / 2 + 4, y - nodeHeight / 2 - 10)
    } else if (isCurrent && alternateColor) {
      context.beginPath()
      context.arc(x + nodeWidth / 2 - 8, y - nodeHeight / 2 + 8, 3.5, 0, Math.PI * 2)
      context.fillStyle = alternateColor
      context.fill()
    }
  }
  context.textAlign = 'start'
  if (isBlueprint) {
    context.fillStyle = secondaryInk
    context.font = '10px ui-monospace, monospace'
    context.textAlign = 'right'
    context.fillText(`DWG ${spec.nodes.length} NODES / ${spec.edges.length} EDGES · REV A`, width - 12, height - 12)
    context.textAlign = 'start'
  }
}
