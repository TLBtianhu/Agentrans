/** Framework-free network-graph renderer shared by the conversation preview and the animation exporter. */
import type { NetworkGraphSpec, FlowchartNodeSpec } from '@deepseek-ai/dsh-artifact/scene'

/** Mutable view state for a network-graph render. */
export interface NetworkGraphRenderState {
  readonly selected?: string
}

interface PositionedNode extends FlowchartNodeSpec {
  px: number
  py: number
}

function hash(value: string): number {
  let result = 0
  for (const character of value) result = (result * 31 + character.charCodeAt(0)) % 1000
  return result / 1000
}

function layout(nodes: readonly FlowchartNodeSpec[], edges: readonly { from: string; to: string }[]): readonly PositionedNode[] {
  const positioned: PositionedNode[] = nodes.map(node => ({
    ...node,
    px: hash(node.id) * 2 - 1,
    py: hash(node.id + 'y') * 2 - 1,
  }))
  const byId = new Map(positioned.map(node => [node.id, node]))
  for (let iteration = 0; iteration < 60; iteration++) {
    for (const a of positioned) {
      for (const b of positioned) {
        if (a === b) continue
        const dx = a.px - b.px
        const dy = a.py - b.py
        const distance = Math.max(0.05, Math.hypot(dx, dy))
        const force = 0.02 / (distance * distance)
        a.px += (dx / distance) * force
        a.py += (dy / distance) * force
      }
    }
    for (const edge of edges) {
      const a = byId.get(edge.from)
      const b = byId.get(edge.to)
      if (!a || !b) continue
      const dx = b.px - a.px
      const dy = b.py - a.py
      const distance = Math.max(0.05, Math.hypot(dx, dy))
      const force = (distance - 0.6) * 0.05
      a.px += (dx / distance) * force
      a.py += (dy / distance) * force
      b.px -= (dx / distance) * force
      b.py -= (dy / distance) * force
    }
    for (const node of positioned) {
      node.px *= 1
      node.py *= 1
    }
  }
  return positioned
}

/**
 * Render a validated NetworkGraph SceneSpec onto a canvas.
 * A deterministic force-directed layout positions the nodes, and the selected
 * node is highlighted with its neighbours.
 * @param spec - Network-graph SceneSpec to draw.
 * @param canvas - Canvas element to draw on.
 * @param width - Canvas width in pixels.
 * @param height - Canvas height in pixels.
 * @param state - Currently selected node id, if any.
 */
export function renderNetworkGraph(
  spec: NetworkGraphSpec,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  state: NetworkGraphRenderState,
): void {
  const context = canvas.getContext('2d')
  if (!context) return
  const { selected } = state
  const nodes = layout(spec.nodes, spec.edges)
  const byId = new Map(nodes.map(node => [node.id, node]))
  const style = getComputedStyle(canvas)
  const ink = style.getPropertyValue('--dsw-alias-label-primary').trim()
  const muted = style.getPropertyValue('--dsw-alias-label-tertiary').trim()
  const accent = style.getPropertyValue('--dsw-alias-state-business-primary').trim()
  const good = style.getPropertyValue('--dsw-alias-state-success-primary').trim()
  const surface = style.getPropertyValue('--dsw-alias-bg-base').trim()
  const isBlueprint = spec.style === 'blueprint'
  const primaryInk = isBlueprint ? '#eef4fb' : ink
  const secondaryInk = isBlueprint ? 'rgba(238,244,251,0.45)' : muted
  const highlightColor = isBlueprint ? '#ffd166' : accent
  const xToPixel = (value: number): number => 70 + ((value + 1) / 2) * (width - 140)
  const yToPixel = (value: number): number => 60 + ((value + 1) / 2) * (height - 120)
  const isNeighbour = (id: string): boolean => selected !== undefined && spec.edges.some(
    edge => (edge.from === selected && edge.to === id) || (edge.to === selected && edge.from === id),
  )
  context.clearRect(0, 0, width, height)
  if (isBlueprint) {
    context.fillStyle = '#17508c'
    context.fillRect(0, 0, width, height)
  }
  for (const edge of spec.edges) {
    const a = byId.get(edge.from)
    const b = byId.get(edge.to)
    if (!a || !b) continue
    const active = selected !== undefined && (edge.from === selected || edge.to === selected)
    context.strokeStyle = active ? highlightColor : secondaryInk
    context.globalAlpha = active ? 0.9 : 0.35
    context.lineWidth = active ? 2 : 1
    context.beginPath()
    context.moveTo(xToPixel(a.px), yToPixel(a.py))
    context.lineTo(xToPixel(b.px), yToPixel(b.py))
    context.stroke()
    const angle = Math.atan2(yToPixel(b.py) - yToPixel(a.py), xToPixel(b.px) - xToPixel(a.px))
    context.beginPath()
    context.moveTo(xToPixel(b.px), yToPixel(b.py))
    context.lineTo(xToPixel(b.px) - 9 * Math.cos(angle - Math.PI / 6), yToPixel(b.py) - 9 * Math.sin(angle - Math.PI / 6))
    context.lineTo(xToPixel(b.px) - 9 * Math.cos(angle + Math.PI / 6), yToPixel(b.py) - 9 * Math.sin(angle + Math.PI / 6))
    context.closePath()
    context.fillStyle = active ? highlightColor : secondaryInk
    context.fill()
    if (edge.label) {
      context.fillStyle = secondaryInk
      context.font = '10px ui-sans-serif, system-ui'
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(edge.label, (xToPixel(a.px) + xToPixel(b.px)) / 2 + 6, (yToPixel(a.py) + yToPixel(b.py)) / 2 - 6)
    }
  }
  context.globalAlpha = 1
  for (const node of nodes) {
    const x = xToPixel(node.px)
    const y = yToPixel(node.py)
    const isSelected = node.id === selected
    const isConnected = isNeighbour(node.id)
    const radius = isSelected ? 10 : isConnected ? 8 : 6
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fillStyle = isSelected ? highlightColor : isConnected ? good : surface
    context.fill()
    context.lineWidth = isSelected ? 2 : 1.5
    context.strokeStyle = isSelected ? highlightColor : isConnected ? good : secondaryInk
    context.stroke()
    context.fillStyle = isSelected ? surface : primaryInk
    context.font = isSelected ? '600 11px ui-sans-serif, system-ui' : '11px ui-sans-serif, system-ui'
    context.textAlign = 'center'
    context.textBaseline = 'top'
    context.fillText(node.label, x, y + radius + 6)
    if (isBlueprint) {
      context.beginPath()
      context.arc(x - radius - 8, y - radius - 8, 9, 0, Math.PI * 2)
      context.strokeStyle = highlightColor
      context.lineWidth = 1
      context.stroke()
      context.fillStyle = highlightColor
      context.font = '9px ui-monospace, monospace'
      context.textBaseline = 'middle'
      context.fillText(String(spec.nodes.indexOf(node) + 1).padStart(2, '0'), x - radius - 12, y - radius - 8)
    }
  }
  if (isBlueprint) {
    context.fillStyle = secondaryInk
    context.font = '10px ui-monospace, monospace'
    context.textAlign = 'right'
    context.textBaseline = 'bottom'
    context.fillText(`DWG ${spec.nodes.length} NODES / ${spec.edges.length} EDGES · REV A`, width - 12, height - 12)
    context.textAlign = 'start'
  }
}
