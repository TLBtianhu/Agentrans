/** Framework-free particle-system renderer shared by the conversation preview and the animation exporter. */
import type { ParticleSystemSpec, ParticleSpec } from '../scene.ts'

/** One particle state at a given simulation time. */
export interface ParticleRenderState {
  readonly time: number
  readonly particles: readonly ParticleSpec[]
  readonly trails: Readonly<Record<string, readonly { x: number; y: number }[]>>
}

/**
 * Render a validated ParticleSystem SceneSpec onto a canvas.
 * @param spec - Particle-system SceneSpec to draw.
 * @param canvas - Canvas element to draw on.
 * @param width - Canvas width in pixels.
 * @param height - Canvas height in pixels.
 * @param state - Simulation time, particle states, and trails.
 */
export function renderParticleSystem(
  spec: ParticleSystemSpec,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  state: ParticleRenderState,
): void {
  const context = canvas.getContext('2d')
  if (!context) return
  const { particles, trails } = state
  const style = getComputedStyle(canvas)
  const ink = style.getPropertyValue('--dsw-alias-label-primary').trim()
  const muted = style.getPropertyValue('--dsw-alias-label-tertiary').trim()
  const accent = style.getPropertyValue('--dsw-alias-state-business-primary').trim()
  const good = style.getPropertyValue('--dsw-alias-state-success-primary').trim()
  const isParticlesStyle = spec.style === 'particles'
  const primaryInk = isParticlesStyle ? '#edf2fb' : ink
  const secondaryInk = isParticlesStyle ? '#8f8da8' : muted
  const particleColors = isParticlesStyle ? ['#38d6e6', '#a78bfa', '#f2f1f7', '#f472b6'] : [accent]
  if (isParticlesStyle) {
    context.fillStyle = '#05060b'
    context.fillRect(0, 0, width, height)
  }
  const xs = particles.map(particle => particle.x)
  const ys = particles.map(particle => particle.y)
  const minX = Math.min(...xs, 0)
  const maxX = Math.max(...xs, 1)
  const minY = Math.min(...ys, 0)
  const maxY = Math.max(...ys, 1)
  const spanX = maxX - minX || 1
  const spanY = maxY - minY || 1
  const xToPixel = (x: number): number => 60 + ((x - minX) / spanX) * (width - 120)
  const yToPixel = (y: number): number => height - 60 - ((y - minY) / spanY) * (height - 120)
  context.clearRect(0, 0, width, height)
  context.strokeStyle = secondaryInk
  context.globalAlpha = 0.25
  for (let index = 0; index <= 6; index++) {
    const x = minX + (index / 6) * spanX
    context.beginPath(); context.moveTo(xToPixel(x), 0); context.lineTo(xToPixel(x), height); context.stroke()
  }
  for (let index = 0; index <= 4; index++) {
    const y = minY + (index / 4) * spanY
    context.beginPath(); context.moveTo(0, yToPixel(y)); context.lineTo(width, yToPixel(y)); context.stroke()
  }
  context.globalAlpha = 1
  if (spec.trails) {
    for (const particle of particles) {
      const points = trails[particle.id] ?? []
      if (points.length < 2) continue
      context.strokeStyle = particleColors[0] ?? accent
      context.globalAlpha = 0.25
      context.beginPath()
      for (const [index, point] of points.entries()) {
        if (index === 0) context.moveTo(xToPixel(point.x), yToPixel(point.y))
        else context.lineTo(xToPixel(point.x), yToPixel(point.y))
      }
      context.stroke()
    }
    context.globalAlpha = 1
  }
  for (const particle of particles) {
    const x = xToPixel(particle.x)
    const y = yToPixel(particle.y)
    const speed = Math.hypot(particle.vx, particle.vy)
    const angle = Math.atan2(particle.vy, particle.vx)
    const length = Math.min(40, speed * 12)
    context.strokeStyle = isParticlesStyle ? (particleColors[1] ?? good) : good
    context.lineWidth = 1.5
    context.beginPath()
    context.moveTo(x, y)
    context.lineTo(x + length * Math.cos(angle), y - length * Math.sin(angle))
    context.stroke()
    context.beginPath()
    context.arc(x, y, Math.max(4, Math.min(12, particle.mass * 2)), 0, Math.PI * 2)
    context.fillStyle = particleColors[particle.id.length % particleColors.length] ?? accent
    if (isParticlesStyle) {
      context.globalAlpha = 0.25
      context.beginPath()
      context.arc(x, y, Math.max(8, Math.min(18, particle.mass * 3)), 0, Math.PI * 2)
      context.fill()
      context.globalAlpha = 1
    }
    context.beginPath()
    context.arc(x, y, Math.max(4, Math.min(12, particle.mass * 2)), 0, Math.PI * 2)
    context.fill()
    context.fillStyle = primaryInk
    context.font = '10px ui-monospace, monospace'
    context.fillText(particle.id, x + 8, y - 8)
  }
}
