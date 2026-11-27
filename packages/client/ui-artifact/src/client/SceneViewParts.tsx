/** Props, layout pieces, and selection state shared by the native canvas SceneSpec views. */
import { useEffect, useRef, type MouseEvent, type ReactNode, type RefObject } from 'react'
import type { PropsLocale } from '@agentrans/client-ui-slots'
import { Button } from '@agentrans/client-ui-primitives'
import type { RuntimeReport } from '@agentrans/artifact-runtime/types'
import type { ScenePalette } from '@agentrans/artifact/scene-renderers'
import type { ArtifactId } from '@agentrans/artifact/types'
import type { JsonValue } from '@agentrans/util-values'
import { drawNativeScene, scenePaletteFor } from './native-runtime.ts'
import type { ArtifactPlacement, RecordArtifactAction } from './protocol.ts'
import css from './FunctionPlotView.module.css'

/** Props every native canvas SceneSpec view receives. */
export interface SceneViewProps<Spec> {
  readonly spec: Spec
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
 * Locate a click inside the element that received it.
 * @param event - Click on the scene canvas.
 * @returns Element-relative coordinates and the element's rendered width.
 */
export function canvasPoint(event: MouseEvent<HTMLElement>): { readonly x: number; readonly y: number; readonly width: number } {
  const rect = event.currentTarget.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width }
}

/**
 * Step to the identifier after the selected one, wrapping at the end.
 * @param ids - Selectable identifiers in order.
 * @param selected - Current selection, if any.
 * @returns The next identifier; the first when nothing is selected.
 */
export function nextSceneId(ids: readonly string[], selected: string | undefined): string | undefined {
  const index = selected === undefined ? -1 : ids.indexOf(selected)
  return ids[(index + 1) % ids.length]
}

/** Canvas renderer of a view whose only state is one selected item. */
type SelectionRenderer<Spec> = (
  spec: Spec, canvas: HTMLCanvasElement, width: number, height: number,
  state: { readonly selected?: string }, palette: ScenePalette,
) => void

/**
 * Draw a single-selection scene and report its selection whenever either changes.
 * @param render - Renderer for this scene kind.
 * @param spec - Validated SceneSpec.
 * @param selected - Current selection, if any.
 * @param listeners - Runtime report and view state listeners.
 * @returns The canvas reference to attach.
 */
export function useSelectionCanvas<Spec>(
  render: SelectionRenderer<Spec>, spec: Spec, selected: string | undefined,
  { onRuntimeReport, onStateChange }: Pick<SceneViewProps<Spec>, 'onRuntimeReport' | 'onStateChange'>,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    drawNativeScene(canvas, () => {
      render(spec, canvas, 900, 420, { ...(selected === undefined ? {} : { selected }) }, scenePaletteFor(canvas))
    }, onRuntimeReport)
  }, [render, spec, selected, onRuntimeReport])
  useEffect(() => {
    onStateChange?.({ selected: selected ?? null })
  }, [onStateChange, selected])
  return canvasRef
}

/** Legend that names the current item above the canvas. */
function SceneLegend({ children }: { readonly children: ReactNode }) {
  return (
    <div className={css.legend}>
      <span className={css.legendItem} data-current="true"><i className={css.swatchAccent} aria-hidden="true" />{children}</span>
    </div>
  )
}

/** Live readout below the canvas, one labelled value per row. */
function SceneReadout({ items }: { readonly items: readonly (readonly [label: string, value: ReactNode])[] }) {
  return (
    <div className={css.readout} role="status" aria-live="polite">
      {items.map(([label, value]) => (
        <div key={label} className={css.readoutItem}>
          <span className={css.readoutLabel}>{label}</span><span className={css.readoutValue}>{value}</span>
        </div>
      ))}
    </div>
  )
}

/** Canvas stage: the current-item legend, the clickable scene canvas, and its live readout. */
export function SceneStage({ legend, canvasRef, label, onCanvasClick, readout }: {
  readonly legend: ReactNode
  readonly canvasRef: RefObject<HTMLCanvasElement>
  readonly label: string
  readonly onCanvasClick: (event: MouseEvent<HTMLCanvasElement>) => void
  readonly readout: readonly (readonly [label: string, value: ReactNode])[]
}) {
  return (
    <div className={css.stage}>
      <SceneLegend>{legend}</SceneLegend>
      <div className={css.plot}>
        <canvas ref={canvasRef} className={css.chart} role="img" aria-label={label} onClick={onCanvasClick} />
      </div>
      <SceneReadout items={readout} />
    </div>
  )
}

/** Compact ghost control in the scene control row. */
export function SceneButton({ onClick, children }: { readonly onClick: () => void; readonly children: ReactNode }) {
  return <Button size="sm" variant="ghost" className={css.toggle} onClick={onClick}>{children}</Button>
}

/** Play/pause toggle for views that animate through their items. */
export function ScenePlayButton({ playing, onToggle, t }: {
  readonly playing: boolean
  readonly onToggle: () => void
  readonly t: SceneViewProps<unknown>['t']
}) {
  return (
    <Button size="sm" variant="ghost" className={css.toggle} data-selected={playing ? '' : undefined}
      aria-pressed={playing} onClick={onToggle}>{playing ? t('scene.pause') : t('scene.play')}</Button>
  )
}

/** Control panel: the view's buttons, the confirmation action when recording is allowed, and a hint. */
export function SceneControls({ children, canRecord, recordPending, onConfirm, hint, t }: {
  readonly children: ReactNode
  readonly canRecord: boolean
  readonly recordPending: boolean
  readonly onConfirm: () => Promise<void>
  readonly hint: string
  readonly t: SceneViewProps<unknown>['t']
}) {
  return (
    <aside className={css.panel} aria-label={t('scene.controls')}>
      <div className={css.buttonRow}>{children}</div>
      {canRecord && <Button size="sm" variant="outline" disabled={recordPending} onClick={() => { void onConfirm() }}>{t('scene.confirm')}</Button>}
      <p className={css.hint}>{hint}</p>
    </aside>
  )
}
