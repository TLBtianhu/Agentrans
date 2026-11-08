/** Named particle observations supplied by the Session projection. */
import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ArtifactId, ArtifactObservationId, ArtifactObservations, SavedParticleObservation } from '@deepseek-ai/dsh-artifact/types'
import type { ParticleCheckpoint } from '@deepseek-ai/dsh-artifact/particle-runtime'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  ArtifactObservationSaveError, type ObservationSaveFailure, type SaveArtifactObservation, type SendArtifactObservation,
} from './protocol.ts'
import css from './ArtifactNodeView.module.css'

/**
 * Resolve a projected observation list using only stored Artifact identities.
 * @param observations - Opened Session observation projection, when ready.
 * @param artifactId - Opaque identity, including valid names shared with Object properties.
 * @returns The stored list, or undefined when that identity has no saved list.
 */
export function observationsFor(
  observations: ArtifactObservations | undefined, artifactId: ArtifactId,
): readonly SavedParticleObservation[] | undefined {
  return observations !== undefined && Object.hasOwn(observations, artifactId) ? observations[artifactId] : undefined
}

/** Plain observation data and commands provided by the Session-owning renderer. */
export interface ObservationControlsData {
  readonly ready: boolean
  readonly observations: readonly SavedParticleObservation[]
  readonly save: SaveArtifactObservation
  readonly send: SendArtifactObservation
}

/** Comparison-owned selection; standalone cards keep their local restore selection. */
export interface ObservationSelection {
  readonly observation: SavedParticleObservation | null
  readonly disabled: boolean
  readonly onSelect: (observationId: ArtifactObservationId | null) => void
}

interface ObservationControlsProps extends ObservationControlsData {
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly checkpoint: ParticleCheckpoint | null
  readonly canSave: boolean
  readonly canSubmit?: boolean
  readonly onRestore: (observation: SavedParticleObservation) => void
  readonly t: PropsLocale<'artifact'>['t']
  readonly actions: ObservationActions
  readonly selection?: ObservationSelection | undefined
}

interface SaveRequest {
  readonly artifactId: ArtifactId
  readonly observationId: ArtifactObservationId
  readonly label: string
  readonly revision: number
  readonly checkpoint: ParticleCheckpoint
}

interface ObservationUiState {
  readonly label: string
  readonly pending: SaveRequest | null
  readonly savePhase: 'idle' | 'saving' | 'saved' | 'failed'
  readonly saveFailure: ObservationSaveFailure | null
  readonly sendingId: ArtifactObservationId | null
  readonly sentIds: readonly ArtifactObservationId[]
  readonly sendFailed: boolean
}

/** Card-owned local submission state and commands; no Session facts are copied here. */
export interface ObservationActions {
  readonly state: ObservationUiState
  readonly setLabel: (label: string) => void
  readonly cancelRetry: () => void
  readonly saveCurrent: (source: {
    artifactId: ArtifactId
    revision: number
    checkpoint: ParticleCheckpoint
    defaultLabel: string
  }) => Promise<void>
  readonly sendSaved: (artifactId: ArtifactId, observation: SavedParticleObservation) => Promise<void>
}

/**
 * Retain submission identities across preview remounts and source revisions.
 * @param commands - Optional Session commands; absent cards cannot submit observations.
 * @returns Local UI state and operations for the lifetime of one Artifact card.
 */
export function useObservationActions(commands: ObservationControlsData | undefined): ObservationActions {
  const [state, setState] = useState<ObservationUiState>({
    label: '', pending: null, savePhase: 'idle', saveFailure: null, sendingId: null, sentIds: [], sendFailed: false,
  })
  const savingRef = useRef(false)
  const sendingRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const saveCurrent: ObservationActions['saveCurrent'] = async (source) => {
    if (commands === undefined || !commands.ready || savingRef.current) return
    const request = state.pending ?? {
      artifactId: source.artifactId,
      observationId: randomUUID() as ArtifactObservationId,
      label: state.label.trim() || source.defaultLabel,
      revision: source.revision,
      checkpoint: source.checkpoint,
    }
    savingRef.current = true
    setState(previous => ({ ...previous, pending: request, savePhase: 'saving', saveFailure: null }))
    try {
      await commands.save(request.artifactId, request.revision, request.observationId, request.label, request.checkpoint)
      if (mounted.current) {
        setState(previous => ({ ...previous, pending: null, label: '', savePhase: 'saved', saveFailure: null }))
      }
    } catch (error) {
      const failure: ObservationSaveFailure = error instanceof ArtifactObservationSaveError ? error.failure : { kind: 'unknown' }
      if (mounted.current) setState(previous => ({
        ...previous, pending: failure.kind === 'unknown' ? request : null, savePhase: 'failed', saveFailure: failure,
      }))
    } finally {
      savingRef.current = false
    }
  }

  const sendSaved: ObservationActions['sendSaved'] = async (artifactId, observation) => {
    if (commands === undefined || sendingRef.current || state.sentIds.includes(observation.observationId)) return
    sendingRef.current = true
    setState(previous => ({ ...previous, sendingId: observation.observationId, sendFailed: false }))
    try {
      await commands.send(artifactId, observation.observationId, true)
      if (mounted.current) setState(previous => ({ ...previous, sentIds: [...previous.sentIds, observation.observationId] }))
    } catch {
      if (mounted.current) setState(previous => ({ ...previous, sendFailed: true }))
    } finally {
      sendingRef.current = false
      if (mounted.current) setState(previous => ({ ...previous, sendingId: null }))
    }
  }

  return {
    state, saveCurrent, sendSaved,
    setLabel: (label) => { setState(previous => ({ ...previous, label, savePhase: 'idle', saveFailure: null })) },
    cancelRetry: () => { setState(previous => ({ ...previous, pending: null, savePhase: 'idle', saveFailure: null })) },
  }
}

/**
 * Display projected observations with separate save, restore, and send controls.
 * @param props - Session facts, the current checkpoint, and card-owned submission actions.
 * @returns Named observations and explicit user commands.
 */
export function ObservationControls({
  observations, ready, artifactId, revision, checkpoint, canSave, canSubmit: hostOperationsAvailable = true,
  onRestore, t, actions, selection,
}: ObservationControlsProps) {
  const { label, pending, savePhase, saveFailure, sendingId, sentIds, sendFailed } = actions.state
  const defaultLabel = t('observation.defaultName', { number: String(observations.length + 1) })
  const saveBlocked = saveFailure?.kind === 'limit' || (saveFailure?.kind === 'stale' && revision < saveFailure.currentRevision)
  const canSubmit = ready && !saveBlocked && (pending !== null || (canSave && checkpoint !== null))

  return (
    <section className={css.observations} aria-label={t('observation.list')}>
      {(hostOperationsAvailable && checkpoint !== null || pending !== null) && <div className={css.observationToolbar}>
        {hostOperationsAvailable && <>
          <Input aria-label={t('observation.name')} value={label} placeholder={defaultLabel} maxLength={80}
            disabled={!ready || !canSave || saveBlocked || pending !== null}
            onChange={(event) => { actions.setLabel(event.target.value) }} />
          <Button size="sm" variant="outline" disabled={!canSubmit || savePhase === 'saving'}
            aria-busy={savePhase === 'saving'} onClick={() => {
              const source = pending ?? (checkpoint === null ? null : { artifactId, revision, checkpoint })
              if (source !== null) void actions.saveCurrent({ ...source, defaultLabel })
            }}>
            {savePhase === 'saving' ? t('observation.saving') : pending === null ? t('observation.save') : t('observation.retrySave')}
          </Button>
        </>}
        {pending !== null && savePhase === 'failed' && (
          <Button size="sm" variant="ghost" onClick={actions.cancelRetry}>
            {t('observation.cancelRetry')}
          </Button>
        )}
      </div>}
      {!ready && hostOperationsAvailable ? <p role="status" className={css.observationHint}>{t('observation.loading')}</p>
        : hostOperationsAvailable && checkpoint !== null && !canSave && <p className={css.observationHint}>{t('observation.latestOnly')}</p>}
      {savePhase === 'saved' && <p role="status" className={css.observationHint}>{t('observation.saved')}</p>}
      {savePhase === 'failed' && pending !== null && (
        <p role="alert" className={css.error}>{t('observation.saveFailed', { label: pending.label })}</p>
      )}
      {savePhase === 'failed' && saveFailure?.kind === 'limit' && (
        <p role="alert" className={css.error}>{t('observation.limitReached', { limit: String(saveFailure.limit) })}</p>
      )}
      {savePhase === 'failed' && saveFailure?.kind === 'stale' && (
        <p role="alert" className={css.error}>{t('observation.staleRevision', { revision: String(saveFailure.currentRevision) })}</p>
      )}
      {ready && observations.length === 0 && savePhase !== 'saved' && <p className={css.observationHint}>{t('observation.empty')}</p>}
      {ready && observations.length > 0 && (
        <ul className={css.observationList}>
          {observations.map(observation => (
            <li key={observation.observationId} data-observation-id={observation.observationId}>
              <div className={css.observationDescription}>
                <strong>{observation.label}</strong>
                <span>{t('observation.details', {
                  revision: String(observation.artifact.revision), step: String(observation.checkpoint.stepCount),
                })}</span>
              </div>
              <div className={css.controls}>
                <Button size="sm" variant="ghost" disabled={savePhase === 'saving' || selection?.disabled === true}
                  aria-pressed={selection === undefined ? undefined : selection.observation?.observationId === observation.observationId}
                  onClick={() => { onRestore(observation) }}>
                  {selection === undefined ? t('observation.restore') : t('comparison.selectObservation')}
                </Button>
                {hostOperationsAvailable && selection === undefined && (
                  <Button size="sm" variant="outline" disabled={sendingId !== null || sentIds.includes(observation.observationId)}
                    aria-busy={sendingId === observation.observationId} onClick={() => { void actions.sendSaved(artifactId, observation) }}>
                    {sentIds.includes(observation.observationId) ? t('observation.sent') : t('send.action')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {sendFailed && <p role="alert" className={css.error}>{t('observation.sendFailed')}</p>}
    </section>
  )
}
