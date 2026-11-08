/** Explicit return of one branch conclusion with immutable saved particle evidence. */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ArtifactBranchEvidenceSelection, ArtifactBranchResultRequest } from '@deepseek-ai/dsh-artifact-branch/types'
import type { SavedParticleObservation, SavedParticleObservationRef } from '@deepseek-ai/dsh-artifact/types'
import {
  buildParticleObservationComparison, ParticleObservationComparisonError,
} from '@deepseek-ai/dsh-artifact/observation-comparison'
import { observeParticleState, restoreParticleCheckpoint, ParticleRuntimeError } from '@deepseek-ai/dsh-artifact/particle-runtime'
import {
  ArtifactBranchReturnError, type ArtifactBranchReturnFailure, type ReturnArtifactBranchResult,
} from './protocol.ts'
import css from './ArtifactBranchResultAction.module.css'

/** Narrow operations for the optional Artifact-owned branch adoption entry. */
export interface ArtifactBranchResultInjected {
  readonly returnResult: ReturnArtifactBranchResult
  readonly openSession: (sessionId: SessionId) => void
}

type ActionProps = PropsRuntime<'conversation.chat.assistant.details'> & InjectFace<ArtifactBranchResultInjected> & PropsLocale<'artifact'>
interface EvidencePreview {
  readonly saved: SavedParticleObservation
  readonly values: SavedParticleObservation['values']
}
interface CapturedReturn {
  readonly request: ArtifactBranchResultRequest
  readonly preview: readonly EvidencePreview[]
  readonly text: string
}
type Submission =
  | { readonly kind: 'editing' }
  | { readonly kind: 'submitting'; readonly captured: CapturedReturn }
  | { readonly kind: 'retry'; readonly captured: CapturedReturn; readonly busy: boolean }
  | { readonly kind: 'rejected'; readonly failure: ArtifactBranchReturnFailure }

function reference(saved: SavedParticleObservation): SavedParticleObservationRef {
  return { artifactId: saved.artifact.artifactId, observationId: saved.observationId }
}

function referenceKey(value: SavedParticleObservationRef | null): string {
  return value === null ? '' : JSON.stringify([value.artifactId, value.observationId])
}

/** Render one independent adoption draft per durable branch conclusion. */
export function ArtifactBranchResultAction(props: ActionProps) {
  return <BranchResultOwner key={`${props.sessionId}:${props.seq}`} {...props} />
}

function BranchResultOwner(props: ActionProps) {
  const { sessionId, text, useSessions, useAccess, useSessionAccess, t } = props
  const [open, setOpen] = useState(false)
  const parentId = useSessions((state) => {
    const current = state.byId[sessionId]
    if (current?.origin === 'subagent' || current?.parentId === undefined) return undefined
    const parent = state.byId[current.parentId]
    return parent?.origin === 'subagent' ? undefined : parent?.id
  })
  const childAllowed = useAccess('artifactBranchResults/returnResult')
  const parentAllowed = useSessionAccess(parentId ?? sessionId, 'artifactBranchResults/returnResult')
  if (parentId === undefined || !childAllowed || !parentAllowed || text.trim() === '') return null
  return <div className={css.root} data-branch-result-seq={props.seq}>
    {!open ? <Button size="sm" variant="ghost" onClick={() => { setOpen(true) }}>{t('branchEvidence.return')}</Button>
      : <EvidenceReturnPreview {...props} parentId={parentId} onClose={() => { setOpen(false) }} />}
  </div>
}

function EvidenceReturnPreview({
  parentId, sessionId, seq, text, useProjection, returnResult, openSession, onClose, t,
}: ActionProps & { readonly parentId: SessionId; readonly onClose: () => void }) {
  const observations = useProjection('artifactObservations')
  const choices = useMemo(() => Object.values(observations ?? {}).flat(), [observations])
  const [mode, setMode] = useState<'observation' | 'comparison'>('observation')
  const [single, setSingle] = useState<SavedParticleObservationRef | null>(null)
  const [control, setControl] = useState<SavedParticleObservationRef | null>(null)
  const [variant, setVariant] = useState<SavedParticleObservationRef | null>(null)
  const [submission, setSubmission] = useState<Submission>({ kind: 'editing' })
  const modeName = useId()
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const prepared = useMemo(() => {
    const resolve = (value: SavedParticleObservationRef | null) =>
      choices.find(saved => referenceKey(reference(saved)) === referenceKey(value))
    const left = resolve(mode === 'observation' ? single : control)
    const right = resolve(variant)
    if (left === undefined || (mode === 'comparison' && right === undefined)) return { kind: 'missing' } as const
    try {
      if (mode === 'observation') {
        if (left.artifact.spec.kind !== 'particle-system') return { kind: 'invalid' } as const
        const values = observeParticleState(restoreParticleCheckpoint(left.artifact.spec, left.checkpoint))
        const evidence: ArtifactBranchEvidenceSelection = { kind: 'observation', observation: reference(left) }
        return { kind: 'ready', evidence, preview: [{ saved: left, values }] } as const
      }
      if (right === undefined) return { kind: 'missing' } as const
      const compared = buildParticleObservationComparison(left.artifact.comparison?.group ?? '', left, right)
      const evidence: ArtifactBranchEvidenceSelection = {
        kind: 'comparison', group: compared.group, control: compared.control.ref, variant: compared.variant.ref,
      }
      return { kind: 'ready', evidence, preview: [
        { saved: left, values: compared.control.values }, { saved: right, values: compared.variant.values },
      ] } as const
    } catch (error) {
      if (!(error instanceof ParticleObservationComparisonError) && !(error instanceof ParticleRuntimeError)) throw error
      return { kind: 'invalid' } as const
    }
  }, [choices, mode, single, control, variant])

  const captured = submission.kind === 'submitting' || submission.kind === 'retry' ? submission.captured : null
  const locked = captured !== null || (submission.kind === 'rejected'
    && (submission.failure.kind === 'conflict' || submission.failure.kind === 'service-unavailable'))
  const pending = submission.kind === 'submitting'
  const preview = captured?.preview ?? (prepared.kind === 'ready' ? prepared.preview : [])
  const choose = (value: string, current: SavedParticleObservationRef | null,
    setValue: (next: SavedParticleObservationRef | null) => void): void => {
    if (locked || value === referenceKey(current)) return
    const selected = choices.find(saved => referenceKey(reference(saved)) === value)
    setValue(selected === undefined ? null : reference(selected))
    setSubmission({ kind: 'editing' })
  }
  const confirm = async (): Promise<void> => {
    if (inFlight.current || submission.kind === 'rejected') return
    const request = captured ?? (observations !== undefined && prepared.kind === 'ready' ? {
      request: { sessionId: parentId, branchSessionId: sessionId, resultSeq: seq, evidence: prepared.evidence },
      preview: prepared.preview, text,
    } : null)
    if (request === null) return
    inFlight.current = true
    setSubmission({ kind: 'submitting', captured: request })
    try {
      await returnResult(request.request)
      if (mounted.current) openSession(request.request.sessionId)
    } catch (error) {
      if (mounted.current) {
        const failure: ArtifactBranchReturnFailure = error instanceof ArtifactBranchReturnError ? error.failure : { kind: 'unknown' }
        setSubmission(failure.kind === 'unknown' || failure.kind === 'busy'
          ? { kind: 'retry', captured: request, busy: failure.kind === 'busy' }
          : { kind: 'rejected', failure })
      }
    } finally { inFlight.current = false }
  }
  const optionLabel = (saved: SavedParticleObservation): string => t('branchEvidence.option', {
    title: saved.artifact.title, label: saved.label, revision: String(saved.artifact.revision), step: String(saved.checkpoint.stepCount),
  })
  const selectOptions = (items: readonly SavedParticleObservation[]) => items.map(saved =>
    <option key={referenceKey(reference(saved))} value={referenceKey(reference(saved))}>{optionLabel(saved)}</option>)
  const failure = submission.kind === 'rejected' ? submission.failure : null
  const failureKey = failure?.kind === 'conflict' ? 'branchEvidence.conflict'
    : failure?.kind === 'too-large' ? 'branchEvidence.tooLarge'
      : failure?.kind === 'result-unavailable' ? 'branchEvidence.resultUnavailable'
        : failure?.kind === 'service-unavailable' ? 'branchEvidence.serviceUnavailable' : 'branchEvidence.evidenceUnavailable'

  return <div className={css.preview} aria-busy={pending || undefined}>
    <span>{t('branchEvidence.conclusion')}</span>
    <p className={css.conclusion}>{captured?.text ?? text}</p>
    <fieldset className={css.mode} disabled={locked}>
      <legend>{t('branchEvidence.kind')}</legend>
      {(['observation', 'comparison'] as const).map(kind => <label key={kind}>
        <input type="radio" name={modeName} checked={mode === kind} onChange={() => {
          if (!locked) { setMode(kind); setSubmission({ kind: 'editing' }) }
        }} />
        {t(kind === 'observation' ? 'branchEvidence.single' : 'branchEvidence.comparison')}
      </label>)}
    </fieldset>
    {mode === 'observation'
      ? <select aria-label={t('branchEvidence.observation')} disabled={locked || observations === undefined}
        value={referenceKey(single)} onChange={(event) => { choose(event.target.value, single, setSingle) }}>
        <option value="">{t('branchEvidence.choose')}</option>{selectOptions(choices)}
      </select>
      : <div className={css.selectors}>
        <select aria-label={t('branchEvidence.control')} disabled={locked || observations === undefined}
          value={referenceKey(control)} onChange={(event) => { choose(event.target.value, control, setControl) }}>
          <option value="">{t('branchEvidence.choose')}</option>
          {selectOptions(choices.filter(saved => saved.artifact.comparison?.role === 'control'))}
        </select>
        <select aria-label={t('branchEvidence.variant')} disabled={locked || observations === undefined}
          value={referenceKey(variant)} onChange={(event) => { choose(event.target.value, variant, setVariant) }}>
          <option value="">{t('branchEvidence.choose')}</option>
          {selectOptions(choices.filter(saved => saved.artifact.comparison?.role === 'variant'))}
        </select>
      </div>}
    {observations === undefined && <p role="status">{t('observation.loading')}</p>}
    {observations !== undefined && choices.length === 0 && <p>{t('branchEvidence.empty')}</p>}
    {prepared.kind === 'invalid' && captured === null && <p role="status">{t('branchEvidence.incompatible')}</p>}
    {preview.map(({ saved, values }) => <div key={referenceKey(reference(saved))} data-evidence-observation-id={saved.observationId}>
      <strong>{optionLabel(saved)}</strong>
      <pre className={css.values} aria-label={t('branchEvidence.values', { label: saved.label })}>{JSON.stringify(values, null, 2)}</pre>
    </div>)}
    {submission.kind === 'retry' && <p role="alert" className={css.error}>
      {t(submission.busy ? 'branchEvidence.busy' : 'branchEvidence.unknown')}
    </p>}
    {failure !== null && <p role="alert" className={css.error}>
      {t(failureKey, { limit: failure.kind === 'too-large' ? String(failure.limit) : '' })}
    </p>}
    <div className={css.actions}>
      {failure?.kind === 'conflict'
        ? <Button size="sm" variant="primary" onClick={() => { openSession(parentId) }}>{t('branchEvidence.openParent')}</Button>
        : <Button size="sm" variant="primary" disabled={pending || submission.kind === 'rejected'
          || (captured === null && (observations === undefined || prepared.kind !== 'ready'))}
        onClick={() => { void confirm() }}>
          {t(pending ? 'branchEvidence.returning' : captured === null ? 'branchEvidence.confirm' : 'branchEvidence.retry')}
        </Button>}
      <Button size="sm" variant="ghost" disabled={pending} onClick={onClose}>{t('branchEvidence.cancel')}</Button>
    </div>
  </div>
}
