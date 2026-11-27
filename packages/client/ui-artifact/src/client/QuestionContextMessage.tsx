/** Compact experiment context and read-only replay in user messages. */
import type { HtmlArtifactSnapshot } from '@agentrans/artifact/types'
import type { ObservableSnapshot } from '@agentrans/client-store'
import type { FileSaveResult } from '@agentrans/client-ui-file-actions/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@agentrans/client-ui-slots'
import { ArtifactReplayDisclosure } from './ArtifactQuestionReplay.tsx'
import { branchEvidenceFocus } from './BranchEvidenceMessage.tsx'
import { artifactHostRouteAvailable } from './artifact-route.ts'
import type { CsvRowsLoader } from './CsvParticipatingRows.tsx'
import {
  CsvAttachedComparison, csvReturnComparisonSideLabels,
  type ChooseCsvComparison, type CsvComparisonDownloadFormat, type CsvComparisonLoader,
  type CsvExplanationActions, type CsvSentComparisonActions, type DownloadSentCsvComparison,
  type OpenCsvExplanationSource, type ReviewSentCsvComparison,
} from './CsvQuestionComparison.tsx'
import type { CsvComparisonExplanation, CsvExplanationSelection } from './csv-comparison-explanation.ts'
import type { CsvSourceChainOptions } from './CsvSourceChain.tsx'
import { csvComparisonSourceKind, type CsvComparisonSourceChain, type CsvComparisonSourceRecovery } from './csv-comparison-source-chain.ts'
import { csvGroupLabel } from './CsvBarChartView.tsx'
import { HtmlCheckpointReadingsView } from './HtmlCheckpointReadings.tsx'
import { HtmlCheckpointReplay } from './HtmlCheckpointReplay.tsx'
import { ExperimentDownload } from './ExperimentDownload.tsx'
import type { ArtifactHtmlCheckpointKind } from '@agentrans/artifact/runtime-values'
import type { HtmlQuestionOrigin } from './question-context-text.ts'
import {
  csvSentQuestionFocus, sameCsvSentQuestion, type CsvComparisonDraftPhase, type CsvComparisonSourceTrail,
  type CsvComparisonSourceVisit, type CsvReturnComparisonSide, type CsvSentQuestion,
} from './csv-comparison-draft.ts'
import type { ArtifactCsvComparisonPage, ArtifactCsvComparisonReturnCards } from '@agentrans/artifact-followup/types'
import css from './QuestionContextMessage.module.css'

type QuestionNode = PropsRuntime<'conversation.user.text.node', 'artifact-question-context'>
type QuestionContentProps = Pick<QuestionNode, 'node' | 'raw' | 'interactive'> & PropsLocale<'artifact'>
type NativeSentExperimentKind = 'function-plot' | 'particle-system'

/** Read-only operations on the exact sent native experiment question. */
export interface QuestionContextInjected {
  readonly readCsvQuestionRows: (message: NonNullable<QuestionNode['messageRef']>, offset: number) => ReturnType<CsvRowsLoader>
  readonly compareCsvQuestion: (message: NonNullable<QuestionNode['messageRef']>, offset: number) => ReturnType<CsvComparisonLoader>
  readonly chooseCsvComparison: ChooseCsvComparison
  readonly downloadSentExperiment: (kind: NativeSentExperimentKind, message: NonNullable<QuestionNode['messageRef']>) => Promise<FileSaveResult>
  readonly hooks: {
    readonly sentExperimentExports: ObservableSnapshot<Readonly<Record<NativeSentExperimentKind, boolean>>>
  }
}

/** Enable history operations for an owned, recorded question and an available session route. */
export function QuestionContextNodeView({
  sessionId, messageRef, useSession, useAccess, readCsvQuestionRows, compareCsvQuestion, chooseCsvComparison,
  useSentExperimentExports, downloadSentExperiment, ...props
}: QuestionNode & PropsLocale<'artifact'> & InjectFace<QuestionContextInjected>) {
  const hostRoute = useSession(artifactHostRouteAvailable)
  const canReadRows = useAccess('artifactBranchResults/csvQuestionParticipatingRows')
  const canCompare = useAccess('artifactBranchResults/compareCsvQuestionToReturn')
  const canPrompt = useAccess('session/prompt')
  const canSaveDraft = useAccess('artifactBranchResults/saveCsvComparisonDraft')
  const downloadAccess = {
    'function-plot': useAccess('artifactBranchResults/exportSentPlot'),
    'particle-system': useAccess('artifactBranchResults/exportSentParticle'),
  }
  const replayKind = props.node.data.replay?.state.kind
  const kind = replayKind === 'function-plot' || replayKind === 'particle-system' ? replayKind : undefined
  const available = useSentExperimentExports(exports => kind !== undefined && exports[kind])
  const sourceSession = props.node.data.replay?.artifact.csvContinuation?.source.sessionId
  const recorded = hostRoute && sourceSession === sessionId ? messageRef : undefined
  const download = props.interactive && hostRoute && kind !== undefined && downloadAccess[kind] && available
    && props.node.data.sessionId === sessionId && messageRef !== undefined
    ? () => downloadSentExperiment(kind, messageRef) : undefined
  return <QuestionContextMessage {...props}
    readCsvRows={canReadRows && recorded !== undefined ? offset => readCsvQuestionRows(recorded, offset) : undefined}
    chooseCsvComparison={canPrompt && canCompare && canSaveDraft && recorded !== undefined ? chooseCsvComparison : undefined}
    loadCsvComparison={canCompare && recorded !== undefined ? offset => compareCsvQuestion(recorded, offset) : undefined}
    download={download} />
}

/** Show source conditions, original text, and an optional replay of confirmed native conditions. */
export function QuestionContextMessage({ node, raw, interactive, readCsvRows, loadCsvComparison, chooseCsvComparison, download, t }:
  QuestionContentProps & {
    readonly readCsvRows?: CsvRowsLoader | undefined
    readonly loadCsvComparison?: CsvComparisonLoader | undefined
    readonly chooseCsvComparison?: ChooseCsvComparison | undefined
    readonly download?: (() => Promise<FileSaveResult>) | undefined
  }) {
  const data = node.data
  const replay = interactive ? data.replay : undefined
  const fromBranch = data.origin === 'branch-evidence'
  const continued = !fromBranch && replay?.artifact.csvContinuation !== undefined
  const source = { title: data.title, revision: String(data.revision) }
  const label = 'csv' in data ? t('csvChart.context', { ...source, group: csvGroupLabel(data.csv.group.key, t) })
    : 'x' in data ? t('questionContext.plot', { ...source, x: String(data.x) })
      : data.variantRevision === undefined
        ? t('questionContext.single', { ...source, step: String(data.stepCount) })
        : t('questionContext.pair', { control: data.title, variant: data.variantTitle ?? '', controlRevision: source.revision,
          variantRevision: String(data.variantRevision), step: String(data.stepCount) })
  return <>
    <details className={css.context} data-artifact-question-context data-artifact-question-context-origin={data.origin}>
      <summary>{fromBranch ? t('questionContext.branchEvidence', { context: label }) : label}</summary>
      <span className={css.label}>{t('questionContext.original')}</span>
      <pre className={css.raw} data-artifact-question-context-raw>{raw}</pre>
    </details>
    {replay !== undefined && <ArtifactReplayDisclosure snapshot={replay.artifact} replay={replay.state}
      readCsvRows={continued ? readCsvRows : undefined} loadCsvComparison={continued ? loadCsvComparison : undefined}
      chooseCsvComparison={continued ? chooseCsvComparison : undefined} t={t} />}
    {download !== undefined && <ExperimentDownload location="question" download={download} t={t} />}
  </>
}

export interface CsvComparisonContextInjected {
  readonly hooks: {
    readonly returnToCsvDraft: ObservableSnapshot<CsvSentQuestion | undefined>
    readonly csvHistoryDraftPhase: ObservableSnapshot<CsvComparisonDraftPhase>
    readonly csvComparisonSourceTrail: ObservableSnapshot<CsvComparisonSourceTrail | undefined>
    readonly csvComparisonSourceRecovery: ObservableSnapshot<CsvComparisonSourceRecovery | undefined>
    readonly csvExplanationSelection: ObservableSnapshot<CsvExplanationSelection | undefined>
  }
  readonly returnToCsvDraft: (target: CsvSentQuestion) => void
  readonly visitCsvComparisonSource: (visit: CsvComparisonSourceVisit) => boolean
  readonly clearCsvComparisonSourceVisit: (visit: CsvComparisonSourceVisit) => void
  readonly returnFromCsvComparisonSource: (visit: CsvComparisonSourceVisit) => CsvSentQuestion | undefined
  readonly jumpInSourceTrail: (current: CsvComparisonSourceVisit, target: CsvComparisonSourceVisit) => CsvSentQuestion | undefined
  readonly sourceQuestionLabel: (target: CsvSentQuestion) => string | undefined
  readonly loadCsvHistorySourceChain: (
    origin: CsvSentQuestion, source: CsvSentQuestion | undefined, signal: AbortSignal,
  ) => Promise<CsvComparisonSourceChain>
  readonly visitCsvHistorySourceChain: (origin: CsvSentQuestion, sources: readonly CsvSentQuestion[]) => boolean
  readonly retryCsvSourceRecovery: (recovery: CsvComparisonSourceRecovery, open: (target: CsvSentQuestion, focus?: string) => void) => void
  readonly reviewSentCsvComparison: (
    target: CsvSentQuestion, page: ArtifactCsvComparisonPage, explanation?: CsvComparisonExplanation,
    returnCards?: ArtifactCsvComparisonReturnCards,
  ) => ReturnType<ReviewSentCsvComparison>
  readonly selectCsvExplanationStep: (target: CsvSentQuestion) => void
  readonly cancelCsvExplanation: () => void
  readonly confirmCsvExplanation: (target: CsvSentQuestion) => void
  readonly downloadSentCsvComparison: (
    target: CsvSentQuestion, format: CsvComparisonDownloadFormat,
  ) => ReturnType<DownloadSentCsvComparison>
}

/** Replay the exact comparison page stored on a sent question, retaining its original text. */
export function CsvComparisonContextMessage({
  node, raw, interactive, messageRef, t, returnToDraft, returnToComparison, returnToExplanation,
  reviewSent, downloadSent, downloadJson, viewSourceQuestion,
  closeSourceVisit, sourceTrail, jumpInSourceTrail, sourceQuestionLabel, sourceChain, sourceRecovery, retrySourceRecovery,
  explanationActions, openExplanationSource, openReturnedSource,
}:
  Pick<PropsRuntime<'conversation.user.text.node', 'artifact-csv-comparison-context'>, 'node' | 'raw' | 'interactive' | 'messageRef'>
  & PropsLocale<'artifact'> & CsvSentComparisonActions & {
    readonly jumpInSourceTrail?: ((target: CsvComparisonSourceVisit) => void) | undefined
    readonly sourceQuestionLabel?: ((target: CsvSentQuestion) => string | undefined) | undefined
    readonly sourceChain?: CsvSourceChainOptions | undefined
    readonly sourceRecovery?: CsvComparisonSourceRecovery | undefined
    readonly retrySourceRecovery?: (() => void) | undefined
    readonly explanationActions?: CsvExplanationActions | undefined
    readonly openExplanationSource?: OpenCsvExplanationSource | undefined
    readonly openReturnedSource?: ((side: CsvReturnComparisonSide) => void) | undefined
  }) {
  return <>
    <details className={css.context} data-artifact-question-context>
      <summary>{t('csvCompare.attachment')}</summary>
      <span className={css.label}>{t('questionContext.original')}</span>
      <pre className={css.raw} data-artifact-question-context-raw>{raw}</pre>
    </details>
    {interactive && messageRef !== undefined && <div className={css.replayAction}>
      <CsvAttachedComparison page={node.data.page} userImported={node.data.attribution === 'user-imported'}
        returnCards={node.data.returnCards}
        sideLabels={node.data.returnedPair ? csvReturnComparisonSideLabels(t) : undefined}
        openReturnedSource={openReturnedSource}
        explanation={node.data.explanation} explanationActions={explanationActions} openExplanationSource={openExplanationSource}
        returnToDraft={returnToDraft} returnToComparison={returnToComparison} returnToExplanation={returnToExplanation}
        reviewSent={reviewSent}
        downloadSent={downloadSent} downloadJson={downloadJson} viewSourceQuestion={viewSourceQuestion} closeSourceVisit={closeSourceVisit}
        sourceTrail={sourceTrail} jumpInSourceTrail={jumpInSourceTrail} sourceQuestionLabel={sourceQuestionLabel}
        sourceChain={sourceChain} sourceRecovery={sourceRecovery} retrySourceRecovery={retrySourceRecovery} t={t} />
    </div>}
  </>
}

/** Only the exact sent question selected by the composer can offer a return route. */
export function CsvComparisonContextNode({
  useReturnToCsvDraft, useCsvHistoryDraftPhase, useCsvComparisonSourceTrail, useCsvComparisonSourceRecovery,
  useCsvExplanationSelection, useSession, useAccess, returnToCsvDraft,
  selectCsvExplanationStep, cancelCsvExplanation, confirmCsvExplanation,
  visitCsvComparisonSource, clearCsvComparisonSourceVisit, returnFromCsvComparisonSource, reviewSentCsvComparison,
  downloadSentCsvComparison, messageRef,
  jumpInSourceTrail, sourceQuestionLabel, loadCsvHistorySourceChain, visitCsvHistorySourceChain, retryCsvSourceRecovery,
  sessionId, openView, ...props
}:
  PropsRuntime<'conversation.user.text.node', 'artifact-csv-comparison-context'> & PropsLocale<'artifact'>
  & InjectFace<CsvComparisonContextInjected>) {
  const showReturn = useReturnToCsvDraft(target => sameCsvSentQuestion(target, messageRef))
  const sourceTrail = useCsvComparisonSourceTrail(trail => sameCsvSentQuestion(trail?.at(-1)?.source, messageRef) ? trail : undefined)
  const recovery = useCsvComparisonSourceRecovery(value => sameCsvSentQuestion(value?.source, messageRef) ? value : undefined)
  const sourceVisit = sourceTrail?.at(-1)
  const explanationOrigin = sourceVisit?.origin.kind === 'explanation' ? sourceVisit.origin : undefined
  const canReview = useCsvHistoryDraftPhase(phase => phase === 'ready')
  const canReadDraft = useAccess('artifactBranchResults/readCsvComparisonDraft')
  const canPrompt = useAccess('session/prompt')
  const hostRoute = useSession(artifactHostRouteAvailable)
  const canReadHistory = useAccess('session/events')
  const canReviewSent = useAccess('artifactBranchResults/reviewSentCsvComparison')
  const canSaveDraft = useAccess('artifactBranchResults/saveCsvComparisonDraft')
  const canDownloadSent = useAccess('artifactBranchResults/exportSentCsvComparison')
  const canDownloadJson = useAccess('artifactBranchResults/exportSentCsvComparisonJson')
  const canReviewExplanation = useAccess('artifactBranchResults/reviewCsvComparisonExplanation')
  const choice = useCsvExplanationSelection(state => sameCsvSentQuestion(state?.first, messageRef)
    || state?.phase !== 'first' && sameCsvSentQuestion(state?.second, messageRef) ? state : undefined)
  const ownComparison = props.node.data.sessionId === sessionId
  const explanation = props.node.data.explanation
  const returnCards = props.node.data.returnCards
  const returnedPair = ownComparison ? props.node.data.returnedPair : undefined
  const single = explanation === undefined
  const canReuse = single || props.node.data.attribution === 'user-imported'
  const canAttach = hostRoute && canPrompt && canReadDraft && canSaveDraft && canReview && ownComparison
  const source = ownComparison ? props.node.data.reusedFrom : undefined
  const sourceKind = csvComparisonSourceKind(props.node.data)
  const recordedSource = source !== undefined || ownComparison && props.node.data.invalidReuseSource === true
  const earlierSource = source !== undefined && messageRef !== undefined && source.eventSeq < messageRef.eventSeq
    && source.messageId !== messageRef.messageId ? source : undefined
  const canOpenSource = ((single && sourceKind === undefined) || canReadHistory)
    && earlierSource !== undefined && messageRef !== undefined && openView !== undefined
  return <CsvComparisonContextMessage {...props} {...(messageRef === undefined ? {} : { messageRef })}
    returnToDraft={sourceVisit?.origin.kind === 'draft' ? () => { returnFromCsvComparisonSource(sourceVisit) }
      : showReturn && canReadDraft && canPrompt && messageRef !== undefined ? () => { returnToCsvDraft(messageRef) } : undefined}
    returnToComparison={sourceVisit?.origin.kind === 'comparison' && openView !== undefined ? () => {
      const origin = returnFromCsvComparisonSource(sourceVisit)
      if (origin !== undefined) openView('chat', csvSentQuestionFocus(origin))
    } : undefined}
    returnToExplanation={explanationOrigin !== undefined && sourceVisit !== undefined && ownComparison && canReadHistory
      && openView !== undefined ? () => {
        const origin = returnFromCsvComparisonSource(sourceVisit)
        if (origin !== undefined) openView('chat', csvSentQuestionFocus(origin, explanationOrigin.step))
      } : undefined}
    sourceTrail={sourceTrail} sourceQuestionLabel={sourceQuestionLabel}
    sourceRecovery={canReadHistory && ownComparison ? recovery : undefined}
    retrySourceRecovery={canReadHistory && ownComparison && recovery?.status === 'unavailable' && openView !== undefined ? () => {
      retryCsvSourceRecovery(recovery, (target, focus) => { openView('chat', focus ?? csvSentQuestionFocus(target)) })
    } : undefined}
    jumpInSourceTrail={sourceVisit !== undefined && openView !== undefined ? (target) => {
      const previous = jumpInSourceTrail(sourceVisit, target)
      const step = target.origin.kind === 'explanation' ? target.origin.step : undefined
      if (previous !== undefined) openView('chat', csvSentQuestionFocus(previous, step))
    } : undefined}
    closeSourceVisit={sourceVisit === undefined ? undefined : () => { clearCsvComparisonSourceVisit(sourceVisit) }}
    openReturnedSource={canReadHistory && returnedPair !== undefined && openView !== undefined && messageRef !== undefined ? (side) => {
      const { eventSeq, messageId } = returnedPair[side]
      const source = { eventSeq, messageId }
      if (visitCsvComparisonSource({ source, origin: { kind: 'returned-comparison', message: messageRef, side } })) {
        openView('chat', branchEvidenceFocus(source))
      }
    } : undefined}
    reviewSent={canReuse && canAttach && canReviewSent && messageRef !== undefined ? () => (
      returnCards !== undefined ? reviewSentCsvComparison(messageRef, props.node.data.page, undefined, returnCards)
        : explanation === undefined ? reviewSentCsvComparison(messageRef, props.node.data.page)
          : reviewSentCsvComparison(messageRef, props.node.data.page, explanation)
    ) : undefined}
    downloadSent={hostRoute && canDownloadSent && ownComparison && messageRef !== undefined
      ? () => downloadSentCsvComparison(messageRef, 'html') : undefined}
    downloadJson={hostRoute && canDownloadJson && ownComparison && messageRef !== undefined
      ? () => downloadSentCsvComparison(messageRef, 'json') : undefined}
    explanationActions={single && !props.node.data.returnedPair && props.node.data.attribution === undefined
      && canReviewExplanation && messageRef !== undefined
      && (canAttach || choice?.phase === 'saving' && ownComparison && hostRoute && canPrompt && canReadDraft && canSaveDraft) ? {
        target: messageRef, choice, select: () => { selectCsvExplanationStep(messageRef) }, cancel: cancelCsvExplanation,
        confirm: () => { confirmCsvExplanation(messageRef) },
      } : undefined}
    openExplanationSource={!single && props.node.data.attribution === undefined && ownComparison && canReadHistory
      && openView !== undefined && messageRef !== undefined
      && [props.node.data.explanation?.aggregation.message, props.node.data.explanation?.filtering].every(sourceRef =>
        sourceRef !== undefined && sourceRef.eventSeq < messageRef.eventSeq && sourceRef.messageId !== messageRef.messageId)
      ? (target, step) => {
        if (visitCsvComparisonSource({ source: target, origin: { kind: 'explanation', message: messageRef, step } })) {
          openView('chat', csvSentQuestionFocus(target))
        }
      } : undefined}
    sourceChain={canReuse && canReadHistory && recordedSource && messageRef !== undefined && openView !== undefined ? {
      load: signal => loadCsvHistorySourceChain(messageRef, source, signal),
      questionLabel: sourceQuestionLabel,
      captureOpen: () => (sources) => {
        const target = sources.at(-1)
        if (target !== undefined && visitCsvHistorySourceChain(messageRef, sources)) openView('chat', csvSentQuestionFocus(target))
      },
    } : undefined}
    viewSourceQuestion={canOpenSource ? () => {
      const visit = { source: earlierSource, origin: { kind: 'comparison', message: messageRef } } as const
      if (visitCsvComparisonSource(sourceKind === undefined ? visit : { ...visit, sourceKind })) {
        openView('chat', csvSentQuestionFocus(earlierSource))
      }
    } : undefined} />
}

type ProgramNode = PropsRuntime<'conversation.user.text.node', 'artifact-program-context'>

/** History lookup and read-only download for recorded HTML checkpoints. */
export interface ProgramContextInjected {
  readonly findCheckpointSource: (
    artifactId: string, revision: number, source: string, kind: ArtifactHtmlCheckpointKind, origin?: HtmlQuestionOrigin,
  ) =>
    HtmlArtifactSnapshot | undefined | Promise<HtmlArtifactSnapshot | undefined>
  readonly downloadSentExperiment: (kind: ArtifactHtmlCheckpointKind, message: NonNullable<ProgramNode['messageRef']>) => Promise<FileSaveResult>
  readonly hooks: {
    readonly sentExperimentExports: ObservableSnapshot<Readonly<Record<ArtifactHtmlCheckpointKind, boolean>>>
  }
}

/** Enable download on an owned, sent continuation of a returned HTML experiment. */
export function ProgramContextNode({
  node, raw, interactive, messageRef, sessionId, useSession, useAccess, useSentExperimentExports,
  findCheckpointSource, downloadSentExperiment, t,
}: ProgramNode & PropsLocale<'artifact'> & InjectFace<ProgramContextInjected>) {
  const hostRoute = useSession(artifactHostRouteAvailable)
  const downloadAccess = {
    'bfs-checkpoint': useAccess('artifactBranchResults/exportSentBfs'),
    'half-adder-checkpoint': useAccess('artifactBranchResults/exportSentHalfAdder'),
  }
  const { checkpoint } = node.data
  const kind = checkpoint?.state.kind
  const origin = checkpoint?.origin
  const available = useSentExperimentExports(exports => kind !== undefined && exports[kind])
  const download = interactive && hostRoute && kind !== undefined && downloadAccess[kind] && available && node.data.sessionId === sessionId
    && messageRef !== undefined && origin !== undefined && origin.eventSeq < messageRef.eventSeq
    ? () => downloadSentExperiment(kind, messageRef) : undefined
  return <ProgramContextMessage node={node} raw={raw} interactive={interactive}
    findCheckpointSource={findCheckpointSource} download={download} t={t} />
}

/** Present the original program report and offer an isolated, user-opened restore for an opt-in checkpoint. */
export function ProgramContextMessage({ node, raw, interactive, findCheckpointSource, download, t }:
  Pick<ProgramNode, 'node' | 'raw' | 'interactive'> & PropsLocale<'artifact'> & Partial<Pick<ProgramContextInjected, 'findCheckpointSource'>> & {
    readonly download?: (() => Promise<FileSaveResult>) | undefined
  }) {
  const { title, revision, status, checkpoint } = node.data
  const label = t(status === 'ready' ? 'questionContext.programReady' : 'questionContext.programError', {
    title, revision: String(revision),
  })
  return <>
    <details className={css.context} data-artifact-program-context
      data-artifact-program-context-origin={checkpoint?.origin === undefined ? undefined : `branch-${checkpoint.state.kind}`}>
      <summary>{label}</summary>
      <span className={css.label}>{t('questionContext.programOriginal')}</span>
      {checkpoint !== undefined && <HtmlCheckpointReadingsView state={checkpoint.state} t={t} />}
      <pre className={css.raw} data-artifact-question-context-raw>{raw}</pre>
    </details>
    {interactive && checkpoint !== undefined && findCheckpointSource !== undefined && <HtmlCheckpointReplay
      resolveSource={() => findCheckpointSource(
        checkpoint.artifactId, revision, checkpoint.source, checkpoint.state.kind, checkpoint.origin,
      )}
      state={checkpoint.state} title={label} t={t} />}
    {download !== undefined && <ExperimentDownload location="question" download={download} t={t} />}
  </>
}
