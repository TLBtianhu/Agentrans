/** Explicit return of one branch conclusion with immutable experiment evidence. */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@agentrans/client-ui-slots'
import { Button } from '@agentrans/client-ui-primitives'
import type { SessionId } from '@agentrans/session/types'
import type { UserMessageNode } from '@agentrans/client-ui-conversation/client'
import type { ObservableSnapshot } from '@agentrans/client-store'
import type { ArtifactBranchEvidenceSelection, ArtifactBranchResultRequest } from '@agentrans/artifact-branch/types'
import type { SavedParticleObservation, SavedParticleObservationRef } from '@agentrans/artifact/types'
import {
  buildParticleObservationComparison, ParticleObservationComparisonError,
} from '@agentrans/artifact/observation-comparison'
import { observeParticleState, restoreParticleCheckpoint, ParticleRuntimeError } from '@agentrans/artifact/particle-runtime'
import { ArtifactQuestionReplay } from './ArtifactQuestionReplay.tsx'
import { csvGroupLabel } from './CsvBarChartView.tsx'
import { HtmlCheckpointReadingsView } from './HtmlCheckpointReadings.tsx'
import { parseHtmlQuestionReplay, parseNativeQuestionReplay,
  type ArtifactQuestionReplay as QuestionReplay, type HtmlQuestionReplay } from './question-context-text.ts'
import {
  ArtifactBranchReturnError, type ArtifactBranchReturnFailure, type ReturnArtifactBranchResult,
} from './protocol.ts'
import css from './ArtifactBranchResultAction.module.css'

/** Narrow operations for the optional Artifact-owned branch adoption entry. */
export interface ArtifactBranchResultInjected {
  readonly returnResult: ReturnArtifactBranchResult
  readonly openSession: (sessionId: SessionId) => void
  readonly keyedHooks: {
    readonly userMessages: (turn: string) => ObservableSnapshot<readonly QuestionMessage[]>
    readonly steeringMessages: (turn: string) => ObservableSnapshot<readonly QuestionMessage[]>
  }
}

type ActionProps = PropsRuntime<'conversation.chat.assistant.details'> & InjectFace<ArtifactBranchResultInjected> & PropsLocale<'artifact'>
type QuestionMessage = Pick<UserMessageNode, 'seq' | 'content'>
const EMPTY_QUESTION_MESSAGES: readonly QuestionMessage[] = []
type EvidenceMode = ArtifactBranchEvidenceSelection['kind']
type QuestionEvidence = Extract<ArtifactBranchEvidenceSelection, { kind: 'question' }>
type QuestionPreview = { readonly kind: 'native'; readonly replay: QuestionReplay } | { readonly kind: 'html'; readonly replay: HtmlQuestionReplay }
interface QuestionChoice {
  readonly key: string
  readonly evidence: QuestionEvidence
  readonly preview: QuestionPreview
}
type EvidencePreview = {
  readonly kind: 'saved'
  readonly saved: SavedParticleObservation
  readonly values: SavedParticleObservation['values']
} | { readonly kind: 'question'; readonly choice: QuestionChoice }
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

function questionChoices(messages: readonly QuestionMessage[], resultSeq: number, sessionId: SessionId): QuestionChoice[] {
  return messages.flatMap(({ seq, content }) => seq >= resultSeq ? [] : content.flatMap((block, blockIndex) => {
    if (blockIndex === 0 || block.type !== 'text') return []
    const native = parseNativeQuestionReplay(block.text, sessionId)
    const html = native === undefined ? parseHtmlQuestionReplay(block.text, sessionId) : undefined
    const preview: QuestionPreview | undefined = native !== undefined ? { kind: 'native', replay: native }
      : html !== undefined ? { kind: 'html', replay: html } : undefined
    return preview === undefined ? [] : [{
      key: `${seq}:${blockIndex}`, evidence: { kind: 'question', questionSeq: seq, blockIndex }, preview,
    }]
  }))
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
  parentId, sessionId, seq, turn, text, useProjection, useUserMessages, useSteeringMessages, returnResult, openSession, onClose, t,
}: ActionProps & { readonly parentId: SessionId; readonly onClose: () => void }) {
  const observations = useProjection('artifactObservations')
  const choices = useMemo(() => Object.values(observations ?? {}).flat(), [observations])
  const turnKey = String(turn ?? 0)
  const userMessages = useUserMessages(turnKey) ?? EMPTY_QUESTION_MESSAGES
  const steeringMessages = useSteeringMessages(turnKey) ?? EMPTY_QUESTION_MESSAGES
  const questions = useMemo(() => questionChoices([...userMessages, ...steeringMessages], seq, sessionId),
    [userMessages, steeringMessages, seq, sessionId])
  const [modeChoice, setMode] = useState<EvidenceMode | null>(null)
  const [questionKey, setQuestionKey] = useState<string | null>(null)
  const [single, setSingle] = useState<SavedParticleObservationRef | null>(null)
  const [control, setControl] = useState<SavedParticleObservationRef | null>(null)
  const [variant, setVariant] = useState<SavedParticleObservationRef | null>(null)
  const [submission, setSubmission] = useState<Submission>({ kind: 'editing' })
  const modeName = useId()
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const mode = modeChoice ?? (questions.length === 0 ? 'observation' : 'question')
  const selectedQuestionKey = questionKey ?? (questions.length === 1 ? questions[0]?.key ?? '' : '')
  const prepared = useMemo(() => {
    if (mode === 'question') {
      const choice = questions.find(question => question.key === selectedQuestionKey)
      return choice === undefined ? { kind: 'missing' } as const
        : { kind: 'ready', evidence: choice.evidence, preview: [{ kind: 'question', choice }] } as const
    }
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
        return { kind: 'ready', evidence, preview: [{ kind: 'saved', saved: left, values }] } as const
      }
      if (right === undefined) return { kind: 'missing' } as const
      const compared = buildParticleObservationComparison(left.artifact.comparison?.group ?? '', left, right)
      const evidence: ArtifactBranchEvidenceSelection = {
        kind: 'comparison', group: compared.group, control: compared.control.ref, variant: compared.variant.ref,
      }
      return { kind: 'ready', evidence, preview: [
        { kind: 'saved', saved: left, values: compared.control.values }, { kind: 'saved', saved: right, values: compared.variant.values },
      ] } as const
    } catch (error) {
      if (!(error instanceof ParticleObservationComparisonError) && !(error instanceof ParticleRuntimeError)) throw error
      return { kind: 'invalid' } as const
    }
  }, [choices, mode, single, control, variant, questions, selectedQuestionKey])

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
    const request = captured ?? (prepared.kind === 'ready' ? {
      request: { sessionId: parentId, branchSessionId: sessionId, resultSeq: seq, evidence: prepared.evidence },
      preview: prepared.preview, text,
    } : null)
    if (request === null) return
    inFlight.current = true
    setMode(request.request.evidence.kind)
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
  const questionLabel = ({ preview }: QuestionChoice): string => {
    const { artifact } = preview.replay
    const source = { title: artifact.title, revision: String(artifact.revision) }
    if (preview.kind === 'html') return t('questionContext.programReady', source)
    const { state } = preview.replay
    if (state.kind === 'csv-bar-chart') return t('csvChart.context', { ...source, group: csvGroupLabel(state.group.key, t) })
    return state.kind === 'function-plot' ? t('questionContext.plot', { ...source, x: String(state.x) })
      : t('questionContext.single', { ...source, step: String(state.checkpoint.stepCount) })
  }
  const modeLabels = { question: 'branchEvidence.question', observation: 'branchEvidence.single', comparison: 'branchEvidence.comparison' } as const
  const modes: readonly EvidenceMode[] = questions.length > 0 || mode === 'question'
    ? ['question', 'observation', 'comparison'] : ['observation', 'comparison']
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
      {modes.map(kind => <label key={kind}>
        <input type="radio" name={modeName} checked={mode === kind} onChange={() => {
          if (!locked) { setMode(kind); setSubmission({ kind: 'editing' }) }
        }} />
        {t(modeLabels[kind])}
      </label>)}
    </fieldset>
    {mode === 'question' ? (
      <select aria-label={t('branchEvidence.question')} disabled={locked} value={selectedQuestionKey} onChange={(event) => {
        if (!locked) { setQuestionKey(event.target.value); setSubmission({ kind: 'editing' }) }
      }}>
        <option value="">{t('branchEvidence.chooseQuestion')}</option>
        {questions.map(choice => <option key={choice.key} value={choice.key}>{questionLabel(choice)}</option>)}
      </select>
    ) : mode === 'observation'
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
    {mode !== 'question' && observations === undefined && <p role="status">{t('observation.loading')}</p>}
    {mode !== 'question' && observations !== undefined && choices.length === 0 && <p>{t('branchEvidence.empty')}</p>}
    {prepared.kind === 'invalid' && captured === null && <p role="status">{t('branchEvidence.incompatible')}</p>}
    {preview.map(item => item.kind === 'question' ? (
      <div key={item.choice.key} data-branch-question-preview>
        <strong>{questionLabel(item.choice)}</strong>
        <QuestionEvidenceReadings preview={item.choice.preview} t={t} />
      </div>
    ) : (
      <div key={referenceKey(reference(item.saved))} data-evidence-observation-id={item.saved.observationId}>
        <strong>{optionLabel(item.saved)}</strong>
        <pre className={css.values} aria-label={t('branchEvidence.values', { label: item.saved.label })}>{JSON.stringify(item.values, null, 2)}</pre>
      </div>
    ))}
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
          || (captured === null && prepared.kind !== 'ready')}
        onClick={() => { void confirm() }}>
          {t(pending ? 'branchEvidence.returning' : captured === null ? 'branchEvidence.confirm' : 'branchEvidence.retry')}
        </Button>}
      <Button size="sm" variant="ghost" disabled={pending} onClick={onClose}>{t('branchEvidence.cancel')}</Button>
    </div>
  </div>
}

function QuestionEvidenceReadings({ preview, t }: { readonly preview: QuestionPreview } & PropsLocale<'artifact'>) {
  if (preview.kind === 'html') return <>
    <p>{t('bfs.reported')}</p>
    <HtmlCheckpointReadingsView state={preview.replay.state} t={t} />
  </>
  return <ArtifactQuestionReplay snapshot={preview.replay.artifact} replay={preview.replay.state} t={t} />
}
