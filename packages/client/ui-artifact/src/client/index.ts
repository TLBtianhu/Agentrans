/** Artifact Conversation plugin, browser registrations only. */
import z from '@agentrans/schemastery'
import { artifactHostRouteAvailable } from './artifact-route.ts'
import { ArtifactRuntimeOwner } from './runtime-owner.ts'
import type { Context as ClientContext } from '@agentrans/cordis'
import type {} from '@agentrans/api-remotes/client'
import type { ChatNode } from '@agentrans/client-ui-chat/client'
import type {} from '@agentrans/client-locale/client'
import type {} from '@agentrans/client-ui-renderer/client'
import type {} from '@agentrans/client-ui-workspace/client'
import type {} from '@agentrans/client-ui-file-actions/client'
import type {} from '@agentrans/client-ui-session/client'
import type { TokenSpan } from '@agentrans/client-ui-conversation/client'
import type { SessionBinding } from '@agentrans/api-session-controller/client'
import { createSnapshotStore, type ObservableSnapshot } from '@agentrans/client-store'
import type {
  ArtifactBranchBindCsvComparisonDraftRequest, ArtifactBranchCheckCsvComparisonDraftRequest, ArtifactBranchCheckCsvComparisonDraftValue,
  ArtifactBranchClearCsvComparisonDraftRequest,
  ArtifactBranchContinuePlotRequest,
  ArtifactBranchCsvQuestionComparisonRequest, ArtifactBranchCsvQuestionComparisonValue,
  ArtifactBranchCsvQuestionRowsRequest, ArtifactBranchCsvQuestionRowsValue, ArtifactBranchCsvReturnedRowsRequest,
  ArtifactBranchCsvReturnedComparisonRequest, ArtifactBranchCsvReturnedComparisonValue,
  ArtifactBranchCsvRowsValue, ArtifactBranchExportSentCsvComparisonRequest, ArtifactBranchImportCsvComparisonRequest,
  ArtifactBranchReadCsvComparisonDraftRequest, ArtifactBranchReviewCsvComparisonExplanationRequest,
  ArtifactBranchReviewSentCsvComparisonRequest, ArtifactBranchSaveCsvComparisonDraftRequest,
} from '@agentrans/artifact-branch/types'
import type {
  ArtifactCsvComparisonAttachment, ArtifactCsvComparisonDraft, ArtifactCsvComparisonPage, ArtifactCsvComparisonReturnedFacts,
} from '@agentrans/artifact-followup/types'
import {
  isCsvReturnedSourceOrigin, sameCsvSentQuestion, type CsvComparisonDraftCheck, type CsvComparisonDraftOutcome,
  type CsvComparisonDraftPhase, type CsvComparisonSourceKind, type CsvComparisonSourceTrail, type CsvComparisonSourceVisit,
  type CsvExplanationStep, type CsvReturnComparisonSide, type CsvReturnedSourceOrigin, type CsvSentQuestion,
} from './csv-comparison-draft.ts'
import { readCsvComparisonSourceTrail, writeCsvComparisonSourceTrail } from './csv-comparison-source-visit.ts'
import { readFunctionPlotDraft, writeFunctionPlotDraft } from './function-plot-draft.ts'
import {
  classifyMissingCsvSource, csvComparisonSourceKind, csvDraftSource, csvExplanationSource, loadCsvComparisonSourceChain,
  verifyCsvComparisonSourceTrail, type CsvComparisonSourceChain, type CsvComparisonSourceRead, type CsvComparisonSourceReadKind,
  type CsvComparisonSourceRecovery,
  type VerifiedCsvComparisonSourceTrail,
} from './csv-comparison-source-chain.ts'
import type { CsvAggregate, CsvExactFilter } from '@agentrans/artifact/scene'
import type { ArtifactSnapshot } from '@agentrans/artifact/types'
import {
  CSV_COMPARISON_EXPLANATION_PREFIX, CSV_COMPARISON_QUESTION_PREFIX, IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX,
  IMPORTED_CSV_COMPARISON_QUESTION_PREFIX,
} from '@agentrans/artifact/runtime-values'
import type { CsvExplanationFailure, CsvExplanationSelection } from './csv-comparison-explanation.ts'
import type { ParticleRunCommand } from './particle-run.ts'
import { ArtifactInteractionOwner, particleRuntimeIdentity, type BranchEvidenceReference } from './particle-runtime-owner.ts'
import { ArtifactPromptContextDock, type ArtifactPromptContextInjected } from './ArtifactPromptContext.tsx'
import { SessionSeq, type SessionId } from '@agentrans/session/types'
import { isAppendSurfaceEvent } from '@agentrans/session/surface'
import { deepEqualJson } from '@agentrans/util-values'
import { csvComparisonContextTextRule, programContextTextRule, questionContextTextRule } from './question-context-text.ts'
import {
  CsvComparisonContextNode, ProgramContextNode, QuestionContextNodeView,
  type CsvComparisonContextInjected, type ProgramContextInjected, type QuestionContextInjected,
} from './QuestionContextMessage.tsx'
import { ArtifactNodeView } from './ArtifactNodeView.tsx'
import { ArtifactComparisonNodeView } from './ArtifactComparisonNodeView.tsx'
import { ArtifactBranchResultAction, type ArtifactBranchResultInjected } from './ArtifactBranchResultAction.tsx'
import {
  branchEvidenceFocus, BranchEvidenceNodeView, type BranchEvidenceFollowupInjected, type ReturnedExperimentExportKind,
} from './BranchEvidenceMessage.tsx'
import { buildLockedHtmlExperiment } from './locked-html-experiment.ts'
import { InquiryReturnedResultAction, type InquiryReturnedResultInjected } from './InquiryReturnedResultAction.tsx'
import { artifactBranchEvidenceDefinition } from './branch-evidence-definition.ts'
import { parseBranchEvidenceNotice } from './branch-evidence-text.ts'
import { artifactComparisonDefinition } from './comparison-definition.ts'
import { artifactDefinition } from './definition.ts'
import { en, ja, es, fr, de, ru, pt, zh, type ArtifactKey } from './locales.ts'
import { artifactPresentationStore } from './presentation.ts'
import {
  ArtifactActionRequestError, confirmArtifactObservationComparison, recordArtifactAction, returnArtifactBranchResult,
  saveArtifactObservation, sendArtifactObservation, type ArtifactNodeInjected,
  createArtifactExport, downloadArtifactExport,
} from './protocol.ts'

export type { ArtifactKey } from './locales.ts'
export type { ArtifactId, ArtifactComparisonSnapshot, ArtifactNodeInjected, ArtifactPayload, ArtifactSnapshot, RecordArtifactAction } from './protocol.ts'

declare module '@agentrans/client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Artifact card and action confirmation copy. */
    artifact: ArtifactKey
  }
}

const NS = 'artifact'
const CSV_DRAFT_SUBMISSION_BLOCK = 'artifact-csv-draft'
const PLOT_DRAFT_SUBMISSION_BLOCK = 'artifact-function-plot-draft'

const returnedExperimentRoutes = {
  'function-plot': { method: 'exportReturnedPlot', prefix: 'returned-plot' },
  'particle-system': { method: 'exportReturnedParticle', prefix: 'returned-particle' },
  'bfs-checkpoint': { method: 'exportReturnedBfs', prefix: 'returned-bfs' },
  'half-adder-checkpoint': { method: 'exportReturnedHalfAdder', prefix: 'returned-half-adder' },
} as const
const sentExperimentRoutes = {
  'function-plot': { method: 'exportSentPlot', prefix: 'sent-plot' },
  'particle-system': { method: 'exportSentParticle', prefix: 'sent-particle' },
  'bfs-checkpoint': { method: 'exportSentBfs', prefix: 'sent-bfs' },
  'half-adder-checkpoint': { method: 'exportSentHalfAdder', prefix: 'sent-half-adder' },
} as const
type SentExperimentExportKind = keyof typeof sentExperimentRoutes
type ExperimentExportRoute = typeof returnedExperimentRoutes[ReturnedExperimentExportKind]
  | typeof sentExperimentRoutes[SentExperimentExportKind]

function sessionEventAt(binding: SessionBinding | undefined, seq: number) {
  if (binding === undefined) return undefined
  const { entries } = binding.eventSource.getSnapshot()
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const entry = entries[middle]
    if (entry !== undefined && entry.event.seq < seq) low = middle + 1
    else high = middle
  }
  const entry = entries[low]
  return entry?.type === 'event' && entry.event.seq === seq ? entry.event : undefined
}

function csvSourceMessage(binding: SessionBinding | undefined, target: CsvSentQuestion) {
  const event = sessionEventAt(binding, target.eventSeq)
  return event?.type === 'user/message' && event.data.id === target.messageId && event.data.source.kind === 'user'
    && isAppendSurfaceEvent(event) ? event : undefined
}

function csvSourceQuestionLabel(binding: SessionBinding | undefined, target: CsvSentQuestion): string | undefined {
  const question = csvSourceMessage(binding, target)?.data.content.find(block => block.type === 'text' && block.text.trim() !== '')
  if (question?.type !== 'text') return undefined
  const start = question.text.split(CSV_COMPARISON_QUESTION_PREFIX, 1)[0]
    ?.split(IMPORTED_CSV_COMPARISON_QUESTION_PREFIX, 1)[0]?.split(CSV_COMPARISON_EXPLANATION_PREFIX, 1)[0]
    ?.split(IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX, 1)[0]?.trim().replace(/\s+/gu, ' ')
  if (start === undefined || start === '') return undefined
  const characters = Array.from(start)
  return characters.length > 72 ? `${characters.slice(0, 72).join('').trimEnd()}…` : start
}

function readCsvComparisonContext(binding: SessionBinding | undefined, sessionId: SessionId, target: CsvSentQuestion) {
  const retained = csvSourceMessage(binding, target)
  if (retained === undefined) return undefined
  let comparison: Extract<ReturnType<typeof csvComparisonContextTextRule.match>, { id: 'artifact-csv-comparison-context' }> | undefined
  const facts = { read: () => undefined }
  for (const block of retained.data.content) {
    if (block.type !== 'text') continue
    const node = csvComparisonContextTextRule.match(block.text, 0, facts)
    if (node?.id !== 'artifact-csv-comparison-context') continue
    if (comparison !== undefined || node.data.sessionId !== sessionId
      || csvComparisonContextTextRule.match(block.text, node.end, facts) !== undefined) return undefined
    comparison = node
  }
  return comparison?.data
}

function readCsvComparison(binding: SessionBinding | undefined, sessionId: SessionId, target: CsvSentQuestion) {
  const comparison = readCsvComparisonContext(binding, sessionId, target)
  return comparison?.explanation === undefined ? comparison : undefined
}

function readCsvComparisonSource(binding: SessionBinding, sessionId: SessionId, target: CsvSentQuestion,
  kind?: CsvComparisonSourceReadKind): CsvComparisonSourceRead {
  if (sessionEventAt(binding, target.eventSeq) !== undefined) {
    const comparison = readCsvComparisonContext(binding, sessionId, target)
    if (comparison === undefined) return 'invalid'
    if (kind === 'explanation') return comparison.explanation !== undefined && comparison.attribution === undefined ? comparison : 'invalid'
    if (kind !== undefined) return csvComparisonSourceKind(comparison) === kind ? comparison : 'invalid'
    return comparison.explanation === undefined ? comparison : 'invalid'
  }
  return missingSourceEvent(binding, target.eventSeq)
}

function missingSourceEvent(binding: SessionBinding, eventSeq: number): 'unavailable' | 'invalid' {
  const { entries, hasMore } = binding.eventSource.getSnapshot()
  return classifyMissingCsvSource(eventSeq, {
    open: binding.session.getSnapshot().openState === 'open', hasMore,
    firstSeq: entries.find(entry => entry.type === 'event')?.event.seq,
    lastSeq: entries.findLast(entry => entry.type === 'event')?.event.seq,
  })
}

type OpenCsvSource = (target: CsvSentQuestion, focus?: string) => void
type CsvSourceCheck = 'matched' | 'unavailable' | 'invalid'

function revealCsvSource(visit: CsvComparisonSourceVisit, open: OpenCsvSource): void {
  if (isCsvReturnedSourceOrigin(visit.origin)) open(visit.source, branchEvidenceFocus(visit.source))
  else open(visit.source)
}

function selectedCsvDraft(owner: ArtifactInteractionOwner): ArtifactCsvComparisonDraft | undefined {
  const selection = owner.selection.getSnapshot()
  return selection?.kind === 'csv-question-comparison' ? selection.draft : undefined
}

function verifyCsvReturnedSource(binding: SessionBinding, sessionId: SessionId, target: CsvSentQuestion,
  origin: CsvReturnedSourceOrigin, draft?: ArtifactCsvComparisonDraft): CsvSourceCheck {
  if (origin.kind === 'draft') {
    if (draft?.receiptId !== origin.receiptId || draft.facts.sessionId !== sessionId || draft.facts.returns === undefined) return 'invalid'
    return verifyCsvReturnedReading(binding, target, draft.facts.returns, draft.facts.comparison, origin.returnSide)
  }
  if (target.eventSeq >= origin.message.eventSeq || target.messageId === origin.message.messageId) return 'invalid'
  if (sessionEventAt(binding, origin.message.eventSeq) === undefined) return missingSourceEvent(binding, origin.message.eventSeq)
  const comparison = readCsvComparisonContext(binding, sessionId, origin.message)
  if (comparison?.returnedPair === undefined) return 'invalid'
  return verifyCsvReturnedReading(binding, target, comparison.returnedPair, comparison.page, origin.side)
}

function verifyCsvReturnedReading(binding: SessionBinding, target: CsvSentQuestion, pair: ArtifactCsvComparisonReturnedFacts['returns'],
  page: ArtifactCsvComparisonPage, side: CsvReturnComparisonSide): CsvSourceCheck {
  if (!sameCsvSentQuestion(pair[side], target)) return 'invalid'
  const event = sessionEventAt(binding, target.eventSeq)
  if (event === undefined) return missingSourceEvent(binding, target.eventSeq)
  if (event.type !== 'user/message' || event.data.id !== target.messageId || !isAppendSurfaceEvent(event)
    || event.data.source.kind !== 'branch-result' || event.data.source.branchSessionId !== pair.branchSessionId) return 'invalid'
  const evidence = parseBranchEvidenceNotice(event.data)?.items[0]
  if (evidence?.role !== 'question' || !('replay' in evidence)) return 'invalid'
  const { artifact, state } = evidence.replay
  const { artifactId, revision } = pair[side]
  if (artifact.artifactId !== artifactId || artifact.revision !== revision || artifact.csvContinuation !== undefined
    || artifact.spec.kind !== 'csv-bar-chart' || state.kind !== 'csv-bar-chart') return 'invalid'
  const reading = side === 'first' ? page.original : page.current
  const { group } = state
  return group.key === reading.groupKey && group.value === reading.value && group.count === reading.count
    && artifact.spec.aggregate === reading.aggregate && artifact.spec.valueColumn === reading.valueColumn
    && deepEqualJson(artifact.spec.filter, reading.filter) ? 'matched' : 'invalid'
}

async function loadCsvComparisonHistory(binding: SessionBinding, sessionId: SessionId, source: CsvSentQuestion,
  checkCurrent: () => void, signal: AbortSignal, sourceKind?: CsvComparisonSourceKind): Promise<CsvComparisonSourceChain> {
  return await loadCsvComparisonSourceChain(source, async (target) => {
    checkCurrent()
    const displayed = readCsvComparisonSource(binding, sessionId, target, sourceKind)
    if (displayed !== 'unavailable') return displayed
    await binding.session.loadThrough(SessionSeq(target.eventSeq))
    checkCurrent()
    return readCsvComparisonSource(binding, sessionId, target, sourceKind)
  }, signal)
}

async function verifyRestoredCsvSourceTrail(
  binding: SessionBinding, sessionId: SessionId, owner: ArtifactInteractionOwner,
  trail: CsvComparisonSourceTrail, active: () => boolean,
): Promise<VerifiedCsvComparisonSourceTrail | undefined> {
  if (!active()) return undefined
  const verify = () => verifyCsvComparisonSourceTrail(trail,
    (target, kind) => readCsvComparisonSource(binding, sessionId, target, kind),
    (target, origin) => verifyCsvReturnedSource(binding, sessionId, target, origin, selectedCsvDraft(owner)))
  const current = verify()
  const deepest = trail.at(-1)
  if (current.interruption?.status !== 'unavailable' || deepest === undefined) return current
  await binding.session.loadThrough(SessionSeq(deepest.source.eventSeq))
  return active() ? verify() : undefined
}

function csvComparisonHistoryVisits(binding: SessionBinding, sessionId: SessionId, origin: CsvSentQuestion,
  sources: readonly CsvSentQuestion[], sourceKind?: CsvComparisonSourceKind): CsvComparisonSourceVisit[] | undefined {
  const visits: CsvComparisonSourceVisit[] = []
  const ids = new Set([origin.messageId])
  let previous = origin
  for (const source of sources) {
    if (source.eventSeq >= previous.eventSeq || ids.has(source.messageId)) return undefined
    const comparison = readCsvComparisonSource(binding, sessionId, previous, sourceKind)
    if (typeof comparison === 'string' || !sameCsvSentQuestion(comparison.reusedFrom, source)
      || typeof readCsvComparisonSource(binding, sessionId, source, sourceKind) === 'string') return undefined
    visits.push({ source, origin: { kind: 'comparison', message: previous }, ...(sourceKind === undefined ? {} : { sourceKind }) })
    ids.add(source.messageId)
    previous = source
  }
  return visits
}

function csvDraftReceipt(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'csv-comparison-draft'
    && 'receiptId' in value && typeof value.receiptId === 'string' ? value.receiptId : undefined
}

function csvDraftCheck(value: ArtifactBranchCheckCsvComparisonDraftValue): CsvComparisonDraftCheck {
  if (!value.accepted) return { status: value.pending === true ? 'pending' : 'unconfirmed' }
  return { status: 'accepted',
    ...(value.message === undefined ? {} : { message: value.message }),
    ...(value.queuedMessageId === undefined ? {} : { queuedMessageId: value.queuedMessageId }),
  }
}

function csvHistoryUnverified(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'artifact-followup/csv-draft-unavailable'
    && 'details' in error && typeof error.details === 'object' && error.details !== null
    && 'reason' in error.details && error.details.reason === 'HISTORY_UNVERIFIED'
}

function csvExplanationFailure(error: unknown): CsvExplanationFailure {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'artifact-followup/csv-draft-unavailable'
    || !('details' in error) || typeof error.details !== 'object' || error.details === null || !('reason' in error.details)) return 'failed'
  if (error.details.reason === 'INCOMPATIBLE_PAIR') return 'incompatible'
  if (error.details.reason === 'EXPLANATION_TOO_LARGE') return 'too-large'
  return 'failed'
}

/** Required Slot, Remote, locale, and Conversation services. */
export const inject = [
  'slots', 'remote', 'remote.artifacts', 'remote.artifactExports', 'remote.artifactRuntime',
  'fileActions', 'locale', 'uiConversation', 'conversation', 'sessions', 'uiSession',
]

/** Maximum wait for an authored program to acknowledge an actual command. */
export interface Config {
  /** Maximum wait for each program command acknowledgement, in milliseconds. */
  runtimeCommandTimeoutMs?: number
}
/** Validated Client runtime command budget. */
export const Config: z<Config, Required<Config>> = z.object({ runtimeCommandTimeoutMs: z.natural().min(1).default(10_000) })

/**
 * Register Artifact dictionaries, the whole-checkpoint Definition, and its keyed Chat renderer.
 * @param ctx - client root context.
 * @param config - Runtime command acknowledgement budget.
 */
export function apply(ctx: ClientContext, config: Config = {}): void {
  const policy = Config(config)
  const unavailableSentExperimentExports = { 'function-plot': false, 'particle-system': false, 'bfs-checkpoint': false, 'half-adder-checkpoint': false }
  const sentExperimentExports = createSnapshotStore<Readonly<Record<SentExperimentExportKind, boolean>>>(unavailableSentExperimentExports)
  const restoreDraftFromCsvSource = (
    binding: SessionBinding, owner: ArtifactInteractionOwner, visit: CsvComparisonSourceVisit,
    target: CsvComparisonSourceVisit, current: () => boolean,
  ): void => {
    if (target.origin.kind !== 'draft' || !current()) return
    const gesture = owner.beginCsvSourceDraftReturn(visit, target)
    if (gesture === undefined) return
    const restoringDraft = (): boolean => owner.isCurrentCsvSourceVisitGesture(gesture) && current()
      && owner.canReturnToCsvComparisonSourceStop(visit, target)
    void ctx.conversation.input.for(binding.ctx).restoreDraftFocus(target.origin, restoringDraft).then((focused) => {
      if (focused && restoringDraft()) owner.returnToCsvComparisonSourceStop(visit, target)
    }).finally(() => { owner.finishCsvDraftNavigation(gesture) })
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-artifact: dictionaries')
  ctx.effect(() => ctx.uiConversation.userText.register(questionContextTextRule), 'ui-artifact: question context text')
  ctx.effect(() => ctx.uiConversation.userText.register(csvComparisonContextTextRule), 'ui-artifact: CSV comparison context text')
  ctx.effect(() => ctx.uiConversation.userText.register(programContextTextRule), 'ui-artifact: program report text')
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'artifact-question-context', priority: 100, locale: NS,
    inject: (sessionId: SessionId): QuestionContextInjected => ({
      hooks: { sentExperimentExports },
      downloadSentExperiment: (kind, ref) => saveExperimentHtml(sessionId, ref, sentExperimentRoutes[kind], 'sentQuestion'),
      readCsvQuestionRows: async (message, offset) => {
        requireHostRoute(sessionId)
        if (csvReplayRows === undefined) throw new Error(t('csvAnalysis.rowsFailed'))
        return await csvReplayRows.question({ sessionId, ...message, offset })
      },
      compareCsvQuestion: async (message, offset) => {
        requireHostRoute(sessionId)
        if (csvReplayRows === undefined) throw new Error(t('csvCompare.failed'))
        return await csvReplayRows.compare({ sessionId, ...message, offset })
      },
      chooseCsvComparison: async attachment => await questionInteractionFor(sessionId)?.chooseCsvComparison(attachment) ?? false,
    }),
  }, QuestionContextNodeView))
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'artifact-csv-comparison-context', priority: 100, locale: NS,
    inject: (sessionId: SessionId): CsvComparisonContextInjected => {
      const binding = ctx.sessions.binding(sessionId)
      const owner = binding === undefined ? undefined : interactionFor(sessionId)
      const draft = owner?.csvDraft
      const current = (): boolean => binding !== undefined && ctx.sessions.binding(sessionId) === binding && hasMainConversation(sessionId)
      const jumpInSourceTrail = (visit: CsvComparisonSourceVisit, target: CsvComparisonSourceVisit): CsvSentQuestion | undefined => {
        if (binding === undefined || owner === undefined) return undefined
        const active = (): boolean => current() && owner.canReturnToCsvComparisonSourceStop(visit, target)
        if (!active()) return undefined
        if (target.origin.kind !== 'draft') {
          return owner.returnToCsvComparisonSourceStop(visit, target) ? target.origin.message : undefined
        }
        restoreDraftFromCsvSource(binding, owner, visit, target, current)
        return undefined
      }
      return {
        hooks: { returnToCsvDraft: draft?.returnToDraftTarget ?? noDraftReturn, csvHistoryDraftPhase: draft?.phase ?? draftUnavailable,
          csvComparisonSourceTrail: owner?.csvComparisonSourceTrail ?? noSourceTrail,
          csvComparisonSourceRecovery: owner?.csvComparisonSourceRecovery ?? noSourceRecovery,
          csvExplanationSelection: owner?.csvExplanation.state ?? noExplanation },
        selectCsvExplanationStep: (target) => {
          if (binding === undefined || owner === undefined || draft === undefined) return
          const candidate = readCsvComparison(binding, sessionId, target)
          if (candidate === undefined || candidate.attribution !== undefined || candidate.returnedPair) return
          const previous = owner.selection.getSnapshot()
          const active = (): boolean => current() && artifactHostRouteAvailable(binding.session.getSnapshot())
            && draft.phase.getSnapshot() === 'ready' && owner.selection.getSnapshot() === previous
          void owner.csvExplanation.select(target, {
            current: active,
            replacesContext: previous !== null,
            review: async (first, second) => {
              try {
                const attachment = await csvDraftRemote().reviewExplanation({ sessionId, first, second })
                return attachment.facts.sessionId === sessionId ? attachment : 'failed'
              } catch (error) { return csvExplanationFailure(error) }
            },
            save: async (attachment) => {
              if (!await owner.chooseCsvComparison(attachment)) return false
              if (current()) ctx.conversation.input.for(binding.ctx).focus()
              return true
            },
          })
        },
        cancelCsvExplanation: () => { owner?.csvExplanation.clear() },
        confirmCsvExplanation: (target) => { void owner?.csvExplanation.confirm(target) },
        returnToCsvDraft: (target) => {
          if (binding === undefined || draft === undefined || ctx.sessions.binding(sessionId) !== binding
            || !sameCsvSentQuestion(draft.returnToDraftTarget.getSnapshot(), target)) return
          if (ctx.conversation.input.for(binding.ctx).focus()) draft.clearReturnToDraft(target)
        },
        visitCsvComparisonSource: (visit) => {
          if (binding === undefined || owner === undefined || ctx.sessions.binding(sessionId) !== binding) return false
          const { origin, source, sourceKind } = visit
          if (origin.kind === 'returned-comparison'
            && (!current() || verifyCsvReturnedSource(binding, sessionId, source, origin) === 'invalid')) return false
          if (origin.kind === 'explanation') {
            const comparison = readCsvComparisonSource(binding, sessionId, origin.message, 'explanation')
            if (!current() || typeof comparison === 'string'
              || !sameCsvSentQuestion(csvExplanationSource(comparison.explanation, origin.step), source)
              || readCsvComparisonSource(binding, sessionId, source) === 'invalid') return false
          }
          if (sourceKind !== undefined) {
            if (!current() || origin.kind !== 'comparison') return false
            const comparison = readCsvComparisonSource(binding, sessionId, origin.message, sourceKind)
            if (typeof comparison === 'string' || !sameCsvSentQuestion(comparison.reusedFrom, source)
              || readCsvComparisonSource(binding, sessionId, source, sourceKind) === 'invalid') return false
          }
          return owner.visitCsvComparisonSource(visit)
        },
        clearCsvComparisonSourceVisit: (visit) => { owner?.clearCsvComparisonSourceVisit(visit) },
        returnFromCsvComparisonSource: visit => jumpInSourceTrail(visit, visit),
        jumpInSourceTrail,
        sourceQuestionLabel: target => csvSourceQuestionLabel(binding, target),
        retryCsvSourceRecovery: (recovery, open) => { retryCsvSourceRecovery(sessionId, binding, owner, recovery, open) },
        loadCsvHistorySourceChain: async (origin, source, signal) => {
          if (binding === undefined) throw new Error('The source conversation is unavailable')
          const sourceKind = csvComparisonSourceKind(readCsvComparisonContext(binding, sessionId, origin))
          const checkOrigin = (): void => {
            signal.throwIfAborted()
            const comparison = readCsvComparisonSource(binding, sessionId, origin, sourceKind)
            const matches = typeof comparison !== 'string' && (source === undefined ? comparison.invalidReuseSource === true
              : sameCsvSentQuestion(comparison.reusedFrom, source))
            if (!current() || !matches) {
              throw new Error('The source comparison changed')
            }
          }
          checkOrigin()
          if (source === undefined || source.eventSeq >= origin.eventSeq || source.messageId === origin.messageId) {
            return { sources: [], status: 'invalid', level: 1 }
          }
          return await loadCsvComparisonHistory(binding, sessionId, source, checkOrigin, signal, sourceKind)
        },
        visitCsvHistorySourceChain: (origin, sources) => {
          if (owner === undefined || binding === undefined || !current()) return false
          const sourceKind = csvComparisonSourceKind(readCsvComparisonContext(binding, sessionId, origin))
          const visits = csvComparisonHistoryVisits(binding, sessionId, origin, sources, sourceKind)
          const [first, ...rest] = visits ?? []
          return first !== undefined && owner.openCsvComparisonSourceTrail([first, ...rest])
        },
        downloadSentCsvComparison: async ({ eventSeq, messageId }, format) => {
          const mediaType = format === 'html' ? 'text/html' : 'application/json'
          const locale = format === 'html' ? ctx.locale.getLocale().active : undefined
          const request = { sessionId, eventSeq, messageId }
          try {
            return await ctx.fileActions.save({
              url: `csv-comparison:${encodeURIComponent(sessionId)}/${eventSeq}/${encodeURIComponent(messageId)}.${format}`,
              name: `csv-comparison-${eventSeq}.${format}`,
              mediaType,
              read: async (signal) => {
                signal.throwIfAborted()
                if (binding === undefined || ctx.sessions.binding(sessionId) !== binding || csvReplayRows === undefined) {
                  throw new Error(t('csvCompare.downloadFailed'))
                }
                requireHostRoute(sessionId)
                const bytes = locale === undefined ? await csvReplayRows.downloadSentJson(request)
                  : await csvReplayRows.downloadSent({ ...request, locale })
                signal.throwIfAborted()
                return new Blob([new Uint8Array(bytes)], { type: mediaType })
              },
            }, 'download')
          } catch (error) {
            if (csvHistoryUnverified(error)) return 'unavailable'
            throw error
          }
        },
        reviewSentCsvComparison: (target, page, explanation, returnCards) => {
          if (binding === undefined || owner === undefined || draft?.phase.getSnapshot() !== 'ready') return undefined
          const importedContents = explanation !== undefined ? { explanation } : returnCards === undefined ? undefined : { returnCards }
          const previous = owner.selection.getSnapshot()
          const canConfirm = (): boolean => ctx.sessions.binding(sessionId) === binding
            && artifactHostRouteAvailable(binding.session.getSnapshot()) && draft.phase.getSnapshot() === 'ready'
            && owner.selection.getSnapshot() === previous && (importedContents === undefined || current())
          return {
            replacesContext: previous !== null,
            confirm: async () => {
              if (!canConfirm()) return false
              let attachment: ArtifactCsvComparisonAttachment
              try {
                attachment = await csvDraftRemote().reviewSent({ sessionId, ...target })
              } catch (error) {
                return csvHistoryUnverified(error) ? 'unavailable' : false
              }
              const facts = attachment.facts
              if (importedContents === undefined) {
                if (facts.sessionId !== sessionId || facts.explanation !== undefined || facts.returnCards !== undefined
                  || !deepEqualJson(facts.comparison, page)) return 'unavailable'
              } else if (!deepEqualJson(facts, { kind: 'csv-question-comparison', sessionId,
                attribution: 'user-imported', comparison: page, ...importedContents, reusedFrom: target })) return 'unavailable'
              if (!canConfirm() || !await owner.chooseCsvComparison(attachment)) return false
              if (ctx.sessions.binding(sessionId) === binding) ctx.conversation.input.for(binding.ctx).focus()
              return true
            },
          }
        },
      }
    },
  }, CsvComparisonContextNode))
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'artifact-program-context', priority: 100, locale: NS,
    inject: (sessionId: SessionId): ProgramContextInjected => ({
      hooks: { sentExperimentExports },
      downloadSentExperiment: (kind, ref) => saveExperimentHtml(sessionId, ref, sentExperimentRoutes[kind], 'sentQuestion'),
      findCheckpointSource: (artifactId, revision, source, kind, origin) => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined) return undefined
        if (origin !== undefined) return binding.session.loadThrough(SessionSeq(origin.eventSeq)).then(() => {
          if (ctx.sessions.binding(sessionId) !== binding) return undefined
          const { entries } = binding.eventSource.getSnapshot()
          const notice = entries.find(entry => entry.type === 'event' && entry.event.seq === origin.eventSeq)?.event
          if (notice?.type !== 'user/message' || !isAppendSurfaceEvent(notice) || notice.data.id !== origin.messageId
            || notice.data.source.kind !== 'branch-result' || notice.data.source.artifactEvidence !== kind
            || notice.data.source.branchSessionId !== origin.branchSessionId
            || notice.data.source.resultSeq !== origin.resultSeq) return undefined
          const item = parseBranchEvidenceNotice(notice.data)?.items[0]
          if (item === undefined || !('html' in item) || item.questionSeq !== origin.questionSeq) return undefined
          const artifact = item.html.artifact
          return artifact.artifactId === artifactId && artifact.revision === revision && artifact.source === source ? artifact : undefined
        })
        const { entries } = binding.eventSource.getSnapshot()
        const found = entries.findLast(entry => entry.type === 'event' && entry.event.type === 'artifact/upsert'
          && entry.event.data.artifactId === artifactId && entry.event.data.revision === revision)
        const event = found?.event
        return event?.type === 'artifact/upsert' && event.data.format === 'html' && event.data.source === source ? event.data : undefined
      },
    }),
  }, ProgramContextNode))
  ctx.effect(() => ctx.uiConversation.events.register(artifactDefinition), 'ui-artifact: conversation definition')
  ctx.effect(() => ctx.uiConversation.events.register(artifactComparisonDefinition), 'ui-artifact: comparison definition')
  ctx.effect(() => ctx.uiConversation.events.register(artifactBranchEvidenceDefinition), 'ui-artifact: returned evidence definition')
  const interactions = new WeakMap<SessionBinding, ArtifactInteractionOwner>()
  const runtimes = new WeakMap<SessionBinding, ArtifactRuntimeOwner>()
  const runtimeFor = (sessionId: SessionId): ArtifactRuntimeOwner => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error('Artifact runtime requires a live Session binding')
    const existing = runtimes.get(binding)
    if (existing !== undefined) return existing
    const owner = new ArtifactRuntimeOwner(
      (identity, signal) => ctx.remote.artifactRuntime.attach(sessionId, identity, signal), policy.runtimeCommandTimeoutMs,
    )
    runtimes.set(binding, owner)
    ctx.effect(() => binding.ctx.effect(() => () => { owner.dispose() }, 'ui-artifact: report leases'), 'ui-artifact: runtime reports')
    return owner
  }
  const t = ctx.locale.bind(NS)
  const draftUnavailable = createSnapshotStore<CsvComparisonDraftPhase>('idle')
  const noDraftOutcome = createSnapshotStore<CsvComparisonDraftOutcome | undefined>(undefined)
  const noDraftReturn = createSnapshotStore<CsvSentQuestion | undefined>(undefined)
  const noSourceTrail = createSnapshotStore<CsvComparisonSourceTrail | undefined>(undefined)
  const noSourceRecovery = createSnapshotStore<CsvComparisonSourceRecovery | undefined>(undefined)
  const noExplanation = createSnapshotStore<CsvExplanationSelection | undefined>(undefined)
  const noDraftCleanupError = createSnapshotStore(false)
  const hasMainConversation = (sessionId: SessionId): boolean =>
    (ctx.sessions.retainInfo(sessionId).getSnapshot().retainedBy.mainView ?? 0) > 0
  const retryCsvSourceRecovery = (
    sessionId: SessionId, binding: SessionBinding | undefined, owner: ArtifactInteractionOwner | undefined,
    recovery: CsvComparisonSourceRecovery, open: OpenCsvSource,
  ): void => {
    const retention = ctx.sessions.retainInfo(sessionId)
    const isMain = (): boolean => (retention.getSnapshot().retainedBy.mainView ?? 0) > 0
    if (owner === undefined || binding === undefined || ctx.sessions.binding(sessionId) !== binding || !isMain()) {
      return
    }
    const attempt = owner.beginCsvSourceRecovery(recovery)
    if (attempt === undefined) return
    const { requested, retry } = attempt
    const active = (): boolean => ctx.sessions.binding(sessionId) === binding && isMain()
      && owner.csvComparisonSourceRecovery.getSnapshot() === retry && owner.isCsvComparisonSourceAvailable(requested[0])
    const finish = (): void => {
      stopWatchingMain()
      owner.finishCsvSourceRecovery(retry, recovery)
    }
    const stopWatchingMain = retention.subscribe(() => {
      // Losing the main view ends this attempt even if a sidebar keeps the binding alive.
      if (!isMain()) finish()
    })
    void verifyRestoredCsvSourceTrail(binding, sessionId, owner, requested, active).then((verified) => {
      if (verified !== undefined && active() && owner.restoreCsvComparisonSourceTrail(requested, verified, retry)) {
        const target = verified.trail?.at(-1)
        if (target !== undefined && !sameCsvSentQuestion(recovery.source, target.source)) revealCsvSource(target, open)
      }
    }).finally(finish)
  }
  const unavailableExperimentExports = { 'function-plot': false, 'particle-system': false, 'bfs-checkpoint': false, 'half-adder-checkpoint': false }
  const returnedExperimentExports = createSnapshotStore<Readonly<Record<ReturnedExperimentExportKind, boolean>>>(
    unavailableExperimentExports,
  )
  let experimentExportRemote: ClientContext['remote']['artifactBranchResults'] | undefined
  let csvReplayRows: {
    readonly question: (request: ArtifactBranchCsvQuestionRowsRequest) => Promise<ArtifactBranchCsvQuestionRowsValue>
    readonly returned: (request: ArtifactBranchCsvReturnedRowsRequest) => Promise<ArtifactBranchCsvRowsValue>
    readonly compare: (request: ArtifactBranchCsvQuestionComparisonRequest) => Promise<ArtifactBranchCsvQuestionComparisonValue>
    readonly compareReturns: (request: ArtifactBranchCsvReturnedComparisonRequest) => Promise<ArtifactBranchCsvReturnedComparisonValue>
    readonly reviewSent: (request: ArtifactBranchReviewSentCsvComparisonRequest) => Promise<ArtifactCsvComparisonAttachment>
    readonly reviewExplanation: (request: ArtifactBranchReviewCsvComparisonExplanationRequest) => Promise<ArtifactCsvComparisonAttachment>
    readonly downloadSent: (request: ArtifactBranchExportSentCsvComparisonRequest) => Promise<Uint8Array>
    readonly downloadSentJson: (request: ArtifactBranchReviewSentCsvComparisonRequest) => Promise<Uint8Array>
    readonly importComparison: (request: ArtifactBranchImportCsvComparisonRequest) => Promise<ArtifactCsvComparisonAttachment>
    readonly readDraft: (request: ArtifactBranchReadCsvComparisonDraftRequest) => Promise<ArtifactCsvComparisonDraft | null>
    readonly saveDraft: (request: ArtifactBranchSaveCsvComparisonDraftRequest) => Promise<ArtifactCsvComparisonDraft>
    readonly clearDraft: (request: ArtifactBranchClearCsvComparisonDraftRequest) => Promise<boolean>
    readonly bindDraft: (request: ArtifactBranchBindCsvComparisonDraftRequest) => Promise<void>
    readonly checkDraft: (request: ArtifactBranchCheckCsvComparisonDraftRequest) => Promise<CsvComparisonDraftCheck>
  } | undefined
  ctx.inject(['remote.artifactBranchResults'], (scope: ClientContext) => {
    scope.effect(() => {
      const remote = scope.remote.artifactBranchResults
      experimentExportRemote = remote
      returnedExperimentExports.set({
        'function-plot': typeof remote.exportReturnedPlot === 'function',
        'particle-system': typeof remote.exportReturnedParticle === 'function',
        'bfs-checkpoint': typeof remote.exportReturnedBfs === 'function',
        'half-adder-checkpoint': typeof remote.exportReturnedHalfAdder === 'function',
      })
      sentExperimentExports.set({
        'function-plot': typeof remote.exportSentPlot === 'function',
        'particle-system': typeof remote.exportSentParticle === 'function',
        'bfs-checkpoint': typeof remote.exportSentBfs === 'function',
        'half-adder-checkpoint': typeof remote.exportSentHalfAdder === 'function',
      })
      return () => {
        experimentExportRemote = undefined
        returnedExperimentExports.set(unavailableExperimentExports)
        sentExperimentExports.set(unavailableSentExperimentExports)
      }
    }, 'ui-artifact: experiment exports')
    scope.effect(() => {
      csvReplayRows = {
        question: async (request) => {
          const result = await scope.remote.artifactBranchResults.csvQuestionParticipatingRows(request)
          if (!result.ok) throw result.error
          return result.value
        },
        returned: async (request) => {
          const result = await scope.remote.artifactBranchResults.csvReturnedParticipatingRows(request)
          if (!result.ok) throw result.error
          return result.value
        },
        compare: async (request) => {
          const result = await scope.remote.artifactBranchResults.compareCsvQuestionToReturn(request)
          if (!result.ok) throw result.error
          return result.value
        },
        compareReturns: async (request) => {
          const result = await scope.remote.artifactBranchResults.compareCsvReturns(request)
          if (!result.ok) throw result.error
          return result.value
        },
        reviewSent: async (request) => {
          const result = await scope.remote.artifactBranchResults.reviewSentCsvComparison(request)
          if (!result.ok) throw result.error
          return result.value
        },
        reviewExplanation: async (request) => {
          const result = await scope.remote.artifactBranchResults.reviewCsvComparisonExplanation(request)
          if (!result.ok) throw result.error
          return result.value
        },
        downloadSent: async (request) => {
          const result = await scope.remote.artifactBranchResults.exportSentCsvComparison(request)
          if (!result.ok) throw result.error
          return result.value
        },
        downloadSentJson: async (request) => {
          const result = await scope.remote.artifactBranchResults.exportSentCsvComparisonJson(request)
          if (!result.ok) throw result.error
          return result.value
        },
        importComparison: async (request) => {
          const result = await scope.remote.artifactBranchResults.importCsvComparison(request)
          if (!result.ok) throw result.error
          return result.value
        },
        readDraft: async (request) => {
          const result = await scope.remote.artifactBranchResults.readCsvComparisonDraft(request)
          if (!result.ok) throw result.error
          return result.value
        },
        saveDraft: async (request) => {
          const result = await scope.remote.artifactBranchResults.saveCsvComparisonDraft(request)
          if (!result.ok) throw result.error
          return result.value
        },
        clearDraft: async (request) => {
          const result = await scope.remote.artifactBranchResults.clearCsvComparisonDraft(request)
          if (!result.ok) throw result.error
          return result.value.cleared
        },
        bindDraft: async (request) => {
          const result = await scope.remote.artifactBranchResults.bindCsvComparisonDraftRequest(request)
          if (!result.ok) throw result.error
        },
        checkDraft: async (request) => {
          const result = await scope.remote.artifactBranchResults.checkCsvComparisonDraftRequest(request)
          if (!result.ok) throw result.error
          return csvDraftCheck(result.value)
        },
      }
      return () => { csvReplayRows = undefined }
    }, 'ui-artifact: recorded CSV rows')
  })
  const csvDraftRemote = (): NonNullable<typeof csvReplayRows> => {
    if (csvReplayRows === undefined) throw new Error(t('csvCompare.draftReadFailed'))
    return csvReplayRows
  }
  const interactionFor = (sessionId: SessionId): ArtifactInteractionOwner => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error(t('promptContext.unavailableSend'))
    const existing = interactions.get(binding)
    if (existing !== undefined) return existing
    const chat = ctx.uiConversation.binding(binding).target('chat')
    const owner = new ArtifactInteractionOwner((key): ObservableSnapshot<ArtifactSnapshot | undefined> => {
      const [nodeKey, artifactId] = particleRuntimeIdentity(key)
      const nodes = chat.getSnapshot()?.nodes
      if (nodes === undefined) throw new Error(t('promptContext.unavailableSend'))
      const source = nodes.source(nodeKey)
      return {
        getSnapshot: () => {
          const node = source.getSnapshot() as ChatNode | undefined
          if (node?.kind === 'artifact') return node.data.snapshot.artifactId === artifactId ? node.data.snapshot : undefined
          if (node?.kind === 'artifact-comparison') {
            return [node.data.control, node.data.variant].find(artifact => artifact?.artifactId === artifactId)
          }
          return undefined
        },
        subscribe: listener => source.subscribe(listener),
      }
    }, { sessionId, runtimeFor: key => runtimeFor(sessionId).source(key) }, {
      read: async () => await csvDraftRemote().readDraft({ sessionId }),
      reconcile: async (expected) => {
        let checked: { requestId: ArtifactBranchCheckCsvComparisonDraftRequest['requestId']; check: CsvComparisonDraftCheck } | undefined
        const status = await ctx.conversation.reconcilePromptContext(sessionId, 'artifact', async (requestId) => {
          const check = await csvDraftRemote().checkDraft({ sessionId, requestId })
          checked = { requestId, check }
          return check.status === 'pending' ? 'pending' : check.status === 'accepted'
        }, expected)
        return status === 'untracked' || checked === undefined || status !== checked.check.status ? { status: 'untracked' }
          : { ...checked.check, requestId: checked.requestId }
      },
      check: async requestId => await csvDraftRemote().checkDraft({ sessionId, requestId }),
      save: async (attachment, expectedReceiptId) => await csvDraftRemote().saveDraft({ sessionId, attachment, expectedReceiptId }),
      clear: async (receiptId, requestId) => await csvDraftRemote().clearDraft({
        sessionId, receiptId, ...(requestId === undefined ? {} : { requestId }),
      }),
    })
    interactions.set(binding, owner)
    const initialPlot = artifactHostRouteAvailable(binding.session.getSnapshot()) ? readFunctionPlotDraft(sessionId) : undefined
    let savedPlot = initialPlot
    if (initialPlot !== undefined) owner.stageFunctionPlotDraft(initialPlot, t('promptContext.label'))
    ctx.effect(() => binding.ctx.effect(() => {
      const { csvDraft } = owner
      if (csvDraft === undefined) return () => { owner.dispose() }
      let plotSubmissionBlocked = false
      const syncSelection = (): void => {
        const selected = owner.selection.getSnapshot()
        const plot = selected?.kind === 'current-function-plot' ? selected.draft : undefined
        if (plot !== savedPlot) {
          writeFunctionPlotDraft(sessionId, plot)
          savedPlot = plot
        }
        const restoringPlot = selected?.kind === 'current-function-plot' && selected.restoration !== undefined
        if (plotSubmissionBlocked !== restoringPlot) {
          plotSubmissionBlocked = restoringPlot
          ctx.conversation.blocks.setSubmission(sessionId, PLOT_DRAFT_SUBMISSION_BLOCK, restoringPlot)
        }
        if (!owner.isActiveCsvComparisonSourceAvailable()) owner.clearCsvComparisonSourceVisit()
      }
      const unsubscribeSelection = owner.selection.subscribe(syncSelection)
      syncSelection()
      const stopPlotRestore = initialPlot === undefined ? undefined : ctx.uiSession.whenAccess(sessionId, 'session/events', () => {
        const retention = ctx.sessions.retainInfo(sessionId)
        let reading = false
        let disposed = false
        const update = (readFinished = false): void => {
          const selected = owner.selection.getSnapshot()
          const state = binding.session.getSnapshot()
          if (disposed || selected?.kind !== 'current-function-plot' || selected.draft !== initialPlot || selected.restoration === undefined
            || ctx.sessions.binding(sessionId) !== binding || !hasMainConversation(sessionId)
            || !artifactHostRouteAvailable(state) || state.openState !== 'open' || state.removed) return
          const event = sessionEventAt(binding, initialPlot.sourceSeq)
          if (event !== undefined) {
            if (chat.getSnapshot()?.nodes !== undefined) {
              owner.restoreFunctionPlotDraft(initialPlot, event.type === 'artifact/upsert' ? event.data : undefined)
            }
            return
          }
          if (missingSourceEvent(binding, initialPlot.sourceSeq) === 'invalid') {
            owner.restoreFunctionPlotDraft(initialPlot, undefined)
            return
          }
          if (reading || state.loadingOlder || selected.restoration === 'retry') return
          if (readFinished) {
            owner.pauseFunctionPlotRestore(initialPlot)
            return
          }
          reading = true
          const finish = (): void => {
            reading = false
            update(true)
          }
          void binding.session.loadThrough(SessionSeq(initialPlot.sourceSeq)).then(finish, finish)
        }
        const observe = (): void => { update() }
        const stopSession = binding.session.subscribe(observe)
        const stopEvents = binding.eventSource.subscribe(observe)
        const stopChat = chat.subscribe(observe)
        const stopSelection = owner.selection.subscribe(observe)
        const stopRetention = retention.subscribe(observe)
        update()
        return () => { disposed = true; stopSession(); stopEvents(); stopChat(); stopSelection(); stopRetention() }
      })
      const routeAvailable = (): boolean => {
        const state = binding.session.getSnapshot()
        return csvReplayRows !== undefined && artifactHostRouteAvailable(state) && state.openState === 'open' && !state.removed
      }
      const restore = (): void => {
        const available = routeAvailable()
        csvDraft.allowConfirmationPolling(available)
        if (available && csvDraft.phase.getSnapshot() === 'idle') csvDraft.restore()
      }
      const stopSourceStorage = ctx.uiSession.whenAccess(sessionId, 'session/events', () => owner.bindCsvSourceVisitStorage(
        () => readCsvComparisonSourceTrail(sessionId),
        (trail) => { writeCsvComparisonSourceTrail(sessionId, trail) },
      ))
      const stopExplanation = ctx.uiSession.whenAccess(sessionId, 'artifactBranchResults/reviewCsvComparisonExplanation', () => {
        const retention = ctx.sessions.retainInfo(sessionId)
        const detach = retention.subscribe(() => { if (!hasMainConversation(sessionId)) owner.csvExplanation.clear() })
        return () => { detach(); owner.csvExplanation.clear() }
      })
      const stop = ctx.uiSession.whenAccess(sessionId, 'artifactBranchResults/readCsvComparisonDraft', () => {
        let submittingBlocked = false
        const syncBlocking = (): void => {
          const next = routeAvailable() && csvDraft.phase.getSnapshot() === 'awaiting-confirmation'
          if (next === submittingBlocked) return
          ctx.conversation.blocks.setSubmission(sessionId, CSV_DRAFT_SUBMISSION_BLOCK, next)
          submittingBlocked = next
        }
        const unsubscribePhase = csvDraft.phase.subscribe(syncBlocking)
        const updateRoute = (): void => { restore(); syncBlocking() }
        const unsubscribeSession = binding.session.subscribe(updateRoute)
        const unsubscribeEvents = binding.eventSource.subscribe(() => {
          const outcome = csvDraft.outcome.getSnapshot()
          if (outcome?.status !== 'accepted' || outcome.queuedMessageId === undefined) return
          const { change } = binding.eventSource.getSnapshot()
          if (change.kind === 'settle-assistant') return
          for (const entry of change.entries) {
            if (entry.type === 'event' && entry.event.type === 'user/message' && entry.event.data.id === outcome.queuedMessageId
              && isAppendSurfaceEvent(entry.event)) csvDraft.observeSentQuestion(outcome.queuedMessageId)
          }
        })
        updateRoute()
        return () => {
          unsubscribeSession()
          unsubscribePhase()
          unsubscribeEvents()
          csvDraft.allowConfirmationPolling(false)
          if (submittingBlocked) ctx.conversation.blocks.setSubmission(sessionId, CSV_DRAFT_SUBMISSION_BLOCK, false)
        }
      })
      return () => {
        stop(); stopSourceStorage(); stopExplanation(); stopPlotRestore?.(); unsubscribeSelection(); owner.dispose()
        if (plotSubmissionBlocked) ctx.conversation.blocks.setSubmission(sessionId, PLOT_DRAFT_SUBMISSION_BLOCK, false)
      }
    }, 'ui-artifact: Session runtime'), 'ui-artifact: runtime and question context')
    return owner
  }
  const requireHostRoute = (sessionId: SessionId): void => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new ArtifactActionRequestError('unavailable', new Error(t('promptContext.unavailableSend')))
    if (!artifactHostRouteAvailable(binding.session.getSnapshot())) {
      throw new ArtifactActionRequestError('denied', new Error(t('route.subagentLocalOnly')))
    }
  }
  const saveExperimentHtml = (
    sessionId: SessionId, { eventSeq, messageId }: BranchEvidenceReference, { method, prefix }: ExperimentExportRoute,
    origin: 'returnedEvidence' | 'sentQuestion',
  ) => {
    const binding = ctx.sessions.binding(sessionId)
    const copy = {
      lang: ctx.locale.getLocale().active,
      revision: t('experimentExport.revision'),
      locked: t('experimentExport.locked'),
      reset: t('experimentExport.reset'),
      restoring: t('experimentExport.restoring'),
      restored: t('experimentExport.restored'),
      failed: t('experimentExport.failed'),
    }
    return ctx.fileActions.save({
      url: `${prefix}:${encodeURIComponent(sessionId)}/${eventSeq}/${encodeURIComponent(messageId)}.html`,
      name: `${prefix}-${eventSeq}.html`,
      mediaType: 'text/html',
      read: async (signal) => {
        signal.throwIfAborted()
        const read = experimentExportRemote?.[method]
        if (binding === undefined || ctx.sessions.binding(sessionId) !== binding || typeof read !== 'function') {
          throw new Error(t('branchEvidence.downloadExperimentFailed'))
        }
        requireHostRoute(sessionId)
        const request = { sessionId, eventSeq, messageId }
        const result = await read(request)
        if (!result.ok) throw result.error
        signal.throwIfAborted()
        const bytes = 'artifact' in result.value ? new TextEncoder().encode(buildLockedHtmlExperiment(result.value, request, origin, copy))
          : new Uint8Array(result.value)
        return new Blob([bytes], { type: 'text/html' })
      },
    }, 'download')
  }
  const questionInteractionFor = (sessionId: SessionId): ArtifactInteractionOwner | undefined => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error(t('promptContext.unavailableSend'))
    if (!artifactHostRouteAvailable(binding.session.getSnapshot())) return undefined
    return interactionFor(sessionId)
  }
  const continuationAvailable = createSnapshotStore(false)
  let continuation: {
    readonly start: (kind: Parameters<BranchEvidenceFollowupInjected['continueExperiment']>[0], request: ArtifactBranchContinuePlotRequest) => Promise<SessionId>
    readonly open: (sessionId: SessionId) => void
    readonly csvAnalysis: (
      sessionId: SessionId, ref: Parameters<BranchEvidenceFollowupInjected['csvAnalysis']>[0],
    ) => ReturnType<BranchEvidenceFollowupInjected['csvAnalysis']>
  } | undefined
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'artifact-branch-evidence', locale: NS,
    inject: (sessionId: SessionId): BranchEvidenceFollowupInjected => ({
      chooseBranchEvidence: (ref, replay) => {
        questionInteractionFor(sessionId)?.chooseBranchEvidence({ kind: 'branch-evidence', capturedSessionId: sessionId, ...ref }, replay)
      },
      chooseBranchHtml: (ref, artifact, state) => questionInteractionFor(sessionId)?.chooseBranchHtml(
        state.kind === 'bfs-checkpoint'
          ? { kind: 'branch-bfs-checkpoint', capturedSessionId: sessionId, ...ref, state }
          : { kind: 'branch-half-adder-checkpoint', capturedSessionId: sessionId, ...ref, state },
        artifact,
      ) ?? false,
      downloadReturnedExperiment: (kind, ref) => saveExperimentHtml(sessionId, ref, returnedExperimentRoutes[kind], 'returnedEvidence'),
      hooks: {
        continuationAvailable, returnedExperimentExports,
        csvReturnedComparisonSource: ctx.sessions.binding(sessionId) === undefined
          ? noSourceTrail : interactionFor(sessionId).csvComparisonSourceTrail,
      },
      returnToCsvOrigin: (source, openView) => {
        const binding = ctx.sessions.binding(sessionId)
        const current = (): boolean => ctx.sessions.binding(sessionId) === binding && hasMainConversation(sessionId)
        if (binding === undefined || !current()) return
        const owner = interactionFor(sessionId)
        const visit = owner.csvComparisonSourceTrail.getSnapshot()?.at(-1)
        if (visit === undefined || !isCsvReturnedSourceOrigin(visit.origin) || !sameCsvSentQuestion(visit.source, source)
          || verifyCsvReturnedSource(binding, sessionId, source, visit.origin, selectedCsvDraft(owner)) !== 'matched') return
        if (visit.origin.kind === 'draft') {
          restoreDraftFromCsvSource(binding, owner, visit, visit, current)
          return
        }
        if (!owner.returnToCsvComparisonSourceStop(visit, visit)) return
        const { message, side } = visit.origin
        openView('chat', JSON.stringify({ kind: 'message', ...message,
          control: `artifact-csv-return-${side}`, expandControl: 'artifact-csv-comparison' }))
      },
      csvAnalysis: (ref) => {
        if (continuation === undefined) throw new Error(t('csvAnalysis.failed'))
        return continuation.csvAnalysis(sessionId, ref)
      },
      readReturnedCsvRows: async (ref, offset) => {
        requireHostRoute(sessionId)
        if (csvReplayRows === undefined) throw new Error(t('csvAnalysis.rowsFailed'))
        return await csvReplayRows.returned({ sessionId, ...ref, offset })
      },
      continueExperiment: async (kind, ref, requestId) => {
        requireHostRoute(sessionId)
        if (continuation === undefined) throw new Error(t('branchEvidence.continueFailed'))
        return continuation.start(kind, { sessionId, ...ref, requestId })
      },
      openExperimentBranch: (childId) => {
        if (continuation === undefined) throw new Error(t('branchEvidence.continueFailed'))
        continuation.open(childId)
      },
    }),
  }, BranchEvidenceNodeView))
  ctx.slots.inject('conversation.chat.inquiry.actions', () => ctx.slots.register({
    name: 'conversation.chat.inquiry.actions', id: 'artifact-inquiry-returned-result', locale: NS,
    inject: (sessionId: SessionId): InquiryReturnedResultInjected => ({
      compareReturns: async (first, second, offset) => {
        requireHostRoute(sessionId)
        if (csvReplayRows === undefined) throw new Error(t('csvCompare.failed'))
        return await csvReplayRows.compareReturns({ sessionId, first, second, offset })
      },
      reviewAttachment: (attachment) => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined || attachment.facts.sessionId !== sessionId || attachment.facts.returns === undefined) return undefined
        const owner = interactionFor(sessionId)
        const previous = owner.selection.getSnapshot()
        const canConfirm = (): boolean => ctx.sessions.binding(sessionId) === binding && hasMainConversation(sessionId)
          && artifactHostRouteAvailable(binding.session.getSnapshot()) && owner.csvDraft?.phase.getSnapshot() === 'ready'
          && owner.selection.getSnapshot() === previous
        if (!canConfirm()) return undefined
        return {
          replacesContext: previous !== null,
          confirm: async () => canConfirm() && await owner.chooseCsvComparison(attachment),
        }
      },
    }),
  }, InquiryReturnedResultAction))
  const runtimeCommands = (sessionId: SessionId): Pick<ArtifactNodeInjected,
    'keyedHooks' | 'runtimeActions' | 'commandParticleRuntime' | 'chooseRuntimePromptContext' | 'chooseParticlePromptContext' | 'choosePlotPromptContext'
    | 'chooseCsvPromptContext' | 'chooseHtmlCheckpointPromptContext' | 'chooseObservationPromptContext' | 'chooseComparisonPromptContext'> => ({
    keyedHooks: { particleRuntime: key => interactionFor(sessionId).runtime(key),
      artifactRuntime: key => runtimeFor(sessionId).source(key) },
    runtimeActions: runtimeFor(sessionId).actions,
    commandParticleRuntime: (key: string, command: ParticleRunCommand) => { interactionFor(sessionId).command(key, command) },
    chooseRuntimePromptContext: (key, source, identity) => { questionInteractionFor(sessionId)?.chooseHtmlRuntime(key, source, identity) },
    chooseHtmlCheckpointPromptContext: (key, source, identity, checkpoint) =>
      questionInteractionFor(sessionId)?.chooseHtmlCheckpoint(key, source, identity, checkpoint) ?? false,
    chooseParticlePromptContext: (key, source, readings) =>
      questionInteractionFor(sessionId)?.chooseCurrent(key, source, readings) ?? false,
    choosePlotPromptContext: (key, source, conditions) => {
      const owner = questionInteractionFor(sessionId)
      if (owner === undefined) return false
      const entry = ctx.sessions.binding(sessionId)?.eventSource.getSnapshot().entries.findLast(({ event }) =>
        event.type === 'artifact/upsert' && event.data.artifactId === source.artifactId && event.data.revision === source.revision)
      return owner.chooseFunctionPlot(key, source, conditions, entry?.event.seq)
    },
    chooseCsvPromptContext: (key, source, groupKey) =>
      questionInteractionFor(sessionId)?.chooseCsvGroup(key, source, groupKey) ?? false,
    chooseObservationPromptContext: (saved) => { questionInteractionFor(sessionId)?.chooseObservation(saved) },
    chooseComparisonPromptContext: (group, control, variant) => {
      questionInteractionFor(sessionId)?.chooseComparison(group, control, variant)
    },
  })
  ctx.effect(() => ctx.conversation.registerPromptContext('artifact', (sessionId) => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) return undefined
    if (!artifactHostRouteAvailable(binding.session.getSnapshot())) {
      if (interactions.get(binding)?.selection.getSnapshot() != null) throw new Error(t('promptContext.subagentUnsupported'))
      return undefined
    }
    return interactionFor(sessionId).capture(t('promptContext.unavailableSend'))
  }, (sessionId, submitted, requestId) => {
    const binding = ctx.sessions.binding(sessionId)
    const owner = binding === undefined ? undefined : interactions.get(binding)
    const receiptId = csvDraftReceipt(submitted)
    if (receiptId === undefined) owner?.acceptFunctionPlot(submitted)
    else owner?.csvDraft?.accept(receiptId, requestId)
  }, async (sessionId, submitted, requestId, signal) => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding !== undefined) interactions.get(binding)?.csvDraft?.clearOutcome()
    const receiptId = csvDraftReceipt(submitted)
    if (receiptId === undefined) return false
    requireHostRoute(sessionId)
    signal?.throwIfAborted()
    await csvDraftRemote().bindDraft({ sessionId, receiptId, requestId })
    signal?.throwIfAborted()
    return true
  }), 'ui-artifact: prompt context capture')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'artifact-question-context', order: 5, locale: NS,
    inject: (sessionId: SessionId): ArtifactPromptContextInjected => {
      const owner = interactionFor(sessionId)
      const binding = ctx.sessions.binding(sessionId)
      const { selection, csvDraft } = owner
      const current = (): boolean => binding !== undefined && ctx.sessions.binding(sessionId) === binding
      const matchesSourceDraft = (
        source: CsvSentQuestion, receiptId: string, position?: CsvExplanationStep | CsvReturnComparisonSide,
      ): boolean => {
        const draft = selectedCsvDraft(owner)
        if (!current() || !hasMainConversation(sessionId) || draft?.receiptId !== receiptId) return false
        const target = position === 'first' || position === 'second' ? draft.facts.returns?.[position] : csvDraftSource(draft.facts, position)
        return sameCsvSentQuestion(target, source)
      }
      const openDraftSources = (first: CsvSentQuestion, rest: readonly CsvSentQuestion[], receiptId: string,
        selection: TokenSpan, open: () => void, position?: CsvExplanationStep | CsvReturnComparisonSide): void => {
        const selected = owner.selection.getSnapshot()
        if (binding === undefined || selected?.kind !== 'csv-question-comparison' || !matchesSourceDraft(first, receiptId, position)) return
        const { facts } = selected.draft
        const sourceKind = csvComparisonSourceKind(facts)
        const returnSide = position === 'first' || position === 'second' ? position : undefined
        const step = position === 'aggregation' || position === 'filtering' ? position : undefined
        if (returnSide !== undefined) {
          if (facts.returns === undefined || verifyCsvReturnedReading(binding, first, facts.returns, facts.comparison, returnSide) === 'invalid') return
        } else if ((step !== undefined || sourceKind !== undefined)
          && readCsvComparisonSource(binding, sessionId, first, sourceKind) === 'invalid') return
        if (owner.pendingCsvComparisonSourceTrail.getSnapshot() !== undefined) owner.clearCsvComparisonSourceVisit()
        const gesture = owner.beginCsvDraftNavigation()
        void ctx.conversation.input.for(binding.ctx).captureDraftFocus(selection).then((bookmark) => {
          if (owner.selection.getSnapshot() !== selected || !matchesSourceDraft(first, receiptId, position)
            || !owner.isCurrentCsvSourceVisitGesture(gesture)) return
          const visits = csvComparisonHistoryVisits(binding, sessionId, first, rest, sourceKind)
          if (visits !== undefined && owner.openCsvComparisonSourceTrail([{
            source: first, ...(sourceKind === undefined ? {} : { sourceKind }),
            origin: { kind: 'draft', receiptId, ...bookmark,
              ...(returnSide === undefined ? step === undefined ? {} : { step } : { returnSide }) },
          }, ...visits])) open()
        }).finally(() => { owner.finishCsvDraftNavigation(gesture) })
      }
      return {
        hooks: { artifactPromptContext: selection, csvComparisonDraft: csvDraft?.phase ?? draftUnavailable,
          csvComparisonDraftOutcome: csvDraft?.outcome ?? noDraftOutcome,
          csvComparisonDraftCleanupFailed: csvDraft?.cleanupFailed ?? noDraftCleanupError,
          pendingCsvComparisonSourceTrail: owner.pendingCsvComparisonSourceTrail,
          csvComparisonSourceRecovery: owner.csvComparisonSourceRecovery },
        retryFunctionPlotDraft: () => { if (current() && hasMainConversation(sessionId)) owner.retryFunctionPlotRestore() },
        restoreCsvComparisonDraft: () => { csvDraft?.restore() },
        loadCsvComparisonImport: async (json, signal) => {
          const active = (): boolean => !signal.aborted && current() && hasMainConversation(sessionId)
          if (!active() || csvDraft === undefined || binding === undefined || csvReplayRows === undefined) {
            throw new Error(t('csvCompare.importFailed'))
          }
          const previous = selection.getSnapshot()
          const canConfirm = (): boolean => active() && artifactHostRouteAvailable(binding.session.getSnapshot())
            && csvDraft.phase.getSnapshot() === 'ready' && selection.getSnapshot() === previous
          if (!canConfirm()) throw new Error(t('csvCompare.importFailed'))
          const attachment = await csvDraftRemote().importComparison({ sessionId, json })
          if (!canConfirm() || attachment.facts.sessionId !== sessionId || attachment.facts.attribution !== 'user-imported'
            || attachment.facts.reusedFrom !== undefined) throw new Error(t('csvCompare.importFailed'))
          return {
            page: attachment.facts.comparison,
            explanation: attachment.facts.explanation,
            returnCards: attachment.facts.returnCards,
            replacesContext: previous !== null,
            confirm: async () => {
              if (!canConfirm() || !await owner.chooseCsvComparison(attachment)) return false
              if (active()) ctx.conversation.input.for(binding.ctx).focus()
              return true
            },
          }
        },
        retryCsvComparisonDraftCleanup: () => { csvDraft?.retryCleanup() },
        dismissCsvComparisonDraftOutcome: () => { csvDraft?.clearOutcome() },
        selectCsvSentQuestion: (target) => {
          if (!csvDraft?.selectSentQuestion(target)) return false
          owner.clearCsvComparisonSourceVisit()
          return true
        },
        visitCsvDraftSource: (source, receiptId, selection, open, step) => {
          openDraftSources(source, [], receiptId, selection, open, step)
        },
        visitCsvDraftReturn: ({ eventSeq, messageId }, receiptId, selection, open, returnSide) => {
          openDraftSources({ eventSeq, messageId }, [], receiptId, selection, open, returnSide)
        },
        sourceQuestionLabel: target => csvSourceQuestionLabel(binding, target),
        loadCsvSourceChain: async (source, receiptId, signal) => {
          if (binding === undefined) throw new Error('The source conversation is unavailable')
          const selected = selection.getSnapshot()
          const sourceKind = selected?.kind === 'csv-question-comparison' ? csvComparisonSourceKind(selected.draft.facts) : undefined
          const checkDraft = (): void => {
            signal.throwIfAborted()
            if (csvDraft?.phase.getSnapshot() !== 'ready' || !matchesSourceDraft(source, receiptId)) throw new Error('The comparison draft changed')
          }
          return await loadCsvComparisonHistory(binding, sessionId, source, checkDraft, signal, sourceKind)
        },
        visitCsvDraftSourceChain: ([first, ...rest], receiptId, selection, open) => {
          const selected = owner.selection.getSnapshot()
          if (binding !== undefined && first !== undefined && csvDraft?.phase.getSnapshot() === 'ready'
            && selected?.kind === 'csv-question-comparison'
            && typeof readCsvComparisonSource(binding, sessionId, first, csvComparisonSourceKind(selected.draft.facts)) !== 'string') {
            openDraftSources(first, rest, receiptId, selection, open)
          }
        },
        restoreCsvSourceTrail: (trail, signal, open) => {
          const pending = (): boolean => owner.pendingCsvComparisonSourceTrail.getSnapshot() === trail
          if (signal.aborted || !current() || binding === undefined || !pending()) return
          if (!owner.isCsvComparisonSourceAvailable(trail[0])) {
            owner.clearCsvComparisonSourceVisit()
            return
          }
          const active = (): boolean => !signal.aborted && current() && pending()
          void verifyRestoredCsvSourceTrail(binding, sessionId, owner, trail, active).then((verified) => {
            if (verified === undefined || !active()) return
            if (!owner.restoreCsvComparisonSourceTrail(trail, verified)) {
              owner.clearCsvComparisonSourceVisit()
              return
            }
            const target = verified.trail?.at(-1)
            if (target !== undefined) revealCsvSource(target, open)
          })
        },
        retryCsvSourceRecovery: (recovery, open) => { retryCsvSourceRecovery(sessionId, binding, owner, recovery, open) },
        clearArtifactPromptContext: () => { owner.clear() },
      }
    },
  }, ArtifactPromptContextDock))
  ctx.inject(['remote.artifactBranchResults', 'uiWorkspace'], (scope: ClientContext) => {
    scope.effect(() => {
      continuation = {
        start: async (kind, request) => {
          const result = await (kind === 'particle-system'
            ? scope.remote.artifactBranchResults.continueParticle(request)
            : scope.remote.artifactBranchResults.continuePlot(request))
          if (!result.ok) throw result.error
          await scope.sessions.refresh()
          return result.value.sessionId
        },
        open: (childId) => { scope.uiWorkspace.openSession(childId) },
        csvAnalysis: (sessionId, ref) => ({
          recalculate: async (aggregate: CsvAggregate, filter?: CsvExactFilter) => {
            requireHostRoute(sessionId)
            const result = await scope.remote.artifactBranchResults.recalculateCsv({ sessionId, ...ref, aggregate,
              ...(filter === undefined ? {} : { filter }) })
            if (!result.ok) throw result.error
            return result.value
          },
          lock: async (aggregate: CsvAggregate, groupKey: string, filter?: CsvExactFilter) => {
            requireHostRoute(sessionId)
            const owner = questionInteractionFor(sessionId)
            if (owner === undefined) return false
            const previousSelection = owner.selection.getSnapshot()
            const result = await scope.remote.artifactBranchResults.lockCsv({ sessionId, ...ref, aggregate, groupKey,
              ...(filter === undefined ? {} : { filter }) })
            if (!result.ok) throw result.error
            if (previousSelection !== owner.selection.getSnapshot()) return false
            return owner.chooseLockedCsvGroup(result.value.artifact, result.value.groupKey)
          },
          filterOptions: async (column) => {
            requireHostRoute(sessionId)
            const result = await scope.remote.artifactBranchResults.csvFilterOptions({ sessionId, ...ref,
              ...(column === undefined ? {} : { column }) })
            if (!result.ok) throw result.error
            return result.value
          },
          participatingRows: async ({ aggregate, filter }, groupKey, offset) => {
            requireHostRoute(sessionId)
            const result = await scope.remote.artifactBranchResults.csvParticipatingRows({ sessionId, ...ref, aggregate, groupKey, offset,
              ...(filter === undefined ? {} : { filter }) })
            if (!result.ok) throw result.error
            return result.value
          },
        }),
      }
      continuationAvailable.set(true)
      return () => {
        continuation = undefined
        continuationAvailable.set(false)
      }
    }, 'ui-artifact: experiment continuation')
    scope.slots.inject('conversation.chat.assistant.details', () => scope.slots.register({
      name: 'conversation.chat.assistant.details',
      id: 'artifact-branch-result',
      locale: NS,
      inject: (sessionId: SessionId): ArtifactBranchResultInjected => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined) throw new Error('ui-artifact: branch Session is unavailable')
        const chat = ctx.uiConversation.binding(binding).target('chat')
        const messages = (turn: string, kind: 'user' | 'steering') => {
          const snapshot = chat.getSnapshot()
          if (snapshot === undefined) throw new Error('ui-artifact: Chat target is unavailable')
          return snapshot.nodes.turnDataSource(Number(turn), kind)
        }
        return {
          returnResult: request => returnArtifactBranchResult(scope, request),
          openSession: (parentId) => { scope.uiWorkspace.openSession(parentId) },
          keyedHooks: {
            userMessages: turn => messages(turn, 'user'),
            steeringMessages: turn => messages(turn, 'steering'),
          },
        }
      },
    }, ArtifactBranchResultAction))
  })
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'artifact',
    locale: NS,
    store: artifactPresentationStore,
    inject: (sessionId: SessionId): ArtifactNodeInjected => ({
      ...runtimeCommands(sessionId),
      exports: { create: async (request) => { requireHostRoute(sessionId); return createArtifactExport(ctx, sessionId, request) },
        download: async (record) => { requireHostRoute(sessionId); return downloadArtifactExport(ctx, sessionId, record) } },
      recordAction: async (artifactId, revision, action, payload, wake, requestId) => {
        requireHostRoute(sessionId)
        return recordArtifactAction(ctx, sessionId, artifactId, revision, action, payload, wake, requestId)
      },
      saveObservation: async (artifactId, revision, observationId, label, checkpoint) => {
        requireHostRoute(sessionId)
        return saveArtifactObservation(ctx, sessionId, artifactId, revision, observationId, label, checkpoint)
      },
      sendObservation: async (artifactId, observationId, wake) => {
        requireHostRoute(sessionId)
        return sendArtifactObservation(ctx, sessionId, artifactId, observationId, wake)
      },
      confirmObservationComparison: async (group, control, variant, wake) => {
        requireHostRoute(sessionId)
        return confirmArtifactObservationComparison(ctx, sessionId, group, control, variant, wake)
      },
    }),
  }, ArtifactNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'artifact-comparison',
    locale: NS,
    inject: (sessionId: SessionId): ArtifactNodeInjected => ({
      ...runtimeCommands(sessionId),
      exports: { create: async (request) => { requireHostRoute(sessionId); return createArtifactExport(ctx, sessionId, request) },
        download: async (record) => { requireHostRoute(sessionId); return downloadArtifactExport(ctx, sessionId, record) } },
      recordAction: async (artifactId, revision, action, payload, wake, requestId) => {
        requireHostRoute(sessionId)
        return recordArtifactAction(ctx, sessionId, artifactId, revision, action, payload, wake, requestId)
      },
      saveObservation: async (artifactId, revision, observationId, label, checkpoint) => {
        requireHostRoute(sessionId)
        return saveArtifactObservation(ctx, sessionId, artifactId, revision, observationId, label, checkpoint)
      },
      sendObservation: async (artifactId, observationId, wake) => {
        requireHostRoute(sessionId)
        return sendArtifactObservation(ctx, sessionId, artifactId, observationId, wake)
      },
      confirmObservationComparison: async (group, control, variant, wake) => {
        requireHostRoute(sessionId)
        return confirmArtifactObservationComparison(ctx, sessionId, group, control, variant, wake)
      },
    }),
  }, ArtifactComparisonNodeView))
}
