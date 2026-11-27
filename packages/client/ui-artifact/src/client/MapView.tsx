/** Native map renderer for validated SceneSpec values. */
import { useState } from 'react'
import type { MapSpec } from '@agentrans/artifact/scene'
import { pointBounds } from '@agentrans/artifact/scene-renderers'
import { renderMap } from './renderers/map.ts'
import { canvasPoint, nextSceneId, SceneButton, SceneControls, SceneStage, useSelectionCanvas, type SceneViewProps } from './SceneViewParts.tsx'
import css from './FunctionPlotView.module.css'

/**
 * Render a validated Map SceneSpec with selectable positioned markers.
 * @param props - SceneSpec, Artifact identity, placement, confirmation callback, and locale seat.
 * @returns An interactive map with a selected marker and its detail card.
 */
export function MapView({
  spec, artifactId, revision, placement, recordAction, canRecord = true, recordPending = false, onRuntimeReport, onStateChange, t,
}: SceneViewProps<MapSpec>) {
  const [selected, setSelected] = useState<string | undefined>(spec.path?.[0] ?? spec.markers[0]?.id)
  const canvasRef = useSelectionCanvas(renderMap, spec, selected, { onRuntimeReport, onStateChange })

  const confirm = async (): Promise<void> => {
    if (!canRecord || recordPending) return
    await recordAction(artifactId, revision, 'map.inspected', { selected: selected ?? null }, true)
  }

  return (
    <div className={css.workspace} data-placement={placement}>
      <SceneStage legend={selected ?? '—'} canvasRef={canvasRef} label={t('scene.map')}
        onCanvasClick={(event) => {
          const { x, y } = canvasPoint(event)
          const { minX, minY, spanX, spanY } = pointBounds(spec.markers)
          const hit = spec.markers.find(marker => Math.hypot(
            x - (60 + ((marker.x - minX) / spanX) * (900 - 120)),
            y - (60 + ((marker.y - minY) / spanY) * (420 - 120)),
          ) < 40)
          if (hit !== undefined) setSelected(hit.id)
        }}
        readout={[
          [t('scene.selectedMarker'), selected ?? '—'],
          [t('scene.markers'), spec.markers.length],
        ]} />
      <SceneControls canRecord={canRecord} recordPending={recordPending} onConfirm={confirm} hint={t('scene.mapHint')} t={t}>
        <SceneButton onClick={() => { setSelected(nextSceneId(spec.markers.map(marker => marker.id), selected)) }}>{t('scene.next')}</SceneButton>
      </SceneControls>
    </div>
  )
}
