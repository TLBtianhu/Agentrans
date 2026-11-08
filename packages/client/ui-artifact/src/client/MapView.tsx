/** Native map renderer for validated SceneSpec values. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RuntimeReport } from '@deepseek-ai/dsh-artifact-runtime/types'
import { drawNativeScene, scenePaletteFor } from './native-runtime.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { MapSpec } from '@deepseek-ai/dsh-artifact/scene'
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import type { ArtifactPlacement, RecordArtifactAction } from './protocol.ts'
import { renderMap } from './renderers/map.ts'
import css from './FunctionPlotView.module.css'

interface MapViewProps {
  readonly spec: MapSpec
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly placement: ArtifactPlacement
  readonly recordAction: RecordArtifactAction
  readonly canRecord?: boolean
  readonly recordPending?: boolean
  readonly onRuntimeReport?: ((report: RuntimeReport) => void) | undefined
  readonly onStateChange?: ((state: JsonValue) => void) | undefined
  readonly t: PropsLocale<'artifact'>['t']
}

/**
 * Render a validated Map SceneSpec with selectable positioned markers.
 * @param props - SceneSpec, Artifact identity, placement, confirmation callback, and locale seat.
 * @returns An interactive map with a selected marker and its detail card.
 */
export function MapView({
  spec, artifactId, revision, placement, recordAction, canRecord = true, recordPending = false, onRuntimeReport, onStateChange, t,
}: MapViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [selected, setSelected] = useState<string | undefined>(spec.path?.[0] ?? spec.markers[0]?.id)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    drawNativeScene(canvas, () => {
      renderMap(spec, canvas, 900, 420, { ...(selected === undefined ? {} : { selected }) }, scenePaletteFor(canvas))
    }, onRuntimeReport)
  }, [spec, selected, onRuntimeReport])

  useEffect(() => {
    onStateChange?.({ selected: selected ?? null })
  }, [onStateChange, selected])

  const confirm = async (): Promise<void> => {
    if (!canRecord || recordPending) return
    await recordAction(artifactId, revision, 'map.inspected', { selected: selected ?? null }, true)
  }

  return (
    <div className={css.workspace} data-placement={placement}>
      <div className={css.stage}>
        <div className={css.legend}>
          <span className={css.legendItem} data-current="true"><i className={css.swatchAccent} aria-hidden="true" />{selected ?? '—'}</span>
        </div>
        <div className={css.plot}>
          <canvas ref={canvasRef} className={css.chart} role="img" aria-label={t('scene.map')}
            onClick={(event) => {
              const canvas = canvasRef.current
              if (!canvas) return
              const rect = canvas.getBoundingClientRect()
              const x = event.clientX - rect.left
              const y = event.clientY - rect.top
              const markers = spec.markers.map((marker) => {
                const xs = spec.markers.map(m => m.x)
                const ys = spec.markers.map(m => m.y)
                const minX = Math.min(...xs)
                const maxX = Math.max(...xs)
                const minY = Math.min(...ys)
                const maxY = Math.max(...ys)
                return {
                  id: marker.id,
                  x: 60 + ((marker.x - minX) / (maxX - minX || 1)) * (900 - 120),
                  y: 60 + ((marker.y - minY) / (maxY - minY || 1)) * (420 - 120),
                }
              })
              for (const marker of markers) {
                if (Math.hypot(x - marker.x, y - marker.y) < 40) {
                  setSelected(marker.id)
                  break
                }
              }
            }} />
        </div>
        <div className={css.readout} role="status" aria-live="polite">
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.selectedMarker')}</span><span className={css.readoutValue}>{selected ?? '—'}</span></div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.markers')}</span><span className={css.readoutValue}>{spec.markers.length}</span></div>
        </div>
      </div>
      <aside className={css.panel} aria-label={t('scene.controls')}>
        <div className={css.buttonRow}>
          <Button size="sm" variant="ghost" className={css.toggle} onClick={() => {
            const ids = spec.markers.map(marker => marker.id)
            const index = selected === undefined ? -1 : ids.indexOf(selected)
            setSelected(ids[(index + 1) % ids.length])
          }}>{t('scene.next')}</Button>
        </div>
        {canRecord && <Button size="sm" variant="outline" disabled={recordPending} onClick={() => { void confirm() }}>{t('scene.confirm')}</Button>}
        <p className={css.hint}>{t('scene.mapHint')}</p>
      </aside>
    </div>
  )
}
