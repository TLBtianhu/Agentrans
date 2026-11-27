/** Native Flowchart renderer for validated SceneSpec values. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { drawNativeScene, scenePaletteFor } from './native-runtime.ts'
import type { FlowchartSpec } from '@agentrans/artifact/scene'
import { pointBounds } from '@agentrans/artifact/scene-renderers'
import { renderFlowchart } from './renderers/flowchart.ts'
import { canvasPoint, SceneButton, SceneControls, SceneStage, ScenePlayButton, type SceneViewProps } from './SceneViewParts.tsx'
import css from './FunctionPlotView.module.css'

interface LayoutNode {
  readonly id: string
  readonly label: string
  readonly x: number
  readonly y: number
}

/**
 * Render a validated Flowchart SceneSpec without executing generated source.
 * @param props - SceneSpec, Artifact identity, placement, confirmation callback, and locale seat.
 * @returns An interactive flowchart with selectable nodes and path advancement.
 */
export function FlowchartView({
  spec, artifactId, revision, placement, recordAction, canRecord = true, recordPending = false, onRuntimeReport, onStateChange, t,
}: SceneViewProps<FlowchartSpec>) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [selected, setSelected] = useState(spec.path?.[0] ?? spec.nodes[0]?.id ?? '')
  const [pathIndex, setPathIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const nodes = useMemo<readonly LayoutNode[]>(() => {
    const { minX, minY, spanX, spanY } = pointBounds(spec.nodes)
    return spec.nodes.map(node => ({
      id: node.id,
      label: node.label,
      x: (node.x - minX) / spanX,
      y: (node.y - minY) / spanY,
    }))
  }, [spec.nodes])
  const path = spec.path ?? []
  const currentId = path[pathIndex] ?? selected
  const selectedNode = nodes.find(node => node.id === selected)
  const currentNode = nodes.find(node => node.id === currentId)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    drawNativeScene(canvas, () => {
      renderFlowchart(spec, canvas, 900, 420, { selected, pathIndex }, scenePaletteFor(canvas))
    }, onRuntimeReport)
  }, [spec, selected, pathIndex, onRuntimeReport])

  useEffect(() => {
    if (!playing || path.length === 0) return
    const timer = window.setInterval(() => {
      setPathIndex((index) => {
        const next = index + 1
        if (next >= path.length) {
          setPlaying(false)
          return index
        }
        return next
      })
    }, Math.max(400, 1000 / (spec.timeline?.fps ?? 30) * 4))
    return () => { window.clearInterval(timer) }
  }, [playing, path.length, spec.timeline])

  useEffect(() => {
    onStateChange?.({ selected, pathIndex, node: currentId })
  }, [onStateChange, selected, pathIndex, currentId])

  const confirm = async (): Promise<void> => {
    if (!canRecord || recordPending) return
    await recordAction(artifactId, revision, 'flow.inspected', { selected, pathIndex, node: currentId, path: [...path] }, true)
  }

  return (
    <div className={css.workspace} data-placement={placement}>
      <SceneStage legend={currentNode?.label ?? currentId} canvasRef={canvasRef} label={t('scene.flowchart')}
        onCanvasClick={(event) => {
          const { x, y } = canvasPoint(event)
          const hit = nodes.find(node => Math.abs(x - (70 + node.x * (900 - 140))) < 60 && Math.abs(y - (60 + node.y * (420 - 120))) < 26)
          if (hit === undefined) return
          setSelected(hit.id)
          const index = path.indexOf(hit.id)
          if (index >= 0) setPathIndex(index)
        }}
        readout={[
          [t('scene.selectedNode'), selectedNode?.label ?? '—'],
          [t('scene.pathStep'), path.length > 0 ? `${pathIndex + 1}/${path.length}` : '—'],
          [t('scene.nodes'), spec.nodes.length],
          [t('scene.edges'), spec.edges.length],
        ]} />
      <SceneControls canRecord={canRecord} recordPending={recordPending} onConfirm={confirm} hint={t('scene.flowchartHint')} t={t}>
        <SceneButton onClick={() => {
          if (path.length === 0) return
          const next = (pathIndex + 1) % path.length
          setPathIndex(next)
          setSelected(path[next] ?? selected)
        }}>{t('scene.next')}</SceneButton>
        <ScenePlayButton playing={playing} onToggle={() => { setPlaying(value => !value) }} t={t} />
      </SceneControls>
    </div>
  )
}
