/** Native FunctionPlot renderer for validated SceneSpec values. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { evaluateExpression, parseExpression, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { recordSceneVideo } from './scene-video.ts'
import type { FunctionPlotSpec } from '@deepseek-ai/dsh-artifact/scene'
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import type { ArtifactPlacement, RecordArtifactAction } from './protocol.ts'
import css from './FunctionPlotView.module.css'

interface FunctionPlotViewProps {
  readonly spec: FunctionPlotSpec
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly placement: ArtifactPlacement
  readonly recordAction: RecordArtifactAction
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
const COLUMNS = 6
const ROWS = 4

/**
 * Render a validated FunctionPlot SceneSpec without executing generated source.
 * @param props - SceneSpec, Artifact identity, placement, confirmation callback, and locale seat.
 * @returns An interactive native function-plot editor.
 */
export function FunctionPlotView({ spec, artifactId, revision, placement, recordAction, onStateChange, t }: FunctionPlotViewProps) {
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

  const evaluateAt = (fn: ParsedFunction, x: number): number => evaluateExpression(fn.node, {
    ...parameters, x, t: x, pi: Math.PI, e: Math.E,
  })
  const derivativeAt = (x: number): number => {
    if (!currentFunction) return 0
    const h = 0.001
    return (evaluateAt(currentFunction, x + h) - evaluateAt(currentFunction, x - h)) / (2 * h)
  }
  const integralAt = (x: number): number => {
    if (!currentFunction) return 0
    const steps = 200
    const width = x / steps
    let total = 0
    for (let index = 0; index <= steps; index++) {
      const weight = index === 0 || index === steps ? 0.5 : 1
      total += evaluateAt(currentFunction, index * width) * weight
    }
    return total * width
  }

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
    const context = canvas.getContext('2d')
    if (!context) return
    const { width, height } = size
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const style = getComputedStyle(canvas)
    const ink = style.getPropertyValue('--dsw-alias-label-primary').trim()
    const muted = style.getPropertyValue('--dsw-alias-label-tertiary').trim()
    const accent = style.getPropertyValue('--dsw-alias-state-business-primary').trim()
    const good = style.getPropertyValue('--dsw-alias-state-success-primary').trim()
    const grid = style.getPropertyValue('--dsw-alias-border-l2').trim()
    const surface = style.getPropertyValue('--dsw-alias-bg-base').trim()
    const [xMin, xMax] = spec.viewport.x
    const [yMin, yMax] = spec.viewport.y
    const xRange = (xMax - xMin) / scale
    const yRange = (yMax - yMin) / scale
    const centerX = (xMin + xMax) / 2 + pan
    const centerY = (yMin + yMax) / 2
    const xToPixel = (x: number): number => ((x - (centerX - xRange / 2)) / xRange) * width
    const yToPixel = (y: number): number => height - ((y - (centerY - yRange / 2)) / yRange) * height
    const pixelToX = (pixel: number): number => centerX - xRange / 2 + (pixel / width) * xRange
    const currentValue = evaluateAt(currentFunction, traceX)

    context.clearRect(0, 0, width, height)
    context.strokeStyle = grid
    context.lineWidth = 1
    for (let index = 0; index <= COLUMNS; index++) {
      const x = centerX - xRange / 2 + (index / COLUMNS) * xRange
      context.beginPath(); context.moveTo(xToPixel(x), 0); context.lineTo(xToPixel(x), height); context.stroke()
    }
    for (let index = 0; index <= ROWS; index++) {
      const y = centerY - yRange / 2 + (index / ROWS) * yRange
      context.beginPath(); context.moveTo(0, yToPixel(y)); context.lineTo(width, yToPixel(y)); context.stroke()
    }
    context.strokeStyle = muted
    context.globalAlpha = 0.55
    context.beginPath(); context.moveTo(0, yToPixel(0)); context.lineTo(width, yToPixel(0)); context.stroke()
    context.beginPath(); context.moveTo(xToPixel(0), 0); context.lineTo(xToPixel(0), height); context.stroke()
    context.globalAlpha = 1

    if (showIntegral) {
      context.fillStyle = good
      context.globalAlpha = 0.1
      context.beginPath()
      context.moveTo(xToPixel(0), yToPixel(0))
      for (let pixel = 0; pixel <= width; pixel++) {
        const x = pixelToX(pixel)
        if (x > traceX) break
        const y = evaluateAt(currentFunction, x)
        if (!Number.isFinite(y)) continue
        context.lineTo(pixel, yToPixel(y))
      }
      context.lineTo(xToPixel(traceX), yToPixel(0))
      context.closePath()
      context.fill()
      context.globalAlpha = 1
    }

    for (const [index, fn] of functions.entries()) {
      context.strokeStyle = index === 0 ? accent : good
      context.lineWidth = fn.id === currentFunction.id ? 2.5 : 1.5
      context.globalAlpha = fn.id === currentFunction.id ? 1 : 0.45
      context.beginPath()
      let drawing = false
      for (let pixel = 0; pixel <= width; pixel++) {
        const y = evaluateAt(fn, pixelToX(pixel))
        if (!Number.isFinite(y)) {
          drawing = false
          continue
        }
        if (drawing) context.lineTo(pixel, yToPixel(y))
        else {
          context.moveTo(pixel, yToPixel(y))
          drawing = true
        }
      }
      context.stroke()
    }
    context.globalAlpha = 1

    if (showDerivative) {
      const slope = derivativeAt(traceX)
      context.strokeStyle = accent
      context.globalAlpha = 0.7
      context.setLineDash([4, 4])
      context.beginPath()
      for (let pixel = 0; pixel <= width; pixel++) {
        const x = pixelToX(pixel)
        const y = currentValue + slope * (x - traceX)
        if (!Number.isFinite(y)) continue
        if (pixel === 0) context.moveTo(pixel, yToPixel(y))
        else context.lineTo(pixel, yToPixel(y))
      }
      context.stroke()
      context.setLineDash([])
      context.globalAlpha = 1
    }

    // Axis values are printed against the last row and column of the grid so
    // the plot reads without a separate legend box.
    context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    context.fillStyle = muted
    context.textBaseline = 'bottom'
    for (let index = 0; index <= COLUMNS; index++) {
      const x = centerX - xRange / 2 + (index / COLUMNS) * xRange
      const pixel = xToPixel(x)
      if (pixel < 16 || pixel > width - 24) continue
      context.fillText(x.toFixed(1), pixel + 4, height - 4)
    }
    context.textBaseline = 'middle'
    for (let index = 0; index <= ROWS; index++) {
      const y = centerY - yRange / 2 + (index / ROWS) * yRange
      const pixel = yToPixel(y)
      if (pixel < 14 || pixel > height - 14) continue
      context.fillText(y.toFixed(1), 5, pixel - 7)
    }

    // Trace: a guide at the sampled x and a ringed marker on the curve.
    context.strokeStyle = muted
    context.globalAlpha = 0.5
    context.setLineDash([3, 3])
    context.beginPath(); context.moveTo(xToPixel(traceX), 0); context.lineTo(xToPixel(traceX), height); context.stroke()
    context.setLineDash([])
    context.globalAlpha = 1
    if (Number.isFinite(currentValue)) {
      context.beginPath()
      context.arc(xToPixel(traceX), yToPixel(currentValue), 4.5, 0, Math.PI * 2)
      context.fillStyle = good
      context.fill()
      context.lineWidth = 1.5
      context.strokeStyle = surface
      context.stroke()
    }
    context.fillStyle = ink
    context.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
    context.textBaseline = 'middle'
    const traceTag = `x ${traceX.toFixed(2)}`
    const traceTagX = Math.min(width - 62, xToPixel(traceX) + 8)
    context.fillText(traceTag, traceTagX, 14)
  }, [spec, currentFunction, functions, parameters, traceX, scale, pan, showDerivative, showIntegral, size])

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
    if (!currentFunction) return
    await recordAction(artifactId, revision, 'plot.inspected', {
      x: traceX, parameters, derivative: derivativeAt(traceX), integral: integralAt(traceX), zoom: scale,
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

  const derivative = derivativeAt(traceX)
  const integral = integralAt(traceX)
  const currentValue = currentFunction ? evaluateAt(currentFunction, traceX) : 0

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
    { symbol: 'f(x)', value: currentFunction ? currentValue.toFixed(3) : '—' },
    { symbol: 'f′(x)', value: currentFunction ? derivative.toFixed(3) : '—' },
    { symbol: '∫', value: currentFunction ? integral.toFixed(3) : '—' },
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
        <Button size="sm" variant="outline" onClick={() => { void confirm() }}>{t('scene.confirm')}</Button>
        <Button size="sm" variant="ghost" className={css.toggle} data-selected={recording ? '' : undefined}
          aria-pressed={recording} onClick={exportVideo}>{recording ? t('scene.stopRecording') : t('scene.exportVideo')}</Button>
        <p className={css.hint}>{t('scene.hint')}</p>
      </aside>
    </div>
  )
}
