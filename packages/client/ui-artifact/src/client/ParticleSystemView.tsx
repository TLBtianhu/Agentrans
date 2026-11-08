/** Native particle-system renderer for validated SceneSpec values. */
import { useEffect, useRef } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RuntimeReport } from '@deepseek-ai/dsh-artifact-runtime/types'
import { drawNativeScene, scenePaletteFor } from './native-runtime.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ParticleSystemSpec } from '@deepseek-ai/dsh-artifact/scene'
import { observeParticleState } from '@deepseek-ai/dsh-artifact/particle-runtime'
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import { renderParticleSystem } from './renderers/particle-system.ts'
import type { ArtifactPlacement, RecordArtifactAction } from './protocol.ts'
import type { ParticleRun, ParticleRunCommand } from './particle-run.ts'
import css from './FunctionPlotView.module.css'

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
  readonly readOnly?: boolean
  readonly t: PropsLocale<'artifact'>['t']
}

/**
 * Render a validated ParticleSystem SceneSpec with fixed-step simulation.
 * @param props - SceneSpec, Artifact identity, placement, confirmation callback, and locale seat.
 * @returns An interactive particle simulation with velocity vectors and trails.
 */
export function ParticleSystemView({
  spec, artifactId, revision, placement, recordAction, canRecord = true, recordPending = false, onRuntimeReport, onStateChange,
  run, onCommand, readOnly = false, t,
}: ParticleSystemViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const runtimeFailureMessage = t('scene.particleRuntimeFailed')
  const { state, playing, failed } = run
  const { time, particles, trails } = state

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    drawNativeScene(canvas, () => {
      renderParticleSystem(spec, canvas, 900, 420, { time, particles, trails }, scenePaletteFor(canvas))
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

  return (
    <div className={css.workspace} data-placement={placement} data-particle-step={state.stepCount} data-particle-time={time}>
      <div className={css.stage}>
        <div className={css.legend}>
          <span className={css.legendItem} data-current="true"><i className={css.swatchAccent} aria-hidden="true" />{t('scene.particleSystem')}</span>
        </div>
        <div className={css.plot}>
          <canvas ref={canvasRef} className={css.chart} role="img" aria-label={t('scene.particleSystem')} />
        </div>
        <div className={css.readout} role="status" aria-live="polite">
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.time')}</span><span className={css.readoutValue}>{time.toFixed(2)}</span></div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.particles')}</span><span className={css.readoutValue}>{particles.length}</span></div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.gravity')}</span><span className={css.readoutValue}>{spec.gravity.x.toFixed(2)}, {spec.gravity.y.toFixed(2)}</span></div>
          <div className={css.readoutItem}><span className={css.readoutLabel}>{t('scene.timeStep')}</span><span className={css.readoutValue}>{spec.timeStep.toFixed(3)}</span></div>
        </div>
      </div>
      {!readOnly && (
        <aside className={css.panel} aria-label={t('scene.controls')}>
          <div className={css.buttonRow}>
            <Button size="sm" variant="ghost" className={css.toggle} data-selected={playing ? '' : undefined}
              aria-pressed={playing} disabled={failed}
              onClick={() => { onCommand(playing ? 'pause' : 'play') }}>{playing ? t('scene.pause') : t('scene.play')}</Button>
            <Button size="sm" variant="ghost" className={css.toggle} disabled={failed} onClick={() => { onCommand('step') }}>{t('scene.step')}</Button>
            <Button size="sm" variant="ghost" className={css.toggle} onClick={() => { onCommand('reset') }}>{t('scene.reset')}</Button>
          </div>
          {failed && <p role="alert">{t('scene.particleFailed')}</p>}
          {canRecord && <Button size="sm" variant="outline" disabled={recordPending} onClick={() => { void confirm() }}>{t('scene.confirm')}</Button>}
          <p className={css.hint}>{t('scene.particleHint')}</p>
        </aside>
      )}
    </div>
  )
}
