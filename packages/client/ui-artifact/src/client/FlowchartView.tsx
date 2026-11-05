/** Native Flowchart renderer for validated SceneSpec values. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { FlowchartSpec } from '@deepseek-ai/dsh-artifact/scene'
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import { renderFlowchart } from './renderers/flowchart.ts'
import type { ArtifactPlacement, RecordArtifactAction } from './protocol.ts'
import css from './FunctionPlotView.module.css'

interface FlowchartViewProps {
  readonly spec: FlowchartSpec
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly placement: ArtifactPlacement
  readonly recordAction: RecordArtifactAction
  readonly onStateChange?: ((state: JsonValue) => void) | undefined
  readonly t: PropsLocale<'artifact'>['t']
}

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
export function FlowchartView({ spec, artifactId, revision, placement, recordAction, onStateChange, t }: FlowchartViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [selected, setSelected] = useState(spec.path?.[0] ?? spec.nodes[0]?.id ?? '')
  const [pathIndex, setPathIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const nodes = useMemo<readonly LayoutNode[]>(() => {
    const xs = spec.nodes.map(node => node.x)
    const ys = spec.nodes.map(node => node.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const spanX = maxX - minX || 1
    const spanY = maxY - minY || 1
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
    renderFlowchart(spec, canvas, 900, 420, { selected, pathIndex })
  }, [spec, selected, pathIndex])

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
    await recordAction(artifactId, revision, 'flow.inspected', { selected, pathIndex, node: currentId, path: [...path] }, true)
  }

  return (
    <div className={css.workspace} data-placement={placement}>
      <div className={css.stage}>
        <div className={css.legend}>
          <span className={css.legendItem} data-current="true"><i className={css.swatchAccent} aria-hidden="true" />{currentNode?.label ?? currentId}</span>
        </div>
        <div className={css.plot}>
          <canvas ref={canvasRef} className={css.chart} role="img" aria-label={t('scene.flowchart')}
            onClick={(event) => {
              const canvas = canvasRef.current
              if (!canvas) return
              const rect = canvas.getBoundingClientRect()
              const x = event.clientX - rect.left
              const y = event.clientY - rect.top
              for (const node of nodes) {
                const centerX = 70 + node.x * (900 - 140)
                const centerY = 60 + node.y * (420 - 120)
                if (Math.abs(x - centerX) < 60 && Math.abs(y - centerY) < 26) {
                  setSelected(node.id)
                  const index = path.indexOf(node.id)
                  if (index >= 0) setPathIndex(index)
                  break
                }
              }
            }} />
        </div>
        <div className={css.readout} role="status" aria-live="polite">
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.selectedNode')}</span><span className={css.readoutValue}>{selectedNode?.label ?? '—'}</span></div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.pathStep')}</span><span className={css.readoutValue}>{path.length > 0 ? `${pathIndex + 1}/${path.length}` : '—'}</span></div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.nodes')}</span><span className={css.readoutValue}>{spec.nodes.length}</span></div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.edges')}</span><span className={css.readoutValue}>{spec.edges.length}</span></div>
        </div>
      </div>
      <aside className={css.panel} aria-label={t('scene.controls')}>
        <div className={css.buttonRow}>
          <Button size="sm" variant="ghost" className={css.toggle} onClick={() => {
            if (path.length === 0) return
            const next = (pathIndex + 1) % path.length
            setPathIndex(next)
            setSelected(path[next] ?? selected)
          }}>{t('scene.next')}</Button>
          <Button size="sm" variant="ghost" className={css.toggle} data-selected={playing ? '' : undefined}
            aria-pressed={playing} onClick={() => { setPlaying(value => !value) }}>{playing ? t('scene.pause') : t('scene.play')}</Button>
        </div>
        <Button size="sm" variant="outline" onClick={() => { void confirm() }}>{t('scene.confirm')}</Button>
        <p className={css.hint}>{t('scene.flowchartHint')}</p>
      </aside>
    </div>
  )
}
