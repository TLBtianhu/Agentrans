/** Native particle-system renderer for validated SceneSpec values. */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { PropsLocale } from '@agentrans/client-ui-slots'
import { Button, Input } from '@agentrans/client-ui-primitives'
import type { RuntimeReport } from '@agentrans/artifact-runtime/types'
import { drawNativeScene, scenePaletteFor } from './native-runtime.ts'
import type { JsonValue } from '@agentrans/util-values'
import type { ParticleSystemSpec } from '@agentrans/artifact/scene'
import { observeParticleState, restoreParticleCheckpoint } from '@agentrans/artifact/particle-runtime'
import type { ArtifactId, ArtifactParticleContinuation } from '@agentrans/artifact/types'
import { renderParticleSystem } from './renderers/particle-system.ts'
import type { ArtifactPlacement, RecordArtifactAction } from './protocol.ts'
import type { ParticleRun, ParticleRunCommand } from './particle-run.ts'
import { formatReadingDifference } from './format-reading-difference.ts'
import css from './FunctionPlotView.module.css'

const COORDINATES = ['x', 'y', 'vx', 'vy'] as const
const CANVAS_WIDTH = 900
const CANVAS_HEIGHT = 420

interface ParticleSystemViewProps {
  readonly spec: ParticleSystemSpec
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly placement: ArtifactPlacement
  readonly recordAction: RecordArtifactAction
  readonly canRecord?: boolean
  readonly recordPending?: boolean
  readonly onRuntimeReport?: ((report: RuntimeReport) => void) | undefined
  readonly onStateChange?: ((state: JsonValue) => void) | undefined
  readonly run: ParticleRun
  readonly onCommand: (command: ParticleRunCommand) => void
  readonly baselineParticle?: ArtifactParticleContinuation | undefined
  readonly particleGravityY?: number | undefined
  readonly readOnly?: boolean
  readonly t: PropsLocale<'artifact'>['t']
}

/**
 * Render a validated ParticleSystem SceneSpec with fixed-step simulation.
 * @param props - SceneSpec, Artifact identity, placement, confirmation callback, and locale seat.
 * @returns A particle simulation with live position and velocity readings.
 */
export function ParticleSystemView({
  spec, artifactId, revision, placement, recordAction, canRecord = true, recordPending = false, onRuntimeReport, onStateChange,
  run, onCommand, baselineParticle, particleGravityY, readOnly = false, t,
}: ParticleSystemViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gravityInputId = useId()
  const [gravityDraft, setGravityDraft] = useState<string | null>(null)
  const runtimeFailureMessage = t('scene.particleRuntimeFailed')
  const { state, playing, failed } = run
  const { time, particles, trails } = state
  const comparison = readOnly ? undefined : baselineParticle
  const baselineCheckpoint = comparison?.baseline.checkpoint
  const referenceParticle = useMemo(() => baselineCheckpoint === undefined ? undefined
    : restoreParticleCheckpoint(spec, baselineCheckpoint).particles[0], [spec, baselineCheckpoint])
  const comparisonReading = comparison === undefined || referenceParticle === undefined ? null : {
    label: t('scene.particleBaselineComparison', { particle: referenceParticle.id, step: String(comparison.baseline.checkpoint.stepCount) }),
    sourceRevision: comparison.source.revision,
    baseline: referenceParticle.y,
    current: failed ? null : particles.find(particle => particle.id === referenceParticle.id)?.y ?? null,
  }
  const gravityY = particleGravityY ?? spec.gravity.y

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    drawNativeScene(canvas, () => {
      renderParticleSystem(spec, canvas, CANVAS_WIDTH, CANVAS_HEIGHT, { time, particles, trails }, scenePaletteFor(canvas))
    }, onRuntimeReport === undefined ? undefined : (report) => {
      const failure = run.failure ?? { code: 'PARTICLE_RUNTIME_FAILED', message: runtimeFailureMessage }
      onRuntimeReport(failed && report.status === 'ready' ? { status: 'error', error: failure } : report)
    })
  }, [spec, time, particles, trails, failed, run.failure, runtimeFailureMessage, onRuntimeReport])

  useEffect(() => {
    onStateChange?.(observeParticleState(state))
  }, [onStateChange, state])

  const confirm = async (): Promise<void> => {
    if (!canRecord || recordPending) return
    await recordAction(artifactId, revision, 'physics.inspected', observeParticleState(state), true)
  }

  const readings = (
    <ul className={css.particleReadings} aria-label={t('scene.particles')}
      aria-live={playing ? 'off' : 'polite'} data-particle-live-readings>
      {particles.map(particle => (
        <li key={particle.id} data-particle-live-id={particle.id}>
          <strong>{particle.id}</strong>
          <dl className={css.sourceParameters}>
            {COORDINATES.map(coordinate => (
              <div key={coordinate}>
                <dt>{coordinate}</dt>
                <dd data-particle-live-coordinate={coordinate}>{String(particle[coordinate])}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  )

  return (
    <div className={css.workspace} data-placement={placement} data-read-only={readOnly ? '' : undefined}
      data-particle-step={state.stepCount} data-particle-time={time}>
      <div className={css.stage}>
        <div className={css.legend}>
          <span className={css.legendItem} data-current="true"><i className={css.swatchAccent} aria-hidden="true" />{t('scene.particleSystem')}</span>
        </div>
        <div className={css.plot}>
          <canvas ref={canvasRef} className={`${css.chart} ${css.particleChart}`} width={CANVAS_WIDTH} height={CANVAS_HEIGHT}
            role="img" aria-label={t('scene.particleSystem')} />
        </div>
        <div className={css.readout} role="status" aria-live="polite">
          <div className={css.readoutItem}>
            <span className={css.readoutLabel}>{t('scene.time')}</span>
            <span className={css.readoutValue} data-particle-source-time={readOnly ? '' : undefined}>{readOnly ? String(time) : time.toFixed(2)}</span>
          </div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.particles')}</span><span className={css.readoutValue}>{particles.length}</span></div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.gravity')}</span><span className={css.readoutValue}>{spec.gravity.x.toFixed(2)}, {gravityY.toFixed(2)}</span></div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.timeStep')}</span><span className={css.readoutValue}>{spec.timeStep.toFixed(3)}</span></div>
        </div>
        {particles.length > 4 ? <details className={css.particleReadingsDetails}>
          <summary>{t('scene.particles')}</summary>
          {readings}
        </details> : readings}
        {comparisonReading !== null && (
          <section className={css.baselineComparison} aria-label={comparisonReading.label} data-particle-baseline-comparison>
            <strong>{comparisonReading.label}</strong>
            <dl aria-live="polite">
              <div>
                <dt>{t('scene.baselineValue', { revision: String(comparisonReading.sourceRevision) })}</dt>
                <dd data-particle-height="baseline">{comparisonReading.baseline.toFixed(3)}</dd>
              </div>
              <div>
                <dt>{t('scene.baselineCurrent')}</dt>
                <dd data-particle-height="current">{comparisonReading.current?.toFixed(3) ?? '—'}</dd>
              </div>
              <div>
                <dt>{t('scene.baselineDelta')}</dt>
                <dd data-particle-height="delta">{formatReadingDifference(comparisonReading.current, comparisonReading.baseline)}</dd>
              </div>
            </dl>
          </section>
        )}
      </div>
      {!readOnly && (
        <aside className={css.panel} aria-label={t('scene.controls')}>
          {comparison !== undefined && (
            <div className={css.field}>
              <label htmlFor={gravityInputId}>{t('scene.particleVerticalGravity')}</label>
              <Input id={gravityInputId} type="number" step="any" data-particle-gravity-y value={gravityDraft ?? gravityY}
                onBlur={() => { setGravityDraft(null) }} onChange={(event) => {
                  setGravityDraft(event.currentTarget.value)
                  const value = event.currentTarget.valueAsNumber
                  if (Number.isFinite(value)) onCommand({ kind: 'set-gravity-y', value })
                }} />
            </div>
          )}
          <div className={css.buttonRow}>
            {comparison === undefined && <>
              <Button size="sm" variant="ghost" className={css.toggle} data-selected={playing ? '' : undefined}
                aria-pressed={playing} disabled={failed}
                onClick={() => { onCommand(playing ? 'pause' : 'play') }}>{playing ? t('scene.pause') : t('scene.play')}</Button>
              <Button size="sm" variant="ghost" className={css.toggle} disabled={failed} onClick={() => { onCommand('step') }}>{t('scene.step')}</Button>
            </>}
            <Button size="sm" variant="ghost" className={css.toggle} onClick={() => {
              setGravityDraft(null)
              onCommand('reset')
            }}>{t('scene.reset')}</Button>
          </div>
          {failed && <p role="alert">{t('scene.particleFailed')}</p>}
          {comparison === undefined && <>
            {canRecord && <Button size="sm" variant="outline" disabled={recordPending} onClick={() => { void confirm() }}>{t('scene.confirm')}</Button>}
            <p className={css.hint}>{t('scene.particleHint')}</p>
          </>}
        </aside>
      )}
    </div>
  )
}
