/** Native network-graph renderer for validated SceneSpec values. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RuntimeReport } from '@deepseek-ai/dsh-artifact-runtime/types'
import { drawNativeScene } from './native-runtime.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { NetworkGraphSpec } from '@deepseek-ai/dsh-artifact/scene'
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import type { ArtifactPlacement, RecordArtifactAction } from './protocol.ts'
import { renderNetworkGraph } from './renderers/network-graph.ts'
import css from './FunctionPlotView.module.css'

interface NetworkGraphViewProps {
  readonly spec: NetworkGraphSpec
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
 * Render a validated NetworkGraph SceneSpec with a selectable relationship graph.
 * @param props - SceneSpec, Artifact identity, placement, confirmation callback, and locale seat.
 * @returns An interactive network graph with a selected node and highlighted neighbours.
 */
export function NetworkGraphView({
  spec, artifactId, revision, placement, recordAction, canRecord = true, recordPending = false, onRuntimeReport, onStateChange, t,
}: NetworkGraphViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [selected, setSelected] = useState<string | undefined>(spec.nodes[0]?.id)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    drawNativeScene(canvas, () => {
      renderNetworkGraph(spec, canvas, 900, 420, { ...(selected === undefined ? {} : { selected }) })
    }, onRuntimeReport)
  }, [spec, selected, onRuntimeReport])

  useEffect(() => {
    onStateChange?.({ selected: selected ?? null })
  }, [onStateChange, selected])

  const neighbours = selected === undefined ? [] : spec.edges
    .filter(edge => edge.from === selected || edge.to === selected)
    .map(edge => edge.from === selected ? edge.to : edge.from)

  const confirm = async (): Promise<void> => {
    if (!canRecord || recordPending) return
    await recordAction(artifactId, revision, 'network.inspected', { selected: selected ?? null, neighbours }, true)
  }

  return (
    <div className={css.workspace} data-placement={placement}>
      <div className={css.stage}>
        <div className={css.legend}>
          <span className={css.legendItem} data-current="true"><i className={css.swatchAccent} aria-hidden="true" />{selected ?? '—'}</span>
        </div>
        <div className={css.plot}>
          <canvas ref={canvasRef} className={css.chart} role="img" aria-label={t('scene.networkGraph')}
            onClick={(event) => {
              const canvas = canvasRef.current
              if (!canvas) return
              const rect = canvas.getBoundingClientRect()
              const x = event.clientX - rect.left
              const y = event.clientY - rect.top
              const nodes = spec.nodes.map(node => ({
                id: node.id,
                x: 70 + ((node.x + 1) / 2) * (900 - 140),
                y: 60 + ((node.y + 1) / 2) * (420 - 120),
              }))
              for (const node of nodes) {
                if (Math.hypot(x - node.x, y - node.y) < 40) {
                  setSelected(node.id)
                  break
                }
              }
            }} />
        </div>
        <div className={css.readout} role="status" aria-live="polite">
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.selectedNode')}</span><span className={css.readoutValue}>{selected ?? '—'}</span></div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.neighbours')}</span><span className={css.readoutValue}>{neighbours.length}</span></div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.nodes')}</span><span className={css.readoutValue}>{spec.nodes.length}</span></div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.edges')}</span><span className={css.readoutValue}>{spec.edges.length}</span></div>
        </div>
      </div>
      <aside className={css.panel} aria-label={t('scene.controls')}>
        <div className={css.buttonRow}>
          <Button size="sm" variant="ghost" className={css.toggle} onClick={() => {
            const ids = spec.nodes.map(node => node.id)
            const index = selected === undefined ? -1 : ids.indexOf(selected)
            setSelected(ids[(index + 1) % ids.length])
          }}>{t('scene.next')}</Button>
        </div>
        {canRecord && <Button size="sm" variant="outline" disabled={recordPending} onClick={() => { void confirm() }}>{t('scene.confirm')}</Button>}
        <p className={css.hint}>{t('scene.networkHint')}</p>
      </aside>
    </div>
  )
}
