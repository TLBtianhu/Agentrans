/** Live DeepSeek and Edge acceptance for a portable two-step CSV explanation. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CSV_COMPARISON_CHANGES_PREFIX, IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX, IMPORTED_CSV_EXPLANATION_SOURCE_TEXT,
} from '@agentrans/artifact/runtime-values'
import type { ArtifactCsvComparisonQuestionFacts } from '@agentrans/artifact-followup/types'
import type { Locator, Request } from 'playwright'
import { expect, vi } from 'vitest'
import { expectCsvExplanationAnswer, selectDraftOffsets, selectedDraftOffsets, type CsvExplanationBrowser } from './artifact-csv-explanation-support.ts'
import { downloadSentCsvComparisonJson, openCsvImportFile, openFreshCsvChat } from './artifact-csv-portable-support.ts'
import { walkImportedCsvSourceChain } from './artifact-csv-return-source-support.ts'
import {
  compareReading, expectCsvComparisonRecords, seedFirstImportedExplanationReuse, seedWitnessedCsvExplanation,
} from './csv-comparison-browser-fixture.ts'
import { acknowledgeReloadConnectionLoss, readPersistedEvents } from './scaffold.ts'
import { writeComposerDraft } from './support.ts'

const QUESTION = 'Explain the two changes in the attached evidence in order. Describe each calculation and which records contribute, '
  + 'giving their original record numbers and values. Describe how I supplied the evidence and what the attachment includes.'
const EXPORT = '/api/artifactBranchResults/exportSentCsvComparisonJson'
const IMPORT = '/api/artifactBranchResults/importCsvComparison'
const SAVE = '/api/artifactBranchResults/saveCsvComparisonDraft'
const REUSE = '/api/artifactBranchResults/reviewSentCsvComparison'
const PROMPT = '/api/session/prompt'
const RECOMPUTE = '/api/artifactBranchResults/recalculateCsv'
const FORBIDDEN = new Set(['compareCsvQuestionToReturn', 'compareCsvReturns', 'csvFilterOptions', 'csvParticipatingRows', 'csvQuestionParticipatingRows',
  'csvReturnedParticipatingRows', 'lockCsv', 'recalculateCsv'].map(endpoint => `/api/artifactBranchResults/${endpoint}`))

function requestBody(request: Request): unknown {
  return (request.postDataJSON() as { payload: { args: { request: unknown } } }).payload.args.request
}

function expectImportedExplanationAnswer(answer: string): void {
  expectCsvExplanationAnswer(answer)
  const plain = answer.replace(/[*`_]/gu, '').replace(/‑/gu, '-').replace(/\.json\b/giu, ' JSON')
  const unchanged = /\b(?:same|both|unchanged)\b[^.?!\n]{0,65}\b(?:rows?|records?|measurements?)\b/iu
  const membership = /\b(?:rows?|records?|measurements?|membership)\b[^.?!\n]{0,65}\b(?:unchanged|same|both kept|both retained)\b/iu
  expect(unchanged.test(plain) || membership.test(plain)).toBe(true)
  const version = /\b(?:versioned|version\s*1|v1)\b/.source
  expect(plain).toMatch(new RegExp(`${version}[^.?!\\n]{0,65}\\bJSON\\b|\\bJSON\\b[^.?!\\n]{0,65}${version}`, 'iu'))
  expect(plain).toMatch(/\b(?:two|both|2)\b[^.?!\n]{0,65}\b(?:pages|comparisons|snapshots)\b/iu)
  expect(plain).toMatch(/\b(?:original|locked|saved|recorded)\b[^.?!\n]{0,70}\b(?:pages|comparisons|snapshots)\b/iu)
  const attribution = '\\b(?:import(?:ed|ing)?|upload(?:ed|ing)?|attach(?:ed|ing)?|provid(?:ed|ing)|suppl(?:ied|ying))\\b'
  const jsonAttribution = new RegExp(`${attribution}[^.?!\\n]{0,100}\\bJSON\\b|\\bJSON\\b[^.?!\\n]{0,100}${attribution}`, 'giu')
  const negation = /\b(?:not|never|rather than|instead of)\b[^,.;!?\n]*$/iu
  const negated = (at: number): boolean => negation.test(plain.slice(Math.max(0, at - 40), at))
  expect([...plain.matchAll(jsonAttribution)].some(match => !negated(match.index) && !negation.test(match[0]))).toBe(true)
  const csv = /\b(?:CSV\b(?![\s-]+(?:comparison|explanation|snapshot|export|records?|rows?|readings?|evidence)\b)|[\w-]+\.csv\b)/iu.source
  const qualifiers = '(?:(?:a|an|the|your|my|raw|original|underlying|actual|source|directly)\\s+)*'
  const csvImport = new RegExp(`${attribution}\\s+${qualifiers}${csv}|${csv}(?:\\s+(?:file|dataset))?\\s+(?:was|got)\\s+${attribution}`, 'giu')
  expect([...plain.matchAll(csvImport)].filter(match => !negated(match.index)).map(match => match[0])).toEqual([])
  const rowPair = /\b(?:rows?|records?)\s*#?\s*4\b[^\d.\n]{0,35}\b25\b[^\d.\n]{0,35}\b5\b[^\d.\n]{0,35}\b35\b/iu
  const numberedRows = /\b(?:rows?|records?)\s*#?\s*4\s*(?:and|,|&)\s*#?\s*5\b/.source
  const respectively = new RegExp(`${numberedRows}[^\\d.\\n]{0,40}\\b25\\b[^\\d.\\n]{0,25}\\b35\\b[^.\\n]{0,25}\\brespectively\\b`, 'iu')
  if (!rowPair.test(plain) && !respectively.test(plain)) {
    for (const [record, value] of [[4, 25], [5, 35]]) {
      const label = `(?:\\b(?:row|record)\\s*#?\\s*${record}\\b|\\|\\s*${record}\\s*\\|)`
      expect(plain).toMatch(new RegExp(`${label}[^\\d.\\n]{0,55}\\b${value}\\b`, 'iu'))
    }
  }
}

type PersistedHistory = Awaited<ReturnType<typeof readPersistedEvents>>

function verifyImportedExplanationSend(history: PersistedHistory, initial: PersistedHistory, facts: ArtifactCsvComparisonQuestionFacts,
  provider: readonly string[], privateSource: readonly string[]) {
  expect(history.slice(0, initial.length)).toEqual(initial)
  const added = history.slice(initial.length)
  expect(added.filter(event => event.type === 'turn/start')).toHaveLength(1)
  expect(added.filter(event => event.type === 'tool/call')).toEqual([])
  const sent = added.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (sent?.type !== 'user/message') throw new Error('The imported explanation question was not recorded')
  const context = sent.data.content[1]
  if (context?.type !== 'text' || !context.text.startsWith(IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX)) {
    throw new Error('The sent explanation lost its imported provenance')
  }
  const canonical = { kind: 'artifact-question-context', sessionId: facts.sessionId, facts }
  expect(JSON.parse(context.text.slice(IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX.length))).toEqual(canonical)
  const texts = [QUESTION, context.text, IMPORTED_CSV_EXPLANATION_SOURCE_TEXT]
  expect(sent.data.content).toEqual(texts.map(text => ({ type: 'text', text })))
  expect(provider.filter(block => block === QUESTION)).toHaveLength(1)
  const providerQuestion = provider.slice(provider.indexOf(QUESTION))
  expect(providerQuestion.slice(0, 3)).toEqual(texts)
  expect(providerQuestion.filter(block => block.startsWith(IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX))).toHaveLength(1)
  expect(providerQuestion.filter(block => block === IMPORTED_CSV_EXPLANATION_SOURCE_TEXT)).toHaveLength(1)
  expect(providerQuestion.every(block => [...privateSource, '"proof"', '"receiptId"', CSV_COMPARISON_CHANGES_PREFIX]
    .every(value => !block.includes(value)))).toBe(true)
  const answerEvent = added.findLast(event => event.type === 'assistant/message' && event.seq > sent.seq)
  if (answerEvent?.type !== 'assistant/message') throw new Error('DeepSeek did not answer the imported explanation')
  const answer = answerEvent.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  expectImportedExplanationAnswer(answer)
  return { address: { eventSeq: sent.seq, messageId: sent.data.id }, canonical, answer }
}

function watchPortableExplanation({ page, world, requests }: CsvExplanationBrowser) {
  const seen: Request[] = []
  const watch = (request: Request): void => { seen.push(request) }
  const path = (request: Request): string => new URL(request.url()).pathname
  const at = (endpoint: string): readonly Request[] => seen.filter(request => path(request) === endpoint)
  const reads = vi.spyOn(world.ctx.attachments, 'readFileStream').mockImplementation(() => {
    throw new Error('A portable explanation must not read the original CSV')
  })
  const expectActivity = (sends: number): void => {
    expect(seen.filter(request => FORBIDDEN.has(path(request)))).toEqual([])
    expect(reads).not.toHaveBeenCalled()
    expect(requests).toHaveLength(sends)
    expect(at(PROMPT)).toHaveLength(sends)
  }
  page.on('request', watch)
  return { at, reads, expectActivity, stop: () => { page.off('request', watch); reads.mockRestore() } }
}

function portableReload({ page, console }: CsvExplanationBrowser) {
  return async (ready: () => Promise<void>): Promise<void> => {
    const warnings = console.warnings.length
    await page.reload()
    await ready()
    acknowledgeReloadConnectionLoss(console, warnings)
  }
}

/** Compare both imported transitions and independently inspect their exact stored originals. */
export async function inspectImportedPair(scope: Locator, capture: (details: Locator, step: string) => Promise<void>,
  allowReuseSource = false): Promise<void> {
  const provenance = scope.locator('[data-csv-comparison-provenance="user-imported"]')
  await expect.poll(() => provenance.textContent()).toBe('User imported')
  expect(await scope.locator('[data-csv-explanation-source]').count()).toBe(0)
  if (!allowReuseSource) expect(await scope.locator('[data-csv-view-source-question], [data-csv-view-full-source-chain]').count()).toBe(0)
  const steps = scope.locator('[data-csv-explanation-step]')
  expect(await steps.evaluateAll(items => items.map(item => item.getAttribute('data-csv-explanation-step')))).toEqual(['aggregation', 'filtering'])
  expect(await scope.locator('details[data-csv-explanation-original]:visible').count()).toBe(2)
  for (const [index, kind] of ['aggregation', 'filtering'].entries()) {
    const filtered = kind === 'filtering'
    const step = steps.nth(index)
    const transition = step.locator('[data-csv-explanation-transition]')
    const page = step.locator('details[data-csv-explanation-original]')
    const summary = page.locator('summary')
    await compareReading(transition, 'original', { key: 'Warm', aggregate: filtered ? 'Sum of LatencyMs' : 'Mean of LatencyMs',
      filter: 'No filter', value: filtered ? '60' : '30', count: '2' })
    await compareReading(transition, 'locked', { key: 'Warm', aggregate: 'Sum of LatencyMs', filter: filtered ? 'Batch = B' : 'No filter',
      value: filtered ? '35' : '60', count: filtered ? '1' : '2' })
    expect(await scope.locator('details[data-csv-explanation-original][open]').count()).toBe(0)
    expect(await summary.textContent()).toBe('View locked source comparison')
    await summary.click()
    await expect.poll(() => page.evaluate(element => element.hasAttribute('open'))).toBe(true)
    expect(await scope.locator('details[data-csv-explanation-original][open]').count()).toBe(1)
    await compareReading(page, 'original', { key: 'Warm', aggregate: 'Mean of LatencyMs', filter: 'No filter', value: '30', count: '2' })
    await compareReading(page, 'locked', { key: 'Warm', aggregate: 'Sum of LatencyMs', filter: filtered ? 'Batch = B' : 'No filter',
      value: filtered ? '35' : '60', count: filtered ? '1' : '2' })
    await expectCsvComparisonRecords(page, filtered)
    await capture(page, kind)
    await summary.click()
  }
  await expect.poll(() => scope.locator('details[data-csv-explanation-original][open]').count()).toBe(0)
}

/** Transfer two witnessed pages through the actual JSON picker and send one imported explanation. */
export async function exercisePortableCsvExplanation(live: CsvExplanationBrowser): Promise<void> {
  const { page, world, evidence, requests, ask, providerUserText, stage, console } = live
  const userAgent = await page.evaluate(() => navigator.userAgent)
  expect(userAgent).toMatch(/\bEdg\//u)
  await page.setViewportSize({ width: 1440, height: 1280 })
  const { at, reads, expectActivity, stop } = watchPortableExplanation(live)
  const reload = portableReload(live)
  try {
    stage('csv-portable-explanation-export-from-native-history')
    const { sessionId, alternate, filtered, explanation, comparison, alternateComparison, source, question }
      = await seedWitnessedCsvExplanation(world, 'csv-explanation-portable-source')
    const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
    await workspace.attachSession(sessionId)
    const workspaceRow = page.locator(`[data-row-key="workspace:${workspace.id}"]`)
    await reload(async () => { await workspaceRow.waitFor({ state: 'visible' }) })
    if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
    await page.locator(`[data-row-key="session:${sessionId}"]`).click()
    const pair = page.locator(`[data-chat-message-id="${explanation.messageId}"][data-chat-message-seq="${explanation.eventSeq}"]`)
      .locator('[data-csv-compare-attached]')
    await pair.getByRole('button', { name: 'Replay attached comparison', exact: true }).click()
    expect(await pair.locator('[data-csv-explanation-source]').count()).toBe(2)
    const { portableFile, json } = await downloadSentCsvComparisonJson(page, pair, explanation.eventSeq, evidence, 'Download explanation as JSON')
    const file = { format: 'agentrans-csv-comparison-explanation', version: 1, aggregation: alternateComparison, filtering: comparison }
    expect(JSON.parse(json)).toEqual(file)
    expect(at(EXPORT).map(requestBody)).toEqual([explanation])
    const privateSource = [sessionId, source.messageId, source.artifactId, question.messageId, alternate.messageId, filtered.messageId,
      explanation.messageId, '"sessionId"', '"messageId"', '"eventSeq"', '"proof"', '"receiptId"']
    for (const value of privateSource) expect(json).not.toContain(value)
    expectActivity(0)

    stage('csv-portable-explanation-import-and-inspect-originals')
    const destination = await openFreshCsvChat(page, world, sessionId)
    const conversation = page.locator(`[data-conversation-session="${destination}"]`)
    const initial = await readPersistedEvents(world, destination)
    const facts = { kind: 'csv-question-comparison', sessionId: destination, provenance: 'user-imported', comparison,
      explanation: { aggregation: { comparison: alternateComparison } } } as const
    const imported = await openCsvImportFile(page, conversation, portableFile)
    expect(await imported.json()).toMatchObject({ result: { ok: true, value: { facts } } })
    expect(at(IMPORT).map(requestBody)).toEqual([{ sessionId: destination, json }])
    const review = conversation.locator('[data-csv-import-review]')
    const shots = (label: string) => async (details: Locator, kind: string): Promise<void> => {
      await details.screenshot({ path: join(evidence, `csv-imported-explanation-${label}-${kind}.png`) })
    }
    await inspectImportedPair(review, shots('preview'))
    await review.screenshot({ path: join(evidence, 'csv-imported-explanation-preview.png') })
    expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId: destination })).toBeNull()
    expect(at(SAVE)).toHaveLength(0)
    expectActivity(0)

    stage('csv-portable-explanation-confirm-and-reload-draft')
    const [saved] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === SAVE),
      review.getByRole('button', { name: 'Attach comparison', exact: true }).click(),
    ])
    const receipt = await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId: destination })
    if (receipt === null) throw new Error('The imported explanation has no saved draft receipt')
    expect(receipt.facts).toEqual(facts)
    expect(await saved.json()).toMatchObject({ result: { ok: true, value: receipt } })
    const chip = conversation.locator('[data-artifact-prompt-context="csv-question-comparison"]')
    const input = conversation.locator('[data-composer-input]')
    await chip.waitFor({ state: 'visible' })
    await writeComposerDraft(page, input, QUESTION)
    const draftToggle = chip.getByRole('button', { name: 'Review attached comparison', exact: true })
    await reload(async () => {
      await expect.poll(() => input.textContent()).toBe(QUESTION)
      expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId: destination })).toEqual(receipt)
      await draftToggle.click()
      await inspectImportedPair(chip, shots('draft-after-refresh'))
      await draftToggle.click()
    })
    expect(await readPersistedEvents(world, destination)).toEqual(initial)
    expectActivity(0)

    stage('csv-portable-explanation-send-one-real-question')
    expect(await ask(QUESTION, destination, true)).toBe(destination)
    expectActivity(1)
    const history = await readPersistedEvents(world, destination)
    const { address, canonical, answer } = verifyImportedExplanationSend(history, initial, facts, providerUserText(QUESTION),
      [...privateSource.filter(value => value !== '"sessionId"'), receipt.receiptId, json.trim(), file.format])
    expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId: destination })).toBeNull()

    stage('csv-portable-explanation-refresh-sent-and-inspect-both')
    const replay = conversation.locator(`[data-chat-message-id="${address.messageId}"][data-chat-message-seq="${address.eventSeq}"]`)
      .locator('[data-csv-compare-attached]')
    await reload(async () => {
      await replay.getByRole('button', { name: 'Replay attached comparison', exact: true }).click()
      await inspectImportedPair(replay, shots('sent-after-refresh'))
    })
    await replay.screenshot({ path: join(evidence, 'csv-imported-explanation-after-refresh.png') })
    expect(await readPersistedEvents(world, destination)).toEqual(history)
    expectActivity(1)
    expect(at(EXPORT)).toHaveLength(1)
    expect(at(IMPORT)).toHaveLength(1)
    expect(at(SAVE)).toHaveLength(1)
    expect(console.warnings).toEqual([])
    expect(console.pageErrors).toEqual([])
    await writeFile(join(evidence, 'csv-portable-explanation-acceptance.json'), JSON.stringify({ userAgent, source: explanation,
      destination: { sessionId: destination, ...address }, file, canonical, answer,
      providerRequests: requests.length, providerRequestsBeforeExplicitSend: 0, promptRequests: at(PROMPT).length,
      csvReads: reads.mock.calls.length, csvRecomputes: at(RECOMPUTE).length, resumedDraftAfterReload: true,
      bothOriginalsInspectedAfterSentReload: true, portableJsonContainsLocalIdentities: false,
    }, null, 2) + '\n')
  } finally { stop() }
}

/** Send one confirmed reuse of an imported explanation and follow its exact source chain. */
export async function exerciseReusedImportedCsvExplanation(live: CsvExplanationBrowser): Promise<void> {
  const { page, world, evidence, requests, ask, providerUserText, stage, console } = live
  const userAgent = await page.evaluate(() => navigator.userAgent)
  expect(userAgent).toMatch(/\bEdg\//u)
  await page.setViewportSize({ width: 1440, height: 1280 })
  const { at, reads, expectActivity, stop } = watchPortableExplanation(live)
  const reload = portableReload(live)
  const shots = (label: string) => async (details: Locator, step: string): Promise<void> => {
    await details.evaluate((element) => { element.scrollIntoView({ block: 'center' }) })
    await details.screenshot({ path: join(evidence, `csv-reuse-explanation-${label}-${step}.png`) })
  }
  try {
    stage('csv-reuse-explanation-seed-imported-history')
    const { sessionId, first, middle: original, facts, native } =
      await seedFirstImportedExplanationReuse(world, 'csv-imported-explanation-reuse')
    const firstSource = { eventSeq: first.eventSeq, messageId: first.messageId }
    const source = { eventSeq: original.eventSeq, messageId: original.messageId }
    const reusedFacts = { ...facts, reusedFrom: source }
    const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
    await workspace.attachSession(sessionId)
    const workspaceRow = page.locator(`[data-row-key="workspace:${workspace.id}"]`)
    await reload(async () => { await workspaceRow.waitFor({ state: 'visible' }) })
    if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
    await page.locator(`[data-row-key="session:${sessionId}"]`).click()
    const conversation = page.locator(`[data-conversation-session="${sessionId}"]`)
    const card = ({ messageId, eventSeq }: typeof source): Locator => conversation
      .locator(`[data-chat-message-id="${messageId}"][data-chat-message-seq="${eventSeq}"] [data-csv-compare-attached]`)
    const originalCard = card(original)
    const toggle = (scope: Locator): Locator => scope.getByRole('button', { name: 'Replay attached comparison', exact: true })
    const screenshot = async (target: Locator, file: string): Promise<void> => {
      await target.screenshot({ path: join(evidence, file), animations: 'disabled' })
    }
    const chain = { page, conversation, sessionId, first, middle: original, sourceKind: 'imported-explanation' as const,
      reload, inspect: inspectImportedPair, screenshot }
    expect(original.eventSeq).not.toBe(first.eventSeq)
    expect(original.messageId).not.toBe(first.messageId)
    await toggle(originalCard).click()
    await expect.poll(() => world.ctx.agents.get(sessionId)?.session.snapshotEvents().some(event => event.type === 'approval/policy')).toBe(true)
    const agent = world.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('The imported explanation Session did not activate')
    await agent.whenIdle()
    expect(await world.ctx.sessions.flush(agent.session)).toBe(true)
    const initial = await readPersistedEvents(world, sessionId)
    expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toBeNull()
    expectActivity(0)

    stage('csv-reuse-explanation-review-entire-pair')
    const reuse = originalCard.locator('[data-csv-reuse-entire-explanation]')
    expect(await reuse.textContent()).toBe('Reuse entire explanation')
    await reuse.click()
    const review = originalCard.locator('[data-csv-compare-review]')
    await inspectImportedPair(review, shots('review'))
    await review.screenshot({ path: join(evidence, 'csv-reuse-explanation-review.png') })
    expect(at(REUSE)).toHaveLength(0)
    expect(at(SAVE)).toHaveLength(0)
    expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toBeNull()
    expectActivity(0)

    stage('csv-reuse-explanation-confirm-and-reload-draft')
    const [reviewed, saved] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === REUSE),
      page.waitForResponse(response => new URL(response.url()).pathname === SAVE),
      review.getByRole('button', { name: 'Attach comparison', exact: true }).click(),
    ])
    expect(at(REUSE).map(requestBody)).toEqual([original])
    expect(await reviewed.json()).toMatchObject({ result: { ok: true, value: { facts: reusedFacts } } })
    const locked = await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })
    if (locked === null) throw new Error('The reused explanation has no confirmed draft receipt')
    expect(locked.facts).toEqual(reusedFacts)
    expect(await saved.json()).toMatchObject({ result: { ok: true, value: locked } })
    const chip = conversation.locator('[data-artifact-prompt-context="csv-question-comparison"]')
    await chip.waitFor({ state: 'visible' })
    const input = conversation.locator('[data-composer-input][contenteditable="true"]')
    await writeComposerDraft(page, input, QUESTION)
    const draftToggle = chip.getByRole('button', { name: 'Review attached comparison', exact: true })
    const checkDraft = async (): Promise<void> => {
      await expect.poll(() => input.textContent()).toBe(QUESTION)
      expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toEqual(locked)
      expectActivity(0)
    }
    await reload(async () => {
      await checkDraft()
      await draftToggle.click()
      await inspectImportedPair(chip, shots('draft-after-refresh'), true)
    })

    stage('csv-reuse-explanation-follow-both-exact-sources-from-draft')
    const caret = { start: 21, end: 21 }
    await selectDraftOffsets(page, input, caret)
    await walkImportedCsvSourceChain({ ...chain, origin: { kind: 'draft', receiptId: locked.receiptId }, checkDraft,
      name: 'csv-live-imported-explanation-draft-chain' })
    expect(await readPersistedEvents(world, sessionId)).toEqual(initial)
    await screenshot(conversation.locator('[data-composer-seat]'), 'csv-live-imported-explanation-restored-draft.png')
    await expect.poll(() => selectedDraftOffsets(input)).toEqual(caret)
    expectActivity(0)

    stage('csv-reuse-explanation-send-one-real-question')
    expect(await ask(QUESTION, sessionId, true)).toBe(sessionId)
    expectActivity(1)
    const history = await readPersistedEvents(world, sessionId)
    const privateSource = [first.messageId, native.sessionId, native.source.artifactId, native.source.messageId, native.question.messageId,
      native.alternate.messageId, native.filtered.messageId, native.explanation.messageId, locked.receiptId]
    const { address, canonical, answer } = verifyImportedExplanationSend(
      history, initial, locked.facts, providerUserText(QUESTION), privateSource,
    )
    const checkSent = async (): Promise<void> => {
      await expect.poll(() => input.textContent()).toBe('')
      await expect.poll(() => world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toBeNull()
      expect(await chip.count()).toBe(0)
      expectActivity(1)
    }
    await checkSent()

    stage('csv-reuse-explanation-refresh-sent-and-inspect-both')
    const replay = card(address)
    await reload(async () => {
      await toggle(replay).click()
      await inspectImportedPair(replay, shots('sent-after-refresh'), true)
    })
    await screenshot(replay, 'csv-reuse-explanation-after-refresh.png')

    stage('csv-reuse-explanation-follow-source-chain-from-real-sent-question')
    await walkImportedCsvSourceChain({ ...chain, origin: { kind: 'comparison', message: address }, checkDraft: checkSent,
      name: 'csv-live-imported-explanation-sent-chain' })
    expect(await readPersistedEvents(world, sessionId)).toEqual(history)
    expectActivity(1)
    expect(at(REUSE)).toHaveLength(1)
    expect(at(SAVE)).toHaveLength(1)
    expect(at(EXPORT)).toHaveLength(0)
    expect(at(IMPORT)).toHaveLength(0)
    expect(console.warnings).toEqual([])
    expect(console.pageErrors).toEqual([])
    await writeFile(join(evidence, 'csv-reused-explanation-acceptance.json'), JSON.stringify({ userAgent, first, original,
      sent: { sessionId, ...address }, canonical, answer, providerRequests: requests.length, providerRequestsBeforeExplicitSend: 0,
      promptRequests: at(PROMPT).length, csvReads: reads.mock.calls.length, csvRecomputes: at(RECOMPUTE).length,
      rereadImportedFile: false, sameReceiptAfterReload: true, historyUnchangedBeforeSend: true,
      bothOriginalsInspectedAfterSentReload: true, exactSourceChainFromDraft: [source, firstSource], restoredDraftCaret: caret,
      returnedToUnchangedDraft: true, exactSourceChainFromSent: [source, firstSource], earliestRefreshed: true,
      returnedThroughBothStopsToSent: true, verifiedJsonImportAndBothLockedPages: true,
    }, null, 2) + '\n')
  } finally { stop() }
}
