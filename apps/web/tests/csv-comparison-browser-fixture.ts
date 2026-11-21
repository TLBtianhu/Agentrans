/** Exact witnessed CSV pages for browser download and transfer acceptance. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { assembleContextFor } from '@agentrans/agent'
import type { SessionRequestId } from '@agentrans/api-session-controller/types'
import type { ArtifactCsvComparisonAttachment, ArtifactCsvComparisonQuestionFacts } from '@agentrans/artifact-followup/types'
import {
  CSV_COMPARISON_CHANGES_PREFIX, IMPORTED_CSV_EXPLANATION_SOURCE_TEXT, IMPORTED_CSV_RETURN_SOURCE_TEXT, IMPORTED_CSV_SINGLE_SOURCE_TEXT,
} from '@agentrans/artifact/runtime-values'
import type { ArtifactId } from '@agentrans/artifact/types'
import { brandString } from '@agentrans/brand'
import { createSystemMessage, createUserMessage, MessageId } from '@agentrans/llm'
import { SessionSeq, type SessionEvent, type SessionId } from '@agentrans/session'
import { renderPrompt } from '@agentrans/system-prompt'
import type { Locator } from 'playwright'
import { expect } from 'vitest'
import { parseSeedFixture, readPersistedEvents, realizeSeedFixture, seedSession, type WebScaffold } from './scaffold.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/replay/csv-filtered-question-replay/session.v4.jsonl', import.meta.url))
const requireWebPlugin = createRequire(new URL('../../../packages/bundle/web-app/package.json', import.meta.url))
const keepImportedReturns = 'Keep both imported return cards for another question.'
const warmMean = { groupKey: 'Warm', valueColumn: 'LatencyMs', aggregate: 'mean', value: 30, count: 2 } as const
const unfilteredWarmComparison: ArtifactCsvComparisonQuestionFacts['comparison'] = {
  original: warmMean, current: { ...warmMean, aggregate: 'sum', value: 60 }, kept: 2, excluded: 0, added: 0, offset: 0, total: 2, rows: [
    { record: 4, status: 'kept', value: '25' }, { record: 5, status: 'kept', value: '35' },
  ],
}

function fixtureAttachment(world: WebScaffold, facts: ArtifactCsvComparisonQuestionFacts): ArtifactCsvComparisonAttachment {
  // Resolve the Web bundle's dependency with Node so this shares the mounted Host's signer.
  const { sealCsvComparisonQuestion } = requireWebPlugin('@agentrans/artifact-followup') as typeof import('@agentrans/artifact-followup')
  const attachment = sealCsvComparisonQuestion(world.ctx, facts)
  if (attachment === undefined) throw new Error('The Host could not seal the bounded fixture comparison')
  return attachment
}

async function appendWitnessedComparison(
  world: WebScaffold, sessionId: SessionId, question: string, attachment: ArtifactCsvComparisonAttachment,
) {
  const { csvComparisonQuestionBlock } = requireWebPlugin('@agentrans/artifact-followup') as typeof import('@agentrans/artifact-followup')
  const { receiptId } = await world.ctx.artifactBranchResults.saveCsvComparisonDraft({ sessionId, expectedReceiptId: null, attachment })
  const requestId = brandString<SessionRequestId>(randomUUID())
  const request = { sessionId, receiptId, requestId }
  await expect(world.ctx.artifactBranchResults.bindCsvComparisonDraftRequest(request)).resolves.toEqual({ bound: true })

  // Record the accepted turn through the normal Session writer without starting a model turn.
  const writer = await world.ctx.sessionPersistence.open(sessionId, 'write')
  const source = { kind: 'user', rpcId: requestId } as const
  const content = [{ type: 'text' as const, text: question }, csvComparisonQuestionBlock(attachment.facts)]
  if (attachment.facts.attribution === 'user-imported') {
    const text = attachment.facts.explanation !== undefined ? IMPORTED_CSV_EXPLANATION_SOURCE_TEXT
      : attachment.facts.returnCards !== undefined ? IMPORTED_CSV_RETURN_SOURCE_TEXT : IMPORTED_CSV_SINGLE_SOURCE_TEXT
    content.push({ type: 'text', text })
  }
  const message = createUserMessage({ source, content })
  let eventSeq: SessionSeq
  try {
    const { events } = await writer.read()
    const tail = events.at(-1)
    if (tail?.type !== 'turn/end') throw new Error('Expected a closed fixture turn before appending a saved comparison')
    const turn = tail.data.turn + 1
    const start = tail.seq + 1
    eventSeq = SessionSeq(start + 2)
    const turnEvents: readonly SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(start), time: tail.time + 1, data: { turn } },
      { type: 'step/start', seq: SessionSeq(start + 1), time: tail.time + 2, data: { turn, step: 1 } },
      { type: 'user/message', seq: eventSeq, time: tail.time + 3, surfaceOp: 'append', data: message },
      { type: 'step/end', seq: SessionSeq(start + 3), time: tail.time + 4, data: { turn, step: 1 } },
      { type: 'turn/end', seq: SessionSeq(start + 4), time: tail.time + 5, data: { turn, reason: { kind: 'completed' } } },
    ]
    await writer.append(turnEvents)
  } finally { await writer.close() }
  const address = { sessionId, eventSeq, messageId: message.id }
  await expect(world.ctx.artifactBranchResults.clearCsvComparisonDraft(request)).resolves.toEqual({ cleared: true })
  return address
}

export async function compareReading(scope: Locator, side: 'original' | 'locked', expected: Readonly<Record<string, string>>): Promise<void> {
  const reading = scope.locator(`[data-csv-compare-reading="${side}"]`)
  for (const [field, value] of Object.entries(expected)) {
    await expect.poll(() => reading.locator(`[data-csv-reading="${field}"]`).textContent()).toBe(value)
  }
}

/** Check the exact visible saved rows for either Warm comparison. */
export async function expectCsvComparisonRecords(scope: Locator, filtered: boolean): Promise<void> {
  const rows = scope.locator('tr[data-csv-compare-record]')
  expect(await rows.evaluateAll(elements => elements.map(row => ({
    record: row.getAttribute('data-csv-compare-record'), status: row.getAttribute('data-csv-compare-status'),
    value: row.querySelector('[data-csv-compare-cell="value"]')?.textContent,
    batch: row.querySelector('[data-csv-compare-cell="current-filter"]')?.textContent,
  })))).toEqual([
    { record: '4', status: filtered ? 'excluded' : 'kept', value: '25', batch: filtered ? 'A' : undefined },
    { record: '5', status: 'kept', value: '35', batch: filtered ? 'B' : undefined },
  ])
}

export function expectComparisonProviderText(blocks: readonly string[], question: string, context: string, changes: string): void {
  expect(blocks.slice(0, 3)).toEqual([question, context, changes])
  expect(blocks.filter(block => block.startsWith(CSV_COMPARISON_CHANGES_PREFIX))).toHaveLength(1)
  expect(blocks.slice(3).every(block => block.startsWith('Current runtime context. This snapshot supersedes')
    || block.startsWith('<system-reminder>\nA skill is a reusable set'))).toBe(true)
}

/** Assemble the mounted Chat preset's system head before recording a model-free fixture turn. */
export async function csvFixtureChatHead(world: WebScaffold): Promise<string> {
  const cold = await world.ctx.sessionController.create({ cwd: world.workspaceCwd, agentPreset: 'chat' })
  const chat = world.ctx.agents.get(cold.sessionId)
  if (chat === undefined) throw new Error('The cold Chat agent is unavailable for prompt assembly')
  const systemHead = renderPrompt(await world.ctx.systemPrompt.assemble(assembleContextFor(chat)))
  expect(systemHead).toContain('You are a conversation and teaching assistant.')
  return systemHead
}

function protectedSystemHead(systemHead: string, time: number): readonly SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time, data: { turn: 1 } },
    { type: 'step/start', seq: SessionSeq(1), time, data: { turn: 1, step: 1 } },
    { type: 'system/message', seq: SessionSeq(2), time, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: createSystemMessage(systemHead) } },
    { type: 'step/end', seq: SessionSeq(3), time, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(4), time, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

function fixtureWithSystemHead(world: WebScaffold, fixture: string, id: string, systemHead: string): string {
  const { headerLine, events } = parseSeedFixture(realizeSeedFixture(world, fixture, id))
  const head = protectedSystemHead(systemHead, events[0]?.time ?? 0)
  const shifted = events.map(event => JSON.stringify({ ...event, seq: event.seq + head.length })
    .replace('"turn":1', '"turn":2')
    // This fixture references its original return from the chart and from the recorded question's JSON text.
    .replace('"eventSeq":0', `"eventSeq":${head.length}`)
    .replace('\\"eventSeq\\":0', `\\"eventSeq\\":${head.length}`)
    .replace('"messageSeqs":[4]', `"messageSeqs":[${4 + head.length}]`))
  return [headerLine, ...head.map(event => JSON.stringify(event)), ...shifted].join('\n') + '\n'
}

export async function seedWitnessedCsvComparisons(world: WebScaffold, id: string, systemHead?: string) {
  const fixture = await readFile(FIXTURE, 'utf8')
  const ready = systemHead === undefined ? fixture : fixtureWithSystemHead(world, fixture, id, systemHead)
  const sessionId = await seedSession(world, ready, id, 'chat')
  const fixtureHistory = await readPersistedEvents(world, sessionId)
  const source = fixtureHistory.find(event => event.type === 'user/message' && event.data.source.kind === 'branch-result')
  const lockedQuestion = fixtureHistory.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (source?.type !== 'user/message' || lockedQuestion?.type !== 'user/message') throw new Error('CSV fixture is missing its prior readings')
  const base = { kind: 'csv-question-comparison', sessionId, question: { eventSeq: lockedQuestion.seq, messageId: lockedQuestion.data.id },
    source: { eventSeq: source.seq, messageId: source.data.id, artifactId: brandString<ArtifactId>('trial-latency'), revision: 1 } } as const
  const comparison: ArtifactCsvComparisonQuestionFacts['comparison'] = {
    original: warmMean, current: { ...warmMean, aggregate: 'sum', value: 35, count: 1, filter: { column: 'Batch', value: 'B' } },
    kept: 1, excluded: 1, added: 0, offset: 0, total: 2, rows: [
      { record: 4, status: 'excluded', currentFilterValue: 'A', value: '25' },
      { record: 5, status: 'kept', currentFilterValue: 'B', value: '35' },
    ],
  }
  const filtered = await appendWitnessedComparison(world, sessionId, 'Explain my saved Batch B comparison.',
    fixtureAttachment(world, { ...base, comparison }))
  const alternateComparison = unfilteredWarmComparison
  const alternate = await appendWitnessedComparison(world, sessionId, 'Explain my saved unfiltered total.',
    fixtureAttachment(world, { ...base, comparison: alternateComparison }))
  return { sessionId, filtered, alternate, comparison, alternateComparison, question: base.question, source: base.source }
}

async function seedCsvReturnComparison(world: WebScaffold, id: string, systemHead?: string) {
  const decoded = parseSeedFixture(realizeSeedFixture(world, await readFile(FIXTURE, 'utf8'), id))
  const original = decoded.events[0]
  if (original?.type !== 'user/message' || original.data.source.kind !== 'branch-result') {
    throw new Error('Expected a frozen CSV return at the start of the fixture')
  }
  const branchSessionId = original.data.source.branchSessionId
  const evidence = original.data.content.at(-1)
  if (evidence?.type !== 'text' || !evidence.text.includes('\n')) throw new Error('The original return has no CSV evidence block')
  const prefix = evidence.text.slice(0, evidence.text.indexOf('\n') + 1)
  const artifactId = brandString<ArtifactId>('trial-latency')
  const group = { key: 'Warm', value: 60, count: 2 }
  const artifact = { artifactId, revision: 2, title: 'Total sample latency', presentation: 'inline', format: 'scene', spec: {
    kind: 'csv-bar-chart', attachmentId: `sha256:${'a'.repeat(64)}`, groupBy: 'Trial', aggregate: 'sum', valueColumn: 'LatencyMs', rowCount: 4,
    groups: [group, { key: 'Cold', value: 100, count: 2 }],
  } }
  const facts = { kind: 'current-csv-bar-chart', artifact, groupKey: group.key, values: group }
  const evidenceText = prefix + JSON.stringify({ kind: 'branch-result-artifact-evidence', branchSessionId,
    evidence: { kind: 'question', questionSeq: 15, facts } })
  const total = createUserMessage({
    source: { ...original.data.source, resultSeq: SessionSeq(16), resultMessageId: MessageId(randomUUID()) },
    content: [{ type: 'text', text: 'Warm had total latency 60 ms across the same two measurements.' }, { type: 'text', text: evidenceText }],
  })
  const head = systemHead === undefined ? [] : protectedSystemHead(systemHead, original.time)
  const meanSeq = SessionSeq(head.length)
  const sumSeq = SessionSeq(head.length + 1)
  const turn = systemHead === undefined ? 1 : 2
  const events: readonly SessionEvent[] = [...head, { ...original, seq: meanSeq },
    { type: 'user/message', seq: sumSeq, time: original.time + 1, surfaceOp: 'append', data: total },
    { type: 'turn/start', seq: SessionSeq(head.length + 2), time: original.time + 2, data: { turn } },
    { type: 'turn/end', seq: SessionSeq(head.length + 3), time: original.time + 3, data: { turn, reason: { kind: 'completed' } } },
  ]
  const sessionLog = [decoded.headerLine, ...events.map(event => JSON.stringify(event))].join('\n') + '\n'
  const sessionId = await seedSession(world, sessionLog, id, 'chat')
  const first = { eventSeq: meanSeq, messageId: original.data.id, artifactId, revision: 1 }
  const second = { eventSeq: sumSeq, messageId: total.id, artifactId, revision: 2 }
  const returns = { branchSessionId, first, second }
  const attachment = fixtureAttachment(world, { kind: 'csv-question-comparison', sessionId, returns, comparison: unfilteredWarmComparison })
  return { sessionId, returns, attachment }
}

/** Record a witnessed sent pair of exact same-branch CSV returns without access to the original file. */
export async function seedWitnessedCsvReturnComparison(world: WebScaffold, id: string) {
  const { sessionId, returns, attachment } = await seedCsvReturnComparison(world, id)
  const sent = await appendWitnessedComparison(world, sessionId, 'Explain the two readings returned from this inquiry.', attachment)
  return { sessionId, sent, returns, comparison: attachment.facts.comparison }
}

/** Save an unsent comparison receipt with exact same-branch return refs and an optional system head for a real next turn. */
export async function seedWitnessedCsvReturnComparisonDraft(world: WebScaffold, id: string, systemHead?: string) {
  const { sessionId, returns, attachment } = await seedCsvReturnComparison(world, id, systemHead)
  const draft = await world.ctx.artifactBranchResults.saveCsvComparisonDraft({ sessionId, expectedReceiptId: null, attachment })
  return { sessionId, returns, draft }
}

async function reviewWitnessedCsvExplanation(world: WebScaffold, id: string) {
  const fixture = await seedWitnessedCsvComparisons(world, id)
  const { sessionId, filtered, alternate } = fixture
  const attachment = await world.ctx.artifactBranchResults.reviewCsvComparisonExplanation({ sessionId,
    first: { eventSeq: filtered.eventSeq, messageId: filtered.messageId },
    second: { eventSeq: alternate.eventSeq, messageId: alternate.messageId },
  })
  return { fixture, attachment }
}

/** Persist a Host-reviewed pair of witnessed native comparisons as a closed question without inference. */
export async function seedWitnessedCsvExplanation(world: WebScaffold, id: string) {
  const { fixture, attachment } = await reviewWitnessedCsvExplanation(world, id)
  const explanation = await appendWitnessedComparison(world, fixture.sessionId, 'Explain the two recorded steps.', attachment)
  return { ...fixture, explanation }
}

/** Save a Host-reviewed pair as a draft receipt without binding it to a question or calling a model. */
export async function seedWitnessedCsvExplanationDraft(world: WebScaffold, id: string) {
  const { fixture, attachment } = await reviewWitnessedCsvExplanation(world, id)
  const draft = await world.ctx.artifactBranchResults.saveCsvComparisonDraft({
    sessionId: fixture.sessionId, expectedReceiptId: null, attachment,
  })
  return { ...fixture, draft }
}

async function seedCsvImportChat(world: WebScaffold, id: string) {
  const header = { type: 'session', version: 4, id: '{{session:1}}', createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }
  const head = protectedSystemHead(await csvFixtureChatHead(world), 0)
  return await seedSession(world, [header, ...head].map(event => JSON.stringify(event)).join('\n') + '\n', id, 'chat')
}

/** Prepare all three Host-exported JSON shapes and their witnessed imported messages in one Chat. */
export async function seedImportedCsvSourceKinds(world: WebScaffold, id: string) {
  const paired = await seedWitnessedCsvExplanation(world, `${id}-native`)
  const returned = await seedWitnessedCsvReturnComparison(world, `${id}-returns`)
  const sources = [
    { kind: 'single-page', address: paired.filtered, question: 'Review the imported comparison.' },
    { kind: 'two-step-explanation', address: paired.explanation, question: 'Review the imported two-step explanation.' },
    { kind: 'return-comparison', address: returned.sent, question: 'Review the imported return comparison.' },
  ] as const
  const sessionId = await seedCsvImportChat(world, id)
  const entries = []
  for (const { kind, address, question } of sources) {
    const bytes = await world.ctx.artifactBranchResults.exportSentCsvComparisonJson(address)
    const json = new TextDecoder().decode(bytes)
    const attachment = await world.ctx.artifactBranchResults.importCsvComparison({ sessionId, json })
    const sent = await appendWitnessedComparison(world, sessionId, question, attachment)
    entries.push({ kind, sent, facts: attachment.facts, json })
  }
  return { sessionId, entries }
}

/** Record a reviewed single-page import for model-free browser replay. */
export async function seedSentImportedCsvSingle(world: WebScaffold, id: string) {
  const native = await seedWitnessedCsvComparisons(world, `${id}-native`)
  const bytes = await world.ctx.artifactBranchResults.exportSentCsvComparisonJson(native.filtered)
  const sessionId = await seedCsvImportChat(world, id)
  const attachment = await world.ctx.artifactBranchResults.importCsvComparison({ sessionId, json: new TextDecoder().decode(bytes) })
  expect(attachment.facts).toEqual({ kind: 'csv-question-comparison', sessionId, attribution: 'user-imported', comparison: native.comparison })
  const sent = await appendWitnessedComparison(world, sessionId, 'Explain my imported comparison.', attachment)
  return { sessionId, sent }
}

/** Record an authentic imported pair in a separate Chat whose next turn may use the real provider. */
async function seedSentImportedCsvExplanation(world: WebScaffold, id: string) {
  const native = await seedWitnessedCsvExplanation(world, `${id}-native`)
  const bytes = await world.ctx.artifactBranchResults.exportSentCsvComparisonJson(native.explanation)
  const json = new TextDecoder().decode(bytes)
  expect(JSON.parse(json)).toEqual({ format: 'agentrans-csv-comparison-explanation', version: 1,
    aggregation: native.alternateComparison, filtering: native.comparison })
  const sessionId = await seedCsvImportChat(world, id)
  const attachment = await world.ctx.artifactBranchResults.importCsvComparison({ sessionId, json })
  expect(attachment.facts).toEqual({ kind: 'csv-question-comparison', sessionId, attribution: 'user-imported',
    comparison: native.comparison, explanation: { aggregation: { comparison: native.alternateComparison } },
  })
  const sent = await appendWitnessedComparison(world, sessionId, 'Keep this imported two-step explanation for a later question.', attachment)
  return { sessionId, sent, facts: attachment.facts, native, json }
}

/** Record imported originals using the production portable package and a Chat head that can send its next turn. */
export async function seedSentImportedCsvReturnComparison(world: WebScaffold, id: string) {
  const native = await seedWitnessedCsvReturnComparison(world, `${id}-native`)
  const bytes = await world.ctx.artifactBranchResults.exportSentCsvComparisonJson(native.sent)
  const json = new TextDecoder().decode(bytes)
  const sessionId = await seedCsvImportChat(world, id)
  const attachment = await world.ctx.artifactBranchResults.importCsvComparison({ sessionId, json })
  const { facts } = attachment
  if (facts.attribution !== 'user-imported' || facts.returnCards === undefined) throw new Error('The portable package lost its return cards')
  expect(JSON.parse(json)).toEqual({ format: 'agentrans-csv-return-comparison', version: 1,
    comparison: native.comparison, returnCards: facts.returnCards })
  expect(facts).toEqual({ kind: 'csv-question-comparison', sessionId, attribution: 'user-imported', comparison: native.comparison,
    returnCards: facts.returnCards })
  const sent = await appendWitnessedComparison(world, sessionId, keepImportedReturns, attachment)
  return { sessionId, sent, facts, native, json }
}

async function seedMatchingImportedCsvReturns(world: WebScaffold, id: string) {
  const { sessionId, sent: first, facts, native, json } = await seedSentImportedCsvReturnComparison(world, id)
  const duplicate = await world.ctx.artifactBranchResults.importCsvComparison({ sessionId, json })
  expect(duplicate.facts).toEqual(facts)
  const second = await appendWitnessedComparison(world, sessionId, keepImportedReturns, duplicate)
  return { sessionId, first, second, facts, native, json }
}

/** Record identical original posts and a witnessed reuse of the later one without inference. */
export async function seedIdenticalImportedCsvReturnSources(world: WebScaffold, id: string) {
  const { sessionId, first, second, facts } = await seedMatchingImportedCsvReturns(world, id)
  const reviewed = await world.ctx.artifactBranchResults.reviewSentCsvComparison(second)
  const reusedFacts = { ...facts, reusedFrom: { eventSeq: second.eventSeq, messageId: second.messageId } }
  expect(reviewed.facts).toEqual(reusedFacts)
  const reused = await appendWitnessedComparison(world, sessionId, 'Keep the reused return comparison from my second question.', reviewed)
  return { sessionId, first, second, reused, reusedFacts }
}

/** Record two identical imported explanations from the same portable file without inference. */
export async function seedMatchingSentImportedCsvExplanations(world: WebScaffold, id: string) {
  const { sessionId, sent: first, facts, native, json } = await seedSentImportedCsvExplanation(world, id)
  const duplicate = await world.ctx.artifactBranchResults.importCsvComparison({ sessionId, json })
  expect(duplicate.facts).toEqual(facts)
  const second = await appendWitnessedComparison(world, sessionId, 'Keep this imported two-step explanation for a later question.', duplicate)
  return { sessionId, first, second, facts, native }
}

/** Add a closed reuse of the later question for the keyless history replay. */
export async function seedIdenticalImportedCsvExplanationSources(world: WebScaffold, id: string) {
  const { sessionId, first, second, facts } = await seedMatchingSentImportedCsvExplanations(world, id)
  const reviewed = await world.ctx.artifactBranchResults.reviewSentCsvComparison(second)
  const reusedFacts = { ...facts, reusedFrom: { eventSeq: second.eventSeq, messageId: second.messageId } }
  expect(reviewed.facts).toEqual(reusedFacts)
  const reused = await appendWitnessedComparison(world, sessionId, 'Explain the reused pair from my second question.', reviewed)
  return { sessionId, first, second, reused, reusedFacts }
}

/** Record one reuse of a witnessed import without invoking the model. */
export async function seedFirstImportedExplanationReuse(world: WebScaffold, id: string) {
  const { sessionId, sent: first, facts, native } = await seedSentImportedCsvExplanation(world, id)
  const firstReview = await world.ctx.artifactBranchResults.reviewSentCsvComparison(first)
  expect(firstReview.facts).toEqual({ ...facts, reusedFrom: { eventSeq: first.eventSeq, messageId: first.messageId } })
  const middle = await appendWitnessedComparison(world, sessionId, 'Keep the reused imported explanation.', firstReview)
  return { sessionId, first, middle, facts, native }
}

/** Record two successive reuses of a witnessed import and save a separate unsent reuse of the middle question. */
export async function seedImportedCsvExplanationSourceChain(world: WebScaffold, id: string) {
  const { sessionId, first, middle, facts } = await seedFirstImportedExplanationReuse(world, id)
  const middleReview = await world.ctx.artifactBranchResults.reviewSentCsvComparison(middle)
  expect(middleReview.facts).toEqual({ ...facts, reusedFrom: { eventSeq: middle.eventSeq, messageId: middle.messageId } })
  const latest = await appendWitnessedComparison(world, sessionId, 'Use the most recent imported explanation again.', middleReview)
  const draft = await world.ctx.artifactBranchResults.saveCsvComparisonDraft({
    sessionId, expectedReceiptId: null, attachment: middleReview,
  })
  expect(draft.facts).toEqual(middleReview.facts)
  return { sessionId, first, middle, latest, draft }
}

async function reviewImportedCsvReturnChain(world: WebScaffold, id: string) {
  const { sessionId, first: decoy, second: first, facts, native, json } = await seedMatchingImportedCsvReturns(world, id)
  const firstReview = await world.ctx.artifactBranchResults.reviewSentCsvComparison(first)
  expect(firstReview.facts).toEqual({ ...facts, reusedFrom: { eventSeq: first.eventSeq, messageId: first.messageId } })
  const middle = await appendWitnessedComparison(world, sessionId, 'Reuse the selected imported return comparison.', firstReview)
  const middleReview = await world.ctx.artifactBranchResults.reviewSentCsvComparison(middle)
  expect(middleReview.facts).toEqual({ ...facts, reusedFrom: { eventSeq: middle.eventSeq, messageId: middle.messageId } })
  return { sessionId, decoy, first, middle, middleReview, facts, native, json }
}

async function saveReviewedCsvReturnDraft(world: WebScaffold, sessionId: SessionId, attachment: ArtifactCsvComparisonAttachment) {
  const draft = await world.ctx.artifactBranchResults.saveCsvComparisonDraft({
    sessionId, expectedReceiptId: null, attachment,
  })
  expect(draft.facts).toEqual(attachment.facts)
  return draft
}

/** Keep two exact sources and a confirmed draft for the next real browser send. */
export async function seedImportedCsvReturnDraftChain(world: WebScaffold, id: string) {
  const { middleReview, ...seed } = await reviewImportedCsvReturnChain(world, id)
  const draft = await saveReviewedCsvReturnDraft(world, seed.sessionId, middleReview)
  return { ...seed, draft }
}

/** Keep an identical decoy alongside the true source and record two exact reuses with a separate unsent draft. */
export async function seedImportedCsvReturnSourceChain(world: WebScaffold, id: string) {
  const { sessionId, decoy, first, middle, middleReview } = await reviewImportedCsvReturnChain(world, id)
  const latest = await appendWitnessedComparison(world, sessionId, 'Use this reused return comparison in another question.', middleReview)
  const draft = await saveReviewedCsvReturnDraft(world, sessionId, middleReview)
  return { sessionId, decoy, first, middle, latest, draft }
}
