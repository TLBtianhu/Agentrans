/** Native timeline renderer for validated SceneSpec values. */
import { useEffect, useRef, useState } from 'react'
import { drawNativeScene, scenePaletteFor } from './native-runtime.ts'
import type { TimelineSpec } from '@agentrans/artifact/scene'
import { renderTimeline } from './renderers/timeline.ts'
import { canvasPoint, SceneButton, SceneControls, SceneStage, ScenePlayButton, type SceneViewProps } from './SceneViewParts.tsx'
import css from './FunctionPlotView.module.css'

/**
 * Render a validated Timeline SceneSpec with a movable playhead.
 * @param props - SceneSpec, Artifact identity, placement, confirmation callback, and locale seat.
 * @returns An interactive timeline with a draggable playhead and event stepping.
 */
export function TimelineView({
  spec, artifactId, revision, placement, recordAction, canRecord = true, recordPending = false, onRuntimeReport, onStateChange, t,
}: SceneViewProps<TimelineSpec>) {
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
    drawNativeScene(canvas, () => { renderTimeline(spec, canvas, 900, 420, { playhead }, scenePaletteFor(canvas)) }, onRuntimeReport)
  }, [spec, playhead, onRuntimeReport])

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
    if (!canRecord || recordPending) return
    await recordAction(artifactId, revision, 'timeline.inspected', { playhead, event: currentEvent?.id ?? null }, true)
  }

  return (
    <div className={css.workspace} data-placement={placement}>
      <SceneStage legend={currentEvent?.label ?? '—'} canvasRef={canvasRef} label={t('scene.timeline')}
        onCanvasClick={(event) => {
          const { x, width } = canvasPoint(event)
          const ratio = (x - 60) / (width - 120)
          setPlayhead(minTime + Math.max(0, Math.min(1, ratio)) * (maxTime - minTime))
        }}
        readout={[
          [t('scene.playhead'), playhead.toFixed(2)],
          [t('scene.events'), spec.events.length],
          [t('scene.currentEvent'), currentEvent?.label ?? '—'],
        ]} />
      <SceneControls canRecord={canRecord} recordPending={recordPending} onConfirm={confirm} hint={t('scene.timelineHint')} t={t}>
        <SceneButton onClick={() => { step(-1) }}>{t('scene.previous')}</SceneButton>
        <SceneButton onClick={() => { step(1) }}>{t('scene.next')}</SceneButton>
        <ScenePlayButton playing={playing} onToggle={() => { setPlaying(value => !value) }} t={t} />
      </SceneControls>
    </div>
  )
}
