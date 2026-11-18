/** Navigate to a returned experiment through its parent-local message identity. */
import { useRef, useState } from 'react'
import type { ArtifactBranchCsvReturnedComparisonValue } from '@agentrans/artifact-branch/types'
import type { ArtifactCsvComparisonAttachment } from '@agentrans/artifact-followup/types'
import type { ChatNode, ChatSnapshot } from '@agentrans/client-ui-chat/client'
import type { PropsLocale, PropsRuntime } from '@agentrans/client-ui-slots'
import { Button, IconChevronDownOutlineRegular, Menu } from '@agentrans/client-ui-primitives'
import type { MessageId } from '@agentrans/llm/brand'
import type { SessionId } from '@agentrans/session/types'
import { branchEvidenceFocus, supportsInquiryReplay } from './BranchEvidenceMessage.tsx'
import type { BranchEvidenceNotice } from './branch-evidence-text.ts'
import { csvGroupLabel, csvMetricLabel } from './CsvBarChartView.tsx'
import type { ReviewSentCsvComparison } from './CsvQuestionComparison.tsx'
import { InquiryReturnedCsvComparison, type InquiryCsvReturnRef, type InquiryCsvReturnOption } from './InquiryReturnedCsvComparison.tsx'
import css from './InquiryReturnedResultAction.module.css'

type EvidenceItem = BranchEvidenceNotice['items'][number]
type Translate = PropsLocale<'artifact'>['t']

interface ReturnedReading {
  readonly eventSeq: number
  readonly messageId: MessageId
  readonly evidence: EvidenceItem
}

const resultsBySnapshot = new WeakMap<ChatSnapshot, ReadonlyMap<SessionId, readonly ReturnedReading[]>>()

function returnedReadings(chat: ChatSnapshot): ReadonlyMap<SessionId, readonly ReturnedReading[]> {
  const cached = resultsBySnapshot.get(chat)
  if (cached !== undefined) return cached
  const results = new Map<SessionId, ReturnedReading[]>()
  // The loaded history is a contiguous tail. Every return is after the source answer.
  for (const node of chat.nodes.values()) {
    if (node.kind !== 'artifact-branch-evidence' || node.visibility !== 'visible') continue
    const { branchSessionId, messageId, items } = (node as ChatNode<'artifact-branch-evidence'>).data
    const evidence = items.find(supportsInquiryReplay)
    if (evidence === undefined) continue
    const record = { eventSeq: node.anchorSeq, messageId, evidence }
    const history = results.get(branchSessionId)
    if (history === undefined) results.set(branchSessionId, [record])
    else history.push(record)
  }
  for (const history of results.values()) history.sort((first, second) => first.eventSeq - second.eventSeq)
  resultsBySnapshot.set(chat, results)
  return results
}

function sameHistory(first: readonly ReturnedReading[] | undefined, second: readonly ReturnedReading[] | undefined): boolean {
  if (first === second) return true
  return first !== undefined && second !== undefined && first.length === second.length
    && first.every(({ eventSeq, messageId, evidence }, index) => {
      const other = second[index]
      return other !== undefined && other.eventSeq === eventSeq && other.messageId === messageId && other.evidence === evidence
    })
}

function historyLabel({ evidence }: ReturnedReading, index: number, t: Translate) {
  const { artifact } = 'html' in evidence ? evidence.html : evidence.replay
  const revision = t('revision', { revision: String(artifact.revision) })
  const position = t('branchEvidence.inquiryReturnNumber', { number: String(index + 1) })
  const state = 'replay' in evidence ? evidence.replay.state : undefined
  const summary = state?.kind === 'csv-bar-chart' && artifact.format === 'scene' && artifact.spec.kind === 'csv-bar-chart'
    ? t('branchEvidence.inquiryCsvReading', {
      group: csvGroupLabel(state.group.key, t), metric: csvMetricLabel(artifact.spec, t), value: String(state.group.value),
    })
    : artifact.title
  return { summary, detail: `${position} · ${revision}` }
}

function historyItem(reading: ReturnedReading, index: number, t: Translate) {
  const { messageId } = reading
  const { summary, detail } = historyLabel(reading, index, t)
  return {
    id: `return:${messageId}`,
    label: <span className={css.choice} data-inquiry-return-message-id={messageId}>
      <bdi>{summary}</bdi>
      <span className={css.detail}>{detail}</span>
    </span>,
  }
}

function csvReturnOptions(history: readonly ReturnedReading[], t: Translate): InquiryCsvReturnOption[] {
  return history.flatMap((reading, index) => {
    const { evidence, eventSeq, messageId } = reading
    if (!('replay' in evidence) || evidence.replay.state.kind !== 'csv-bar-chart'
      || evidence.replay.artifact.csvContinuation !== undefined) return []
    const { summary, detail } = historyLabel(reading, index, t)
    return [{ eventSeq, messageId, label: `${summary} · ${detail}` }]
  })
}

const COMPARE_CSV_RETURNS = 'compare-csv-returns'

export interface InquiryReturnedResultInjected {
  readonly compareReturns: (first: InquiryCsvReturnRef, second: InquiryCsvReturnRef, offset: number)
  => Promise<ArtifactBranchCsvReturnedComparisonValue>
  readonly reviewAttachment: (attachment: ArtifactCsvComparisonAttachment) => ReturnType<ReviewSentCsvComparison>
}

/** Open one confirmed reading or choose among the exact inquiry branch's returns. */
export function InquiryReturnedResultAction({
  branchSessionId, sessionId, openView, useAccess, useChat, compareReturns, reviewAttachment, t,
}: Pick<PropsRuntime<'conversation.chat.inquiry.actions'>, 'branchSessionId' | 'sessionId' | 'openView' | 'useAccess' | 'useChat'>
& PropsLocale<'artifact'> & InquiryReturnedResultInjected) {
  const history = useChat(chat => returnedReadings(chat).get(branchSessionId), sameHistory)
  const canCompare = useAccess('artifactBranchResults/compareCsvReturns')
  const canPrompt = useAccess('session/prompt')
  const canReadDraft = useAccess('artifactBranchResults/readCsvComparisonDraft')
  const canSaveDraft = useAccess('artifactBranchResults/saveCsvComparisonDraft')
  const [open, setOpen] = useState(false)
  const [comparisonOpen, setComparisonOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const first = history?.[0]
  if (first === undefined || history === undefined || openView === undefined) return null
  const reveal = (reading: ReturnedReading): void => {
    openView('chat', branchEvidenceFocus(reading))
  }
  const label = t('branchEvidence.inquiryResult')
  if (history.length === 1) return <Button size="sm" variant="ghost" data-inquiry-result={branchSessionId}
    onClick={() => { reveal(first) }}>{label}</Button>

  const options = canCompare && (open || comparisonOpen) ? csvReturnOptions(history, t) : []
  const items = open ? history.map((reading, index) => historyItem(reading, index, t)) : []
  if (open && options.length > 1) items.push({
    id: COMPARE_CSV_RETURNS,
    label: <span data-inquiry-compare-action>{t('branchEvidence.inquiryCompare')}</span>,
  })
  return <>
    <Menu open={open} portal autoFocus listClassName={css.menu}
      anchor={<Button ref={anchor} size="sm" variant="ghost" data-inquiry-result={branchSessionId}
        aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        {label}<IconChevronDownOutlineRegular size={14} />
      </Button>}
      items={items}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        setOpen(false)
        if (id === COMPARE_CSV_RETURNS) {
          anchor.current?.focus()
          setComparisonOpen(true)
          return
        }
        const reading = history.find(entry => `return:${entry.messageId}` === id)
        if (reading !== undefined) reveal(reading)
      }} />
    {comparisonOpen && options.length > 1 && <InquiryReturnedCsvComparison
      key={JSON.stringify([sessionId, branchSessionId])}
      sessionId={sessionId} branchSessionId={branchSessionId} options={options} loadPage={compareReturns}
      reviewAttachment={canPrompt && canReadDraft && canSaveDraft ? reviewAttachment : undefined}
      onClose={() => { setComparisonOpen(false) }} t={t} />}
  </>
}
