/** Native particle-system renderer for validated SceneSpec values. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ParticleSystemSpec, ParticleSpec } from '@deepseek-ai/dsh-artifact/scene'
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import type { ArtifactPlacement, RecordArtifactAction } from './protocol.ts'
import css from './FunctionPlotView.module.css'

interface ParticleSystemViewProps {
  readonly spec: ParticleSystemSpec
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly placement: ArtifactPlacement
  readonly recordAction: RecordArtifactAction
  readonly onStateChange?: ((state: JsonValue) => void) | undefined
  readonly t: PropsLocale<'artifact'>['t']
}

interface TrailPoint {
  readonly x: number
  readonly y: number
}

/**
 * Render a validated ParticleSystem SceneSpec with fixed-step simulation.
 * @param props - SceneSpec, Artifact identity, placement, confirmation callback, and locale seat.
 * @returns An interactive particle simulation with velocity vectors and trails.
 */
export function ParticleSystemView({ spec, artifactId, revision, placement, recordAction, onStateChange, t }: ParticleSystemViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [particles, setParticles] = useState<readonly ParticleSpec[]>(spec.particles)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [trails, setTrails] = useState<Readonly<Record<string, readonly TrailPoint[]>>>({})

  const step = (): void => {
    const dt = spec.timeStep
    setParticles(current => current.map(particle => ({
      ...particle,
      vx: particle.vx + spec.gravity.x * dt,
      vy: particle.vy + spec.gravity.y * dt,
      x: particle.x + particle.vx * dt,
      y: particle.y + particle.vy * dt,
    })))
    setTime(current => current + dt)
    if (spec.trails) {
      setTrails((current) => {
        const next: Record<string, readonly TrailPoint[]> = { ...current }
        for (const particle of particles) {
          const existing = next[particle.id] ?? []
          next[particle.id] = [...existing.slice(-120), { x: particle.x, y: particle.y }]
        }
        return next
      })
    }
  }

  const reset = (): void => {
    setParticles(spec.particles)
    setTime(0)
    setPlaying(false)
    setTrails({})
  }

  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(step, Math.max(16, spec.timeStep * 1000))
    return () => { window.clearInterval(timer) }
  }, [playing, particles, spec])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const width = 900
    const height = 420
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const style = getComputedStyle(canvas)
    const ink = style.getPropertyValue('--dsw-alias-label-primary').trim()
    const muted = style.getPropertyValue('--dsw-alias-label-tertiary').trim()
    const accent = style.getPropertyValue('--dsw-alias-state-business-primary').trim()
    const good = style.getPropertyValue('--dsw-alias-state-success-primary').trim()
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
    context.strokeStyle = muted
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
        context.strokeStyle = accent
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
      context.strokeStyle = good
      context.lineWidth = 1.5
      context.beginPath()
      context.moveTo(x, y)
      context.lineTo(x + length * Math.cos(angle), y - length * Math.sin(angle))
      context.stroke()
      context.beginPath()
      context.arc(x, y, Math.max(4, Math.min(12, particle.mass * 2)), 0, Math.PI * 2)
      context.fillStyle = accent
      context.fill()
      context.fillStyle = ink
      context.font = '10px ui-monospace, monospace'
      context.fillText(particle.id, x + 8, y - 8)
    }
  }, [spec, particles, trails])

  useEffect(() => {
    onStateChange?.({
      time,
      particles: particles.map(particle => ({ id: particle.id, x: particle.x, y: particle.y, vx: particle.vx, vy: particle.vy })),
    })
  }, [onStateChange, time, particles])

  const confirm = async (): Promise<void> => {
    await recordAction(artifactId, revision, 'physics.inspected', {
      time,
      particles: particles.map(particle => ({ id: particle.id, x: particle.x, y: particle.y, vx: particle.vx, vy: particle.vy })),
    }, true)
  }

  return (
    <div className={css.workspace} data-placement={placement}>
      <div className={css.stage}>
        <div className={css.legend}>
          <span className={css.legendItem} data-current="true"><i className={css.swatchAccent} aria-hidden="true" />{t('scene.particleSystem')}</span>
        </div>
        <div className={css.plot}>
          <canvas ref={canvasRef} className={css.chart} role="img" aria-label={t('scene.particleSystem')} />
        </div>
        <div className={css.readout} role="status" aria-live="polite">
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.time')}</span><span className={css.readoutValue}>{time.toFixed(2)}</span></div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.particles')}</span><span className={css.readoutValue}>{particles.length}</span></div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.gravity')}</span><span className={css.readoutValue}>{spec.gravity.x.toFixed(2)}, {spec.gravity.y.toFixed(2)}</span></div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.timeStep')}</span><span className={css.readoutValue}>{spec.timeStep.toFixed(3)}</span></div>
        </div>
      </div>
      <aside className={css.panel} aria-label={t('scene.controls')}>
        <div className={css.buttonRow}>
          <Button size="sm" variant="ghost" className={css.toggle} data-selected={playing ? '' : undefined}
            aria-pressed={playing} onClick={() => { setPlaying(value => !value) }}>{playing ? t('scene.pause') : t('scene.play')}</Button>
          <Button size="sm" variant="ghost" className={css.toggle} onClick={step}>{t('scene.step')}</Button>
          <Button size="sm" variant="ghost" className={css.toggle} onClick={reset}>{t('scene.reset')}</Button>
        </div>
        <Button size="sm" variant="outline" onClick={() => { void confirm() }}>{t('scene.confirm')}</Button>
        <p className={css.hint}>{t('scene.particleHint')}</p>
      </aside>
    </div>
  )
}
