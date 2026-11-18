/** Live DeepSeek and Edge acceptance for an imported comparison with both saved return cards. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IMPORTED_CSV_COMPARISON_QUESTION_PREFIX, IMPORTED_CSV_RETURN_SOURCE_TEXT, csvComparisonChangesText } from '@agentrans/artifact/runtime-values'
import type { ArtifactCsvComparisonQuestionFacts } from '@agentrans/artifact-followup/types'
import type { Locator, Request } from 'playwright'
import { expect, vi } from 'vitest'
import { selectDraftOffsets, selectedDraftOffsets, type CsvExplanationBrowser } from './artifact-csv-explanation-support.ts'
import { downloadSentCsvComparisonJson, openCsvImportFile, openFreshCsvChat } from './artifact-csv-portable-support.ts'
import { expectWarmReturnComparison, walkImportedCsvSourceChain } from './artifact-csv-return-source-support.ts'
import { expectWarmComparisonAnswer } from './artifact-csv-support.ts'
import {
  expectComparisonProviderText, seedImportedCsvReturnDraftChain, seedSentImportedCsvReturnComparison, seedWitnessedCsvReturnComparison,
} from './csv-comparison-browser-fixture.ts'
import { acknowledgeReloadConnectionLoss, readPersistedEvents } from './scaffold.ts'
import { writeComposerDraft } from './support.ts'

const QUESTION = 'Using my attached comparison, identify both original return revisions and explain how their readings differ. '
  + 'Cite the original record numbers and their values, and identify how I supplied the evidence.'
const REUSE_QUESTION = 'Using the attached comparison, identify both original return revisions and explain their readings. '
  + 'State what happened to the contributing records, list their record numbers and values, and say how I supplied the evidence.'
const EXPORT = '/api/artifactBranchResults/exportSentCsvComparisonJson'
const IMPORT = '/api/artifactBranchResults/importCsvComparison'
const REUSE = '/api/artifactBranchResults/reviewSentCsvComparison'
const SAVE = '/api/artifactBranchResults/saveCsvComparisonDraft'
const PROMPT = '/api/session/prompt'
const RECALCULATE = '/api/artifactBranchResults/recalculateCsv'
const FORBIDDEN = new Set(['compareCsvReturns', 'compareCsvQuestionToReturn', 'csvFilterOptions', 'csvParticipatingRows',
  'csvQuestionParticipatingRows', 'csvReturnedParticipatingRows', 'lockCsv', 'recalculateCsv']
  .map(endpoint => `/api/artifactBranchResults/${endpoint}`))
const ORIGINALS = [
  { side: 'first', label: 'Earlier return', title: 'Original sample latency', aggregate: 'Mean of LatencyMs', revision: 1, warm: 30, cold: 50,
    conclusion: 'Warm had mean latency 30 ms across two measurements.' },
  { side: 'second', label: 'Later return', title: 'Total sample latency', aggregate: 'Sum of LatencyMs', revision: 2, warm: 60, cold: 100,
    conclusion: 'Warm had total latency 60 ms across the same two measurements.' },
] as const

type Original = typeof ORIGINALS[number]
function groupRows({ warm, cold }: Original) { return [{ key: 'Warm', value: warm, count: 2 }, { key: 'Cold', value: cold, count: 2 }] }

/** Inspect the immutable readings and original records of both imported return cards. */
export async function inspectImportedReturns(scope: Locator, capture: (details: Locator, side: Original['side']) => Promise<void>,
  reused = false): Promise<void> {
  const provenance = scope.locator('[data-csv-comparison-provenance="user-imported"]')
  await expect.poll(() => provenance.textContent()).toBe('User imported')
  expect(await scope.locator('[data-csv-return-source]').count()).toBe(0)
  if (!reused) expect(await scope.locator('[data-csv-view-source-question], [data-csv-view-full-source-chain]').count()).toBe(0)
  await expectWarmReturnComparison(scope)
  const details = scope.locator('details[data-csv-imported-return-card]')
  expect(await details.evaluateAll(items => items.map(item => item.getAttribute('data-csv-imported-return-card')))).toEqual(['first', 'second'])
  const expanded = scope.locator('details[data-csv-imported-return-card][open]')
  expect(await expanded.count()).toBe(0)
  for (const original of ORIGINALS) {
    const { side, label, title, aggregate, revision, warm, conclusion } = original
    const card = details.and(scope.locator(`[data-csv-imported-return-card="${side}"]`))
    const summary = card.locator('summary')
    expect(await summary.textContent()).toBe(label)
    if (side === 'first') await summary.click()
    else await summary.press('Enter')
    await expect.poll(() => expanded.count()).toBe(1)
    expect(await card.locator('[data-csv-return-title]').textContent()).toBe(title)
    expect(await card.locator('[data-csv-return-revision]').textContent()).toBe(`Revision ${revision}`)
    expect(await card.locator('[data-csv-return-conclusion]').textContent()).toBe(conclusion)
    for (const [field, value] of Object.entries({ key: 'Warm', aggregate, filter: 'No filter', value: String(warm), count: '2' })) {
      expect(await card.locator(`[data-csv-return-reading] [data-csv-reading="${field}"]`).textContent()).toBe(value)
    }
    expect(await card.locator('[data-csv-return-group-by]').textContent()).toBe('Trial')
    expect(await card.locator('[data-csv-return-group]').evaluateAll(rows => rows.map(row => ({
      key: row.querySelector('[data-csv-return-group-cell="key"]')?.textContent,
      value: Number(row.querySelector('[data-csv-return-group-cell="value"]')?.textContent),
      count: Number(row.querySelector('[data-csv-return-group-cell="count"]')?.textContent),
    })))).toEqual(groupRows(original))
    expect(await card.locator('[data-csv-return-record]').evaluateAll(rows => rows.map(row => ({
      record: row.getAttribute('data-csv-return-record'), value: row.querySelector('[data-csv-return-cell="value"]')?.textContent,
    })))).toEqual([{ record: '4', value: '25' }, { record: '5', value: '35' }])
    await capture(card, side)
    await summary.click()
    await expect.poll(() => expanded.count()).toBe(0)
  }
}

function requestBody(request: Request): unknown {
  return (request.postDataJSON() as { payload: { args: { request: unknown } } }).payload.args.request
}

type PersistedHistory = Awaited<ReturnType<typeof readPersistedEvents>>

function expectImportedReturnProviderText(blocks: readonly string[], question: string, context: string, changes: string): void {
  expect(blocks.slice(0, 4)).toEqual([question, context, IMPORTED_CSV_RETURN_SOURCE_TEXT, changes])
  expect(blocks.filter(block => block === IMPORTED_CSV_RETURN_SOURCE_TEXT)).toHaveLength(1)
  expectComparisonProviderText([...blocks.slice(0, 2), ...blocks.slice(3)], question, context, changes)
}

function expectImportedReturnAnswer(answer: string): void {
  expectWarmComparisonAnswer(answer)
  const plain = answer.replace(/[*`_]/gu, '').replace(/‑/gu, '-').replace(/\.json\b/giu, ' JSON')
  for (const revision of [1, 2]) expect(plain).toMatch(new RegExp(`\\b(?:revision|rev\\.?)\\s*-?\\s*${revision}\\b`, 'iu'))
  const rowPair = /\b(?:rows?|records?)\s*#?\s*4\b[^\d.\n]{0,35}\b25\b[^\d.\n]{0,35}\b5\b[^\d.\n]{0,35}\b35\b/iu
  const numberedRows = /\b(?:rows?|records?)\s*#?\s*4\s*(?:and|,|&)\s*#?\s*5\b/.source
  const respectively = new RegExp(`${numberedRows}[^\\d.\\n]{0,40}\\b25\\b[^\\d.\\n]{0,25}\\b35\\b[^.\\n]{0,25}\\brespectively\\b`, 'iu')
  if (!rowPair.test(plain) && !respectively.test(plain)) {
    for (const [record, value] of [[4, 25], [5, 35]]) {
      const label = `(?:\\b(?:row|record)\\s*#?\\s*${record}\\b|\\|\\s*${record}\\s*\\|)`
      expect(plain).toMatch(new RegExp(`${label}[^\\d.\\n]{0,55}\\b${value}\\b`, 'iu'))
    }
  }
  const transfer = '\\b(?:import(?:ed|ing|s)?|upload(?:ed|ing|s)?|attach(?:ed|ing|es)?|provid(?:e|ed|es|ing)'
    + '|suppl(?:y|ied|ies|ying)|receiv(?:e|ed|es|ing))\\b'
  const negation = /\b(?:not|never|rather than|instead of)\b[^,.;!?\n]*$/iu
  const negated = (index: number): boolean => negation.test(plain.slice(Math.max(0, index - 40), index))
  const jsonTransfer = new RegExp(`${transfer}[^.?!\\n]{0,100}\\bJSON\\b|\\bJSON\\b[^.?!\\n]{0,100}${transfer}`, 'giu')
  expect([...plain.matchAll(jsonTransfer)].some(match => !negated(match.index) && !negation.test(match[0]))).toBe(true)

  const rawCsv = /\b(?:CSV\b(?![\s-]+(?:comparison|snapshot|export|records?|rows?|readings?|evidence)\b)|[\w-]+\.csv\b)/iu.source
  const qualifiers = '(?:(?:a|an|the|your|my|raw|original|underlying|actual|source|directly)\\s+)*'
  const directCsvImport = new RegExp(`${transfer}\\s+${qualifiers}${rawCsv}|${rawCsv}(?:\\s+(?:file|dataset))?\\s+(?:was|got)\\s+${transfer}`, 'giu')
  expect([...plain.matchAll(directCsvImport)].filter(match => !negated(match.index)).map(match => match[0])).toEqual([])
}

function verifyReusedReturnSend(history: PersistedHistory, initial: PersistedHistory, facts: ArtifactCsvComparisonQuestionFacts,
  provider: readonly string[], privateSource: readonly string[]) {
  expect(history.slice(0, initial.length)).toEqual(initial)
  const added = history.slice(initial.length)
  expect(added.filter(event => event.type === 'turn/start')).toHaveLength(1)
  expect(added.filter(event => event.type === 'tool/call')).toEqual([])
  const sent = added.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (sent?.type !== 'user/message') throw new Error('The comparison reuse did not become a recorded question')
  const context = sent.data.content[1]
  if (context?.type !== 'text' || !context.text.startsWith(IMPORTED_CSV_COMPARISON_QUESTION_PREFIX)) {
    throw new Error('The reused comparison lost its imported provenance')
  }
  const canonical = { kind: 'artifact-question-context', sessionId: facts.sessionId, facts }
  expect(JSON.parse(context.text.slice(IMPORTED_CSV_COMPARISON_QUESTION_PREFIX.length))).toEqual(canonical)
  const changes = csvComparisonChangesText(facts.comparison)
  expect(sent.data.content).toEqual([REUSE_QUESTION, context.text, IMPORTED_CSV_RETURN_SOURCE_TEXT, changes].map(text => ({ type: 'text', text })))
  expect(provider.filter(block => block === REUSE_QUESTION)).toHaveLength(1)
  const questionBlocks = provider.slice(provider.indexOf(REUSE_QUESTION))
  expectImportedReturnProviderText(questionBlocks, REUSE_QUESTION, context.text, changes)
  expect(provider.every(text => [...privateSource, '"proof"', '"receiptId"'].every(value => !text.includes(value)))).toBe(true)
  const answerEvent = added.findLast(event => event.type === 'assistant/message')
  if (answerEvent?.type !== 'assistant/message') throw new Error('The official model did not explain the reused attachment')
  const answer = answerEvent.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  expectImportedReturnAnswer(answer)
  return { address: { eventSeq: sent.seq, messageId: sent.data.id }, canonical, answer }
}

async function preparePortableReturns({ page, world, evidence, requests, console }: CsvExplanationBrowser, shotPrefix: string) {
  const userAgent = await page.evaluate(() => navigator.userAgent)
  expect(userAgent).toMatch(/\bEdg\//u)
  await page.setViewportSize({ width: 1440, height: 1280 })
  const seen: Request[] = []
  const watch = (request: Request): void => { seen.push(request) }
  const path = (request: Request): string => new URL(request.url()).pathname
  const at = (endpoint: string): readonly Request[] => seen.filter(request => path(request) === endpoint)
  const reads = vi.spyOn(world.ctx.attachments, 'readFileStream').mockImplementation(() => {
    throw new Error('Portable CSV return comparisons must not read the original file')
  })
  const expectActivity = (sends: number): void => {
    expect(seen.filter(request => FORBIDDEN.has(path(request)))).toEqual([])
    expect(reads).not.toHaveBeenCalled()
    expect(requests).toHaveLength(sends)
    expect(at(PROMPT)).toHaveLength(sends)
  }
  const reload = async (ready: () => Promise<void>): Promise<void> => {
    const warnings = console.warnings.length
    await page.reload()
    await ready()
    acknowledgeReloadConnectionLoss(console, warnings)
  }
  const shots = (phase: string) => async (target: Locator, side: Original['side']): Promise<void> => {
    await target.screenshot({ path: join(evidence, `${shotPrefix}-${phase}-${side}.png`), animations: 'disabled' })
  }
  page.on('request', watch)
  return { userAgent, at, reads, expectActivity, reload, shots, stop: () => { page.off('request', watch); reads.mockRestore() } }
}

/** Download and import both original return cards, then send one question with the exact reviewed copy. */
export async function exercisePortableCsvReturns(live: CsvExplanationBrowser): Promise<void> {
  const { page, world, evidence, requests, ask, providerUserText, stage, console } = live
  const { userAgent, at, reads, expectActivity, reload, shots, stop } = await preparePortableReturns(live, 'csv-imported-return')
  try {
    stage('csv-portable-returns-download-native-comparison')
    const { sessionId, returns, sent, comparison } = await seedWitnessedCsvReturnComparison(world, 'csv-portable-return-source')
    const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
    await workspace.attachSession(sessionId)
    const workspaceRow = page.locator(`[data-row-key="workspace:${workspace.id}"]`)
    await reload(async () => { await workspaceRow.waitFor({ state: 'visible' }) })
    if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
    await page.locator(`[data-row-key="session:${sessionId}"]`).click()
    const source = page.locator(`[data-chat-message-id="${sent.messageId}"][data-chat-message-seq="${sent.eventSeq}"]`)
      .locator('[data-csv-compare-attached]')
    await source.getByRole('button', { name: 'Replay attached comparison', exact: true }).click()
    await expectWarmReturnComparison(source)
    expect(await source.locator('button[data-csv-return-source]').count()).toBe(2)
    const { portableFile, json } = await downloadSentCsvComparisonJson(page, source, sent.eventSeq, evidence)
    const [firstOriginal, secondOriginal] = ORIGINALS
    const card = (original: Original) => {
      const { title, revision, conclusion } = original
      return { title, revision, conclusion: [conclusion], groupBy: 'Trial', groups: groupRows(original) }
    }
    const returnCards = { first: card(firstOriginal), second: card(secondOriginal) }
    const file = { format: 'agentrans-csv-return-comparison', version: 1, comparison, returnCards }
    expect(JSON.parse(json)).toEqual(file)
    expect(at(EXPORT).map(requestBody)).toEqual([sent])
    const privateSource = [sessionId, returns.branchSessionId, returns.first.messageId, returns.second.messageId, returns.first.artifactId,
      sent.messageId, '"sessionId"', '"messageId"', '"eventSeq"', '"artifactId"', '"attachmentId"', '"proof"', '"receiptId"']
    for (const value of privateSource) expect(json).not.toContain(value)
    expectActivity(0)

    stage('csv-portable-returns-import-both-originals-in-empty-chat')
    const destination = await openFreshCsvChat(page, world, sessionId)
    const conversation = page.locator(`[data-conversation-session="${destination}"]`)
    const initial = await readPersistedEvents(world, destination)
    const facts = { kind: 'csv-question-comparison', sessionId: destination, provenance: 'user-imported', comparison, returnCards }
    const imported = await openCsvImportFile(page, conversation, portableFile)
    expect(await imported.json()).toMatchObject({ result: { ok: true, value: { facts } } })
    expect(at(IMPORT).map(requestBody)).toEqual([{ sessionId: destination, json }])
    const review = conversation.locator('[data-csv-import-review]')
    await inspectImportedReturns(review, shots('preview'))
    expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId: destination })).toBeNull()
    expect(at(SAVE)).toHaveLength(0)
    expectActivity(0)

    stage('csv-portable-returns-confirm-and-reload-imported-draft')
    const [saved] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === SAVE),
      review.getByRole('button', { name: 'Attach comparison', exact: true }).click(),
    ])
    const receipt = await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId: destination })
    if (receipt === null) throw new Error('The imported original cards did not attach to the draft')
    expect(receipt.facts).toEqual(facts)
    expect(await saved.json()).toMatchObject({ result: { ok: true, value: receipt } })
    const chip = conversation.locator('[data-artifact-prompt-context="csv-question-comparison"]')
    const input = conversation.locator('[data-composer-input]')
    await chip.waitFor({ state: 'visible' })
    await writeComposerDraft(page, input, QUESTION)
    await reload(async () => {
      await expect.poll(() => input.textContent()).toBe(QUESTION)
      expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId: destination })).toEqual(receipt)
      await chip.getByRole('button', { name: 'Review attached comparison', exact: true }).click()
      await inspectImportedReturns(chip, shots('draft-after-refresh'))
    })
    expect(await readPersistedEvents(world, destination)).toEqual(initial)
    expectActivity(0)

    stage('csv-portable-returns-send-one-real-question')
    expect(await ask(QUESTION, destination, true)).toBe(destination)
    expectActivity(1)
    const history = await readPersistedEvents(world, destination)
    const question = history.find(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === QUESTION))
    if (question?.type !== 'user/message') throw new Error('The imported return comparison question was not recorded')
    const context = question.data.content[1]
    if (context?.type !== 'text' || !context.text.startsWith(IMPORTED_CSV_COMPARISON_QUESTION_PREFIX)) {
      throw new Error('The imported comparison lost its canonical context and provenance')
    }
    const canonical = { kind: 'artifact-question-context', sessionId: destination, facts }
    expect(JSON.parse(context.text.slice(IMPORTED_CSV_COMPARISON_QUESTION_PREFIX.length))).toEqual(canonical)
    const changes = csvComparisonChangesText(comparison)
    expect(question.data.content).toEqual([QUESTION, context.text, IMPORTED_CSV_RETURN_SOURCE_TEXT, changes].map(text => ({ type: 'text', text })))
    const provider = providerUserText(QUESTION)
    expectImportedReturnProviderText(provider, QUESTION, context.text, changes)
    expect(provider.every(text => ![...privateSource.filter(value => value !== '"sessionId"'), receipt.receiptId, json.trim(), file.format]
      .some(value => text.includes(value)))).toBe(true)
    expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId: destination })).toBeNull()
    const answerEvent = history.findLast(event => event.seq > question.seq && event.type === 'assistant/message')
    if (answerEvent?.type !== 'assistant/message') throw new Error('The official model did not answer the imported comparison')
    const answer = answerEvent.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expectImportedReturnAnswer(answer)
    expect(history.filter(event => event.type === 'tool/call')).toEqual([])

    stage('csv-portable-returns-replay-both-originals-after-refresh')
    const replay = conversation.locator(`[data-chat-message-id="${question.data.id}"][data-chat-message-seq="${question.seq}"]`)
      .locator('[data-csv-compare-attached]')
    await reload(async () => {
      await replay.getByRole('button', { name: 'Replay attached comparison', exact: true }).click()
      await inspectImportedReturns(replay, shots('sent-after-refresh'))
    })
    expect(await readPersistedEvents(world, destination)).toEqual(history)
    expectActivity(1)
    for (const endpoint of [EXPORT, IMPORT, SAVE]) expect(at(endpoint)).toHaveLength(1)
    expect(console.warnings).toEqual([])
    expect(console.pageErrors).toEqual([])
    await writeFile(join(evidence, 'csv-portable-return-comparison-acceptance.json'), JSON.stringify({ userAgent, source: sent,
      destination: { sessionId: destination, messageId: question.data.id, eventSeq: question.seq }, file, canonical, answer,
      providerRequests: requests.length, providerRequestsBeforeExplicitSend: 0, promptRequests: at(PROMPT).length,
      csvReads: reads.mock.calls.length, csvRecomputes: at(RECALCULATE).length, resumedDraftAfterReload: true,
      bothOriginalsInspectedAfterSentReload: true, portableJsonContainsLocalIdentities: false,
    }, null, 2) + '\n')
  } finally { stop() }
}

/** Review and send a reuse of one complete imported return comparison. */
export async function exerciseReusedImportedCsvReturns(live: CsvExplanationBrowser): Promise<void> {
  const { page, world, evidence, requests, ask, providerUserText, stage, console } = live
  const { userAgent, at, reads, expectActivity, reload, shots, stop } = await preparePortableReturns(live, 'csv-reused-imported-return')
  try {
    stage('csv-reuse-imported-returns-open-witnessed-original')
    const { sessionId, sent: original, facts, native, json } = await seedSentImportedCsvReturnComparison(world, 'csv-reused-return-source')
    await writeFile(join(evidence, 'csv-reused-imported-return-source.json'), json)
    const sourceRef = { eventSeq: original.eventSeq, messageId: original.messageId }
    const reusedFacts = { ...facts, reusedFrom: sourceRef }
    const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
    await workspace.attachSession(sessionId)
    const workspaceRow = page.locator(`[data-row-key="workspace:${workspace.id}"]`)
    await reload(async () => { await workspaceRow.waitFor({ state: 'visible' }) })
    if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
    await page.locator(`[data-row-key="session:${sessionId}"]`).click()
    const conversation = page.locator(`[data-conversation-session="${sessionId}"]`)
    const card = ({ eventSeq, messageId }: typeof sourceRef): Locator => conversation
      .locator(`[data-chat-message-id="${messageId}"][data-chat-message-seq="${eventSeq}"] [data-csv-compare-attached]`)
    const toggle = (scope: Locator): Locator => scope.getByRole('button', { name: 'Replay attached comparison', exact: true })
    const originalCard = card(original)
    await toggle(originalCard).click()
    await inspectImportedReturns(originalCard, shots('history'))
    await expect.poll(() => world.ctx.agents.get(sessionId)?.session.snapshotEvents().some(event => event.type === 'approval/policy')).toBe(true)
    const agent = world.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('The recorded imported comparison Session did not activate')
    await agent.whenIdle()
    expect(await world.ctx.sessions.flush(agent.session)).toBe(true)
    const initial = await readPersistedEvents(world, sessionId)
    expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toBeNull()
    expectActivity(0)

    stage('csv-reuse-imported-returns-review-and-lock-entire-comparison')
    await originalCard.getByRole('button', { name: 'Reuse entire return comparison', exact: true })
      .and(originalCard.locator('[data-csv-reuse-entire-return-comparison]')).click()
    const review = originalCard.locator('[data-csv-compare-review]')
    await inspectImportedReturns(review, shots('review'))
    expect(at(REUSE)).toHaveLength(0)
    expect(at(SAVE)).toHaveLength(0)
    expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toBeNull()
    const [reviewed, saved] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === REUSE),
      page.waitForResponse(response => new URL(response.url()).pathname === SAVE),
      review.getByRole('button', { name: 'Attach comparison', exact: true }).click(),
    ])
    expect(at(REUSE).map(requestBody)).toEqual([original])
    expect(await reviewed.json()).toMatchObject({ result: { ok: true, value: { facts: reusedFacts } } })
    const receipt = await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })
    if (receipt === null) throw new Error('The reused original cards were not confirmed as one draft attachment')
    expect(receipt.facts).toEqual(reusedFacts)
    expect(await saved.json()).toMatchObject({ result: { ok: true, value: receipt } })
    const chip = conversation.locator('[data-artifact-prompt-context="csv-question-comparison"]')
    const input = conversation.locator('[data-composer-input]')
    await chip.waitFor({ state: 'visible' })
    await writeComposerDraft(page, input, REUSE_QUESTION)

    stage('csv-reuse-imported-returns-refresh-exact-draft')
    await reload(async () => {
      await expect.poll(() => input.textContent()).toBe(REUSE_QUESTION)
      expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toEqual(receipt)
      await chip.getByRole('button', { name: 'Review attached comparison', exact: true }).click()
      await inspectImportedReturns(chip, shots('draft-after-refresh'), true)
      await chip.getByRole('button', { name: 'View source question', exact: true }).waitFor({ state: 'visible' })
    })
    expect(await readPersistedEvents(world, sessionId)).toEqual(initial)
    expectActivity(0)

    stage('csv-reuse-imported-returns-send-once-with-both-originals')
    expect(await ask(REUSE_QUESTION, sessionId, true)).toBe(sessionId)
    expectActivity(1)
    const history = await readPersistedEvents(world, sessionId)
    const privateSource = [native.sessionId, native.sent.messageId, native.returns.branchSessionId, native.returns.first.messageId,
      native.returns.second.messageId, native.returns.first.artifactId, receipt.receiptId, json.trim()]
    const { address, canonical, answer } = verifyReusedReturnSend(
      history, initial, reusedFacts, providerUserText(REUSE_QUESTION), privateSource,
    )
    expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toBeNull()

    stage('csv-reuse-imported-returns-refresh-and-replay-exact-sent-comparison')
    const replay = card(address)
    await reload(async () => {
      await toggle(replay).click()
      await inspectImportedReturns(replay, shots('sent-after-refresh'), true)
    })
    expect(await toggle(originalCard).getAttribute('aria-expanded')).toBe('false')
    await replay.getByRole('button', { name: 'View source question', exact: true }).click()
    await expect.poll(() => toggle(originalCard).evaluate(element => element === document.activeElement)).toBe(true)
    await inspectImportedReturns(originalCard, shots('reopened-original'))
    await originalCard.getByRole('button', { name: 'Return to comparison', exact: true }).click()
    await expect.poll(() => toggle(replay).evaluate(element => element === document.activeElement)).toBe(true)
    expect(await readPersistedEvents(world, sessionId)).toEqual(history)
    expectActivity(1)
    for (const endpoint of [REUSE, SAVE]) expect(at(endpoint)).toHaveLength(1)
    for (const endpoint of [EXPORT, IMPORT]) expect(at(endpoint)).toHaveLength(0)
    expect(console.warnings).toEqual([])
    expect(console.pageErrors).toEqual([])
    await writeFile(join(evidence, 'csv-reused-imported-return-comparison-acceptance.json'), JSON.stringify({ userAgent, original,
      sent: address, canonical, answer, providerRequests: requests.length, providerRequestsBeforeExplicitSend: 0,
      promptRequests: at(PROMPT).length,
      csvReads: reads.mock.calls.length, csvRecomputes: at(RECALCULATE).length, resumedDraftAfterReload: true,
      bothOriginalsInspectedAfterSentReload: true, reopenedExactReusedSource: true,
    }, null, 2) + '\n')
  } finally { stop() }
}

/** Send the restored draft once, then exercise the same source path from the real sent question. */
export async function exerciseImportedCsvReturnDraftChain(live: CsvExplanationBrowser): Promise<void> {
  const { page, world, evidence, requests, ask, providerUserText, stage, console } = live
  const { userAgent, at, reads, expectActivity, reload, shots, stop } = await preparePortableReturns(live, 'csv-imported-return-draft-chain')
  try {
    stage('csv-return-chain-open-previously-confirmed-unsent-comparison')
    const { sessionId, first, middle, decoy, draft, native, json } = await seedImportedCsvReturnDraftChain(world, 'csv-live-imported-return-chain')
    const source = { eventSeq: middle.eventSeq, messageId: middle.messageId }
    expect(draft.facts).toMatchObject({ provenance: 'user-imported', reusedFrom: source })
    await writeFile(join(evidence, 'csv-imported-return-chain-source.json'), json)
    const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
    await workspace.attachSession(sessionId)
    const workspaceRow = page.locator(`[data-row-key="workspace:${workspace.id}"]`)
    await reload(async () => { await workspaceRow.waitFor({ state: 'visible' }) })
    if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
    await page.locator(`[data-row-key="session:${sessionId}"]`).click()
    await expect.poll(() => world.ctx.agents.get(sessionId)?.session.snapshotEvents().some(event => event.type === 'approval/policy')).toBe(true)
    const agent = world.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('The recorded imported return comparison Session did not activate')
    await agent.whenIdle()
    expect(await world.ctx.sessions.flush(agent.session)).toBe(true)
    const initial = await readPersistedEvents(world, sessionId)
    const conversation = page.locator(`[data-conversation-session="${sessionId}"]`)
    const input = conversation.locator('[data-composer-input][contenteditable="true"]')
    const chip = conversation.locator('[data-artifact-prompt-context="csv-question-comparison"]')
    const review = chip.getByRole('button', { name: 'Review attached comparison', exact: true })
    const checkDraft = async (): Promise<void> => {
      await expect.poll(() => input.textContent()).toBe(REUSE_QUESTION)
      expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toEqual(draft)
      expectActivity(0)
    }
    const screenshot = async (target: Locator, file: string): Promise<void> => {
      await target.screenshot({ path: join(evidence, file), animations: 'disabled' })
    }
    const chain = { page, conversation, sessionId, first, middle, decoy, sourceKind: 'imported-return-comparison' as const,
      reload, inspect: inspectImportedReturns, screenshot }
    const caret = { start: 21, end: 21 }
    await writeComposerDraft(page, input, REUSE_QUESTION)
    await checkDraft()
    await review.click()
    await inspectImportedReturns(chip, shots('before-navigation'), true)
    await selectDraftOffsets(page, input, caret)

    stage('csv-return-chain-draft-follow-and-refresh-earliest-source')
    await walkImportedCsvSourceChain({ ...chain, origin: { kind: 'draft', receiptId: draft.receiptId }, checkDraft,
      name: 'csv-live-return-draft-chain' })
    await expect.poll(() => selectedDraftOffsets(input)).toEqual(caret)
    await checkDraft()
    const historyBeforeSend = await readPersistedEvents(world, sessionId)
    expect(historyBeforeSend).toEqual(initial)
    await screenshot(conversation.locator('[data-composer-seat]'), 'csv-live-return-chain-restored-draft.png')
    await expect.poll(() => selectedDraftOffsets(input)).toEqual(caret)
    expectActivity(0)

    stage('csv-return-chain-send-restored-draft-once')
    expect(await ask(REUSE_QUESTION, sessionId, true)).toBe(sessionId)
    expectActivity(1)
    const history = await readPersistedEvents(world, sessionId)
    const privateSource = [native.sessionId, native.sent.messageId, native.returns.branchSessionId, native.returns.first.messageId,
      native.returns.second.messageId, native.returns.first.artifactId, draft.receiptId, json.trim()]
    const { address, canonical, answer } = verifyReusedReturnSend(
      history, initial, draft.facts, providerUserText(REUSE_QUESTION), privateSource,
    )
    const checkAccepted = async (): Promise<void> => {
      await expect.poll(() => world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toBeNull()
      await expect.poll(() => input.textContent()).toBe('')
      expect(await chip.count()).toBe(0)
      expectActivity(1)
    }
    await checkAccepted()

    stage('csv-return-chain-refreshed-real-sent-question-follows-same-exact-hops')
    const replay = conversation.locator(`[data-chat-message-id="${address.messageId}"][data-chat-message-seq="${address.eventSeq}"]`)
      .locator('[data-csv-compare-attached]')
    const toggle = replay.getByRole('button', { name: 'Replay attached comparison', exact: true })
    await reload(async () => {
      await toggle.click()
      await inspectImportedReturns(replay, shots('sent-after-refresh'), true)
    })
    await walkImportedCsvSourceChain({ ...chain, origin: { kind: 'comparison', message: address }, checkDraft: checkAccepted,
      name: 'csv-live-return-sent-chain' })
    await checkAccepted()
    expect(await readPersistedEvents(world, sessionId)).toEqual(history)
    for (const endpoint of [REUSE, SAVE, EXPORT, IMPORT]) expect(at(endpoint)).toHaveLength(0)
    expect(console.warnings).toEqual([])
    expect(console.pageErrors).toEqual([])
    await writeFile(join(evidence, 'csv-imported-return-draft-chain-live-acceptance.json'), JSON.stringify({ userAgent,
      first, middle, decoy, sent: address, canonical, answer, restoredDraftCaret: caret, unchangedDraftReceiptAndContents: true,
      droveBothExactHopsFromDraftAndActualSent: true, providerRequests: requests.length, providerRequestsBeforeExplicitSend: 0,
      promptRequests: at(PROMPT).length, csvReads: reads.mock.calls.length, csvRecomputes: at(RECALCULATE).length,
    }, null, 2) + '\n')
  } finally { stop() }
}
