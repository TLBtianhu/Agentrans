/** Browser acceptance of a draft and one explanation from two native saved CSV comparisons. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArtifactCsvComparisonDraft } from '@agentrans/artifact-followup/types'
import { CSV_COMPARISON_CHANGES_PREFIX, CSV_COMPARISON_EXPLANATION_PREFIX } from '@agentrans/artifact/runtime-values'
import type { SessionId } from '@agentrans/session'
import type { Locator, Page, Request } from 'playwright'
import { expect, vi } from 'vitest'
import { compareReading, csvFixtureChatHead, expectCsvComparisonRecords, seedWitnessedCsvComparisons } from './csv-comparison-browser-fixture.ts'
import { acknowledgeReloadConnectionLoss, readPersistedEvents, type WebScaffold, type watchConsole } from './scaffold.ts'
import { writeComposerDraft } from './support.ts'

const REVIEW = '/api/artifactBranchResults/reviewCsvComparisonExplanation'
const SAVE = '/api/artifactBranchResults/saveCsvComparisonDraft'
const PROMPT = '/api/session/prompt'
const SOURCE_TRAIL_KEY = 'dsh.artifact.csv-comparison-source.v1'
const LOOKUPS = new Set(['compareCsvQuestionToReturn', 'csvFilterOptions', 'csvParticipatingRows', 'csvQuestionParticipatingRows',
  'csvReturnedParticipatingRows', 'lockCsv', 'recalculateCsv'].map(endpoint => `/api/artifactBranchResults/${endpoint}`))

type Witnessed = Awaited<ReturnType<typeof seedWitnessedCsvComparisons>>
type Address = Pick<Witnessed['alternate'], 'eventSeq' | 'messageId'>

export interface CsvExplanationBrowser {
  readonly page: Page
  readonly world: WebScaffold
  readonly evidence: string
  readonly requests: readonly unknown[]
  readonly ask: (prompt: string, sessionId?: SessionId, useExistingDraft?: boolean) => Promise<SessionId>
  readonly providerUserText: (question: string) => readonly string[]
  readonly stage: (name: string) => void
  readonly console: ReturnType<typeof watchConsole>
}

function browserRequest(request: Request): unknown {
  return (request.postDataJSON() as { payload: { args: { request: unknown } } }).payload.args.request
}

async function expectSavedComparison(scope: Locator, filtered: boolean): Promise<void> {
  await compareReading(scope, 'original', { key: 'Warm', aggregate: 'Mean of LatencyMs', filter: 'No filter', value: '30', count: '2' })
  await compareReading(scope, 'locked', { key: 'Warm', aggregate: 'Sum of LatencyMs', filter: filtered ? 'Batch = B' : 'No filter',
    value: filtered ? '35' : '60', count: filtered ? '1' : '2' })
  await expectCsvComparisonRecords(scope, filtered)
}

async function expectSteps(scope: Locator): Promise<void> {
  const aggregation = scope.locator('[data-csv-explanation-step="aggregation"]')
  const filtering = scope.locator('[data-csv-explanation-step="filtering"]')
  await aggregation.getByText('First change aggregation', { exact: true }).waitFor({ state: 'visible' })
  await filtering.getByText('Then add filter', { exact: true }).waitFor({ state: 'visible' })
  await expectSavedComparison(aggregation, false)
  await compareReading(filtering, 'original', { key: 'Warm', aggregate: 'Sum of LatencyMs', filter: 'No filter', value: '60', count: '2' })
  await compareReading(filtering, 'locked', { key: 'Warm', aggregate: 'Sum of LatencyMs', filter: 'Batch = B', value: '35', count: '1' })
  await expectCsvComparisonRecords(filtering, true)
}

/** Read native editor selection offsets only while the draft editor has focus. */
export async function selectedDraftOffsets(input: Locator): Promise<{ start: number; end: number } | null> {
  return input.evaluate((element) => {
    const doc = element.ownerDocument
    const selection = doc.getSelection()
    if (doc.activeElement !== element || selection?.rangeCount !== 1) return null
    const { startContainer, startOffset, endContainer, endOffset } = selection.getRangeAt(0)
    if (!element.contains(startContainer) || !element.contains(endContainer)) return null
    const start = doc.createRange()
    start.selectNodeContents(element)
    start.setEnd(startContainer, startOffset)
    const end = doc.createRange()
    end.selectNodeContents(element)
    end.setEnd(endContainer, endOffset)
    return { start: start.toString().length, end: end.toString().length }
  })
}

/** Set and verify an exact native caret or selection using editor keyboard commands. */
export async function selectDraftOffsets(page: Page, input: Locator, offsets: { start: number; end: number }): Promise<void> {
  await input.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home')
  for (let at = 0; at < offsets.start; at++) await page.keyboard.press('ArrowRight')
  for (let at = offsets.start; at < offsets.end; at++) await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(() => selectedDraftOffsets(input)).toEqual(offsets)
}

interface CsvExplanationDraftBrowser {
  readonly page: Page
  readonly world: WebScaffold
  readonly sessionId: SessionId
  readonly conversation: Locator
  readonly card: (address: Address) => Locator
  readonly sources: { readonly aggregation: Address; readonly filtering: Address }
  readonly draft: ArtifactCsvComparisonDraft
  readonly text: string
  readonly reload: (check: () => Promise<void>) => Promise<void>
  readonly screenshot: (target: Locator, name: string) => Promise<void>
  readonly reloadAfterReturn?: boolean
}

/** Follow both attached sources through reload and restore the same signed draft and native selection. */
export async function visitCsvExplanationDraftSources({ page, world, sessionId, conversation, card, sources, draft, text, reload,
  screenshot, reloadAfterReturn = false }: CsvExplanationDraftBrowser) {
  const input = conversation.locator('[data-composer-input][contenteditable="true"]')
  const chip = conversation.locator('[data-artifact-prompt-context="csv-question-comparison"]')
  const draftToggle = chip.getByRole('button', { name: 'Review attached comparison', exact: true })
  const returns = conversation.locator('[data-csv-return-to-draft]')
  const storedTrail = () => page.evaluate(key => sessionStorage.getItem(key), SOURCE_TRAIL_KEY)
  const checkDraft = async (): Promise<void> => {
    await expect.poll(() => input.textContent()).toBe(text)
    await chip.waitFor({ state: 'visible' })
    expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toEqual(draft)
  }
  const openSavedDraft = async (): Promise<void> => {
    if (await draftToggle.getAttribute('aria-expanded') !== 'true') await draftToggle.click()
    await expectSteps(chip)
  }
  const selection = () => selectedDraftOffsets(input)
  const digest: unknown = expect.stringMatching(/^[a-f0-9]{64}$/u)
  const toggle = (target: Locator): Locator => target.getByRole('button', { name: 'Replay attached comparison', exact: true })
  const cases = [['aggregation', { start: 5, end: 13 }], ['filtering', { start: 17, end: 17 }]] as const
  await checkDraft()
  for (const [kind, offsets] of cases) {
    const address = sources[kind]
    const target = card(address)
    const back = target.getByRole('button', { name: 'Return to draft', exact: true })
    const step = chip.locator(`[data-csv-explanation-step="${kind}"]`)
    const checkSource = async (): Promise<void> => {
      await back.waitFor({ state: 'visible' })
      expect(await returns.count()).toBe(1)
      await expect.poll(() => toggle(target).getAttribute('aria-expanded')).toBe('true')
      await expectSavedComparison(target, kind === 'filtering')
      await expect.poll(() => toggle(target).evaluate(element => document.activeElement === element)).toBe(true)
    }
    await openSavedDraft()
    await selectDraftOffsets(page, input, offsets)
    await step.locator('[data-csv-explanation-source]').click()
    await checkSource()
    await expect.poll(async () => {
      const saved: unknown = JSON.parse(await storedTrail() ?? 'null')
      return saved
    }).toEqual({ sessionId, trail: [{
      source: { eventSeq: address.eventSeq, messageId: address.messageId },
      origin: { kind: 'draft', receiptId: draft.receiptId, step: kind, ...offsets, digest },
    }] })
    await reload(async () => {
      await checkSource()
      await checkDraft()
    })
    await screenshot(target, `csv-draft-${kind}-source-after-refresh.png`)
    if (kind === 'aggregation') await back.click()
    else await back.press('Enter')
    await expect.poll(selection).toEqual(offsets)
    await checkDraft()
    await expect.poll(storedTrail).toBeNull()
    expect(await returns.count()).toBe(0)
    await screenshot(conversation.locator('[data-composer-seat]'), `csv-draft-returned-from-${kind}.png`)
    await openSavedDraft()
    await screenshot(step, `csv-draft-${kind}-attachment-preserved.png`)
    if (reloadAfterReturn) await reload(async () => {
      await checkDraft()
      for (const saved of Object.values(sources)) expect(await toggle(card(saved)).getAttribute('aria-expanded')).toBe('false')
      expect(await returns.count()).toBe(0)
      expect(await storedTrail()).toBeNull()
    })
  }
  await openSavedDraft()
  return cases.map(([kind, offsets]) => ({ kind, ...offsets }))
}

/** Check ordered-comparison answer evidence and reject a direct cross-aggregation trend claim. */
export function expectCsvExplanationAnswer(answer: string): void {
  const plain = answer.replaceAll('*', '').replaceAll('`', '')
  expect(plain).toMatch(/\bWarm\b/iu)
  expect(plain).toMatch(/\b(?:mean|average)\b[\s\S]{0,125}\b30\b|\b30\b[\s\S]{0,125}\b(?:mean|average)\b/iu)
  expect(plain).toMatch(/\b(?:sum|total)\b[\s\S]{0,125}\b60\b|\b60\b[\s\S]{0,125}\b(?:sum|total)\b/iu)
  expect(plain).toMatch(/\b(?:sum|total)\b[\s\S]{0,125}\b35\b|\b35\b[\s\S]{0,125}\b(?:sum|total)\b/iu)
  expect(plain).toMatch(/\bBatch\b[^.\n]{0,45}\bB\b/iu)
  const clauses = plain.split(/[\n.!?]+/u)
  const records = (n: number): RegExp => new RegExp(`\\b(?:row|record)\\s*#?\\s*${n}\\b|\\|\\s*${n}\\s*\\|`, 'iu')
  expect(clauses.some(line => records(4).test(line) && /\b(?:exclud\w*|remov\w*|filter\w* out)/iu.test(line))).toBe(true)
  expect(clauses.some(line => records(5).test(line) && /\b(?:kept|retain\w*|remain\w*|included)/iu.test(line))).toBe(true)
  const direction = '\\b(?:rose|fell|ris(?:e|es|ing)|fall(?:s|ing)?|drop(?:s|ped)?|(?:in|de)creas(?:e|es|ed))\\b'
  const crossAggregation = '\\b30\\b[^.\\n]{0,20}(?:to|→|->)\\s*\\b(?:60|35)\\b'
  const invalidTrend = new RegExp(`${direction}[^.\\n]{0,45}${crossAggregation}|${crossAggregation}[^.\\n]{0,25}${direction}`, 'iu')
  for (const clause of clauses.filter(line => !/\b(?:not|no|neither|cannot|can't|doesn't|isn't)\b/iu.test(line))) {
    expect(clause).not.toMatch(invalidTrend)
  }
}

/** Verify two witnessed source cards, one confirmed native question, and both exact sources after reload. */
export async function exerciseCsvComparisonExplanation({ page, world, evidence, requests, ask, providerUserText, stage, console }:
CsvExplanationBrowser): Promise<void> {
  const userAgent = await page.evaluate(() => navigator.userAgent)
  expect(userAgent).toMatch(/\bEdg\//u)
  await page.setViewportSize({ width: 1440, height: 1280 })
  const observed: Request[] = []
  const watch = (request: Request): void => { observed.push(request) }
  const rejectRead = vi.spyOn(world.ctx.attachments, 'readFileStream').mockImplementation(() => {
    throw new Error('Reading current CSV data is outside the saved explanation workflow')
  })
  const path = (request: Request): string => new URL(request.url()).pathname
  const requestsFor = (endpoint: string): readonly Request[] => observed.filter(request => path(request) === endpoint)
  const expectReadOnly = (sends: number): void => {
    expect(requests).toHaveLength(sends)
    expect(requestsFor(PROMPT)).toHaveLength(sends)
    expect(observed.filter(request => LOOKUPS.has(path(request)))).toEqual([])
    expect(rejectRead).not.toHaveBeenCalled()
  }
  page.on('request', watch)
  const reload = async (ready: () => Promise<void>): Promise<void> => {
    const before = console.warnings.length
    await page.reload()
    await ready()
    acknowledgeReloadConnectionLoss(console, before)
  }
  try {
    stage('csv-explanation-seed-native-history')
    const systemHead = await csvFixtureChatHead(world)
    const { sessionId, filtered, alternate, comparison, alternateComparison, source, question } =
      await seedWitnessedCsvComparisons(world, 'csv-native-explanation', systemHead)
    const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
    await workspace.attachSession(sessionId)
    const workspaceRow = page.locator(`[data-row-key="workspace:${workspace.id}"]`)
    await reload(async () => { await workspaceRow.waitFor({ state: 'visible' }) })
    if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
    await page.locator(`[data-row-key="session:${sessionId}"]`).click()
    const conversation = page.locator(`[data-conversation-session="${sessionId}"]`)
    const card = (address: Address): Locator => conversation.locator(
      `[data-chat-message-id="${address.messageId}"][data-chat-message-seq="${address.eventSeq}"] [data-csv-compare-attached]`,
    )
    const open = async (address: Address): Promise<Locator> => {
      const comparisonCard = card(address)
      const toggle = comparisonCard.getByRole('button', { name: 'Replay attached comparison', exact: true })
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
      return comparisonCard
    }

    stage('csv-explanation-review-two-saved-cards')
    const filteredCard = await open(filtered)
    await expectSavedComparison(filteredCard, true)
    const alternateCard = await open(alternate)
    await expectSavedComparison(alternateCard, false)
    const select = (target: Locator): Locator => target.locator('[data-csv-select-explanation-step]')
    const first = { eventSeq: filtered.eventSeq, messageId: filtered.messageId }
    const second = { eventSeq: alternate.eventSeq, messageId: alternate.messageId }
    const facts = { kind: 'csv-question-comparison', sessionId, question, source, comparison,
      explanation: { aggregation: { message: second, comparison: alternateComparison }, filtering: first } }
    const initialEvents = await readPersistedEvents(world, sessionId)
    await select(filteredCard).click()
    expectReadOnly(0)
    expect(requestsFor(REVIEW)).toHaveLength(0)
    expect(requestsFor(SAVE)).toHaveLength(0)
    const [reviewed] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === REVIEW), select(alternateCard).click(),
    ])
    expect(browserRequest(reviewed.request())).toEqual({ sessionId, first, second })
    expect(await reviewed.json()).toMatchObject({ result: { ok: true, value: { facts } } })
    const review = conversation.locator('[data-csv-explanation-review]')
    await expectSteps(review)
    await review.screenshot({ path: join(evidence, 'csv-two-step-review.png') })
    expectReadOnly(0)
    expect(requestsFor(SAVE)).toHaveLength(0)
    const [saved] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === SAVE), review.locator('[data-csv-confirm-explanation]').click(),
    ])
    const locked = await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })
    if (locked === null) throw new Error('The confirmed explanation has no saved draft receipt')
    expect(locked.facts).toEqual(facts)
    expect(await saved.json()).toMatchObject({ result: { ok: true, value: locked } })
    const chip = conversation.locator('[data-artifact-prompt-context="csv-question-comparison"]')
    await chip.waitFor({ state: 'visible' })
    expect(await readPersistedEvents(world, sessionId)).toEqual(initialEvents)
    expectReadOnly(0)

    const prompt = 'Explain this confirmed CSV comparison in order. Keep the two changes distinct and describe what happened to the contributing '
      + 'records by record number. Use the recorded comparison.'
    const input = conversation.locator('[data-composer-input]')
    await writeComposerDraft(page, input, prompt)
    stage('csv-explanation-draft-source-round-trips')
    const selections = await visitCsvExplanationDraftSources({ page, world, sessionId, conversation, card,
      sources: { aggregation: second, filtering: first }, draft: locked, text: prompt, reload,
      screenshot: async (target, name) => { await target.screenshot({ path: join(evidence, name) }) },
    })
    expect(await readPersistedEvents(world, sessionId)).toEqual(initialEvents)
    expectReadOnly(0)
    expect(requestsFor(REVIEW)).toHaveLength(1)
    expect(requestsFor(SAVE)).toHaveLength(1)
    const beforeSend = { providerRequests: requests.length, promptRequests: requestsFor(PROMPT).length,
      csvReads: rejectRead.mock.calls.length, csvRecomputes: requestsFor('/api/artifactBranchResults/recalculateCsv').length,
      historyUnchanged: true, sameDraftReceiptAndFacts: true, exactRestoredSelections: selections }

    stage('csv-explanation-send-one-real-question')
    expect(await ask(prompt, sessionId, true)).toBe(sessionId)
    expectReadOnly(1)
    await expect.poll(() => world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toBeNull()
    await chip.waitFor({ state: 'hidden' })
    await expect.poll(() => input.textContent()).toBe('')
    const history = await readPersistedEvents(world, sessionId)
    expect(history.filter(event => event.seq > initialEvents.at(-1)!.seq && event.type === 'turn/start')).toHaveLength(1)
    const sent = history.find(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text === prompt))
    if (sent?.type !== 'user/message') throw new Error('The two-step question is missing from recorded history')
    const [questionText, context] = sent.data.content
    expect(questionText).toEqual({ type: 'text', text: prompt })
    expect(sent.data.content).toHaveLength(2)
    if (context?.type !== 'text' || !context.text.startsWith(CSV_COMPARISON_EXPLANATION_PREFIX)) {
      throw new Error('The sent question lost its confirmed two-step explanation')
    }
    expect(JSON.parse(context.text.slice(CSV_COMPARISON_EXPLANATION_PREFIX.length)))
      .toEqual({ kind: 'artifact-question-context', sessionId, facts })
    const modelText = providerUserText(prompt)
    expect(modelText.filter(text => text === prompt)).toHaveLength(1)
    // The adapter can coalesce neighboring user messages in the recorded native conversation.
    const newQuestion = modelText.slice(modelText.indexOf(prompt))
    expect(newQuestion.slice(0, 2)).toEqual([prompt, context.text])
    expect(modelText.filter(text => text.startsWith(CSV_COMPARISON_EXPLANATION_PREFIX))).toHaveLength(1)
    expect(newQuestion.every(text => !text.includes('"proof"') && !text.includes('"receiptId"')
      && !text.includes(CSV_COMPARISON_CHANGES_PREFIX))).toBe(true)
    const final = history.findLast(event => event.seq > sent.seq && event.type === 'assistant/message')
    if (final?.type !== 'assistant/message') throw new Error('DeepSeek did not answer the two-step question')
    const answer = final.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expectCsvExplanationAnswer(answer)
    expect(history.filter(event => event.seq > sent.seq && event.type === 'tool/call')).toEqual([])

    stage('csv-explanation-refresh-and-open-exact-sources')
    const sentAddress = { eventSeq: sent.seq, messageId: sent.data.id }
    await reload(async () => { await expectSteps(await open(sentAddress)) })
    const sentCard = card(sentAddress)
    await sentCard.screenshot({ path: join(evidence, 'csv-two-step-after-refresh.png') })
    for (const [target, address, isFiltered] of [['aggregation', second, false], ['filtering', first, true]] as const) {
      await sentCard.locator(`[data-csv-explanation-step="${target}"] [data-csv-explanation-source]`).click()
      const original = card(address)
      const toggle = original.getByRole('button', { name: 'Replay attached comparison', exact: true })
      await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
      await expect.poll(() => toggle.evaluate(element => document.activeElement === element)).toBe(true)
      await expectSavedComparison(original, isFiltered)
      await original.screenshot({ path: join(evidence, `csv-two-step-source-${target}.png`) })
    }
    expectReadOnly(1)
    expect(requestsFor(REVIEW)).toHaveLength(1)
    expect(requestsFor(SAVE)).toHaveLength(1)
    expect(await readPersistedEvents(world, sessionId)).toEqual(history)
    expect(console.warnings).toEqual([])
    expect(console.pageErrors).toEqual([])
    await writeFile(join(evidence, 'csv-two-step-acceptance.json'), JSON.stringify({ userAgent, source: { sessionId, aggregation: second, filtering: first },
      sent: sentAddress, explanation: facts.explanation, filteredComparison: comparison, answer, beforeSend,
      providerRequests: requests.length, promptRequests: requestsFor(PROMPT).length, csvReads: rejectRead.mock.calls.length,
      csvRecomputes: requestsFor('/api/artifactBranchResults/recalculateCsv').length,
      extraModelCallsForReviewAndReload: 0, bothSourcesReproduced: true }, null, 2) + '\n')
  } finally {
    page.off('request', watch)
    rejectRead.mockRestore()
  }
}
