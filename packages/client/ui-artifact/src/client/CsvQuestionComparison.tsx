/** Comparison of a recorded CSV question and its original returned reading. */
import { useId, useRef, useState } from 'react'
import type { ArtifactBranchCsvQuestionComparisonValue } from '@agentrans/artifact-branch/types'
import type { ArtifactCsvComparisonAttachment, ArtifactCsvComparisonPage, ArtifactCsvComparisonReturnCards } from '@agentrans/artifact-followup/types'
import { csvComparisonChanges } from '@agentrans/artifact/runtime-values'
import { Button } from '@agentrans/client-ui-primitives'
import type { PropsLocale } from '@agentrans/client-ui-slots'
import type { FileSaveResult } from '@agentrans/client-ui-file-actions/client'
import { CsvGroupReading, csvGroupLabel } from './CsvBarChartView.tsx'
import { CsvImportedReturnCards } from './CsvImportedReturnCards.tsx'
import { CsvSourceChain, type CsvSourceChainOptions } from './CsvSourceChain.tsx'
import { CsvSourceRecoveryNotice } from './CsvSourceRecoveryNotice.tsx'
import {
  sameCsvSentQuestion, type CsvComparisonSourceTrail, type CsvComparisonSourceVisit, type CsvExplanationStep,
  type CsvReturnComparisonSide, type CsvSentQuestion,
} from './csv-comparison-draft.ts'
import type { CsvComparisonExplanation, CsvExplanationSelection } from './csv-comparison-explanation.ts'
import type { CsvComparisonSourceRecovery } from './csv-comparison-source-chain.ts'
import { HTML_DOWNLOAD_NOTICES } from './ExportControls.tsx'
import rowsCss from './BranchEvidenceMessage.module.css'
import css from './CsvQuestionComparison.module.css'

/** Request one Host-authorized page for a sent question. */
export type CsvComparisonLoader = (offset: number) => Promise<ArtifactBranchCsvQuestionComparisonValue>

export type ChooseCsvComparison = (attachment: ArtifactCsvComparisonAttachment) => Promise<boolean>

/** Snapshot the existing composer context before showing a historical comparison review. */
export type ReviewSentCsvComparison = () => {
  readonly replacesContext: boolean
  readonly confirm: () => Promise<boolean | 'unavailable'>
} | undefined

/** Review the exact signed page already displayed by the inquiry comparison. */
export type ReviewCsvComparisonAttachment = (attachment: ArtifactCsvComparisonAttachment) => ReturnType<ReviewSentCsvComparison>

/** Localized names for the earlier and later readings. */
export type CsvComparisonSideLabels = Readonly<Record<'original' | 'locked', string>>
export type OpenCsvReturnedSource = (side: CsvReturnComparisonSide) => void

/** Display the two chronological return readings without implying a new question. */
export function csvReturnComparisonSideLabels(t: PropsLocale<'artifact'>['t']): CsvComparisonSideLabels {
  return { original: t('branchEvidence.inquiryCompareEarlier'), locked: t('branchEvidence.inquiryCompareLater') }
}

/** Download the immutable attachment on one exact sent message. */
export type DownloadSentCsvComparison = () => Promise<FileSaveResult | 'unavailable'>
export type CsvComparisonDownloadFormat = 'html' | 'json'

const jsonDownloadNotices = {
  downloading: 'export.downloading', requested: 'csvCompare.jsonDownloadRequested',
  saved: 'csvCompare.jsonDownloadSaved', cancelled: 'csvCompare.jsonDownloadCancelled',
} as const

type DownloadStatus = keyof typeof HTML_DOWNLOAD_NOTICES | 'failed' | 'unavailable'

const rowStatuses = ['kept', 'excluded', 'added'] as const

/** Whether the Host proved that the two locked readings describe different groups. */
export function csvComparisonGroupMismatch(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'artifact-branch/csv-analysis-unavailable'
    && 'details' in error && typeof error.details === 'object' && error.details !== null
    && 'reason' in error.details && error.details.reason === 'GROUP_MISMATCH'
}

function CsvReturnedSourceButton({ side, open, describedBy, draft = false, t }: PropsLocale<'artifact'> & {
  readonly side: CsvReturnComparisonSide
  readonly open: OpenCsvReturnedSource
  readonly describedBy: string
  readonly draft?: boolean
}) {
  return <Button size="sm" variant="outline" className={css.toggle} data-csv-return-source={side}
    data-chat-message-control={draft ? undefined : `artifact-csv-return-${side}`} aria-describedby={describedBy}
    onClick={() => { open(side) }}>{t('csvCompare.viewOriginalReturn')}</Button>
}

function CsvDraftReturnSources({ open, t }: PropsLocale<'artifact'> & { readonly open: OpenCsvReturnedSource }) {
  const headingId = useId()
  const labels = csvReturnComparisonSideLabels(t)
  const sides = [['first', labels.original], ['second', labels.locked]] as const
  return <div className={css.draftReturnSources}>
    {sides.map(([side, label]) => <div key={side}>
      <span id={`${headingId}-${side}`}>{label}</span>
      <CsvReturnedSourceButton side={side} open={open} describedBy={`${headingId}-${side}`} draft t={t} />
    </div>)}
  </div>
}

/** Present the two saved readings and membership totals in review, composition, and replay. */
export function CsvComparisonReadings({
  summary, userImported = false, previousStep = false, sideLabels, openReturnedSource, t,
}: PropsLocale<'artifact'> & {
  readonly summary: ArtifactCsvComparisonPage
  readonly userImported?: boolean
  readonly previousStep?: boolean
  readonly sideLabels?: CsvComparisonSideLabels | undefined
  readonly openReturnedSource?: OpenCsvReturnedSource | undefined
}) {
  const headingId = useId()
  const readings = [['original', 'first', summary.original], ['locked', 'second', summary.current]] as const
  const changes = csvComparisonChanges(summary)
  return <>
    <div className={css.readings}>
      {readings.map(([side, returnSide, reading]) => <div key={side} data-csv-compare-reading={side}>
        <strong id={`${headingId}-${returnSide}`}>{sideLabels?.[side] ?? t(previousStep && side === 'original' ? 'csvCompare.explanationPriorReading'
          : userImported ? `csvCompare.imported.${side}` : `csvCompare.${side}`)}</strong>
        <CsvGroupReading group={{ key: reading.groupKey, value: reading.value, count: reading.count }}
          recipe={reading} showNoFilter t={t} />
        {openReturnedSource !== undefined && <div className={css.returnSource}>
          <CsvReturnedSourceButton side={returnSide} open={openReturnedSource} describedBy={`${headingId}-${returnSide}`} t={t} />
        </div>}
      </div>)}
    </div>
    {(changes.aggregation.changed || changes.filterChanged || changes.membership.changed) && <ul className={css.changes}>
      {changes.aggregation.changed && <li data-csv-comparison-method-changed>{t('csvCompare.methodChanged')}</li>}
      {changes.filterChanged && <li data-csv-comparison-filter-changed>{t('csvCompare.filterChanged')}</li>}
      {changes.membership.changed && <li data-csv-comparison-membership-changed>{t('csvCompare.membershipChanged')}</li>}
    </ul>}
    <dl className={css.counts}>{rowStatuses.map(status => <div key={status}>
      <dt>{t(`csvCompare.${status}`)}</dt><dd data-csv-compare-count={status}>{String(summary[status])}</dd>
    </div>)}</dl>
  </>
}

function CsvImportedAttribution({ explanation, returnCards, t }: PropsLocale<'artifact'> & {
  readonly explanation?: CsvComparisonExplanation | undefined
  readonly returnCards?: ArtifactCsvComparisonReturnCards | undefined
}) {
  const kind = explanation !== undefined ? 'two-step-explanation' : returnCards !== undefined ? 'return-comparison' : 'single-page'
  return <div className={css.importedAttribution}>
    <p data-csv-comparison-attribution="user-imported">{t('csvCompare.userImported')}</p>
    <p data-csv-import-source={kind}>{t(`csvCompare.importSource.${kind}`)}</p>
  </div>
}

export type OpenCsvExplanationSource = (target: CsvSentQuestion, step: CsvExplanationStep) => void

/** Present the resolved order, with the locked sum as the starting reading for the filter. */
function CsvExplanationSteps({ page, explanation, openSource, userImported = false, t }: PropsLocale<'artifact'> & {
  readonly page: ArtifactCsvComparisonPage
  readonly explanation: CsvComparisonExplanation
  readonly openSource?: OpenCsvExplanationSource | undefined
  readonly userImported?: boolean
}) {
  const aggregation = explanation.aggregation.comparison
  const steps = [
    { kind: 'aggregation', page: aggregation, saved: aggregation, source: explanation.aggregation.message },
    { kind: 'filtering', page: { ...page, original: aggregation.current }, saved: page, source: explanation.filtering },
  ] as const
  return <div className={css.explanationSteps}>{steps.map(step => <section key={step.kind} className={css.review}
    data-csv-explanation-step={step.kind} aria-label={t(`csvCompare.explanation.${step.kind}`)}>
    <strong>{t(`csvCompare.explanation.${step.kind}`)}</strong>
    <div className={css.explanationStepContent} data-csv-explanation-transition>
      <CsvComparisonReadings summary={step.page} previousStep={step.kind === 'filtering'} userImported={userImported} t={t} />
      {!userImported && <ComparisonRecords page={step.page} t={t} />}
    </div>
    {userImported && <details data-csv-explanation-original>
      <summary>{t('csvCompare.explanationOriginal')}</summary>
      <div className={css.explanationStepContent}>
        <CsvComparisonReadings summary={step.saved} userImported t={t} />
        <ComparisonRecords page={step.saved} t={t} />
      </div>
    </details>}
    {!userImported && openSource !== undefined && step.source !== undefined && <div>
      <Button size="sm" variant="outline" className={css.toggle} data-csv-explanation-source
        data-chat-message-control={`artifact-csv-explanation-${step.kind}`}
        onClick={() => { if (step.source !== undefined) openSource(step.source, step.kind) }}>{t('csvCompare.viewSourceQuestion')}</Button>
    </div>}
  </section>)}</div>
}

export interface CsvExplanationActions {
  readonly target: CsvSentQuestion
  readonly choice: CsvExplanationSelection | undefined
  readonly select: () => void
  readonly cancel: () => void
  readonly confirm: () => void
}

function CsvExplanationControls({ choice, target, select, cancel, confirm, t }: CsvExplanationActions & PropsLocale<'artifact'>) {
  const first = sameCsvSentQuestion(choice?.first, target)
  const second = choice?.phase !== 'first' && sameCsvSentQuestion(choice?.second, target)
  const saving = choice?.phase === 'saving'
  return <>
    <div><Button size="sm" variant="outline" className={css.toggle} data-csv-select-explanation-step
      aria-pressed={first || second} disabled={saving || second && choice?.phase === 'loading'}
      onClick={select}>{t('csvCompare.explanationSelect')}</Button></div>
    {first && choice?.phase === 'first' && <p role="status">{t('csvCompare.explanationSelectAnother')}</p>}
    {second && choice?.phase === 'loading' && <p role="status">{t('csvCompare.loading')}</p>}
    {second && choice?.phase === 'error' && <div className={rowsCss.csvAnalysisFailure}>
      <p role="alert">{t(`csvCompare.explanationError.${choice.failure}`)}</p>
      <Button size="sm" variant="ghost" onClick={cancel}>{t('promptContext.cancelReadings')}</Button>
    </div>}
    {second && (choice?.phase === 'review' || choice?.phase === 'saving') && <section className={css.review}
      data-csv-explanation-review aria-label={t('csvCompare.explanationReview')}>
      <strong>{t('csvCompare.explanationReview')}</strong>
      <CsvExplanationSteps page={choice.preview.page} explanation={choice.preview.explanation} t={t} />
      {choice.preview.replacesContext && <p>{t('csvCompare.replaceContext')}</p>}
      <div className={rowsCss.csvAnalysisFailure}>
        <Button size="sm" variant="primary" disabled={saving} data-csv-confirm-explanation
          onClick={confirm}>{t('csvCompare.explanationAttach')}</Button>
        <Button size="sm" variant="ghost" disabled={saving} onClick={cancel}>{t('promptContext.cancelReadings')}</Button>
      </div>
    </section>}
  </>
}

/** Show the received page of CSV records and their membership in both readings. */
export function ComparisonRecords({ page, t }: PropsLocale<'artifact'> & { readonly page: ArtifactCsvComparisonPage }) {
  const currentFilter = page.current.filter?.column
  const originalFilter = page.original.filter?.column === currentFilter ? undefined : page.original.filter?.column
  const valueColumn = page.current.valueColumn ?? page.original.valueColumn
  const cell = (value: string | undefined): string => value === undefined ? '—' : csvGroupLabel(value, t)
  return <>
    <p className={css.pageRange} aria-live="polite">{t('csvCompare.range', {
      first: String(page.rows.length === 0 ? 0 : page.offset + 1), last: String(page.offset + page.rows.length), total: String(page.total),
    })}</p>
    <table>
      <thead><tr>
        <th scope="col">{t('csvAnalysis.recordNumber')}</th>
        <th scope="col">{t('csvCompare.status')}</th>
        {originalFilter !== undefined && <th scope="col">{csvGroupLabel(originalFilter, t)}</th>}
        {currentFilter !== undefined && <th scope="col">{csvGroupLabel(currentFilter, t)}</th>}
        {valueColumn !== undefined && <th scope="col">{csvGroupLabel(valueColumn, t)}</th>}
      </tr></thead>
      <tbody>{page.rows.map(row => <tr key={row.record} data-csv-compare-record={row.record} data-csv-compare-status={row.status}>
        <th scope="row">{String(row.record)}</th>
        <td data-csv-compare-cell="status">{t(`csvCompare.${row.status}`)}</td>
        {originalFilter !== undefined && <td data-csv-compare-cell="original-filter">{cell(row.originalFilterValue)}</td>}
        {currentFilter !== undefined && <td data-csv-compare-cell="current-filter">{cell(row.currentFilterValue)}</td>}
        {valueColumn !== undefined && <td data-csv-compare-cell="value">{cell(row.value)}</td>}
      </tr>)}</tbody>
    </table>
  </>
}

/** Provide previous and next navigation without coupling either comparison to its data loader. */
export function CsvComparisonPagination({ page, history, loading, onLoad, t }: PropsLocale<'artifact'> & {
  readonly page: ArtifactCsvComparisonPage
  readonly history: readonly number[]
  readonly loading: boolean
  readonly onLoad: (offset: number, history: readonly number[]) => void
}) {
  const previousOffset = history.at(-1)
  const { nextOffset } = page
  if (nextOffset === undefined && previousOffset === undefined) return null
  return <div className={rowsCss.csvAnalysisFailure}>
    <Button size="sm" variant="outline" disabled={loading || previousOffset === undefined}
      onClick={() => { if (previousOffset !== undefined) onLoad(previousOffset, history.slice(0, -1)) }}>
      {t('csvAnalysis.previousPage')}
    </Button>
    <Button size="sm" variant="outline" disabled={loading || nextOffset === undefined}
      onClick={() => { if (nextOffset !== undefined) onLoad(nextOffset, [...history, page.offset]) }}>
      {t('csvAnalysis.nextPage')}
    </Button>
  </div>
}

export function CsvComparisonReviewContents({
  page, explanation, returnCards, replacesContext, userImported = false, sideLabels, t,
}: PropsLocale<'artifact'> & {
  readonly page: ArtifactCsvComparisonPage
  readonly explanation?: CsvComparisonExplanation | undefined
  readonly returnCards?: ArtifactCsvComparisonReturnCards | undefined
  readonly replacesContext: boolean
  readonly userImported?: boolean
  readonly sideLabels?: CsvComparisonSideLabels | undefined
}) {
  const labels = sideLabels ?? (returnCards === undefined ? undefined : csvReturnComparisonSideLabels(t))
  return <>
    <strong>{t('csvCompare.review')}</strong>
    {userImported && <CsvImportedAttribution explanation={explanation} returnCards={returnCards} t={t} />}
    {explanation === undefined ? <>
      <CsvComparisonReadings summary={page} userImported={userImported} sideLabels={labels} t={t} />
      <ComparisonRecords page={page} t={t} />
      {returnCards !== undefined && <CsvImportedReturnCards page={page} cards={returnCards} t={t} />}
    </> : <CsvExplanationSteps page={page} explanation={explanation} userImported={userImported} t={t} />}
    {replacesContext && <p>{t('csvCompare.replaceContext')}</p>}
  </>
}

/** Show a comparison page and, when allowed, review its immutable attachment. */
export function ComparisonPage({
  page, explanation, returnCards, openExplanationSource, attachment, onAttach, reviewSent, reviewAttachment, children,
  userImported = false, sideLabels, openReturnedSource, t,
}: PropsLocale<'artifact'> & {
  readonly page: ArtifactCsvComparisonPage
  readonly explanation?: CsvComparisonExplanation | undefined
  readonly returnCards?: ArtifactCsvComparisonReturnCards | undefined
  readonly openExplanationSource?: OpenCsvExplanationSource | undefined
  readonly attachment?: ArtifactCsvComparisonAttachment | undefined
  readonly onAttach?: ChooseCsvComparison | undefined
  readonly reviewSent?: ReviewSentCsvComparison | undefined
  readonly reviewAttachment?: ReviewCsvComparisonAttachment | undefined
  readonly children?: React.ReactNode
  readonly userImported?: boolean
  readonly sideLabels?: CsvComparisonSideLabels | undefined
  readonly openReturnedSource?: OpenCsvReturnedSource | undefined
}) {
  const [review, setReview] = useState<{
    readonly page: ArtifactCsvComparisonPage
    readonly explanation?: CsvComparisonExplanation | undefined
    readonly returnCards?: ArtifactCsvComparisonReturnCards | undefined
    readonly replacesContext: boolean
    readonly historical: boolean
    readonly confirm: () => Promise<boolean | 'unavailable'>
  }>()
  const [status, setStatus] = useState<'ready' | 'saving' | 'failed' | 'unavailable' | 'attached'>('ready')
  const reviewId = useId()
  const canReview = onAttach !== undefined || reviewSent !== undefined || reviewAttachment !== undefined
  const reuseLabel = returnCards !== undefined ? 'csvCompare.reuseEntireReturnComparison'
    : explanation !== undefined ? 'csvCompare.reuseEntireExplanation' : 'csvCompare.reuseSent'
  const beginReview = (): void => {
    if (reviewSent !== undefined) {
      const action = reviewSent()
      if (action === undefined) { setStatus('failed'); return }
      setReview({ page, explanation, returnCards, historical: true, ...action })
    } else if (attachment !== undefined && reviewAttachment !== undefined) {
      const action = reviewAttachment(attachment)
      if (action === undefined) { setStatus('failed'); return }
      setReview({ page: attachment.facts.comparison, historical: false, ...action })
    } else if (attachment !== undefined && onAttach !== undefined) {
      setReview({ page: attachment.facts.comparison, replacesContext: false, historical: false,
        confirm: async () => await onAttach(attachment) })
    }
    setStatus('ready')
  }
  const mayConfirm = review?.historical === true ? reviewSent !== undefined : onAttach !== undefined || reviewAttachment !== undefined
  const confirm = async (): Promise<void> => {
    if (review === undefined || !mayConfirm || status === 'saving' || status === 'unavailable') return
    setStatus('saving')
    try {
      const result = await review.confirm()
      if (result !== true) { setStatus(result === 'unavailable' ? 'unavailable' : 'failed'); return }
      setStatus('attached')
      setReview(undefined)
    } catch (_error) { setStatus('failed') }
  }
  return <>
    {review === undefined && <>
      {userImported && <CsvImportedAttribution explanation={explanation} returnCards={returnCards} t={t} />}
      {explanation === undefined ? <>
        <CsvComparisonReadings summary={page} userImported={userImported} sideLabels={sideLabels}
          openReturnedSource={returnCards === undefined ? openReturnedSource : undefined} t={t} />
        <ComparisonRecords page={page} t={t} />
        {returnCards !== undefined && <CsvImportedReturnCards page={page} cards={returnCards} t={t} />}
      </> : <CsvExplanationSteps page={page} explanation={explanation} openSource={openExplanationSource}
        userImported={userImported} t={t} />}
      {children}
      {canReview && (attachment === undefined && reviewSent === undefined
        ? <p>{t('csvCompare.attachUnavailable')}</p> : <div>
          <Button size="sm" variant="outline" className={css.toggle} aria-controls={reviewId} aria-expanded={false}
            data-csv-compare-attach={reviewSent === undefined || undefined}
            data-csv-compare-reuse={(reviewSent !== undefined && explanation === undefined && returnCards === undefined) || undefined}
            data-csv-reuse-entire-explanation={(reviewSent !== undefined && explanation !== undefined) || undefined}
            data-csv-reuse-entire-return-comparison={(reviewSent !== undefined && returnCards !== undefined) || undefined}
            onClick={beginReview}>{t(reviewSent === undefined ? 'csvCompare.attach' : reuseLabel)}</Button>
        </div>)}
      {status === 'failed' && <p role="alert">{t('csvCompare.attachFailed')}</p>}
      {status === 'attached' && <p role="status">{t('csvCompare.attached')}</p>}
    </>}
    <section id={reviewId} hidden={review === undefined} className={css.review} data-csv-compare-review aria-label={t('csvCompare.review')}>
      {review !== undefined && <>
        <CsvComparisonReviewContents page={review.page} explanation={review.explanation} returnCards={review.returnCards}
          replacesContext={review.replacesContext} userImported={userImported} sideLabels={sideLabels} t={t} />
        <div className={rowsCss.csvAnalysisFailure}>
          <Button size="sm" variant="primary" data-csv-compare-confirm autoFocus
            disabled={status === 'saving' || status === 'unavailable' || !mayConfirm}
            aria-busy={status === 'saving'} onClick={() => { void confirm() }}>{t('csvCompare.confirm')}</Button>
          <Button size="sm" variant="ghost" disabled={status === 'saving'}
            onClick={() => { setReview(undefined); setStatus('ready') }}>{t('promptContext.cancelReadings')}</Button>
        </div>
        {status === 'failed' && <p role="alert">{t('csvCompare.attachFailed')}</p>}
        {status === 'unavailable' && <p role="alert">{t(review.historical ? 'csvCompare.sentReuseUnavailable' : 'csvCompare.attachUnavailable')}</p>}
      </>}
    </section>
  </>
}

/** Open the comparison on demand and keep the saved question replay independent of any source failure. */
export function CsvQuestionComparison({ loadPage, onAttach, t }: PropsLocale<'artifact'> & {
  readonly loadPage: CsvComparisonLoader
  readonly onAttach?: ChooseCsvComparison | undefined
}) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<ArtifactBranchCsvQuestionComparisonValue>()
  const [attempted, setAttempted] = useState<{ readonly offset: number; readonly history: readonly number[] }>({ offset: 0, history: [] })
  const [history, setHistory] = useState<readonly number[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed' | 'group-mismatch'>('idle')
  const panelId = useId()

  const load = async (offset: number, nextHistory: readonly number[]): Promise<void> => {
    setAttempted({ offset, history: nextHistory })
    setStatus('loading')
    try {
      const next = await loadPage(offset)
      setPage(next)
      setHistory(nextHistory)
      setStatus('ready')
    } catch (error) {
      setStatus(csvComparisonGroupMismatch(error) ? 'group-mismatch' : 'failed')
    }
  }

  return <div className={rowsCss.csvParticipants}>
    <Button size="sm" variant="outline" className={css.toggle} data-csv-compare-open aria-controls={panelId} aria-expanded={open}
      onClick={() => { setOpen(!open); if (!open && status === 'idle') void load(0, []) }}>
      {t('csvCompare.open')}
    </Button>
    <section id={panelId} hidden={!open} className={css.panel} data-csv-compare aria-label={t('csvCompare.open')}>
      {open && <>
        {status === 'loading' && <p role="status">{t('csvCompare.loading')}</p>}
        {status === 'group-mismatch' && <p role="status">{t('csvCompare.groupMismatch')}</p>}
        {status === 'failed' && <div className={rowsCss.csvAnalysisFailure}>
          <p role="alert">{t('csvCompare.failed')}</p>
          <Button size="sm" variant="outline" onClick={() => { void load(attempted.offset, attempted.history) }}>{t('csvAnalysis.retry')}</Button>
        </div>}
        {page !== undefined && status !== 'group-mismatch' && <ComparisonPage page={page}
          attachment={status === 'ready' ? page.attachment : undefined} onAttach={status === 'ready' ? onAttach : undefined} t={t}>
          <CsvComparisonPagination page={page} history={history} loading={status === 'loading'} t={t}
            onLoad={(offset, pageHistory) => { void load(offset, pageHistory) }} />
        </ComparisonPage>}
      </>}
    </section>
  </div>
}

/** Navigation and download actions a CSV comparison page offers once it has been sent. */
export interface CsvSentComparisonActions {
  readonly returnToDraft?: (() => void) | undefined
  readonly returnToComparison?: (() => void) | undefined
  readonly returnToExplanation?: (() => void) | undefined
  readonly reviewSent?: ReviewSentCsvComparison | undefined
  readonly downloadSent?: DownloadSentCsvComparison | undefined
  readonly downloadJson?: DownloadSentCsvComparison | undefined
  readonly viewSourceQuestion?: (() => void) | undefined
  readonly closeSourceVisit?: (() => void) | undefined
  readonly sourceTrail?: CsvComparisonSourceTrail | undefined
}

interface CsvSourcePathActions {
  readonly jumpInSourceTrail?: ((target: CsvComparisonSourceVisit) => void) | undefined
  readonly sourceQuestionLabel?: ((target: CsvSentQuestion) => string | undefined) | undefined
}

function CsvComparisonSourcePath({
  sourceTrail, jumpInSourceTrail, sourceQuestionLabel, t,
}: PropsLocale<'artifact'> & CsvSourcePathActions & { readonly sourceTrail: CsvComparisonSourceTrail }) {
  const current = sourceTrail.at(-1)?.source
  if (current === undefined) return null
  const questionLabel = (target: CsvSentQuestion): string =>
    sourceQuestionLabel?.(target) ?? t('csvCompare.sourceTrailQuestion', { sequence: String(target.eventSeq) })
  return <nav className={css.sourceTrail} aria-label={t('csvCompare.sourceTrail')} data-csv-source-trail>
    <ol role="list">
      {sourceTrail.map((visit) => {
        const previous = visit.origin.kind === 'draft' ? undefined : visit.origin.message
        const label = previous === undefined ? t('csvCompare.sourceTrailDraft') : questionLabel(previous)
        return <li key={visit.source.messageId} data-csv-source-trail-stop={previous === undefined ? 'draft' : 'question'}
          data-csv-source-event-seq={previous?.eventSeq} data-csv-source-message-id={previous?.messageId}>
          {jumpInSourceTrail === undefined ? <span>{label}</span> : <Button size="sm" variant="ghost" className={css.sourceTrailStop}
            onClick={() => { jumpInSourceTrail(visit) }}>{label}</Button>}
          <span className={css.sourceTrailSeparator} aria-hidden="true">›</span>
        </li>
      })}
      <li aria-current="location" data-csv-source-trail-stop="question"
        data-csv-source-event-seq={current.eventSeq} data-csv-source-message-id={current.messageId}>
        <span>{questionLabel(current)}</span>
      </li>
    </ol>
  </nav>
}

/** Replay the saved page locally and let owners explicitly download it. */
export function CsvAttachedComparison({
  page, draft = false, userImported = false, returnCards, returnToDraft, returnToComparison, returnToExplanation, reviewSent,
  downloadSent, downloadJson,
  viewSourceQuestion, closeSourceVisit, explanation, explanationActions, openExplanationSource, sideLabels, openReturnedSource, t,
  sourceTrail, jumpInSourceTrail, sourceQuestionLabel, sourceChain, sourceRecovery, retrySourceRecovery,
}: PropsLocale<'artifact'> & CsvSourcePathActions & CsvSentComparisonActions & {
  readonly page: ArtifactCsvComparisonPage
  readonly draft?: boolean
  readonly userImported?: boolean
  readonly returnCards?: ArtifactCsvComparisonReturnCards | undefined
  readonly sideLabels?: CsvComparisonSideLabels | undefined
  readonly openReturnedSource?: OpenCsvReturnedSource | undefined
  readonly explanation?: CsvComparisonExplanation | undefined
  readonly explanationActions?: CsvExplanationActions | undefined
  readonly openExplanationSource?: OpenCsvExplanationSource | undefined
  readonly sourceChain?: CsvSourceChainOptions | undefined
  readonly sourceRecovery?: CsvComparisonSourceRecovery | undefined
  readonly retrySourceRecovery?: (() => void) | undefined
}) {
  const [open, setOpen] = useState(false)
  const [downloadState, setDownloadState] = useState<{ format: CsvComparisonDownloadFormat; status: DownloadStatus }>()
  const downloading = useRef(false)
  const panelId = useId()
  const label = t(draft ? 'csvCompare.reviewDraft' : 'csvCompare.replay')
  const downloadStatus = downloadState?.status
  const downloadFailed = downloadStatus === 'failed' || downloadStatus === 'unavailable'
  const notices = downloadState?.format === 'json' ? jsonDownloadNotices : HTML_DOWNLOAD_NOTICES
  const download = async (format: CsvComparisonDownloadFormat): Promise<void> => {
    const action = format === 'html' ? downloadSent : downloadJson
    if (action === undefined || downloading.current || downloadStatus === 'unavailable') return
    downloading.current = true
    setDownloadState({ format, status: 'downloading' })
    try {
      const result = await action()
      setDownloadState({ format, status: result === 'unavailable' ? result : result.status })
    } catch {
      setDownloadState({ format, status: 'failed' })
    } finally { downloading.current = false }
  }
  return <div className={rowsCss.csvParticipants} data-csv-compare-attached={!draft || undefined}
    data-csv-compare-draft-page={draft || undefined}>
    {userImported && (draft || !open) && <CsvImportedAttribution explanation={explanation} returnCards={returnCards} t={t} />}
    <div className={rowsCss.csvAnalysisFailure}>
      <Button size="sm" variant="outline" className={css.toggle} aria-controls={panelId} aria-expanded={open}
        data-chat-message-control={draft ? undefined : 'artifact-csv-comparison'}
        onClick={() => {
          if (open) closeSourceVisit?.()
          setOpen(!open)
        }}>{label}</Button>
      {!draft && open && returnToDraft !== undefined && <Button size="sm" variant="ghost" className={css.toggle}
        data-csv-return-to-draft onClick={returnToDraft}>{t('csvCompare.returnToDraft')}</Button>}
      {!draft && open && returnToComparison !== undefined && <Button size="sm" variant="ghost" className={css.toggle}
        data-csv-return-to-comparison onClick={returnToComparison}>{t('csvCompare.returnToComparison')}</Button>}
      {!draft && open && returnToExplanation !== undefined && <Button size="sm" variant="ghost" className={css.toggle}
        data-csv-return-to-explanation onClick={returnToExplanation}>{t('csvCompare.returnToExplanation')}</Button>}
      {(draft || open) && viewSourceQuestion !== undefined && <Button size="sm" variant="ghost" className={css.toggle}
        data-csv-view-source-question onClick={viewSourceQuestion}>{t('csvCompare.viewSourceQuestion')}</Button>}
      {(draft || open) && sourceChain !== undefined && <CsvSourceChain {...sourceChain} t={t} />}
    </div>
    <section id={panelId} hidden={!open} className={css.panel} data-csv-compare aria-label={label}>
      {!draft && open && sourceTrail !== undefined && <CsvComparisonSourcePath sourceTrail={sourceTrail}
        jumpInSourceTrail={jumpInSourceTrail} sourceQuestionLabel={sourceQuestionLabel} t={t} />}
      {!draft && open && sourceRecovery !== undefined && <CsvSourceRecoveryNotice
        recovery={sourceRecovery} retry={retrySourceRecovery} t={t} />}
      {open && (draft ? (explanation === undefined ? <>
        {returnCards === undefined && openReturnedSource !== undefined && <CsvDraftReturnSources open={openReturnedSource} t={t} />}
        <ComparisonRecords page={page} t={t} />
        {returnCards !== undefined && <CsvImportedReturnCards page={page} cards={returnCards} t={t} />}
      </>
        : <CsvExplanationSteps page={page} explanation={explanation} openSource={openExplanationSource}
          userImported={userImported} t={t} />)
        : <ComparisonPage page={page} explanation={explanation} returnCards={returnCards} openExplanationSource={openExplanationSource}
          reviewSent={reviewSent} userImported={userImported}
          sideLabels={sideLabels ?? (returnCards === undefined ? undefined : csvReturnComparisonSideLabels(t))}
          openReturnedSource={openReturnedSource} t={t} />)}
      {open && !draft && explanationActions !== undefined && <CsvExplanationControls {...explanationActions} t={t} />}
      {!draft && open && (downloadSent !== undefined || downloadJson !== undefined) && <div className={rowsCss.csvAnalysisFailure}>
        {downloadSent !== undefined && <Button size="sm" variant="outline" className={css.toggle} data-csv-download-comparison
          disabled={downloadStatus === 'downloading' || downloadStatus === 'unavailable'}
          aria-busy={downloadStatus === 'downloading' && downloadState?.format === 'html'}
          onClick={() => { void download('html') }}>
          {t(explanation === undefined ? 'csvCompare.downloadSent' : 'csvCompare.downloadExplanation')}
        </Button>}
        {downloadJson !== undefined && <Button size="sm" variant="outline" className={css.toggle} data-csv-download-comparison-json
          disabled={downloadStatus === 'downloading' || downloadStatus === 'unavailable'}
          aria-busy={downloadStatus === 'downloading' && downloadState?.format === 'json'}
          onClick={() => { void download('json') }}>
          {t(explanation === undefined ? 'csvCompare.downloadJson' : 'csvCompare.downloadExplanationJson')}
        </Button>}
        <p className={css.downloadStatus} role="status" data-csv-download-comparison-status={downloadFailed ? undefined : downloadStatus}>
          {downloadStatus !== undefined && !downloadFailed && t(notices[downloadStatus])}
        </p>
        {downloadFailed && <p className={css.downloadStatus} role="alert" data-csv-download-comparison-status={downloadStatus}>
          {t(downloadStatus === 'unavailable' ? 'csvCompare.downloadUnavailable' : 'csvCompare.downloadFailed')}
        </p>}
      </div>}
    </section>
  </div>
}
