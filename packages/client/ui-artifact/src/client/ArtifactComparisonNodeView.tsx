/** Current analysis and fixed saved-observation comparison, with explicit model admission. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@agentrans/client-ui-slots'
import { Button } from '@agentrans/client-ui-primitives'
import type { JsonValue } from '@agentrans/util-values'
import type { ArtifactSnapshot, SavedParticleObservation, SavedParticleObservationRef } from '@agentrans/artifact/types'
import {
  buildParticleObservationComparison, ParticleObservationComparisonError,
} from '@agentrans/artifact/observation-comparison'
import { useArtifactActionSubmission } from './action-submission.ts'
import { ActionSubmissionFeedback } from './ActionSubmissionFeedback.tsx'
import { ArtifactCard, type SceneOrigin } from './ArtifactNodeView.tsx'
import { observationsFor } from './ObservationControls.tsx'
import type { ArtifactRuntimeSnapshot } from './runtime-owner.ts'
import { ArtifactComparisonRequestError, type ArtifactCommand, type ArtifactNodeInjected } from './protocol.ts'
import { particleRuntimeKey } from './particle-runtime-owner.ts'
import type { ParticleRunCommand } from './particle-run.ts'
import type { ArtifactId } from '@agentrans/artifact/types'
import { artifactHostRouteAvailable } from './artifact-route.ts'
import css from './ArtifactNodeView.module.css'

type ComparisonProps = PropsRuntime<'conversation.chat.node', 'artifact-comparison'>
  & PropsLocale<'artifact'> & InjectFace<ArtifactNodeInjected>
type Role = 'control' | 'variant'
type Phase = 'idle' | 'sending' | 'sent' | 'failed'
interface SavedPairRequest {
  readonly kind: 'saved'
  readonly group: string
  readonly control: SavedParticleObservationRef
  readonly variant: SavedParticleObservationRef
}
type PairRequest = SavedPairRequest
const EMPTY_OBSERVATIONS: readonly SavedParticleObservation[] = []

function currentReport(
  report: ArtifactRuntimeSnapshot | undefined, source: ArtifactSnapshot | undefined,
): report is ArtifactRuntimeSnapshot & { readonly state: JsonValue } {
  return report !== undefined && source !== undefined && report.identity.artifactId === source.artifactId
    && report.identity.revision === source.revision && report.host === 'accepted' && report.report.status === 'ready'
    && report.report.capabilities.state && report.state !== undefined
}

/** Render each Session/group with independent selection and submission state. */
export function ArtifactComparisonNodeView(props: ComparisonProps) {
  return <ComparisonInstance key={`${props.sessionId}:${props.node.data.group}`} {...props} />
}

function ComparisonInstance({
  node, sessionId, useSession, useSessions, useProjection, useAccess, recordAction,
  saveObservation, sendObservation, confirmObservationComparison, exports, t,
  useParticleRuntime, useArtifactRuntime, runtimeActions, commandParticleRuntime,
  chooseRuntimePromptContext, chooseParticlePromptContext, chooseObservationPromptContext, chooseComparisonPromptContext,
}: ComparisonProps) {
  const comparison = node.data
  const hostRouteAvailable = useSession(artifactHostRouteAvailable)
  const control = comparison.control
  const variant = comparison.variant
  const controlKey = particleRuntimeKey(node.key, control?.artifactId ?? 'unavailable-control' as ArtifactId)
  const variantKey = particleRuntimeKey(node.key, variant?.artifactId ?? 'unavailable-variant' as ArtifactId)
  const controlRuntime = useParticleRuntime(controlKey)
  const variantRuntime = useParticleRuntime(variantKey)
  const controlReport = useArtifactRuntime(controlKey)
  const variantReport = useArtifactRuntime(variantKey)
  const commandControl = useCallback((command: ParticleRunCommand): void => {
    commandParticleRuntime(controlKey, command)
  }, [controlKey, commandParticleRuntime])
  const commandVariant = useCallback((command: ParticleRunCommand): void => {
    commandParticleRuntime(variantKey, command)
  }, [variantKey, commandParticleRuntime])
  const origin = useSessions((state): SceneOrigin => {
    const current = state.byId[sessionId]
    if (current?.parentId === undefined) return { kind: 'current' }
    const parent = state.byId[current.parentId]
    return { kind: 'branch', title: parent?.displayTitle ?? current.parentId }
  })
  const observations = useProjection('artifactObservations')
  const projectedExports = useProjection('artifactExports')
  const canExport = useAccess('artifactExports/create')
  const canReadExport = useAccess('artifactExports/read')
  const [selected, setSelected] = useState<Partial<Record<Role, SavedParticleObservationRef>>>({})
  const [requestedMode, setRequestedMode] = useState<'current' | 'saved' | null>(null)
  const requiresSaved = [control, variant].some(source => source?.format === 'scene' && source.spec.kind === 'particle-system')
  const savedMode = requiresSaved || requestedMode === 'saved'
  const savedAvailable = [control, variant].some(source => source !== undefined
    && (observationsFor(observations, source.artifactId)?.length ?? 0) > 0)
  const selectedObservation = (role: Role): SavedParticleObservation | null => {
    const reference = selected[role]
    return reference === undefined ? null
      : observationsFor(observations, reference.artifactId)?.find(item => item.observationId === reference.observationId) ?? null
  }
  const selectedControl = selectedObservation('control')
  const selectedVariant = selectedObservation('variant')
  const prepared = useMemo(() => {
    if (selectedControl === null || selectedVariant === null) return { kind: 'missing' } as const
    try {
      return { kind: 'ready', value: buildParticleObservationComparison(comparison.group, selectedControl, selectedVariant) } as const
    } catch (error) {
      if (!(error instanceof ParticleObservationComparisonError)) throw error
      return { kind: 'invalid', reason: error.code } as const
    }
  }, [comparison.group, selectedControl, selectedVariant])

  const currentSubmission = useArtifactActionSubmission(recordAction)
  const [phase, setPhase] = useState<Phase>('idle')
  const [pending, setPending] = useState<PairRequest | null>(null)
  const [rejectedReason, setRejectedReason] = useState<ArtifactComparisonRequestError['reason'] | null>(null)
  const [commandFailure, setCommandFailure] = useState(false)
  const sending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const legacyReady = currentReport(controlReport, control) && currentReport(variantReport, variant)
  const sharedCommands = !savedMode && control?.format === 'html' && variant?.format === 'html'
    && controlReport?.host === 'accepted' && variantReport?.host === 'accepted'
    && controlReport.report.status === 'ready' && variantReport.report.status === 'ready'
    ? controlReport.report.capabilities.commands.filter(command => variantReport.report.status === 'ready' && variantReport.report.capabilities.commands.includes(command)) : []
  const commandPending = controlReport?.command === 'pending' || variantReport?.command === 'pending'
  const commandFailed = controlReport?.command === 'failed' || variantReport?.command === 'failed'
  const locked = phase === 'sending' || pending !== null || currentSubmission.pending
  const select = (role: Role, source: ArtifactSnapshot, observationId: SavedParticleObservationRef['observationId'] | null): void => {
    if (locked) return
    const previous = selected[role]
    if (previous?.artifactId === source.artifactId && previous.observationId === observationId) return
    setSelected(previous => ({
      ...previous, [role]: observationId === null ? undefined : { artifactId: source.artifactId, observationId },
    }))
    setPhase('idle')
    setRejectedReason(null)
    setRequestedMode('saved')
  }
  const command = async (name: ArtifactCommand): Promise<void> => {
    if (commandPending || !sharedCommands.includes(name)) return
    setCommandFailure(false)
    try { await Promise.all([runtimeActions.command(controlKey, name), runtimeActions.command(variantKey, name)]) }
    catch (error) {
      // One side may reject before dispatch while the other has already run; never retry either side automatically.
      if (mounted.current) setCommandFailure(true)
      void error
    }
  }
  const compare = async (): Promise<void> => {
    if (!hostRouteAvailable || sending.current || currentSubmission.pending) return
    if (savedMode) {
      if (rejectedReason !== null || phase === 'sent') return
      const request = pending ?? (prepared.kind === 'ready' ? {
        kind: 'saved' as const, group: comparison.group, control: prepared.value.control.ref, variant: prepared.value.variant.ref,
      } : null)
      if (request === null) return
      currentSubmission.dismiss()
      sending.current = true
      setPending(request)
      setPhase('sending')
      setRejectedReason(null)
      try {
        await confirmObservationComparison(request.group, request.control, request.variant, true)
        if (mounted.current) { setPending(null); setPhase('sent') }
      } catch (error) {
        if (mounted.current) {
          if (error instanceof ArtifactComparisonRequestError) { setPending(null); setRejectedReason(error.reason) }
          setPhase('failed')
        }
      } finally { sending.current = false }
      return
    }
    if (!currentReport(controlReport, control) || !currentReport(variantReport, variant)
      || control === undefined || variant === undefined) return
    setPhase('idle')
    await currentSubmission.begin(control.artifactId, control.revision, 'comparison.completed', {
      group: comparison.group,
      control: { artifactId: control.artifactId, revision: control.revision, state: controlReport.state },
      variant: { artifactId: variant.artifactId, revision: variant.revision, state: variantReport.state },
    }, true)
  }
  const ready = savedMode ? observations !== undefined && prepared.kind === 'ready' : legacyReady
  const failureKey = rejectedReason === null ? 'comparison.unknownSaved'
    : rejectedReason === 'ACTION_TOO_LARGE' ? 'comparison.rejectedTooLarge'
      : rejectedReason === 'OBSERVATION_NOT_FOUND' ? 'comparison.rejectedUnavailable' : 'comparison.rejectedSaved'
  const submissionDisabled = phase === 'sending' || currentSubmission.pending
    || (savedMode && (phase === 'sent' || rejectedReason !== null))

  return (
    <section className={css.comparison} data-comparison-group={comparison.group}
      role="group" aria-label={t('comparison.title', { group: comparison.group })}>
      <header className={css.comparisonHeader}>
        <div className={css.heading}>
          <h3 className={css.title}>{t('comparison.title', { group: comparison.group })}</h3>
          <span className={css.origin}>{origin.kind === 'current' ? t('origin.current') : t('origin.branch', { parent: origin.title })}</span>
        </div>
        <div className={css.controls}>
          {sharedCommands.map(name => <Button key={name} size="sm" variant="outline" disabled={commandPending}
            onClick={() => { void command(name) }}>{t(`comparison.${name}`)}</Button>)}
          {commandPending && <span role="status">{t('runtime.commandPending')}</span>}
          {(commandFailed || commandFailure) && <span role="alert">{t('runtime.commandFailed')}</span>}
          {!requiresSaved && savedAvailable && <>
            <Button size="sm" variant="ghost" disabled={locked} aria-pressed={!savedMode}
              onClick={() => { setRequestedMode('current'); setSelected({}); setPhase('idle') }}>{t('comparison.currentMode')}</Button>
            <Button size="sm" variant="ghost" disabled={locked} aria-pressed={savedMode}
              onClick={() => { setRequestedMode('saved'); setPhase('idle') }}>{t('comparison.savedMode')}</Button>
          </>}
          {hostRouteAvailable && <Button size="sm" variant="primary" disabled={(!ready && pending === null) || submissionDisabled}
            aria-busy={phase === 'sending' || currentSubmission.state.phase === 'sending'} onClick={() => { void compare() }}>
            {phase === 'sending' || currentSubmission.state.phase === 'sending' ? t('comparison.sending') : pending?.kind === 'saved' ? t('comparison.retrySaved')
              : savedMode ? t('comparison.sendSaved') : t('comparison.send')}
          </Button>}
          {savedMode && hostRouteAvailable && <Button size="sm" variant="ghost" disabled={prepared.kind !== 'ready' || locked}
            onClick={() => {
              if (selectedControl !== null && selectedVariant !== null) {
                chooseComparisonPromptContext(comparison.group, selectedControl, selectedVariant)
              }
            }}>
            {t('promptContext.attachComparison')}
          </Button>}
          {pending?.kind === 'saved' && phase === 'failed' && <Button size="sm" variant="ghost"
            onClick={() => { setPending(null); setPhase('idle') }}>{t('comparison.cancelRetry')}</Button>}

        </div>
      </header>
      <div className={css.comparisonGrid}>
        {(['control', 'variant'] as const).map((role) => {
          const source = role === 'control' ? control : variant
          const selection = role === 'control' ? selectedControl : selectedVariant
          return <div key={role} data-comparison-role={role}>
            {source === undefined ? <div className={css.placeholder}>{t('comparison.waiting')}</div> : (
              <ArtifactCard key={`${sessionId}:${source.artifactId}`} snapshot={source} origin={origin} recordAction={recordAction} t={t}
                placement="inline" placementControls={false}
                particleRuntime={{ current: role === 'control' ? controlRuntime : variantRuntime, command: role === 'control' ? commandControl : commandVariant }}
                promptContext={hostRouteAvailable ? { chooseRuntime: (identity) => { chooseRuntimePromptContext(role === 'control' ? controlKey : variantKey, source, identity) },
                  chooseCurrent: () => { chooseParticlePromptContext(role === 'control' ? controlKey : variantKey, source) }, chooseObservation: chooseObservationPromptContext } : undefined}
                hostOperationsAvailable={hostRouteAvailable}
                exportControls={exports === undefined ? undefined : {
                  ...exports, ready: projectedExports !== undefined, canCreate: canExport, canRead: canReadExport,
                  records: Object.values(projectedExports ?? {})
                    .filter(record => record.frozen.artifact.artifactId === source.artifactId),
                }}
                runtimeControls={{ key: role === 'control' ? controlKey : variantKey, actions: runtimeActions, snapshot: role === 'control' ? controlReport : variantReport }}
                observationControls={savedMode ? {
                  ready: observations !== undefined, observations: observationsFor(observations, source.artifactId) ?? EMPTY_OBSERVATIONS,
                  save: saveObservation, send: sendObservation,
                } : undefined}
                observationSelection={savedMode ? { observation: selection, disabled: locked,
                  onSelect: (observationId) => { select(role, source, observationId) } } : undefined} />
            )}
          </div>
        })}
      </div>
      {savedMode && observations === undefined && <p role="status" className={css.comparisonStatus}>{t('observation.loading')}</p>}
      {savedMode && observations !== undefined && prepared.kind === 'missing'
        && <p className={css.comparisonStatus}>{t('comparison.selectBoth')}</p>}
      {savedMode && prepared.kind === 'invalid' && <p role="status" className={css.comparisonStatus}>{
        t(['RUNTIME_MISMATCH', 'TIME_STEP_MISMATCH', 'STEP_COUNT_MISMATCH'].includes(prepared.reason)
          ? 'comparison.incompatibleTiming' : 'comparison.invalidSelection')
      }</p>}
      {savedMode && prepared.kind === 'ready' && <p className={css.comparisonStatus}>{t('comparison.fixedPair', {
        control: prepared.value.control.label, variant: prepared.value.variant.label,
        step: String(prepared.value.conditions.stepCount),
      })}</p>}
      {!savedMode && !legacyReady && <p className={css.comparisonStatus}>{t('comparison.waiting')}</p>}
      <ActionSubmissionFeedback state={currentSubmission.state} available={hostRouteAvailable}
        retry={() => { void currentSubmission.retry() }} dismiss={currentSubmission.dismiss} sentText={t('comparison.sent')} t={t} />
      {phase === 'failed' && savedMode && <p role="alert" className={css.error}>{t(failureKey)}</p>}
      {phase === 'sent' && <p role="status" className={css.comparisonStatus}>{t(savedMode ? 'comparison.sentSaved' : 'comparison.sent')}</p>}
    </section>
  )
}
