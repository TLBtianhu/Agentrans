/** Native timeline renderer for validated SceneSpec values. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { TimelineSpec } from '@deepseek-ai/dsh-artifact/scene'
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import type { ArtifactPlacement, RecordArtifactAction } from './protocol.ts'
import { renderTimeline } from './renderers/timeline.ts'
import css from './FunctionPlotView.module.css'

interface TimelineViewProps {
  readonly spec: TimelineSpec
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly placement: ArtifactPlacement
  readonly recordAction: RecordArtifactAction
  readonly onStateChange?: ((state: JsonValue) => void) | undefined
  readonly t: PropsLocale<'artifact'>['t']
}

/**
 * Render a validated Timeline SceneSpec with a movable playhead.
 * @param props - SceneSpec, Artifact identity, placement, confirmation callback, and locale seat.
 * @returns An interactive timeline with a draggable playhead and event stepping.
 */
export function TimelineView({ spec, artifactId, revision, placement, recordAction, onStateChange, t }: TimelineViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const times = spec.events.map(event => event.time)
  const minTime = Math.min(...times)
  const maxTime = Math.max(...times)
  const [playhead, setPlayhead] = useState(spec.playhead ?? minTime)
  const [playing, setPlaying] = useState(false)
  const currentEvent = spec.events.filter(event => event.time <= playhead).at(-1)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    renderTimeline(spec, canvas, 900, 420, { playhead })
  }, [spec, playhead])

  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      setPlayhead((current) => {
        const next = current + (maxTime - minTime) / 60
        if (next > maxTime) {
          setPlaying(false)
          return minTime
        }
        return next
      })
    }, 100)
    return () => { window.clearInterval(timer) }
  }, [playing, minTime, maxTime])

  useEffect(() => {
    onStateChange?.({ playhead, event: currentEvent?.id ?? null })
  }, [onStateChange, playhead, currentEvent])

  const step = (direction: 1 | -1): void => {
    const sorted = [...times].sort((a, b) => a - b)
    const index = sorted.findIndex(time => time > playhead)
    const nextIndex = direction === 1 ? (index < 0 ? sorted.length - 1 : index) : Math.max(0, (index < 0 ? sorted.length : index) - 2)
    setPlayhead(sorted[nextIndex] ?? playhead)
  }

  const confirm = async (): Promise<void> => {
    await recordAction(artifactId, revision, 'timeline.inspected', { playhead, event: currentEvent?.id ?? null }, true)
  }

  return (
    <div className={css.workspace} data-placement={placement}>
      <div className={css.stage}>
        <div className={css.legend}>
          <span className={css.legendItem} data-current="true"><i className={css.swatchAccent} aria-hidden="true" />{currentEvent?.label ?? '—'}</span>
        </div>
        <div className={css.plot}>
          <canvas ref={canvasRef} className={css.chart} role="img" aria-label={t('scene.timeline')}
            onClick={(event) => {
              const canvas = canvasRef.current
              if (!canvas) return
              const rect = canvas.getBoundingClientRect()
              const ratio = (event.clientX - rect.left - 60) / (rect.width - 120)
              setPlayhead(minTime + Math.max(0, Math.min(1, ratio)) * (maxTime - minTime))
            }} />
        </div>
        <div className={css.readout} role="status" aria-live="polite">
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.playhead')}</span><span className={css.readoutValue}>{playhead.toFixed(2)}</span></div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.events')}</span><span className={css.readoutValue}>{spec.events.length}</span></div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.currentEvent')}</span><span className={css.readoutValue}>{currentEvent?.label ?? '—'}</span></div>
        </div>
      </div>
      <aside className={css.panel} aria-label={t('scene.controls')}>
        <div className={css.buttonRow}>
          <Button size="sm" variant="ghost" className={css.toggle} onClick={() => { step(-1) }}>{t('scene.previous')}</Button>
          <Button size="sm" variant="ghost" className={css.toggle} onClick={() => { step(1) }}>{t('scene.next')}</Button>
          <Button size="sm" variant="ghost" className={css.toggle} data-selected={playing ? '' : undefined}
            aria-pressed={playing} onClick={() => { setPlaying(value => !value) }}>{playing ? t('scene.pause') : t('scene.play')}</Button>
        </div>
        <Button size="sm" variant="outline" onClick={() => { void confirm() }}>{t('scene.confirm')}</Button>
        <p className={css.hint}>{t('scene.timelineHint')}</p>
      </aside>
    </div>
  )
}
