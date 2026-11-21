/** Resolve one returned CSV chart before accessing its original Session attachment. */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@agentrans/cordis'
import {
  CsvAttachmentError, compareCsvParticipatingRows, csvAttachmentRefFromBlock, groupCsvAttachment, readCsvFilterOptions,
  readCsvParticipatingRows,
} from '@agentrans/artifact/attachment-csv-tool'
import { CSV_AGGREGATES, normalizeCsvExactFilter, normalizeSceneSpec, SceneValidationError, type CsvBarChartSpec } from '@agentrans/artifact/scene'
import type { SceneArtifactSnapshot } from '@agentrans/artifact/types'
import type { SessionRequestId } from '@agentrans/api-session-controller/types'
import {
  csvComparisonDrafts, csvComparisonDraftUnavailable, csvComparisonQuestionBlock,
  isPortableCsvComparisonExplanation, isPortableCsvComparisonPage,
  readCsvComparisonQuestionBlock, resolveReturnedReadings, returnedReadingNotice, sealCsvComparisonQuestion,
} from '@agentrans/artifact-followup'
import type {
  ArtifactCsvComparisonAttachment, ArtifactCsvComparisonDraft, ArtifactCsvComparisonLocalExplanationFacts,
  ArtifactCsvComparisonPage, ArtifactCsvComparisonQuestionFacts, ArtifactCsvComparisonReading, ArtifactCsvComparisonReturnCard,
  ArtifactCsvComparisonReturnCards, ArtifactCsvComparisonReturnedFacts,
  ArtifactCsvComparisonSingleFacts,
} from '@agentrans/artifact-followup/types'
import type { UserMessage } from '@agentrans/llm'
import { SessionSeq, type SessionId } from '@agentrans/session'
import { selectBranchResult } from '@agentrans/session-branch'
import { SessionQueryError, type SessionObservation } from '@agentrans/session-query'
import { principalOf, RemoteError } from '@agentrans/typert-protocol'
import { csvComparisonImportInvalid, readCsvComparisonSnapshot } from './csv-comparison-snapshot.ts'
import { resolveContinuedCsvQuestion, resolveQuestionEvidence } from './question-evidence.ts'
import type {
  ArtifactBranchCsvComparisonReading, ArtifactBranchCsvEvidenceRef, ArtifactBranchCsvFailure, ArtifactBranchCsvFilterOptionsRequest,
  ArtifactBranchCsvFilterOptionsValue, ArtifactBranchCsvQuestionComparisonRequest, ArtifactBranchCsvQuestionComparisonValue,
  ArtifactBranchCsvQuestionRowsRequest, ArtifactBranchCsvQuestionRowsValue, ArtifactBranchCsvReturnedComparisonRequest,
  ArtifactBranchCsvReturnedComparisonValue, ArtifactBranchCsvReturnedRowsRequest, ArtifactBranchCsvRowsRequest, ArtifactBranchCsvRowsValue,
  ArtifactBranchRecalculateCsvRequest, ArtifactBranchRecalculatedCsv,
  ArtifactBranchBindCsvComparisonDraftRequest, ArtifactBranchBindCsvComparisonDraftValue,
  ArtifactBranchCheckCsvComparisonDraftRequest, ArtifactBranchCheckCsvComparisonDraftValue,
  ArtifactBranchClearCsvComparisonDraftRequest, ArtifactBranchClearCsvComparisonDraftValue, ArtifactBranchReadCsvComparisonDraftRequest,
  ArtifactBranchImportCsvComparisonRequest, ArtifactBranchReviewCsvComparisonExplanationRequest,
  ArtifactBranchReviewSentCsvComparisonRequest, ArtifactBranchSaveCsvComparisonDraftRequest,
} from './types.ts'

/**
 * Reject one CSV operation with its wire reason and an optional underlying failure.
 * @param reason - Wire reason reported as `artifact-branch/csv-analysis-unavailable` details.
 * @param cause - Underlying attachment, CSV or Scene validation failure, when one caused the refusal.
 * @returns Never; always throws a `RemoteError`.
 */
export function csvAnalysisUnavailable(reason: ArtifactBranchCsvFailure, cause?: Error): never {
  throw new RemoteError('artifact-branch/csv-analysis-unavailable', 'The selected returned CSV analysis is unavailable',
    { reason }, cause === undefined ? undefined : { cause })
}

function requestEventSeq(value: number) {
  try { return SessionSeq(value) } catch {
    throw new RemoteError('gateway/bad-request', 'eventSeq must be a non-negative safe integer', {})
  }
}

async function observe(ctx: Context, id: SessionId, signal: AbortSignal): Promise<SessionObservation | undefined> {
  try {
    return await ctx.sessionQuery.observeSession(id, { projectionMode: 'none', signal })
  } catch (error) {
    if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return undefined
    throw error
  }
}

function findCsvInput(child: SessionObservation, questionSeq: number, artifact: SceneArtifactSnapshot, spec: CsvBarChartSpec) {
  const cutoff = child.events.findLastIndex(event => event.seq < questionSeq && event.type === 'artifact/upsert'
    && event.data.artifactId === artifact.artifactId && event.data.revision === artifact.revision)
  if (cutoff < 0) return undefined
  for (let index = 0; index < cutoff; index++) {
    const event = child.events[index]
    if (event?.type !== 'user/message' || event.data.source.kind !== 'user') continue
    for (const block of event.data.content) {
      const ref = csvAttachmentRefFromBlock(block)
      if (ref?.attachmentId === spec.attachmentId) return ref
    }
  }
  return undefined
}

async function resolveReturnedCsv(ctx: Context, request: ArtifactBranchCsvEvidenceRef, signal: AbortSignal) {
  using parent = await observeReceivingSession(ctx, request.sessionId, signal)
  return await resolveOriginalCsv(ctx, parent, request, signal)
}

async function observeReceivingSession(ctx: Context, sessionId: SessionId, signal: AbortSignal): Promise<SessionObservation> {
  const parent = await observe(ctx, sessionId, signal)
  if (parent === undefined) throw new RemoteError('session/not-found', 'The receiving Session was not found', { sessionId })
  return parent
}

async function resolveOriginalCsv(ctx: Context, parent: SessionObservation, request: ArtifactBranchCsvEvidenceRef, signal: AbortSignal) {
  const { sessionId, messageId } = request
  const eventSeq = requestEventSeq(request.eventSeq)
  const retained = parentCsvReturn(parent, eventSeq, messageId)
  if (retained === undefined) return csvAnalysisUnavailable('SOURCE_NOT_FOUND')
  const { event, notice, returned, readings, spec, source } = retained
  const { artifact } = readings
  const { questionSeq } = returned.branchResult
  using child = await observe(ctx, notice.branchSessionId, signal)
  if (child === undefined) return csvAnalysisUnavailable('SOURCE_NOT_FOUND')
  const resultSeq = SessionSeq(notice.resultSeq)
  const conclusion = selectBranchResult(child, sessionId, resultSeq)
  const question = child.events[questionSeq]
  if (!conclusion.ok || conclusion.value.reference.resultMessageId !== source.resultMessageId
    || !isDeepStrictEqual(conclusion.value.content, event.data.content.slice(0, -1))
    || question?.type !== 'user/message') return csvAnalysisUnavailable('SOURCE_NOT_FOUND')
  const original = question.data.content.some((_block, blockIndex) => {
    const evidence = resolveQuestionEvidence(child, resultSeq, { kind: 'question', questionSeq, blockIndex })
    return evidence?.facts.kind === 'current-csv-bar-chart' && evidence.facts.artifact.csvContinuation === undefined
      && isDeepStrictEqual(evidence.facts, readings)
  })
  if (!original) return csvAnalysisUnavailable('SOURCE_NOT_FOUND')
  const ref = findCsvInput(child, questionSeq, artifact, spec)
  const store = ctx.get('attachments')
  if (ref === undefined || store === undefined) return csvAnalysisUnavailable('ATTACHMENT_UNAVAILABLE')
  return { store, ref, spec, title: artifact.title, recordedGroup: readings.values,
    branch: { sessionId: child.header.id, resultSeq, inquiry: child.header.inquiry !== undefined },
    source: { sessionId, eventSeq, messageId, artifactId: artifact.artifactId, revision: artifact.revision } }
}

function parentCsvReturn(parent: SessionObservation, eventSeq: number, messageId: ArtifactBranchCsvEvidenceRef['messageId']) {
  const event = parent.events[eventSeq]
  if (parent.header.origin === 'subagent' || eventSeq < parent.inheritedEventCount || event?.seq !== eventSeq
    || event.type !== 'user/message') return undefined
  const { source } = event.data
  if (source.kind !== 'branch-result') return undefined
  const notice = returnedReadingNotice(event)
  if (notice?.messageId !== messageId) return undefined
  const returned = resolveReturnedReadings(notice, eventSeq)
  const readings = returned?.readings
  if (returned === undefined || readings?.kind !== 'current-csv-bar-chart' || readings.artifact.spec.kind !== 'csv-bar-chart'
    || readings.artifact.csvContinuation !== undefined) return undefined
  return { event, notice, returned, readings, spec: readings.artifact.spec, source }
}

type ResolvedCsv = Awaited<ReturnType<typeof resolveReturnedCsv>>

async function readAuthorizedCsv<T>(csv: ResolvedCsv, read: (source: ResolvedCsv) => Promise<T>): Promise<T> {
  try {
    return await read(csv)
  } catch (error) {
    if (csv.store.isAttachmentError(error)) return csvAnalysisUnavailable('ATTACHMENT_UNAVAILABLE', error)
    if (error instanceof CsvAttachmentError || error instanceof SceneValidationError) return csvAnalysisUnavailable('RESULT_UNAVAILABLE', error)
    throw error
  }
}

function selectedFilter(request: ArtifactBranchRecalculateCsvRequest) {
  if (!CSV_AGGREGATES.includes(request.aggregate)) throw new RemoteError('gateway/bad-request', 'Invalid CSV aggregation', {})
  if (request.filter === undefined) return undefined
  try { return normalizeCsvExactFilter(request.filter) } catch (error) {
    if (!(error instanceof SceneValidationError)) throw error
    throw new RemoteError('gateway/bad-request', 'Invalid CSV filter', {}, { cause: error })
  }
}

/**
 * Resolve and recalculate an exact returned chart, with access limited to its original authorized CSV.
 * @param ctx - Host context of the owner's invocation.
 * @param request - Returned-message address, aggregation and optional exact-match filter.
 * @param signal - Lifetime of the Session observations and the CSV read.
 * @returns The recalculated chart, the returned chart title and its exact source revision.
 */
export async function recalculateReturnedCsv(ctx: Context, request: ArtifactBranchRecalculateCsvRequest,
  signal: AbortSignal): Promise<ArtifactBranchRecalculatedCsv> {
  const filter = selectedFilter(request)
  const { aggregate } = request
  const csv = await resolveReturnedCsv(ctx, request, signal)
  const { valueColumn, groupBy } = csv.spec
  if (aggregate !== 'count' && valueColumn === undefined) return csvAnalysisUnavailable('AGGREGATE_UNAVAILABLE')
  return await readAuthorizedCsv(csv, async ({ store, ref, title, source }) => {
    const next = await groupCsvAttachment(store, ref, { groupBy, aggregate,
      ...(aggregate === 'count' || valueColumn === undefined ? {} : { valueColumn }),
      ...(filter === undefined ? {} : { filter }) }, signal)
    const spec = normalizeSceneSpec(next)
    if (spec.kind !== 'csv-bar-chart') throw new Error('Expected a recalculated CSV scene')
    return { spec, title, source }
  })
}

/**
 * Read headings and bounded distinct options from the exact returned chart's CSV.
 * @param ctx - Host context of the owner's invocation.
 * @param request - Returned-message address and an optional column of at most 128 UTF-8 bytes.
 * @param signal - Lifetime of the Session observations and the CSV read.
 * @returns Column headings, or the bounded distinct values of the requested column.
 */
export async function filterOptionsForReturnedCsv(ctx: Context, request: ArtifactBranchCsvFilterOptionsRequest,
  signal: AbortSignal): Promise<ArtifactBranchCsvFilterOptionsValue> {
  const { column } = request
  if (column !== undefined && (Buffer.byteLength(column, 'utf8') > 128 || column.trim() === '')) {
    throw new RemoteError('gateway/bad-request', 'Invalid CSV filter column', {})
  }
  const csv = await resolveReturnedCsv(ctx, request, signal)
  return await readAuthorizedCsv(csv, ({ store, ref }) => readCsvFilterOptions(store, ref, column, signal))
}

/**
 * Read one bounded page of the records used by the selected group and filter.
 * @param ctx - Host context of the owner's invocation.
 * @param request - Returned-message address, aggregation, group key, optional filter and record offset.
 * @param signal - Lifetime of the Session observations and the CSV read.
 * @returns One page of participating records and their total count.
 */
export async function readReturnedCsvRows(ctx: Context, request: ArtifactBranchCsvRowsRequest,
  signal: AbortSignal): Promise<ArtifactBranchCsvRowsValue> {
  const filter = selectedFilter(request)
  const { aggregate, groupKey } = request
  const offset = rowsOffset(request.offset)
  if (Buffer.byteLength(groupKey, 'utf8') > 256) return csvAnalysisUnavailable('INVALID_GROUP')
  const csv = await resolveReturnedCsv(ctx, request, signal)
  return await readCsvRows(csv, { aggregate, groupKey, offset, filter }, signal)
}

/**
 * Resolve and read only the records used by the adopted CSV reading.
 * @param ctx - Host context of the owner's invocation.
 * @param request - Returned-message address and record offset.
 * @param signal - Lifetime of the Session observations and the CSV read.
 * @returns One page of the recorded group's records; a total that differs from the recorded count is refused.
 */
export async function readReturnedCsvEvidenceRows(ctx: Context, request: ArtifactBranchCsvReturnedRowsRequest,
  signal: AbortSignal): Promise<ArtifactBranchCsvRowsValue> {
  const offset = rowsOffset(request.offset)
  const csv = await resolveReturnedCsv(ctx, request, signal)
  const { aggregate, filter } = csv.spec
  const { key: groupKey, count } = csv.recordedGroup
  return await readRecordedGroupRows(csv, { aggregate, groupKey, offset, filter }, count, signal)
}

function rowsOffset(offset = 0): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 20_000) {
    throw new RemoteError('gateway/bad-request', 'Invalid CSV record offset', {})
  }
  return offset
}

type CsvRowRecipe = Pick<ArtifactBranchCsvRowsRequest, 'aggregate' | 'groupKey'> & {
  readonly offset: number
  readonly filter: CsvBarChartSpec['filter']
}

async function readCsvRows(csv: ResolvedCsv, recipe: CsvRowRecipe, signal: AbortSignal): Promise<ArtifactBranchCsvRowsValue> {
  const { aggregate, groupKey, offset, filter } = recipe
  const { valueColumn, groupBy } = csv.spec
  if (aggregate !== 'count' && valueColumn === undefined) return csvAnalysisUnavailable('AGGREGATE_UNAVAILABLE')
  if (!csv.spec.groups.some(group => group.key === groupKey)) return csvAnalysisUnavailable('INVALID_GROUP')
  return await readAuthorizedCsv(csv, ({ store, ref }) => readCsvParticipatingRows(store, ref, { groupBy, groupKey, offset,
    ...(valueColumn === undefined ? {} : { valueColumn }), ...(filter === undefined ? {} : { filter }) }, signal))
}

async function readRecordedGroupRows(csv: ResolvedCsv, recipe: CsvRowRecipe, count: number,
  signal: AbortSignal): Promise<ArtifactBranchCsvRowsValue> {
  const page = await readCsvRows(csv, recipe, signal)
  if (page.total !== count) return csvAnalysisUnavailable('RESULT_CONFLICT')
  return page
}

async function resolveCsvQuestionAndReturn(ctx: Context, request: ArtifactBranchCsvQuestionRowsRequest, signal: AbortSignal) {
  const { sessionId, messageId } = request
  const questionSeq = requestEventSeq(request.eventSeq)
  using parent = await observeReceivingSession(ctx, sessionId, signal)
  if (parent.header.origin === 'subagent') return csvAnalysisUnavailable('SOURCE_NOT_FOUND')
  const question = resolveContinuedCsvQuestion(parent, questionSeq, messageId)
  if (question === undefined) return csvAnalysisUnavailable('SOURCE_NOT_FOUND')
  const { source, spec, group } = question
  const csv = await resolveOriginalCsv(ctx, parent, source, signal)
  const { valueColumn } = csv.spec
  if (csv.source.artifactId !== source.artifactId || csv.source.revision !== source.revision
    || csv.spec.attachmentId !== spec.attachmentId || csv.spec.groupBy !== spec.groupBy
    || spec.aggregate !== 'count' && spec.valueColumn !== valueColumn) return csvAnalysisUnavailable('SOURCE_NOT_FOUND')
  return { csv, spec, group }
}

/**
 * Resolve and read only the records used by the group locked on one sent question.
 * @param ctx - Host context of the owner's invocation.
 * @param request - Sent question address and record offset.
 * @param signal - Lifetime of the Session observations and the CSV read.
 * @returns One page of the locked group's records and the value column when the chart has one.
 */
export async function readCsvQuestionRows(ctx: Context, request: ArtifactBranchCsvQuestionRowsRequest,
  signal: AbortSignal): Promise<ArtifactBranchCsvQuestionRowsValue> {
  const offset = rowsOffset(request.offset)
  const { csv, spec, group } = await resolveCsvQuestionAndReturn(ctx, request, signal)
  const { valueColumn } = csv.spec
  const recipe = { aggregate: spec.aggregate, groupKey: group.key, offset, filter: spec.filter }
  const page = await readRecordedGroupRows(csv, recipe, group.count, signal)
  return { ...page, ...(valueColumn === undefined ? {} : { valueColumn }) }
}

function comparisonReading(spec: CsvBarChartSpec, group: CsvBarChartSpec['groups'][number]): ArtifactBranchCsvComparisonReading {
  const { aggregate, filter, valueColumn } = spec
  const { key: groupKey, value, count } = group
  return { groupKey, aggregate, value, count,
    ...(valueColumn === undefined ? {} : { valueColumn }), ...(filter === undefined ? {} : { filter }) }
}

async function compareRecordedCsvReadings(csv: ResolvedCsv, spec: CsvBarChartSpec, group: CsvBarChartSpec['groups'][number],
  offset: number, signal: AbortSignal): Promise<ArtifactCsvComparisonPage> {
  if (csv.recordedGroup.key !== group.key) return csvAnalysisUnavailable('GROUP_MISMATCH')
  const original = comparisonReading(csv.spec, csv.recordedGroup)
  const current = comparisonReading(spec, group)
  const { groupBy } = csv.spec
  const valueColumn = csv.spec.valueColumn ?? spec.valueColumn
  const page = await readAuthorizedCsv(csv, ({ store, ref }) => compareCsvParticipatingRows(store, ref, {
    groupBy, groupKey: current.groupKey, offset,
    ...(valueColumn === undefined ? {} : { valueColumn }),
    ...(original.filter === undefined ? {} : { originalFilter: original.filter }),
    ...(current.filter === undefined ? {} : { currentFilter: current.filter }),
  }, signal))
  if (page.kept + page.excluded !== original.count || page.kept + page.added !== current.count) {
    return csvAnalysisUnavailable('RESULT_CONFLICT')
  }
  return { original, current, ...page }
}

/**
 * Compare the two saved calculations against one verified read of the original CSV.
 * @param ctx - Host context of the owner's invocation.
 * @param request - Sent question address and record offset.
 * @param signal - Lifetime of the Session observations and the CSV read.
 * @returns One comparison page, with a sealed attachment when the draft store is available.
 */
export async function compareCsvQuestionToReturn(ctx: Context, request: ArtifactBranchCsvQuestionComparisonRequest,
  signal: AbortSignal): Promise<ArtifactBranchCsvQuestionComparisonValue> {
  const offset = rowsOffset(request.offset)
  const { csv, spec, group } = await resolveCsvQuestionAndReturn(ctx, request, signal)
  const comparison = await compareRecordedCsvReadings(csv, spec, group, offset, signal)
  const { sessionId, eventSeq, messageId } = request
  const { sessionId: _sourceSession, ...source } = csv.source
  const attachment = csvComparisonDrafts(ctx) === undefined ? undefined : sealCsvComparisonQuestion(ctx, {
    kind: 'csv-question-comparison', sessionId, question: { eventSeq, messageId }, source, comparison,
  })
  return attachment === undefined ? comparison : { ...comparison, attachment }
}

/**
 * Read one comparison page from two exact returned CSV readings in the same inquiry.
 * @param ctx - Host context of the owner's invocation.
 * @param request - Receiving Session, the earlier and later returned messages, and record offset.
 * @param signal - Lifetime of the Session observations and the CSV read.
 * @returns One comparison page, with a sealed attachment for an owner call that satisfies the portable page limits.
 */
export async function compareCsvReturns(ctx: Context, request: ArtifactBranchCsvReturnedComparisonRequest,
  signal: AbortSignal): Promise<ArtifactBranchCsvReturnedComparisonValue> {
  const offset = rowsOffset(request.offset)
  const { sessionId, first, second } = request
  if (first.eventSeq === second.eventSeq) return csvAnalysisUnavailable('SOURCE_NOT_FOUND')
  using parent = await observeReceivingSession(ctx, sessionId, signal)
  const original = await resolveOriginalCsv(ctx, parent, { ...first, sessionId }, signal)
  if (!original.branch.inquiry) return csvAnalysisUnavailable('SOURCE_NOT_FOUND')
  const current = await resolveOriginalCsv(ctx, parent, { ...second, sessionId }, signal)
  if (current.branch.sessionId !== original.branch.sessionId || current.branch.resultSeq === original.branch.resultSeq) {
    return csvAnalysisUnavailable('SOURCE_NOT_FOUND')
  }
  const originalMeasure = original.spec.valueColumn
  const currentMeasure = current.spec.valueColumn
  if (original.ref.attachmentId !== current.ref.attachmentId || original.ref.bytes !== current.ref.bytes
    || original.spec.groupBy !== current.spec.groupBy
    || (originalMeasure !== undefined && currentMeasure !== undefined && originalMeasure !== currentMeasure)) {
    return csvAnalysisUnavailable('RESULT_CONFLICT')
  }
  const comparison = await compareRecordedCsvReadings(original, current.spec, current.recordedGroup, offset, signal)
  if (principalOf(ctx.invocation) !== undefined || csvComparisonDrafts(ctx) === undefined
    || original.source.eventSeq >= current.source.eventSeq || original.source.messageId === current.source.messageId
    || !isPortableCsvComparisonPage(comparison)) {
    return comparison
  }
  const { sessionId: _firstSession, ...firstReturn } = original.source
  const { sessionId: _secondSession, ...secondReturn } = current.source
  const attachment = sealCsvComparisonQuestion(ctx, { kind: 'csv-question-comparison', sessionId, comparison,
    returns: { branchSessionId: original.branch.sessionId, first: firstReturn, second: secondReturn } })
  return attachment === undefined ? comparison : { ...comparison, attachment }
}

function requireDraftOwner(ctx: Context): void {
  if (principalOf(ctx.invocation) !== undefined) csvComparisonDraftUnavailable('UNAVAILABLE')
}

/**
 * Read a private current draft without resuming an Agent.
 * @param ctx - Host context of the owner's invocation.
 * @param request - Receiving Session.
 * @param signal - Lifetime of the Session observations.
 * @returns The reconciled draft, or `null` when no draft store is mounted or no draft remains.
 */
export async function readCsvComparisonDraft(ctx: Context, request: ArtifactBranchReadCsvComparisonDraftRequest,
  signal: AbortSignal): Promise<ArtifactCsvComparisonDraft | null> {
  requireDraftOwner(ctx)
  using session = await observeReceivingSession(ctx, request.sessionId, signal)
  if (session.header.origin === 'subagent') return csvComparisonDraftUnavailable('UNAVAILABLE')
  const drafts = csvComparisonDrafts(ctx)
  if (drafts === undefined) return null
  return await drafts.reconcile(request.sessionId, async ({ requestId, facts, savedAfterSeq }) => {
    if (requestId === undefined) return 'absent'
    try {
      const { accepted, pending } = await comparisonPromptStatus(ctx, request.sessionId, requestId, signal, facts, savedAfterSeq)
      return accepted ? 'accepted' : pending === true ? 'pending' : 'absent'
    } catch {
      signal.throwIfAborted()
      return 'pending'
    }
  })
}

/**
 * Preserve a reviewed page apart from the receiving Session event log.
 * @param ctx - Host context of the owner's invocation.
 * @param request - Receiving Session, expected receipt and reviewed attachment.
 * @param signal - Lifetime of the Session observation.
 * @returns The saved draft bound to the current Session cursor.
 */
export async function saveCsvComparisonDraft(ctx: Context, request: ArtifactBranchSaveCsvComparisonDraftRequest,
  signal: AbortSignal): Promise<ArtifactCsvComparisonDraft> {
  requireDraftOwner(ctx)
  using session = await observeReceivingSession(ctx, request.sessionId, signal)
  if (session.header.origin === 'subagent') return csvComparisonDraftUnavailable('UNAVAILABLE')
  const drafts = csvComparisonDrafts(ctx) ?? csvComparisonDraftUnavailable('UNAVAILABLE')
  return await drafts.save(request.sessionId, request.expectedReceiptId, request.attachment, session.cursor)
}

type ComparisonPromptAdmission = {
  readonly event: SessionObservation['events'][number]
  readonly message: UserMessage
  readonly block: string
}

function findComparisonPrompt(session: SessionObservation, requestId: SessionRequestId,
  facts?: ArtifactCsvComparisonQuestionFacts, savedAfterSeq = -1): ComparisonPromptAdmission | undefined {
  // The provider serializes only the captured comparison and no private receipt.
  const expectedBlock = facts === undefined ? undefined : csvComparisonQuestionBlock(facts).text
  for (let index = session.inheritedEventCount; index < session.events.length; index++) {
    const event = session.events[index]
    if (event === undefined) continue
    const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted : event.type === 'user/message' ? [event.data] : []
    const first = messages.find(message => message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === requestId)
    if (first === undefined || first.source.kind !== 'user' || !('rpcId' in first.source)) continue
    if (event.seq <= savedAfterSeq || first.source.principal !== undefined) return undefined
    const block = first.content.find(block => block.type === 'text' && (expectedBlock === undefined
      ? readCsvComparisonQuestionBlock(block.text, session.header.id) !== undefined
      : block.text === expectedBlock))
    return block?.type === 'text' ? { event, message: first, block: block.text } : undefined
  }
  return undefined
}

type ComparisonPromptTarget = Pick<Extract<ArtifactBranchCheckCsvComparisonDraftValue, { accepted: true }>, 'message' | 'queuedMessageId'>

function comparisonPromptTarget(session: SessionObservation, requestId: SessionRequestId,
  admission: ComparisonPromptAdmission): ComparisonPromptTarget {
  const { event, message, block } = admission
  for (let index = event.seq; index < session.events.length; index++) {
    const candidate = session.events[index]
    if (candidate?.type !== 'user/message' || candidate.data.id !== message.id) continue
    if (candidate.surfaceOp !== 'append' || candidate.data.source.kind !== 'user' || !('rpcId' in candidate.data.source)
      || candidate.data.source.rpcId !== requestId || candidate.data.source.principal !== undefined
      || !candidate.data.content.some(content => content.type === 'text' && content.text === block)) return {}
    return { message: { eventSeq: candidate.seq, messageId: candidate.data.id } }
  }
  return event.type === 'agent/inbox/spliced' ? { queuedMessageId: message.id } : {}
}

async function comparisonPromptIsDurable(ctx: Context, session: SessionObservation, requestId: SessionRequestId,
  facts?: ArtifactCsvComparisonQuestionFacts, savedAfterSeq?: number): Promise<boolean> {
  if (findComparisonPrompt(session, requestId, facts, savedAfterSeq) === undefined) return false
  return await flushComparisonPrompt(ctx, session)
}

async function flushComparisonPrompt(ctx: Context, session: SessionObservation): Promise<boolean> {
  if (session.source !== 'live') return true
  const live = ctx.sessions.get(session.header.id)
  return live !== undefined && await ctx.sessions.flush(live)
}

/**
 * Persist the exact request identity before the client dispatches its ordinary prompt.
 * @param ctx - Host context of the owner's invocation.
 * @param request - Receiving Session, draft receipt and the client request ID of at most 128 characters.
 * @param signal - Lifetime of the Session observations.
 * @returns `{ bound: true }`; a previous request still in flight or already accepted is refused.
 */
export async function bindCsvComparisonDraftRequest(ctx: Context, request: ArtifactBranchBindCsvComparisonDraftRequest,
  signal: AbortSignal): Promise<ArtifactBranchBindCsvComparisonDraftValue> {
  requireDraftOwner(ctx)
  const { sessionId, receiptId, requestId } = request
  if (requestId.trim() === '' || requestId.length > 128) throw new RemoteError('gateway/bad-request', 'Invalid request ID', {})
  using session = await observeReceivingSession(ctx, sessionId, signal)
  if (session.header.origin === 'subagent') return csvComparisonDraftUnavailable('UNAVAILABLE')
  const drafts = csvComparisonDrafts(ctx) ?? csvComparisonDraftUnavailable('UNAVAILABLE')
  await drafts.bind(sessionId, receiptId, requestId, async ({ requestId: previous, facts, savedAfterSeq }) => {
    if (previous === undefined) return
    if (ctx.get('sessionInputs')?.hasPendingPrompt(sessionId, previous) === true) return csvComparisonDraftUnavailable('PROMPT_IN_FLIGHT')
    using latest = await observeReceivingSession(ctx, sessionId, signal)
    if (findComparisonPrompt(latest, previous, facts, savedAfterSeq) !== undefined) return csvComparisonDraftUnavailable('PROMPT_ALREADY_ACCEPTED')
    if (ctx.get('sessionInputs')?.hasPendingPrompt(sessionId, previous) === true) return csvComparisonDraftUnavailable('PROMPT_IN_FLIGHT')
  })
  return { bound: true }
}

async function comparisonPromptStatus(ctx: Context, sessionId: SessionId, requestId: SessionRequestId, signal: AbortSignal,
  facts?: ArtifactCsvComparisonQuestionFacts, savedAfterSeq?: number): Promise<ArtifactBranchCheckCsvComparisonDraftValue> {
  // Remember a reservation from before the read. It can complete as this observation's fixed cut resolves.
  const wasPending = ctx.get('sessionInputs')?.hasPendingPrompt(sessionId, requestId) === true
  using session = await observeReceivingSession(ctx, sessionId, signal)
  if (session.header.origin === 'subagent') return csvComparisonDraftUnavailable('UNAVAILABLE')
  const admission = findComparisonPrompt(session, requestId, facts, savedAfterSeq)
  if (admission === undefined) {
    const pending = wasPending || ctx.get('sessionInputs')?.hasPendingPrompt(sessionId, requestId) === true
      || (ctx.sessions.get(sessionId)?.seq ?? 0) > session.cursor + 1
    // If the live log advanced past the fixed cut, a fresh status check can resolve the new record.
    return pending ? { accepted: false, pending: true } : { accepted: false }
  }
  try {
    if (await flushComparisonPrompt(ctx, session)) {
      return { accepted: true, ...(facts === undefined ? comparisonPromptTarget(session, requestId, admission) : {}) }
    }
  } catch {
    signal.throwIfAborted()
  }
  return { accepted: false, pending: true }
}

/**
 * Resolve acceptance or ongoing admission for one exact comparison request without resuming the Agent.
 * @param ctx - Host context of the owner's invocation.
 * @param request - Receiving Session and client request ID.
 * @param signal - Lifetime of the Session observation.
 * @returns Acceptance with the durable message address, or whether admission is still pending.
 */
export async function checkCsvComparisonDraftRequest(ctx: Context, request: ArtifactBranchCheckCsvComparisonDraftRequest,
  signal: AbortSignal): Promise<ArtifactBranchCheckCsvComparisonDraftValue> {
  requireDraftOwner(ctx)
  return await comparisonPromptStatus(ctx, request.sessionId, request.requestId, signal)
}

function witnessedSentCsvComparison(ctx: Context, session: SessionObservation,
  address: ArtifactBranchReviewCsvComparisonExplanationRequest['first']): ArtifactCsvComparisonQuestionFacts {
  const sessionId = session.header.id
  const eventSeq = requestEventSeq(address.eventSeq)
  const selected = session.events[eventSeq]
  if (session.header.origin === 'subagent' || eventSeq < session.inheritedEventCount || selected?.seq !== eventSeq
    || selected.type !== 'user/message' || selected.surfaceOp !== 'append' || selected.data.id !== address.messageId) {
    return csvComparisonDraftUnavailable('HISTORY_UNVERIFIED')
  }
  const { source, content } = selected.data
  if (source.kind !== 'user' || !('rpcId' in source) || source.principal !== undefined) return csvComparisonDraftUnavailable('HISTORY_UNVERIFIED')
  const drafts = csvComparisonDrafts(ctx) ?? csvComparisonDraftUnavailable('UNAVAILABLE')
  const reviewed = content.find(block => block.type === 'text' && drafts.verifiesHistory(sessionId, source.rpcId, block.text))
  const facts = reviewed?.type === 'text' ? readCsvComparisonQuestionBlock(reviewed.text, sessionId) : undefined
  if (facts === undefined) return csvComparisonDraftUnavailable('HISTORY_UNVERIFIED')
  const admission = findComparisonPrompt(session, source.rpcId, facts)
  if (admission === undefined || comparisonPromptTarget(session, source.rpcId, admission).message?.eventSeq !== eventSeq) {
    return csvComparisonDraftUnavailable('HISTORY_UNVERIFIED')
  }
  return facts
}

function witnessedSentCsvSingleComparison(ctx: Context, session: SessionObservation,
  address: ArtifactBranchReviewCsvComparisonExplanationRequest['first']): ArtifactCsvComparisonSingleFacts {
  const facts = witnessedSentCsvComparison(ctx, session, address)
  if (facts.explanation !== undefined || facts.returns !== undefined || facts.returnCards !== undefined) {
    return csvComparisonDraftUnavailable('HISTORY_UNVERIFIED')
  }
  return facts
}

function verifyExportReturn(
  session: SessionObservation, requestSeq: number, address: ArtifactCsvComparisonReturnedFacts['returns']['first'],
  branchSessionId: SessionId, reading: ArtifactCsvComparisonReading,
) {
  if (address.eventSeq >= requestSeq) return csvComparisonDraftUnavailable('HISTORY_UNVERIFIED')
  const retained = parentCsvReturn(session, address.eventSeq, address.messageId)
  if (retained === undefined || retained.notice.branchSessionId !== branchSessionId) return csvComparisonDraftUnavailable('HISTORY_UNVERIFIED')
  const { event, readings, spec, source } = retained
  const { title, artifactId, revision } = readings.artifact
  const recorded = comparisonReading(spec, readings.values)
  if (artifactId !== address.artifactId || revision !== address.revision || !isDeepStrictEqual(recorded, reading)) {
    return csvComparisonDraftUnavailable('HISTORY_UNVERIFIED')
  }
  const conclusion = event.data.content.slice(0, -1).flatMap(block => block.type === 'text' ? [block.text] : [])
  const value: ArtifactCsvComparisonReturnCard = { title, revision, conclusion, groupBy: spec.groupBy, groups: spec.groups }
  return { value, attachmentId: spec.attachmentId, resultSeq: source.resultSeq, resultMessageId: source.resultMessageId }
}

function verifyExportReturns(
  session: SessionObservation, requestSeq: number, facts: ArtifactCsvComparisonReturnedFacts,
): ArtifactCsvComparisonReturnCards {
  const { returns, comparison } = facts
  const first = verifyExportReturn(session, requestSeq, returns.first, returns.branchSessionId, comparison.original)
  const second = verifyExportReturn(session, requestSeq, returns.second, returns.branchSessionId, comparison.current)
  if (first.resultSeq === second.resultSeq || first.resultMessageId === second.resultMessageId
    || first.attachmentId !== second.attachmentId || first.value.groupBy !== second.value.groupBy) {
    return csvComparisonDraftUnavailable('HISTORY_UNVERIFIED')
  }
  return { first: first.value, second: second.value }
}

/**
 * Resolve a witnessed sent comparison for export using only its parent Session history.
 * @param ctx - Host context of the owner's invocation.
 * @param request - Receiving Session ID, event sequence and matching message ID.
 * @param signal - Lifetime of the caller's observation.
 * @returns The unchanged attached snapshot and both original return cards when applicable.
 */
export async function resolveSentCsvComparisonExport(
  ctx: Context, request: ArtifactBranchReviewSentCsvComparisonRequest, signal: AbortSignal,
): Promise<{ readonly facts: ArtifactCsvComparisonQuestionFacts; readonly returnCards?: ArtifactCsvComparisonReturnCards }> {
  requireDraftOwner(ctx)
  using session = await observeReceivingSession(ctx, request.sessionId, signal)
  const facts = witnessedSentCsvComparison(ctx, session, request)
  if (facts.explanation !== undefined && facts.attribution === undefined) {
    const { aggregation, filtering } = facts.explanation
    if (aggregation.message.eventSeq >= request.eventSeq || filtering.eventSeq >= request.eventSeq
      || !isDeepStrictEqual(facts, readCsvComparisonExplanation(ctx, session, aggregation.message, filtering))) {
      return csvComparisonDraftUnavailable('HISTORY_UNVERIFIED')
    }
  }
  const returnCards = facts.returns === undefined ? facts.returnCards : verifyExportReturns(session, request.eventSeq, facts)
  if (!await flushComparisonPrompt(ctx, session)) return csvComparisonDraftUnavailable('PROMPT_NOT_DURABLE')
  return returnCards === undefined ? { facts } : { facts, returnCards }
}

/**
 * Seal a witnessed comparison or imported explanation from the selected own history message.
 * @param ctx - Host context of the owner's invocation.
 * @param request - Receiving Session, event sequence and matching message ID.
 * @param signal - Lifetime of the Session observation.
 * @returns A new attachment whose facts record the reused message.
 */
export async function reviewSentCsvComparison(ctx: Context, request: ArtifactBranchReviewSentCsvComparisonRequest,
  signal: AbortSignal): Promise<ArtifactCsvComparisonAttachment> {
  requireDraftOwner(ctx)
  const { sessionId, eventSeq, messageId } = request
  using session = await observeReceivingSession(ctx, sessionId, signal)
  const facts = witnessedSentCsvComparison(ctx, session, request)
  if (facts.explanation !== undefined && facts.attribution !== 'user-imported') return csvComparisonDraftUnavailable('HISTORY_UNVERIFIED')
  if (!await flushComparisonPrompt(ctx, session)) return csvComparisonDraftUnavailable('PROMPT_NOT_DURABLE')
  signal.throwIfAborted()
  return sealCsvComparisonQuestion(ctx, { ...facts, reusedFrom: { eventSeq, messageId } }) ?? csvComparisonDraftUnavailable('UNAVAILABLE')
}

/**
 * Review two witnessed pages from one returned CSV calculation in recipe order.
 * @param ctx - Host context of the owner's invocation.
 * @param request - Receiving Session and both exact user message addresses.
 * @param signal - Lifetime of the caller's observation.
 * @returns Both unchanged reviewed pages and a proof for explicit draft confirmation.
 */
export async function reviewCsvComparisonExplanation(ctx: Context, request: ArtifactBranchReviewCsvComparisonExplanationRequest,
  signal: AbortSignal): Promise<ArtifactCsvComparisonAttachment> {
  requireDraftOwner(ctx)
  const { sessionId, first, second } = request
  using session = await observeReceivingSession(ctx, sessionId, signal)
  const facts = readCsvComparisonExplanation(ctx, session, first, second)
  if (facts === undefined) return csvComparisonDraftUnavailable('INCOMPATIBLE_PAIR')
  if (!await flushComparisonPrompt(ctx, session)) return csvComparisonDraftUnavailable('PROMPT_NOT_DURABLE')
  signal.throwIfAborted()
  return sealCsvComparisonQuestion(ctx, facts) ?? csvComparisonDraftUnavailable('EXPLANATION_TOO_LARGE')
}

type CsvExplanationAddress = ArtifactBranchReviewCsvComparisonExplanationRequest['first']

function readCsvComparisonExplanation(
  ctx: Context, session: SessionObservation, first: CsvExplanationAddress, second: CsvExplanationAddress,
): ArtifactCsvComparisonLocalExplanationFacts | undefined {
  const firstFacts = witnessedSentCsvSingleComparison(ctx, session, first)
  const secondFacts = witnessedSentCsvSingleComparison(ctx, session, second)
  if (first.eventSeq === second.eventSeq || first.messageId === second.messageId
    || firstFacts.attribution !== undefined || secondFacts.attribution !== undefined
    || !isDeepStrictEqual(firstFacts.source, secondFacts.source)) return undefined
  const choices = [
    { message: { eventSeq: first.eventSeq, messageId: first.messageId }, facts: firstFacts },
    { message: { eventSeq: second.eventSeq, messageId: second.messageId }, facts: secondFacts },
  ] as const
  const [aggregation, filtering] = firstFacts.comparison.current.filter === undefined ? choices : [choices[1], choices[0]] as const
  const base = aggregation.facts.comparison
  const filtered = filtering.facts.comparison
  if (!isPortableCsvComparisonExplanation({ aggregation: base, filtering: filtered })) return undefined
  return {
    kind: 'csv-question-comparison',
    sessionId: session.header.id,
    question: filtering.facts.question,
    source: filtering.facts.source,
    comparison: filtered,
    explanation: { aggregation: { message: aggregation.message, comparison: base }, filtering: filtering.message },
  }
}

/**
 * Review a portable file in one destination Session without creating a draft or sending a question.
 * @param ctx - Host context of the owner's invocation.
 * @param request - Destination Session and bounded decoded JSON file.
 * @param signal - Lifetime of the caller's observation.
 * @returns The exact user-imported evidence and proof required for explicit draft confirmation.
 */
export async function importCsvComparison(ctx: Context, request: ArtifactBranchImportCsvComparisonRequest,
  signal: AbortSignal): Promise<ArtifactCsvComparisonAttachment> {
  requireDraftOwner(ctx)
  const { sessionId, json } = request
  using session = await observeReceivingSession(ctx, sessionId, signal)
  if (session.header.origin === 'subagent' || csvComparisonDrafts(ctx) === undefined) return csvComparisonDraftUnavailable('UNAVAILABLE')
  signal.throwIfAborted()
  const snapshot = readCsvComparisonSnapshot(json)
  const facts = { kind: 'csv-question-comparison', sessionId, attribution: 'user-imported' } as const
  let imported: ArtifactCsvComparisonQuestionFacts
  if ('returnCards' in snapshot) imported = { ...facts, comparison: snapshot.comparison, returnCards: snapshot.returnCards }
  else if ('comparison' in snapshot) imported = { ...facts, comparison: snapshot.comparison }
  else imported = { ...facts, comparison: snapshot.filtering, explanation: { aggregation: { comparison: snapshot.aggregation } } }
  const attachment = sealCsvComparisonQuestion(ctx, imported)
  return attachment ?? csvComparisonImportInvalid('PROMPT_LIMIT')
}

/**
 * Compare-and-delete a draft after deliberate removal or verified durable prompt acceptance.
 * @param ctx - Host context of the owner's invocation.
 * @param request - Receiving Session, draft receipt and, after sending, the bound request ID.
 * @param signal - Lifetime of the Session observations.
 * @returns Whether a draft matching the receipt was deleted.
 */
export async function clearCsvComparisonDraft(ctx: Context, request: ArtifactBranchClearCsvComparisonDraftRequest,
  signal: AbortSignal): Promise<ArtifactBranchClearCsvComparisonDraftValue> {
  requireDraftOwner(ctx)
  const { sessionId, requestId, receiptId } = request
  using session = await observeReceivingSession(ctx, sessionId, signal)
  if (session.header.origin === 'subagent') return csvComparisonDraftUnavailable('UNAVAILABLE')
  const drafts = csvComparisonDrafts(ctx) ?? csvComparisonDraftUnavailable('UNAVAILABLE')
  return { cleared: await drafts.clear(sessionId, receiptId, requestId === undefined ? undefined
    : async (binding) => {
      if (binding.requestId !== requestId) return csvComparisonDraftUnavailable('DRAFT_CHANGED')
      using latest = await observeReceivingSession(ctx, sessionId, signal)
      if (!await comparisonPromptIsDurable(ctx, latest, requestId, binding.facts, binding.savedAfterSeq)) {
        return csvComparisonDraftUnavailable('PROMPT_NOT_DURABLE')
      }
    }) }
}
