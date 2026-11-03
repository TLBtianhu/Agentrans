/** Native FunctionPlot renderer for validated SceneSpec values. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { evaluateExpression, parseExpression } from '@deepseek-ai/dsh-util-values'
import type { FunctionPlotSpec } from '@deepseek-ai/dsh-artifact/scene'
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import type { RecordArtifactAction } from './protocol.ts'
import css from './FunctionPlotView.module.css'

interface FunctionPlotViewProps {
  readonly spec: FunctionPlotSpec
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly recordAction: RecordArtifactAction
  readonly t: PropsLocale<'artifact'>['t']
}

interface ParsedFunction {
  readonly id: string
  readonly label: string
  readonly node: ReturnType<typeof parseExpression>
}

/**
 * Render a validated FunctionPlot SceneSpec without executing generated source.
 * @param props - SceneSpec, Artifact identity, confirmation callback, and locale seat.
 * @returns An interactive native function-plot editor.
 */
export function FunctionPlotView({ spec, artifactId, revision, recordAction, t }: FunctionPlotViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<{ active: boolean; x: number }>({ active: false, x: 0 })
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

  const functions = useMemo<readonly ParsedFunction[]>(() => spec.functions.map(fn => ({
    id: fn.id, label: fn.label, node: parseExpression(fn.expression, Object.keys(spec.parameters)),
  })), [spec])
  const currentFunction = functions.find(fn => fn.id === selectedFunction) ?? functions[0]
  const sweepKey = Object.keys(spec.parameters)[0]
  const sweep = sweepKey === undefined ? undefined : spec.parameters[sweepKey]
  const currentSweepValue = sweepKey === undefined || sweep === undefined ? undefined : parameters[sweepKey] ?? sweep.value

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

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !currentFunction) return
    const context = canvas.getContext('2d')
    if (!context) return
    const style = getComputedStyle(canvas)
    const ink = style.getPropertyValue('--dsw-alias-label-primary').trim()
    const muted = style.getPropertyValue('--dsw-alias-label-tertiary').trim()
    const accent = style.getPropertyValue('--dsw-alias-state-business-primary').trim()
    const good = style.getPropertyValue('--dsw-alias-state-success-primary').trim()
    const grid = style.getPropertyValue('--dsw-alias-border-l2').trim()
    const [xMin, xMax] = spec.viewport.x
    const [yMin, yMax] = spec.viewport.y
    const xRange = (xMax - xMin) / scale
    const yRange = (yMax - yMin) / scale
    const centerX = (xMin + xMax) / 2 + pan
    const centerY = (yMin + yMax) / 2
    const xToPixel = (x: number): number => ((x - (centerX - xRange / 2)) / xRange) * canvas.width
    const yToPixel = (y: number): number => canvas.height - ((y - (centerY - yRange / 2)) / yRange) * canvas.height

    context.clearRect(0, 0, canvas.width, canvas.height)
    context.strokeStyle = grid
    context.lineWidth = 1
    for (let index = 0; index <= 8; index++) {
      const x = centerX - xRange / 2 + (index / 8) * xRange
      context.beginPath(); context.moveTo(xToPixel(x), 0); context.lineTo(xToPixel(x), canvas.height); context.stroke()
    }
    for (let index = 0; index <= 5; index++) {
      const y = centerY - yRange / 2 + (index / 5) * yRange
      context.beginPath(); context.moveTo(0, yToPixel(y)); context.lineTo(canvas.width, yToPixel(y)); context.stroke()
    }
    context.strokeStyle = muted
    context.globalAlpha = 0.6
    context.beginPath(); context.moveTo(0, yToPixel(0)); context.lineTo(canvas.width, yToPixel(0)); context.stroke()
    context.beginPath(); context.moveTo(xToPixel(0), 0); context.lineTo(xToPixel(0), canvas.height); context.stroke()
    context.globalAlpha = 1

    if (showIntegral) {
      context.fillStyle = good
      context.globalAlpha = 0.12
      context.beginPath()
      context.moveTo(xToPixel(0), yToPixel(0))
      for (let x = 0; x <= traceX; x += 0.02) context.lineTo(xToPixel(x), yToPixel(evaluateAt(currentFunction, x)))
      context.lineTo(xToPixel(traceX), yToPixel(0))
      context.closePath()
      context.fill()
      context.globalAlpha = 1
    }

    for (const [index, fn] of functions.entries()) {
      context.strokeStyle = index === 0 ? accent : good
      context.lineWidth = fn.id === currentFunction.id ? 3 : 2
      context.globalAlpha = fn.id === currentFunction.id ? 1 : 0.52
      context.beginPath()
      for (let pixel = 0; pixel <= canvas.width; pixel++) {
        const x = centerX - xRange / 2 + (pixel / canvas.width) * xRange
        const y = evaluateAt(fn, x)
        if (pixel === 0) context.moveTo(pixel, yToPixel(y))
        else context.lineTo(pixel, yToPixel(y))
      }
      context.stroke()
    }
    context.globalAlpha = 1

    if (showDerivative) {
      const slope = derivativeAt(traceX)
      context.strokeStyle = accent
      context.setLineDash([5, 5])
      context.beginPath()
      for (let pixel = 0; pixel <= canvas.width; pixel++) {
        const x = centerX - xRange / 2 + (pixel / canvas.width) * xRange
        const y = evaluateAt(currentFunction, traceX) + slope * (x - traceX)
        if (pixel === 0) context.moveTo(pixel, yToPixel(y))
        else context.lineTo(pixel, yToPixel(y))
      }
      context.stroke()
      context.setLineDash([])
    }

    context.strokeStyle = muted
    context.globalAlpha = 0.45
    context.beginPath(); context.moveTo(xToPixel(traceX), 0); context.lineTo(xToPixel(traceX), canvas.height); context.stroke()
    context.globalAlpha = 1
    context.fillStyle = good
    context.beginPath(); context.arc(xToPixel(traceX), yToPixel(evaluateAt(currentFunction, traceX)), 6, 0, Math.PI * 2); context.fill()
    context.fillStyle = ink
    context.font = '12px system-ui'
    context.fillText(`x = ${traceX.toFixed(2)}`, Math.min(canvas.width - 72, xToPixel(traceX) + 10), yToPixel(evaluateAt(currentFunction, traceX)) - 12)
  }, [spec, currentFunction, functions, parameters, traceX, scale, pan, showDerivative, showIntegral])

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

  const derivative = derivativeAt(traceX)
  const integral = integralAt(traceX)
  const currentValue = currentFunction ? evaluateAt(currentFunction, traceX) : 0
  const readout = currentFunction
    ? `x=${traceX.toFixed(2)} · f(x)=${currentValue.toFixed(3)} · f′(x)=${derivative.toFixed(3)} · ∫=${integral.toFixed(3)}`
    : t('scene.select')

  return (
    <div className={css.workspace}>
      <div className={css.stage}>
        <div className={css.metricRow} aria-label={t('scene.analysis')}>
          <div className={css.metric}><strong>{currentSweepValue === undefined ? '—' : currentSweepValue.toFixed(2)}</strong><span>{sweepKey ? t('scene.parameter', { name: sweepKey }) : t('scene.parameterless')}</span></div>
          <div className={css.metric}><strong>{traceX.toFixed(2)}</strong><span>{t('scene.trace')}</span></div>
          <div className={css.metric}><strong>{scale.toFixed(2)}×</strong><span>{t('scene.viewport')}</span></div>
        </div>
        <canvas ref={canvasRef} className={css.chart} width={640} height={260} role="img" aria-label={t('scene.canvas')}
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
          }}
          onWheel={(event) => {
            event.preventDefault()
            setScale(current => Math.max(0.25, Math.min(8, current * Math.exp(-event.deltaY * 0.001))))
          }} />
        <output className={css.result} role="status" aria-live="polite">{readout}</output>
      </div>

      <aside className={css.panel} aria-label={t('scene.controls')}>
        <h2>{t('scene.controls')}</h2>
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
          <Button size="sm" variant={showDerivative ? 'primary' : 'outline'} aria-pressed={showDerivative} onClick={() => { setShowDerivative(value => !value) }}>{t('scene.derivative')}</Button>
          <Button size="sm" variant={showIntegral ? 'primary' : 'outline'} aria-pressed={showIntegral} onClick={() => { setShowIntegral(value => !value) }}>{t('scene.integral')}</Button>
        </div>
        <div className={css.buttonRow}>
          <Button size="sm" variant="outline" aria-label={t('scene.zoomOut')} onClick={() => { setScale(current => Math.max(0.25, current / 1.25)) }}>−</Button>
          <Button size="sm" variant="outline" aria-label={t('scene.zoomIn')} onClick={() => { setScale(current => Math.min(8, current * 1.25)) }}>+</Button>
          <Button size="sm" variant="outline" onClick={reset}>{t('scene.viewReset')}</Button>
        </div>
        <div className={css.buttonRow}>
          <Button size="sm" variant={playing ? 'primary' : 'outline'} aria-pressed={playing} onClick={() => { setPlaying(value => !value) }}>{playing ? t('scene.pause') : t('scene.play')}</Button>
          <Button size="sm" variant="outline" onClick={() => {
            if (!sweepKey || !sweep) return
            setParameters((current) => {
              const next = (current[sweepKey] ?? sweep.value) + sweep.step
              return { ...current, [sweepKey]: next > sweep.max ? sweep.min : next }
            })
          }}>{t('scene.step')}</Button>
          <Button size="sm" variant="outline" onClick={reset}>{t('scene.reset')}</Button>
        </div>
        <Button size="sm" variant="outline" onClick={() => { void confirm() }}>{t('scene.confirm')}</Button>
        <p className={css.subtitle}>{t('scene.hint')}</p>
      </aside>
    </div>
  )
}
