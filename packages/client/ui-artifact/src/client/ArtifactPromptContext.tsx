/** Visible composer choice for the next ordinary question. */
import { useEffect } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@agentrans/client-ui-slots'
import type { ObservableSnapshot } from '@agentrans/client-store'
import type { TokenSpan } from '@agentrans/client-ui-conversation/client'
import { Button } from '@agentrans/client-ui-primitives'
import type { ArtifactPromptBinding } from './particle-runtime-owner.ts'
import { ArtifactReplayDisclosure } from './ArtifactQuestionReplay.tsx'
import { branchEvidenceFocus } from './BranchEvidenceMessage.tsx'
import { CsvGroupReading, csvGroupLabel } from './CsvBarChartView.tsx'
import { CsvAttachedComparison, CsvComparisonReadings, csvReturnComparisonSideLabels } from './CsvQuestionComparison.tsx'
import { CsvComparisonImport, type LoadCsvComparisonImport } from './CsvComparisonImport.tsx'
import type { CsvSourceChainOptions } from './CsvSourceChain.tsx'
import { CsvSourceRecoveryNotice } from './CsvSourceRecoveryNotice.tsx'
import type { CsvComparisonSourceChain, CsvComparisonSourceRecovery } from './csv-comparison-source-chain.ts'
import { HtmlCheckpointReadingsView } from './HtmlCheckpointReadings.tsx'
import { artifactHostRouteAvailable } from './artifact-route.ts'
import {
  csvSentQuestionFocus, type CsvComparisonDraftOutcome, type CsvComparisonDraftPhase, type CsvComparisonSourceTrail,
  type CsvExplanationStep, type CsvReturnComparisonSide, type CsvSentQuestion,
} from './csv-comparison-draft.ts'
import css from './ArtifactNodeView.module.css'

/** Session-local presentation selection and its explicit removal. */
export interface ArtifactPromptContextInjected {
  readonly hooks: {
    readonly artifactPromptContext: ObservableSnapshot<ArtifactPromptBinding | null>
    readonly csvComparisonDraft: ObservableSnapshot<CsvComparisonDraftPhase>
    readonly csvComparisonDraftOutcome: ObservableSnapshot<CsvComparisonDraftOutcome | undefined>
    readonly csvComparisonDraftCleanupFailed: ObservableSnapshot<boolean>
    readonly pendingCsvComparisonSourceTrail: ObservableSnapshot<CsvComparisonSourceTrail | undefined>
    readonly csvComparisonSourceRecovery: ObservableSnapshot<CsvComparisonSourceRecovery | undefined>
  }
  readonly restoreCsvComparisonDraft: () => void
  readonly loadCsvComparisonImport: LoadCsvComparisonImport
  readonly retryCsvComparisonDraftCleanup: () => void
  readonly dismissCsvComparisonDraftOutcome: () => void
  readonly selectCsvSentQuestion: (target: CsvSentQuestion) => boolean
  readonly visitCsvDraftSource: (
    source: CsvSentQuestion, receiptId: string, selection: TokenSpan, open: () => void, step?: CsvExplanationStep,
  ) => void
  readonly visitCsvDraftReturn: (
    source: CsvSentQuestion, receiptId: string, selection: TokenSpan, open: () => void, returnSide: CsvReturnComparisonSide,
  ) => void
  readonly loadCsvSourceChain: (source: CsvSentQuestion, receiptId: string, signal: AbortSignal) => Promise<CsvComparisonSourceChain>
  readonly visitCsvDraftSourceChain: (
    sources: readonly CsvSentQuestion[], receiptId: string, selection: TokenSpan, open: () => void,
  ) => void
  readonly sourceQuestionLabel: (question: CsvSentQuestion) => string | undefined
  readonly restoreCsvSourceTrail: (
    trail: CsvComparisonSourceTrail, signal: AbortSignal, open: (target: CsvSentQuestion, focus?: string) => void,
  ) => void
  readonly retryCsvSourceRecovery: (recovery: CsvComparisonSourceRecovery, open: (target: CsvSentQuestion, focus?: string) => void) => void
  readonly retryFunctionPlotDraft: () => void
  readonly clearArtifactPromptContext: () => void
}

type PromptContextProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'artifact'> & InjectFace<ArtifactPromptContextInjected>

/** Keep restore and failed synchronization visible without changing the user's text draft. */
export function ArtifactPromptContextDock({
  useCsvComparisonDraft, useCsvComparisonDraftOutcome, useCsvComparisonDraftCleanupFailed, useSession, useAccess,
  usePendingCsvComparisonSourceTrail, useCsvComparisonSourceRecovery, openView, inputActions,
  restoreCsvComparisonDraft, retryCsvComparisonDraftCleanup, loadCsvComparisonImport,
  dismissCsvComparisonDraftOutcome, selectCsvSentQuestion, visitCsvDraftSource, visitCsvDraftReturn, restoreCsvSourceTrail,
  loadCsvSourceChain, visitCsvDraftSourceChain, sourceQuestionLabel, retryCsvSourceRecovery, retryFunctionPlotDraft, ...props
}: PromptContextProps) {
  const phase = useCsvComparisonDraft(value => value)
  const outcome = useCsvComparisonDraftOutcome(value => value)
  const cleanupFailed = useCsvComparisonDraftCleanupFailed(value => value)
  const pendingTrail = usePendingCsvComparisonSourceTrail(value => value)
  const recovery = useCsvComparisonSourceRecovery(value => value?.source === undefined ? value : undefined)
  const hostRoute = useSession(artifactHostRouteAvailable)
  const canRead = useAccess('artifactBranchResults/readCsvComparisonDraft')
  const canReadHistory = useAccess('session/events')
  const canClear = useAccess('artifactBranchResults/clearCsvComparisonDraft')
  const canPrompt = useAccess('session/prompt')
  const canImport = useAccess('artifactBranchResults/importCsvComparison')
  const canSaveDraft = useAccess('artifactBranchResults/saveCsvComparisonDraft')
  const available = hostRoute && canRead && canPrompt
  const archiveReady = props.session.openState === 'open' && !props.session.removed
  const canRestoreSource = canReadHistory && (pendingTrail?.[0].origin.kind !== 'draft' || phase === 'ready' && available)
  useEffect(() => {
    if (openView === undefined || !archiveReady || !canRestoreSource || pendingTrail === undefined) return
    const controller = new AbortController()
    restoreCsvSourceTrail(pendingTrail, controller.signal, (target, focus) => { openView('chat', focus ?? csvSentQuestionFocus(target)) })
    return () => { controller.abort() }
  }, [archiveReady, canRestoreSource, openView, pendingTrail, restoreCsvSourceTrail])
  const { t } = props
  const busyMessage = phase === 'restoring' ? 'csvCompare.draftReading'
    : phase === 'awaiting-confirmation' ? 'csvCompare.draftAwaitingConfirmation'
      : phase === 'saving' ? 'csvCompare.draftSaving' : phase === 'clearing' ? 'csvCompare.draftClearing' : undefined
  const errorMessage = phase === 'restore-failed' ? 'csvCompare.draftReadFailed'
    : phase === 'clear-failed' ? 'csvCompare.draftClearFailed' : undefined
  const outcomeMessage = outcome?.status === 'accepted' ? 'csvCompare.draftAccepted'
    : outcome?.status === 'unconfirmed' ? 'csvCompare.draftUnconfirmed' : undefined
  const sent = outcome?.status === 'accepted' ? outcome.message : undefined
  const message = busyMessage ?? outcomeMessage
  return <>
    {available && message !== undefined && <p role="status" data-csv-comparison-draft-state={busyMessage === undefined ? undefined : phase}
      data-csv-comparison-draft-outcome={busyMessage === undefined ? outcome?.status : undefined}>{t(message)}</p>}
    {available && busyMessage === undefined && openView !== undefined && sent !== undefined && <Button size="sm" variant="outline"
      data-csv-view-sent-question onClick={() => {
        if (!selectCsvSentQuestion(sent)) return
        openView('chat', csvSentQuestionFocus(sent))
      }}>{t('csvCompare.viewSentQuestion')}</Button>}
    {available && busyMessage === undefined && outcomeMessage !== undefined && <Button size="sm" variant="ghost"
      onClick={dismissCsvComparisonDraftOutcome}>{t('csvCompare.dismissDraftOutcome')}</Button>}
    {available && errorMessage !== undefined && <div data-csv-comparison-draft-state={phase}>
      <p role="alert">{t(errorMessage)}</p>
      <Button size="sm" variant="outline" onClick={restoreCsvComparisonDraft}>{t('csvAnalysis.retry')}</Button>
    </div>}
    {available && cleanupFailed && <div data-csv-comparison-draft-state="cleanup-failed">
      <p role="alert">{t('csvCompare.draftCleanupFailed')}</p>
      <Button size="sm" variant="outline" onClick={retryCsvComparisonDraftCleanup}>{t('csvAnalysis.retry')}</Button>
    </div>}
    {canReadHistory && openView !== undefined && recovery !== undefined && <CsvSourceRecoveryNotice recovery={recovery} t={t}
      retry={() => { retryCsvSourceRecovery(recovery, (target, focus) => { openView('chat', focus ?? csvSentQuestionFocus(target)) }) }} />}
    {available && archiveReady && canImport && canSaveDraft && <CsvComparisonImport key={props.session.sessionId}
      load={loadCsvComparisonImport} disabled={phase !== 'ready'} t={t} />}
    <ArtifactPromptContext {...props} useSession={useSession} csvDraftVisible={available} csvDraftClearAllowed={canClear}
      csvDraftBusy={busyMessage !== undefined}
      retryFunctionPlotDraft={canReadHistory && archiveReady ? retryFunctionPlotDraft : undefined}
      viewCsvReturn={openView === undefined || !canReadHistory || phase !== 'ready' ? undefined : (source, receiptId, side) => {
        const selection = inputActions.captureInsertion()
        visitCsvDraftReturn(source, receiptId, selection, () => { openView('chat', branchEvidenceFocus(source)) }, side)
      }}
      viewCsvSource={openView === undefined || !canReadHistory || phase !== 'ready' ? undefined : (source, receiptId, step) => {
        const selection = inputActions.captureInsertion()
        const open = (): void => { openView('chat', csvSentQuestionFocus(source)) }
        if (step === undefined) visitCsvDraftSource(source, receiptId, selection, open)
        else visitCsvDraftSource(source, receiptId, selection, open, step)
      }} draftSourceChain={openView === undefined || !available || !canReadHistory || phase !== 'ready' ? undefined : (source, receiptId) => ({
        load: signal => loadCsvSourceChain(source, receiptId, signal),
        questionLabel: sourceQuestionLabel,
        captureOpen: () => {
          const selection = inputActions.captureInsertion()
          return (sources) => {
            const target = sources.at(-1)
            if (target !== undefined) {
              visitCsvDraftSourceChain(sources, receiptId, selection, () => { openView('chat', csvSentQuestionFocus(target)) })
            }
          }
        },
      })} />
  </>
}

function describeContext(context: ArtifactPromptBinding, t: PropsLocale<'artifact'>['t']): string {
  switch (context.kind) {
    case 'current-particle':
      return t(context.available ? 'promptContext.live' : 'promptContext.unavailable', { revision: String(context.revision),
        step: String(context.readings.checkpoint.stepCount), time: String(context.readings.values.time) })
    case 'current-function-plot':
      return t(context.restoration === 'reading' ? 'promptContext.restoringPlot' : context.restoration === 'retry' ? 'promptContext.plotHistoryFailed'
        : context.available ? 'promptContext.plot' : 'promptContext.unavailable', {
        revision: String(context.request.revision), x: String(context.request.x),
      })
    case 'current-csv-bar-chart':
      return t(context.available ? 'revision' : 'promptContext.unavailable', { revision: String(context.request.revision) })
    case 'csv-question-comparison':
      return t('csvCompare.attached')
    case 'branch-evidence': {
      const { artifact, state } = context.replay
      const revision = String(artifact.revision)
      if (state.kind === 'csv-bar-chart') {
        const details = t('csvChart.context', { title: artifact.title, revision, group: csvGroupLabel(state.group.key, t) })
        return t('questionContext.branchEvidence', { context: details })
      }
      const details = state.kind === 'function-plot' ? t('promptContext.plot', { revision, x: String(state.x) })
        : t('promptContext.live', { revision, step: String(state.checkpoint.stepCount), time: String(state.values.time) })
      return t('questionContext.branchEvidence', { context: details })
    }
    case 'html-runtime':
      return t(`promptContext.program.${context.availability}`)
    case 'html-bfs':
    case 'html-half-adder':
      return t(context.available ? 'bfs.locked' : 'promptContext.unavailable')
    case 'branch-bfs-checkpoint':
    case 'branch-half-adder-checkpoint':
      return t('bfs.locked')
    case 'observation':
      return t('promptContext.saved', { label: context.observation.label,
        revision: String(context.observation.revision), step: String(context.observation.stepCount) })
    case 'comparison':
      return t('promptContext.comparison', { control: context.control.label,
        variant: context.variant.label, step: String(context.control.stepCount) })
  }
}

/** Display selected source identity without claiming the model has already received it. */
export function ArtifactPromptContext({
  useArtifactPromptContext, useSession, clearArtifactPromptContext, csvDraftVisible = true, csvDraftClearAllowed = true,
  csvDraftBusy = false, viewCsvSource, viewCsvReturn, draftSourceChain, retryFunctionPlotDraft, t,
}: Pick<PromptContextProps, 'useArtifactPromptContext' | 'useSession' | 'clearArtifactPromptContext' | 't'> & {
  readonly csvDraftVisible?: boolean
  readonly csvDraftClearAllowed?: boolean
  readonly csvDraftBusy?: boolean
  readonly viewCsvSource?: ((source: CsvSentQuestion, receiptId: string, step?: CsvExplanationStep) => void) | undefined
  readonly viewCsvReturn?: ((source: CsvSentQuestion, receiptId: string, side: CsvReturnComparisonSide) => void) | undefined
  readonly draftSourceChain?: ((source: CsvSentQuestion, receiptId: string) => CsvSourceChainOptions) | undefined
  readonly retryFunctionPlotDraft?: (() => void) | undefined
}) {
  const context = useArtifactPromptContext(value => value)
  const questionContextAvailable = useSession(artifactHostRouteAvailable)
  const sessionId = useSession(session => session.sessionId)
  if (context === null || context.kind === 'csv-question-comparison' && !csvDraftVisible) return null
  const sourceQuestion = context.kind === 'csv-question-comparison' && context.draft.facts.sessionId === sessionId
    ? context.draft.facts.reusedFrom : undefined
  const sourceReturns = context.kind === 'csv-question-comparison' && context.draft.facts.sessionId === sessionId
    ? context.draft.facts.returns : undefined
  const title = 'title' in context ? context.title : context.kind === 'csv-question-comparison' ? t('csvCompare.attachment')
    : context.kind === 'observation' ? context.observation.title : `${context.control.title} / ${context.variant.title}`
  const description = questionContextAvailable ? describeContext(context, t) : t('promptContext.subagentUnsupported')
  return <section className={css.observations} aria-label={t('promptContext.label')} data-artifact-prompt-context={context.kind}>
    <strong>{title}</strong>
    {context.kind === 'html-runtime' && <span>{t('revision', { revision: String(context.identity.revision) })}</span>}
    {(context.kind === 'html-bfs' || context.kind === 'html-half-adder') && <>
      <span>{t('revision', { revision: String(context.request.revision) })}</span>
      <HtmlCheckpointReadingsView state={context.checkpoint} t={t} />
    </>}
    {(context.kind === 'branch-bfs-checkpoint' || context.kind === 'branch-half-adder-checkpoint') && <>
      <span>{t('revision', { revision: String(context.revision) })}</span>
      <HtmlCheckpointReadingsView state={context.request.state} t={t} />
    </>}
    <p role={!questionContextAvailable || 'available' in context && !context.available
      && !(context.kind === 'current-function-plot' && context.restoration === 'reading')
      || context.kind === 'html-runtime' && context.availability !== 'state' && context.availability !== 'error' ? 'alert' : 'status'}>{description}</p>
    {questionContextAvailable && context.kind === 'current-function-plot' && context.restoration === 'retry'
      && retryFunctionPlotDraft !== undefined && <Button size="sm" variant="outline" data-function-plot-draft-retry
      onClick={retryFunctionPlotDraft}>{t('promptContext.retryPlot')}</Button>}
    {context.kind === 'current-particle' && context.readings.gravityY !== undefined && <span>
      {t('scene.particleVerticalGravity')}{' '}{String(context.readings.gravityY)}
    </span>}
    {context.kind === 'current-csv-bar-chart' && <CsvGroupReading group={context.group} recipe={context.recipe} t={t} />}
    {context.kind === 'csv-question-comparison' && <>
      {context.draft.facts.explanation === undefined && <CsvComparisonReadings summary={context.draft.facts.comparison}
        sideLabels={context.draft.facts.returns !== undefined || context.draft.facts.returnCards !== undefined
          ? csvReturnComparisonSideLabels(t) : undefined}
        userImported={context.draft.facts.provenance === 'user-imported'} t={t} />}
      <CsvAttachedComparison key={context.draft.receiptId} page={context.draft.facts.comparison} draft t={t}
        explanation={context.draft.facts.explanation} userImported={context.draft.facts.provenance === 'user-imported'}
        returnCards={context.draft.facts.returnCards}
        openReturnedSource={sourceReturns !== undefined && viewCsvReturn !== undefined
          ? (side) => {
            const { eventSeq, messageId } = sourceReturns[side]
            viewCsvReturn({ eventSeq, messageId }, context.draft.receiptId, side)
          } : undefined}
        openExplanationSource={context.draft.facts.provenance === undefined && context.draft.facts.sessionId === sessionId
          && viewCsvSource !== undefined
          ? (target, step) => { viewCsvSource(target, context.draft.receiptId, step) } : undefined}
        viewSourceQuestion={sourceQuestion !== undefined && viewCsvSource !== undefined
          ? () => { viewCsvSource(sourceQuestion, context.draft.receiptId) } : undefined}
        sourceChain={sourceQuestion === undefined ? undefined : draftSourceChain?.(sourceQuestion, context.draft.receiptId)} />
    </>}
    {context.kind === 'branch-evidence' && <ArtifactReplayDisclosure key={context.request.messageId}
      snapshot={context.replay.artifact} replay={context.replay.state} t={t} />}
    {(context.kind !== 'csv-question-comparison' || csvDraftClearAllowed) && <Button size="sm" variant="ghost"
      disabled={context.kind === 'csv-question-comparison' && csvDraftBusy} onClick={clearArtifactPromptContext}>
      {t('promptContext.clear')}
    </Button>}
  </section>
}
