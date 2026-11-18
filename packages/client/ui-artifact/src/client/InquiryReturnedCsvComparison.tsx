/** Read-only comparison of two exact CSV returns from one inquiry branch. */
import { useEffect, useRef, useState } from 'react'
import type { ArtifactBranchCsvReturnedComparisonValue } from '@agentrans/artifact-branch/types'
import type { ArtifactCsvComparisonAttachment } from '@agentrans/artifact-followup/types'
import { Button, Modal } from '@agentrans/client-ui-primitives'
import type { PropsLocale } from '@agentrans/client-ui-slots'
import type { MessageId } from '@agentrans/llm/brand'
import type { SessionId } from '@agentrans/session/types'
import { deepEqualJson } from '@agentrans/util-values'
import {
  ComparisonPage, CsvComparisonPagination, csvComparisonGroupMismatch, csvReturnComparisonSideLabels, type ReviewCsvComparisonAttachment,
} from './CsvQuestionComparison.tsx'
import rowsCss from './BranchEvidenceMessage.module.css'
import comparisonCss from './CsvQuestionComparison.module.css'
import css from './InquiryReturnedCsvComparison.module.css'

/** Exact parent-local address of a branch result. */
export interface InquiryCsvReturnRef {
  readonly eventSeq: number
  readonly messageId: MessageId
}

/** One displayed choice, already scoped to the selected inquiry branch. */
export interface InquiryCsvReturnOption extends InquiryCsvReturnRef {
  readonly label: string
}

type ReturnPair = readonly [InquiryCsvReturnRef, InquiryCsvReturnRef]
type Selection = readonly [string, string]

interface Request {
  readonly pair: ReturnPair
  readonly offset: number
  readonly history: readonly number[]
}

interface ComparisonProps extends PropsLocale<'artifact'> {
  readonly sessionId: SessionId
  readonly branchSessionId: SessionId
  readonly options: readonly InquiryCsvReturnOption[]
  readonly loadPage: (
    first: InquiryCsvReturnRef, second: InquiryCsvReturnRef, offset: number,
  ) => Promise<ArtifactBranchCsvReturnedComparisonValue>
  readonly reviewAttachment?: ReviewCsvComparisonAttachment | undefined
  readonly onClose: () => void
}

function exactPair(first: InquiryCsvReturnRef | undefined, second: InquiryCsvReturnRef | undefined): ReturnPair | undefined {
  if (first === undefined || second === undefined || first.messageId === second.messageId
    || first.eventSeq === second.eventSeq) return undefined
  return first.eventSeq < second.eventSeq ? [first, second] : [second, first]
}

function hasAddress(value: unknown, option: InquiryCsvReturnRef): boolean {
  return typeof value === 'object' && value !== null && 'eventSeq' in value && value.eventSeq === option.eventSeq
    && 'messageId' in value && value.messageId === option.messageId
}

function addressOf({ eventSeq, messageId }: InquiryCsvReturnRef): InquiryCsvReturnRef { return { eventSeq, messageId } }

function savedPair(key: string, options: readonly InquiryCsvReturnOption[]): ReturnPair | undefined {
  try {
    const raw = sessionStorage.getItem(key)
    const addresses: unknown = raw === null ? undefined : JSON.parse(raw)
    if (!Array.isArray(addresses) || addresses.length !== 2) return undefined
    const first: unknown = addresses[0]
    const second: unknown = addresses[1]
    return exactPair(options.find(option => hasAddress(first, option)), options.find(option => hasAddress(second, option)))
  } catch { return undefined }
}

function rememberPair(key: string, pair: ReturnPair): void {
  try { sessionStorage.setItem(key, JSON.stringify(pair.map(addressOf))) } catch {
    // The verified comparison can still be read when tab storage is unavailable.
  }
}

function exactAttachment({ attachment, ...page }: ArtifactBranchCsvReturnedComparisonValue, pair: ReturnPair,
  sessionId: SessionId, branchSessionId: SessionId): ArtifactCsvComparisonAttachment | undefined {
  const facts = attachment?.facts
  const source = facts?.returns
  if (facts?.sessionId !== sessionId || source?.branchSessionId !== branchSessionId || facts.reusedFrom !== undefined
    || !hasAddress(source.first, pair[0]) || !hasAddress(source.second, pair[1]) || !deepEqualJson(facts.comparison, page)) return undefined
  return attachment
}

/** Opened explicitly from the inquiry. Only successful pair addresses survive a reload. */
export function InquiryReturnedCsvComparison({
  sessionId, branchSessionId, options, loadPage, reviewAttachment, onClose, t,
}: ComparisonProps) {
  const storageKey = `dsh.artifact.inquiry-csv-comparison.v1.${sessionId}.${branchSessionId}`
  const [initial] = useState(() => savedPair(storageKey, options))
  const [choice, setChoice] = useState<Selection>(() => initial === undefined ? ['', ''] : [initial[0].messageId, initial[1].messageId])
  const [request, setRequest] = useState<Request | undefined>(() =>
    initial === undefined ? undefined : { pair: initial, offset: 0, history: [] })
  const [page, setPage] = useState<{ request: Request; value: ArtifactBranchCsvReturnedComparisonValue }>()
  const [failure, setFailure] = useState<{ request: Request; reason: 'failed' | 'groupMismatch' }>()
  const current = useRef(request)
  const pending = useRef<{ request: Request; result: Promise<ArtifactBranchCsvReturnedComparisonValue> }>()
  const verifiedRequest = request?.pair.every(address => options.some(option => hasAddress(address, option))) ? request : undefined

  useEffect(() => {
    if (verifiedRequest === undefined) return
    const next = verifiedRequest
    let active = true
    // A development remount or a changed callback can observe the same in-flight read.
    const result = pending.current?.request === next ? pending.current.result : Promise.resolve().then(() => {
      const [first, second] = next.pair
      return loadPage(addressOf(first), addressOf(second), next.offset)
    })
    pending.current = { request: next, result }
    void result.then((value) => {
      if (!active || current.current !== next) return
      if (next.offset === 0) rememberPair(storageKey, next.pair)
      setPage({ request: next, value })
    }, (error: unknown) => {
      if (active && current.current === next) setFailure({ request: next, reason: csvComparisonGroupMismatch(error) ? 'groupMismatch' : 'failed' })
    })
    return () => { active = false }
  }, [loadPage, storageKey, verifiedRequest])

  const select = (index: number, value: string): void => {
    current.current = undefined
    setRequest(undefined)
    setPage(undefined)
    setFailure(undefined)
    setChoice(index === 0 ? [value, choice[1]] : [choice[0], value])
  }
  const start = (next: Request): void => {
    current.current = next
    setRequest(next)
  }
  const pair = exactPair(options.find(option => option.messageId === choice[0]), options.find(option => option.messageId === choice[1]))
  const waiting = verifiedRequest !== undefined && verifiedRequest !== page?.request && verifiedRequest !== failure?.request
  const error = verifiedRequest !== undefined && failure?.request === verifiedRequest ? failure.reason : undefined
  const reviewCurrent = page?.request === verifiedRequest && error === undefined ? reviewAttachment : undefined
  const attachment = page !== undefined && reviewCurrent !== undefined
    ? exactAttachment(page.value, page.request.pair, sessionId, branchSessionId) : undefined
  const title = t('branchEvidence.inquiryCompareTitle')
  return <Modal open title={title} closeLabel={t('dock.close', { title })} onClose={() => {
    current.current = undefined
    onClose()
  }} className={css.dialog ?? ''} contentClassName={css.content ?? ''}>
    <div className={css.layout}>
      <form className={css.form} onSubmit={(event) => {
        event.preventDefault()
        if (pair === undefined || waiting) return
        setPage(undefined)
        setFailure(undefined)
        setChoice([pair[0].messageId, pair[1].messageId])
        start({ pair, offset: 0, history: [] })
      }}>
        <label className={rowsCss.csvAnalysisSelect}>
          <span>{t('branchEvidence.inquiryCompareFirst')}</span>
          <select data-modal-autofocus data-inquiry-compare-first value={choice[0]}
            onChange={(event) => { select(0, event.currentTarget.value) }}>
            <option value="">{t('branchEvidence.inquiryCompareChoose')}</option>
            {options.map(option => <option key={option.messageId} value={option.messageId}
              disabled={option.messageId === choice[1]}>{option.label}</option>)}
          </select>
        </label>
        <label className={rowsCss.csvAnalysisSelect}>
          <span>{t('branchEvidence.inquiryCompareSecond')}</span>
          <select data-inquiry-compare-second value={choice[1]} onChange={(event) => { select(1, event.currentTarget.value) }}>
            <option value="">{t('branchEvidence.inquiryCompareChoose')}</option>
            {options.map(option => <option key={option.messageId} value={option.messageId}
              disabled={option.messageId === choice[0]}>{option.label}</option>)}
          </select>
        </label>
        <Button size="sm" variant="primary" type="submit" data-inquiry-compare-open disabled={pair === undefined || waiting}>
          {t('branchEvidence.inquiryCompareOpen')}
        </Button>
      </form>
      {waiting && <p role="status">{t('csvCompare.loading')}</p>}
      {error === 'groupMismatch' && <p role="alert">{t('csvCompare.groupMismatch')}</p>}
      {error === 'failed' && verifiedRequest !== undefined && <div className={rowsCss.csvAnalysisFailure}>
        <p role="alert">{t('csvCompare.failed')}</p>
        <Button size="sm" variant="outline" onClick={() => { start({ ...verifiedRequest }) }}>{t('csvAnalysis.retry')}</Button>
      </div>}
      {verifiedRequest !== undefined && page !== undefined && <div className={rowsCss.csvParticipants}>
        <section className={comparisonCss.panel} data-inquiry-return-comparison aria-label={title} aria-busy={waiting || undefined}>
          <ComparisonPage key={page.request.offset} page={page.value} attachment={attachment} reviewAttachment={reviewCurrent}
            sideLabels={csvReturnComparisonSideLabels(t)} t={t}>
            <CsvComparisonPagination page={page.value} history={page.request.history} loading={waiting}
              onLoad={(offset, history) => { start({ pair: verifiedRequest.pair, offset, history }) }} t={t} />
          </ComparisonPage>
        </section>
      </div>}
    </div>
  </Modal>
}
