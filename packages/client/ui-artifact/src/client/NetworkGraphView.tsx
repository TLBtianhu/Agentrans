/** Native network-graph renderer for validated SceneSpec values. */
import { useState } from 'react'
import type { NetworkGraphSpec } from '@agentrans/artifact/scene'
import { renderNetworkGraph } from './renderers/network-graph.ts'
import { canvasPoint, nextSceneId, SceneButton, SceneControls, SceneStage, useSelectionCanvas, type SceneViewProps } from './SceneViewParts.tsx'
import css from './FunctionPlotView.module.css'

/**
 * Render a validated NetworkGraph SceneSpec with a selectable relationship graph.
 * @param props - SceneSpec, Artifact identity, placement, confirmation callback, and locale seat.
 * @returns An interactive network graph with a selected node and highlighted neighbours.
 */
export function NetworkGraphView({
  spec, artifactId, revision, placement, recordAction, canRecord = true, recordPending = false, onRuntimeReport, onStateChange, t,
}: SceneViewProps<NetworkGraphSpec>) {
  const [selected, setSelected] = useState<string | undefined>(spec.nodes[0]?.id)
  const canvasRef = useSelectionCanvas(renderNetworkGraph, spec, selected, { onRuntimeReport, onStateChange })

  const neighbours = selected === undefined ? [] : spec.edges
    .filter(edge => edge.from === selected || edge.to === selected)
    .map(edge => edge.from === selected ? edge.to : edge.from)

  const confirm = async (): Promise<void> => {
    if (!canRecord || recordPending) return
    await recordAction(artifactId, revision, 'network.inspected', { selected: selected ?? null, neighbours }, true)
  }

  return (
    <div className={css.workspace} data-placement={placement}>
      <SceneStage legend={selected ?? '—'} canvasRef={canvasRef} label={t('scene.networkGraph')}
        onCanvasClick={(event) => {
          const { x, y } = canvasPoint(event)
          const hit = spec.nodes.find(node => Math.hypot(
            x - (70 + ((node.x + 1) / 2) * (900 - 140)),
            y - (60 + ((node.y + 1) / 2) * (420 - 120)),
          ) < 40)
          if (hit !== undefined) setSelected(hit.id)
        }}
        readout={[
          [t('scene.selectedNode'), selected ?? '—'],
          [t('scene.neighbours'), neighbours.length],
          [t('scene.nodes'), spec.nodes.length],
          [t('scene.edges'), spec.edges.length],
        ]} />
      <SceneControls canRecord={canRecord} recordPending={recordPending} onConfirm={confirm} hint={t('scene.networkHint')} t={t}>
        <SceneButton onClick={() => { setSelected(nextSceneId(spec.nodes.map(node => node.id), selected)) }}>{t('scene.next')}</SceneButton>
      </SceneControls>
    </div>
  )
}
