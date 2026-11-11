/** Native FunctionPlot renderer for validated SceneSpec values. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeReport } from '@agentrans/artifact-runtime/types'
import { drawNativeScene, scenePaletteFor } from './native-runtime.ts'
import type { PropsLocale } from '@agentrans/client-ui-slots'
import { Button } from '@agentrans/client-ui-primitives'
import { parseExpression, type JsonValue } from '@agentrans/util-values'
import { recordSceneVideo } from './scene-video.ts'
import { renderFunctionPlot } from './renderers/function-plot.ts'
import { analyzeFunction } from './renderers/function-analysis.ts'
import type { FunctionPlotSpec } from '@agentrans/artifact/scene'
import type { ArtifactId } from '@agentrans/artifact/types'
import type { ArtifactPlacement, RecordArtifactAction } from './protocol.ts'
import css from './FunctionPlotView.module.css'

interface FunctionPlotViewProps {
  readonly spec: FunctionPlotSpec
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

interface ParsedFunction {
  readonly id: string
  readonly label: string
  readonly node: ReturnType<typeof parseExpression>
}

interface CanvasSize {
  readonly width: number
  readonly height: number
}

const FALLBACK_SIZE: CanvasSize = { width: 640, height: 300 }
/** Grid lines per axis; the same counts label the axis ticks. */

/**
 * Render a validated FunctionPlot SceneSpec without executing generated source.
 * @param props - SceneSpec, Artifact identity, placement, confirmation callback, and locale seat.
 * @returns An interactive native function-plot editor.
 */
export function FunctionPlotView({
  spec, artifactId, revision, placement, recordAction, canRecord = true, recordPending = false, onRuntimeReport, onStateChange, t,
}: FunctionPlotViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const plotRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef({ active: false, x: 0 })
  const [size, setSize] = useState<CanvasSize>(FALLBACK_SIZE)
  const [parameters, setParameters] = useState<Record<string, number>>(() =>
    Object.fromEntries(Object.entries(spec.parameters).map(([key, value]) => [key, value.value])),
  )
  const [traceX, setTraceX] = useState(spec.trace.x)
  const [selectedFunction, setSelectedFunction] = useState(spec.functions[0]?.id ?? '')
  const [showDerivative, setShowDerivative] = useState(spec.trace.derivative)
  const [showIntegral, setShowIntegral] = useState(spec.trace.integral)
  const [scale, setScale] = useState(1)
  const [pan, setPan] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [recording, setRecording] = useState(false)
  const recordingRef = useRef<{ stop: () => void } | null>(null)

  const functions = useMemo<readonly ParsedFunction[]>(() => spec.functions.map(fn => ({
    id: fn.id, label: fn.label, node: parseExpression(fn.expression, Object.keys(spec.parameters)),
  })), [spec])
  const currentFunction = functions.find(fn => fn.id === selectedFunction) ?? functions[0]
  const sweepKey = Object.keys(spec.parameters)[0]
  const sweep = sweepKey === undefined ? undefined : spec.parameters[sweepKey]

  const analysis = currentFunction === undefined
    ? { value: null, derivative: null, integral: null }
    : analyzeFunction(currentFunction.node, parameters, traceX)

  // The canvas is drawn in CSS pixels: sizing the backing store from the
  // stage's measured box keeps the plot sharp and un-stretched in every
  // placement instead of resampling one fixed bitmap.
  useEffect(() => {
    const plot = plotRef.current
    if (plot === null) return
    const update = (): void => {
      const rect = plot.getBoundingClientRect()
      const width = Math.max(280, Math.round(rect.width))
      const height = Math.max(180, Math.round(rect.height))
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height })
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(plot)
    return () => { observer.disconnect() }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !currentFunction) return
    drawNativeScene(canvas, () => { renderFunctionPlot(spec, canvas, size.width, size.height, {
      traceX, scale, pan, parameters, currentFunctionId: currentFunction.id, showDerivative, showIntegral,
    }, scenePaletteFor(canvas)) }, onRuntimeReport)
  }, [spec, currentFunction, functions, parameters, traceX, scale, pan, showDerivative, showIntegral, size, onRuntimeReport])

  // React's onWheel is passive, so preventDefault cannot stop the page from
  // scrolling. A native non-passive listener is required for an explicit zoom.
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    function handleWheel(event: WheelEvent): void {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const factor = Math.exp(-event.deltaY * 0.001)
      setScale((current) => {
        const next = current * factor
        return next < 0.25 ? 0.25 : next > 8 ? 8 : next
      })
    }
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => { canvas.removeEventListener('wheel', handleWheel) }
  }, [])

  useEffect(() => {
    if (!playing || sweepKey === undefined || sweep === undefined) return
    let frame = 0
    let previous = 0
    const tick = (now: number): void => {
      if (previous === 0) previous = now
      if (now - previous >= 90) {
        previous = now
        setParameters((current) => {
          const next = (current[sweepKey] ?? sweep.value) + sweep.step
          return { ...current, [sweepKey]: next > sweep.max ? sweep.min : next }
        })
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame) }
  }, [playing, sweep, sweepKey])

  const reset = (): void => {
    setPlaying(false)
    setParameters(Object.fromEntries(Object.entries(spec.parameters).map(([key, value]) => [key, value.value])))
    setTraceX(spec.trace.x)
    setSelectedFunction(spec.functions[0]?.id ?? '')
    setShowDerivative(spec.trace.derivative)
    setShowIntegral(spec.trace.integral)
    setScale(1)
    setPan(0)
  }

  const confirm = async (): Promise<void> => {
    if (!canRecord || recordPending) return
    if (!currentFunction) return
    await recordAction(artifactId, revision, 'plot.inspected', {
      x: traceX, parameters, derivative: analysis.derivative, integral: analysis.integral, zoom: scale,
    }, true)
  }

  const exportVideo = (): void => {
    if (recording) {
      recordingRef.current?.stop()
      recordingRef.current = null
      setRecording(false)
      setPlaying(false)
      return
    }
    const canvas = canvasRef.current
    if (canvas === null) return
    const handle = recordSceneVideo(spec, canvas)
    if (handle === null) return
    recordingRef.current = handle
    setRecording(true)
    setPlaying(true)
    const duration = spec.timeline?.duration ?? 8
    window.setTimeout(() => {
      recordingRef.current?.stop()
      recordingRef.current = null
      setRecording(false)
      setPlaying(false)
    }, duration * 1000)
  }

  const { value: currentValue, derivative, integral } = analysis

  // A comparison host reads the current analysis as a local state report;
  // reporting it never wakes the Agent by itself.
  useEffect(() => {
    onStateChange?.({
      x: traceX, parameters, derivative, integral, zoom: scale,
      ...(currentFunction === undefined ? {} : { function: currentFunction.id }),
    })
  }, [onStateChange, parameters, traceX, derivative, integral, scale, currentFunction])

  const readout: readonly { readonly symbol: string; readonly value: string }[] = [
    { symbol: t('scene.trace'), value: traceX.toFixed(2) },
    { symbol: 'f(x)', value: currentValue === null ? '—' : currentValue.toFixed(3) },
    { symbol: 'f′(x)', value: derivative === null ? '—' : derivative.toFixed(3) },
    { symbol: '∫', value: integral === null ? '—' : integral.toFixed(3) },
  ]

  return (
    <div className={css.workspace} data-placement={placement}>
      <div className={css.stage}>
        <div className={css.legend}>
          {functions.map((fn, index) => (
            <span key={fn.id} className={css.legendItem} data-current={fn.id === currentFunction?.id ? '' : undefined}>
              <i className={index === 0 ? css.swatchAccent : css.swatchSecondary} aria-hidden="true" />
              {fn.label}
            </span>
          ))}
        </div>
        <div className={css.plot} ref={plotRef}>
          <canvas ref={canvasRef} className={css.chart} role="img" aria-label={t('scene.canvas')}
            onPointerDown={(event) => {
              dragRef.current = { active: true, x: event.clientX }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerUp={() => { dragRef.current.active = false }}
            onPointerMove={(event) => {
              const canvas = canvasRef.current
              if (!canvas) return
              const rect = canvas.getBoundingClientRect()
              const [xMin, xMax] = spec.viewport.x
              const range = (xMax - xMin) / scale
              const center = (xMin + xMax) / 2 + pan
              if (dragRef.current.active) {
                const delta = (event.clientX - dragRef.current.x) / rect.width * range
                setPan(current => current - delta)
                dragRef.current.x = event.clientX
              }
              setTraceX(center - range / 2 + ((event.clientX - rect.left) / rect.width) * range)
            }} />
        </div>
        <div className={css.readout} role="status" aria-live="polite">
          {readout.map(item => (
            <div key={item.symbol} className={css.readoutItem}>
              <span className={css.readoutLabel}>{item.symbol}</span>
              <span className={css.readoutValue}>{item.value}</span>
            </div>
          ))}
        </div>
      </div>

      <aside className={css.panel} aria-label={t('scene.controls')}>
        <div className={css.field}>
          <label htmlFor="scene-function">{t('scene.selected')}</label>
          <select id="scene-function" value={selectedFunction} onChange={(event) => { setSelectedFunction(event.target.value) }}>
            {functions.map(fn => <option key={fn.id} value={fn.id}>{fn.label}</option>)}
          </select>
        </div>
        {sweepKey && sweep && (
          <div className={css.field}>
            <label htmlFor="scene-parameter">{t('scene.parameter', { name: sweepKey })} <output>{(parameters[sweepKey] ?? sweep.value).toFixed(2)}</output></label>
            <input id="scene-parameter" type="range" min={sweep.min} max={sweep.max} step={sweep.step} value={parameters[sweepKey] ?? sweep.value}
              onChange={(event) => { setParameters(current => ({ ...current, [sweepKey]: Number(event.target.value) })) }} />
          </div>
        )}
        <div className={css.buttonRow}>
          <Button size="sm" variant="ghost" className={css.toggle} data-selected={showDerivative ? '' : undefined}
            aria-pressed={showDerivative} onClick={() => { setShowDerivative(value => !value) }}>{t('scene.derivative')}</Button>
          <Button size="sm" variant="ghost" className={css.toggle} data-selected={showIntegral ? '' : undefined}
            aria-pressed={showIntegral} onClick={() => { setShowIntegral(value => !value) }}>{t('scene.integral')}</Button>
        </div>
        <div className={css.buttonRow}>
          <Button size="sm" variant="ghost" className={css.toggle} aria-label={t('scene.zoomOut')}
            onClick={() => { setScale(current => Math.max(0.25, current / 1.25)) }}>−</Button>
          <Button size="sm" variant="ghost" className={css.toggle} aria-label={t('scene.zoomIn')}
            onClick={() => { setScale(current => Math.min(8, current * 1.25)) }}>+</Button>
          <Button size="sm" variant="ghost" className={css.toggle}
            onClick={() => { setScale(1); setPan(0) }}>{t('scene.viewReset')}</Button>
        </div>
        <div className={css.buttonRow}>
          <Button size="sm" variant="ghost" className={css.toggle} data-selected={playing ? '' : undefined}
            aria-pressed={playing} onClick={() => { setPlaying(value => !value) }}>{playing ? t('scene.pause') : t('scene.play')}</Button>
          <Button size="sm" variant="ghost" className={css.toggle} onClick={() => {
            if (!sweepKey || !sweep) return
            setParameters((current) => {
              const next = (current[sweepKey] ?? sweep.value) + sweep.step
              return { ...current, [sweepKey]: next > sweep.max ? sweep.min : next }
            })
          }}>{t('scene.step')}</Button>
          <Button size="sm" variant="ghost" className={css.toggle} onClick={reset}>{t('scene.reset')}</Button>
        </div>
        {canRecord && <Button size="sm" variant="outline" disabled={recordPending} onClick={() => { void confirm() }}>{t('scene.confirm')}</Button>}
        <Button size="sm" variant="ghost" className={css.toggle} data-selected={recording ? '' : undefined}
          aria-pressed={recording} onClick={exportVideo}>{recording ? t('scene.stopRecording') : t('scene.exportVideo')}</Button>
        <p className={css.hint}>{t('scene.hint')}</p>
      </aside>
    </div>
  )
}
