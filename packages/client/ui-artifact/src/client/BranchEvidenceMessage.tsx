/** Parent-side display of a returned conclusion and its recorded experiment readings. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@agentrans/client-ui-slots'
import { Button } from '@agentrans/client-ui-primitives'
import type { UserTextInput } from '@agentrans/client-ui-conversation/client'
import type { FileSaveResult } from '@agentrans/client-ui-file-actions/client'
import { useEffect, useRef, useState } from 'react'
import type { ObservableSnapshot } from '@agentrans/client-store'
import type { SessionId } from '@agentrans/session/types'
import type { ArtifactBranchContinuePlotRequestId, ArtifactBranchCsvRowsValue } from '@agentrans/artifact-branch/types'
import type { ArtifactHtmlCheckpoint, ArtifactHtmlCheckpointKind } from '@agentrans/artifact/runtime-values'
import type { HtmlArtifactSnapshot } from '@agentrans/artifact/types'
import { randomUUID } from '@agentrans/util-crypto'
import { ArtifactReplayDisclosure, type CsvReplayReturn } from './ArtifactQuestionReplay.tsx'
import { ExperimentDownload } from './ExperimentDownload.tsx'
import { csvGroupLabel, CsvGroupReading } from './CsvBarChartView.tsx'
import { CsvAnalysisContinuation, type CsvAnalysisCommands } from './CsvAnalysisContinuation.tsx'
import type { CsvRowsLoader } from './CsvParticipatingRows.tsx'
import { HtmlCheckpointReadingsView } from './HtmlCheckpointReadings.tsx'
import { HtmlCheckpointReplay } from './HtmlCheckpointReplay.tsx'
import { artifactHostRouteAvailable } from './artifact-route.ts'
import type { BranchEvidenceNotice } from './branch-evidence-text.ts'
import type { BranchEvidenceReference } from './particle-runtime-owner.ts'
import type { ArtifactQuestionReplay } from './question-context-text.ts'
import { sameCsvSentQuestion, type CsvComparisonSourceTrail } from './csv-comparison-draft.ts'
import css from './BranchEvidenceMessage.module.css'
import contextCss from './QuestionContextMessage.module.css'

type ExperimentKind = ArtifactQuestionReplay['state']['kind']
export type ReturnedExperimentExportKind = 'function-plot' | 'particle-system' | ArtifactHtmlCheckpointKind

/** Focus control for a returned inquiry reading. */
export const BRANCH_RESULT_REPLAY_CONTROL = 'artifact-branch-result'

/** Focus and open the existing replay for the addressed returned evidence. */
export function branchEvidenceFocus(target: BranchEvidenceReference): string {
  return JSON.stringify({ kind: 'message', eventSeq: target.eventSeq, messageId: target.messageId, control: BRANCH_RESULT_REPLAY_CONTROL })
}

/** Whether a returned question supports direct replay from its inquiry entry. */
export function supportsInquiryReplay(item: BranchEvidenceNotice['items'][number]): boolean {
  return item.role === 'question'
}

/** Composer selection for one immutable native evidence message. */
export interface BranchEvidenceFollowupInjected {
  readonly chooseBranchEvidence: (ref: BranchEvidenceReference, replay: ArtifactQuestionReplay) => void
  readonly chooseBranchHtml: (ref: BranchEvidenceReference, artifact: HtmlArtifactSnapshot, state: ArtifactHtmlCheckpoint) => boolean
  readonly csvAnalysis: (ref: BranchEvidenceReference) => CsvAnalysisCommands
  readonly readReturnedCsvRows: (ref: BranchEvidenceReference, offset: number) => Promise<ArtifactBranchCsvRowsValue>
  readonly downloadReturnedExperiment: (kind: ReturnedExperimentExportKind, ref: BranchEvidenceReference) => Promise<FileSaveResult>
  readonly hooks: {
    readonly continuationAvailable: ObservableSnapshot<boolean>
    readonly returnedExperimentExports: ObservableSnapshot<Readonly<Record<ReturnedExperimentExportKind, boolean>>>
    readonly csvReturnedComparisonSource: ObservableSnapshot<CsvComparisonSourceTrail | undefined>
  }
  readonly returnToCsvOrigin: (source: BranchEvidenceReference, openView: NonNullable<UserTextInput['openView']>) => void
  readonly continueExperiment: (
    kind: ExperimentKind, ref: BranchEvidenceReference, requestId: ArtifactBranchContinuePlotRequestId,
  ) => Promise<SessionId>
  readonly openExperimentBranch: (sessionId: SessionId) => void
}

interface ContinueExperiment {
  readonly start: (requestId: ArtifactBranchContinuePlotRequestId) => Promise<SessionId>
  readonly open: (sessionId: SessionId) => void
}

function ContinueExperimentButton({ continuation, t }: { readonly continuation: ContinueExperiment } & PropsLocale<'artifact'>) {
  const [phase, setPhase] = useState<'idle' | 'opening' | 'failed'>('idle')
  const request = useRef<ArtifactBranchContinuePlotRequestId | undefined>(undefined)
  const busy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const open = async (): Promise<void> => {
    if (busy.current) return
    const requestId = request.current ??= randomUUID() as ArtifactBranchContinuePlotRequestId
    busy.current = true
    setPhase('opening')
    try {
      const sessionId = await continuation.start(requestId)
      if (mounted.current) {
        continuation.open(sessionId)
        request.current = undefined
        setPhase('idle')
      }
    } catch (_error) {
      if (mounted.current) setPhase('failed')
    } finally { busy.current = false }
  }

  return <div className={contextCss.replayAction}>
    <Button size="sm" variant="outline" data-artifact-branch-continue
      disabled={phase === 'opening'} aria-busy={phase === 'opening'} onClick={() => { void open() }}>
      {t(phase === 'opening' ? 'branchEvidence.continueOpening' : 'branchEvidence.continueExperiment')}
    </Button>
    {phase === 'failed' && <p role="alert">{t('branchEvidence.continueFailed')}</p>}
  </div>
}

/**
 * Render the exact conclusion and the evidence selected in the child branch.
 * @param props - Parsed evidence and localized display labels.
 * @returns A visible conclusion with independent replay controls and the original evidence disclosure.
 */
export function BranchEvidenceMessage({
  matched, messageRef, openInquirySource, returnToOrigin, onFollowup, onHtmlFollowup, continuation, csvAnalysis, readCsvRows,
  downloadExperiment, t,
}:
  {
    readonly matched: BranchEvidenceNotice
    readonly messageRef?: BranchEvidenceReference
    readonly openInquirySource?: (() => void) | undefined
    readonly returnToOrigin?: CsvReplayReturn | undefined
    readonly onFollowup?: (replay: ArtifactQuestionReplay) => void
    readonly onHtmlFollowup?: (artifact: HtmlArtifactSnapshot, state: ArtifactHtmlCheckpoint) => boolean
    readonly continuation?: ContinueExperiment
    readonly csvAnalysis?: CsvAnalysisCommands
    readonly readCsvRows?: CsvRowsLoader | undefined
    readonly downloadExperiment?: (() => Promise<FileSaveResult>) | undefined
  } & PropsLocale<'artifact'>) {
  return <section className={css.root} aria-label={t('branchEvidence.returned')} data-artifact-branch-evidence
    data-chat-message-seq={messageRef?.eventSeq} data-chat-message-id={messageRef?.messageId}>
    <h4 className={css.heading}>{t('branchEvidence.returned')}</h4>
    {matched.conclusion.map((text, index) => <p key={index} className={css.conclusion}>{text}</p>)}
    {openInquirySource !== undefined && <div className={contextCss.replayAction}>
      <Button size="sm" variant="outline" data-inquiry-source onClick={openInquirySource}>{t('branchEvidence.inquirySource')}</Button>
    </div>}
    <div className={css.items}>
      {matched.items.map((item) => {
        const messageControl = supportsInquiryReplay(item) ? BRANCH_RESULT_REPLAY_CONTROL : undefined
        if ('html' in item) {
          const { artifact, state } = item.html
          const title = t('questionContext.programReady', { title: artifact.title, revision: String(artifact.revision) })
          return <div key={item.role} className={css.item} data-artifact-branch-evidence-item={item.role}>
            <strong>{title}</strong>
            <HtmlCheckpointReadingsView state={state} t={t} />
            <HtmlCheckpointReplay resolveSource={() => artifact} state={state} title={title} messageControl={messageControl} t={t}
              attach={onHtmlFollowup === undefined ? undefined : checkpoint => onHtmlFollowup(artifact, checkpoint)} />
            {downloadExperiment !== undefined && <ExperimentDownload location="branch" download={downloadExperiment} t={t} />}
          </div>
        }
        const { role, replay } = item
        const { artifact, state } = replay
        const originalCsv = role === 'question' && state.kind === 'csv-bar-chart' && artifact.spec.kind === 'csv-bar-chart'
          && artifact.csvContinuation === undefined ? artifact.spec : undefined
        const source = { title: artifact.title, revision: String(artifact.revision) }
        const label = state.kind === 'csv-bar-chart' ? t('csvChart.context', { ...source, group: csvGroupLabel(state.group.key, t) })
          : state.kind === 'function-plot' ? t('questionContext.plot', { ...source, x: String(state.x) })
            : 'label' in item ? t('branchEvidence.option', { ...source, label: item.label, step: String(state.checkpoint.stepCount) })
              : t('questionContext.single', { ...source, step: String(state.checkpoint.stepCount) })
        return <div key={role} className={css.item} data-artifact-branch-evidence-item={role}>
          {(role === 'control' || role === 'variant')
            && <div>{t(role === 'control' ? 'branchEvidence.control' : 'branchEvidence.variant')}</div>}
          <strong>{label}</strong>
          {state.kind === 'csv-bar-chart' && artifact.spec.kind === 'csv-bar-chart'
            && <CsvGroupReading group={state.group} recipe={artifact.spec} t={t} />}
          <ArtifactReplayDisclosure snapshot={artifact} replay={state} t={t} messageControl={messageControl}
            returnToOrigin={role === 'question' && state.kind === 'csv-bar-chart' ? returnToOrigin : undefined}
            readCsvRows={originalCsv === undefined ? undefined : readCsvRows} />
          {role === 'question' && (state.kind === 'function-plot' || state.kind === 'particle-system') && state.kind === artifact.spec.kind
            && downloadExperiment !== undefined && <ExperimentDownload location="branch" download={downloadExperiment} t={t} />}
          {role === 'question' && onFollowup !== undefined && (
            <div className={contextCss.replayAction}>
              <Button size="sm" variant="outline" data-artifact-branch-followup onClick={() => { onFollowup(replay) }}>
                {t('branchEvidence.followup')}
              </Button>
            </div>
          )}
          {role === 'question' && continuation !== undefined && (state.kind === 'particle-system'
            || artifact.spec.kind === 'function-plot' && Object.values(artifact.spec.parameters).some(({ min, max }) => min < max))
            && <ContinueExperimentButton continuation={continuation} t={t} />}
          {originalCsv !== undefined && state.kind === 'csv-bar-chart' && csvAnalysis !== undefined
            && <div className={contextCss.replayAction}>
              <CsvAnalysisContinuation source={originalCsv} groupKey={state.group.key} commands={csvAnalysis} t={t} />
            </div>}
        </div>
      })}
    </div>
    <details className={contextCss.context}>
      <summary>{t('questionContext.original')}</summary>
      <pre className={contextCss.raw} data-artifact-branch-evidence-raw>{matched.raw}</pre>
    </details>
  </section>
}

/**
 * Render the parent-local Chat node for a returned experiment.
 * @param props - The durable evidence notice and locale seat.
 * @returns A conclusion with its experiment controls.
 */
export function BranchEvidenceNodeView({
  node, sessionId, useSession, useSessions, useAccess, openView, chooseBranchEvidence, chooseBranchHtml,
  csvAnalysis, readReturnedCsvRows, downloadReturnedExperiment, useContinuationAvailable, useReturnedExperimentExports,
  continueExperiment, openExperimentBranch,
  useCsvReturnedComparisonSource, returnToCsvOrigin, t,
}:
  Pick<PropsRuntime<'conversation.chat.node', 'artifact-branch-evidence'>, 'node' | 'sessionId' | 'useSession' | 'useSessions' | 'useAccess' | 'openView'>
  & PropsLocale<'artifact'> & InjectFace<BranchEvidenceFollowupInjected>) {
  const hostRoute = useSession(artifactHostRouteAvailable)
  const canPrompt = useAccess('session/prompt')
  const canContinuePlot = useAccess('artifactBranchResults/continuePlot')
  const canContinueParticle = useAccess('artifactBranchResults/continueParticle')
  const canRecalculateCsv = useAccess('artifactBranchResults/recalculateCsv')
  const canLockCsv = useAccess('artifactBranchResults/lockCsv')
  const canCsvFilterOptions = useAccess('artifactBranchResults/csvFilterOptions')
  const canCsvRows = useAccess('artifactBranchResults/csvParticipatingRows')
  const canReadReturnedCsvRows = useAccess('artifactBranchResults/csvReturnedParticipatingRows')
  const downloadAccess = {
    'function-plot': useAccess('artifactBranchResults/exportReturnedPlot'),
    'particle-system': useAccess('artifactBranchResults/exportReturnedParticle'),
    'bfs-checkpoint': useAccess('artifactBranchResults/exportReturnedBfs'),
    'half-adder-checkpoint': useAccess('artifactBranchResults/exportReturnedHalfAdder'),
  }
  const branchParent = useSessions(state => state.byId[node.data.branchSessionId]?.parentId)
  const inquiry = useSessions((state) => {
    const branch = state.byId[node.data.branchSessionId]
    return branch?.parentId === sessionId ? branch.inquiry : undefined
  })
  const continuationAvailable = useContinuationAvailable(available => available)
  const question = node.data.items.find(item => item.role === 'question')
  const kind = question !== undefined && 'replay' in question ? question.replay.state.kind : undefined
  const exportKind = question !== undefined && 'html' in question ? question.html.state.kind
    : kind === 'function-plot' || kind === 'particle-system' ? kind : undefined
  const exportAvailable = useReturnedExperimentExports(available => exportKind !== undefined && available[exportKind])
  const canContinue = kind === 'particle-system' ? canContinueParticle : canContinuePlot
  const ref = { eventSeq: node.anchorSeq, messageId: node.data.messageId }
  const originKind = useCsvReturnedComparisonSource((trail) => {
    const visit = trail?.at(-1)
    if (visit === undefined || !sameCsvSentQuestion(visit.source, ref)) return undefined
    if (visit.origin.kind === 'returned-comparison') return 'comparison'
    if (visit.origin.kind === 'draft' && visit.origin.returnSide !== undefined) return 'draft'
    return undefined
  })
  const returnToOrigin: CsvReplayReturn | undefined = originKind !== undefined && openView !== undefined
    ? { kind: originKind, open: () => { returnToCsvOrigin(ref, openView) } } : undefined
  const readCsvRows: CsvRowsLoader | undefined = hostRoute && canReadReturnedCsvRows && kind === 'csv-bar-chart'
    ? offset => readReturnedCsvRows(ref, offset) : undefined
  const downloadExperiment = hostRoute && exportKind !== undefined && downloadAccess[exportKind] && exportAvailable
    && (branchParent === undefined || branchParent === sessionId)
    ? () => downloadReturnedExperiment(exportKind, ref) : undefined
  const openInquirySource = inquiry !== undefined && openView !== undefined
    ? () => { openView('chat', JSON.stringify({ ...inquiry, kind: 'inquiry', eventSeq: inquiry.messageSeq })) } : undefined
  return <BranchEvidenceMessage matched={node.data} messageRef={ref} t={t} readCsvRows={readCsvRows}
    openInquirySource={openInquirySource} returnToOrigin={returnToOrigin} downloadExperiment={downloadExperiment}
    {...(hostRoute && canPrompt ? {
      onFollowup: (replay: ArtifactQuestionReplay) => {
        chooseBranchEvidence(ref, replay)
      },
      onHtmlFollowup: (artifact: HtmlArtifactSnapshot, state: ArtifactHtmlCheckpoint) => chooseBranchHtml(ref, artifact, state),
      ...(kind === 'csv-bar-chart' && canRecalculateCsv && canLockCsv && canCsvFilterOptions && canCsvRows && continuationAvailable
        ? { csvAnalysis: csvAnalysis(ref) } : {}),
    } : {})}
    {...((kind === 'function-plot' || kind === 'particle-system') && hostRoute && canContinue && continuationAvailable ? {
      continuation: { start: requestId => continueExperiment(kind, ref, requestId), open: openExperimentBranch },
    } : {})} />
}
