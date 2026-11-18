/** Live Edge journey for a conversation-owned CSV and its chart revisions. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CSV_COMPARISON_QUESTION_PREFIX, csvComparisonChangesText } from '@agentrans/artifact/runtime-values'
import type { ArtifactCsvComparisonPage } from '@agentrans/artifact-followup/types'
import { MessageId } from '@agentrans/llm'
import type { SessionId } from '@agentrans/session'
import type { JsonValue } from '@agentrans/util-values'
import type { Browser, Locator, Page, Request, Route } from 'playwright'
import { expect, vi } from 'vitest'
import { expectComparisonProviderText } from './csv-comparison-browser-fixture.ts'
import {
  createCsvHistoryControls, expectFocusedCsvComparison as expectFocusedComparison, interceptCsvHistorySnapshot,
  runRetainedCsvRetryScenarios,
} from './csv-source-retry-browser.ts'
import { acknowledgeReloadConnectionLoss, rawSessionLog, readPersistedEvents, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { expandOwningTurnProcess, writeComposerDraft } from './support.ts'

const FILE_NAME = 'trial-latencies.csv'
const CSV = 'Trial,LatencyMs\nBaseline,10\nBaseline,20\nWarm,25\nWarm,35\nCold,40\nCold,60\n'
const FILTER_CSV = 'Trial,LatencyMs,Batch\nBaseline,10,A\nBaseline,20,B\nWarm,25,A\nWarm,35,B\nCold,40,A\nCold,60,B\n'
const BATCH_FILTER = { column: 'Batch', value: 'B' } as const
const GROUPS = [
  { key: 'Baseline', value: 15, count: 2 },
  { key: 'Warm', value: 30, count: 2 },
  { key: 'Cold', value: 50, count: 2 },
] as const
const TOTALS = [
  { key: 'Baseline', value: 30, count: 2 },
  { key: 'Warm', value: 60, count: 2 },
  { key: 'Cold', value: 100, count: 2 },
] as const
const MAXIMUMS = [
  { key: 'Baseline', value: 20, count: 2 },
  { key: 'Warm', value: 35, count: 2 },
  { key: 'Cold', value: 60, count: 2 },
] as const
const FILTERED_TOTALS = [
  { key: 'Baseline', value: 20, count: 1 },
  { key: 'Warm', value: 35, count: 1 },
  { key: 'Cold', value: 60, count: 1 },
] as const
const CSV_REQUEST = 'Use the attached CSV to calculate the mean of LatencyMs grouped by Trial. '
  + 'Show a single native CSV bar chart so I can select a group and check its mean and number of measurements.'
const BRANCH_QUESTION = 'Update the same chart to show the sum of LatencyMs for each Trial instead of the mean. '
  + 'In your final answer, name the group from the locked reading and report both its original mean and updated total.'
const BRANCH_READING_QUESTION = 'Using my attached bar chart reading, state the selected group, mean latency, and sample count in one sentence.'
const BRANCH_TOTAL_QUESTION = 'Using only my attached bar chart reading, state the selected group, total latency, and sample count in one sentence.'
const REVIEWED_INQUIRY_EXPLANATION = 'Explain how the calculations and contributing records differ in my attached comparison. '
  + 'State both locked readings and list the original CSV record numbers and values. Use only this attachment in your answer.'
const INQUIRY_PHRASE = 'Warm trial'
const MAIN_READING_QUESTION = 'What does the newly attached recalculated total show? '
  + 'Give the selected group, aggregation, value and sample count in one sentence.'
const FILTER_READING_QUESTION = 'What does the newly attached filtered total show? '
  + 'State the exact filter, selected group, aggregation, value, and sample count in one sentence.'
const UNFILTERED_COMPARISON_QUESTION = 'What does this unfiltered Warm total show? Give the sum and number of records in one sentence.'
const EXPLAIN_COMPARISON_QUESTION = 'Using only the comparison attached to this question, explain how to calculate the original mean, '
  + 'what the sum would be with the same records and no filter, and why the locked result changes. '
  + 'Identify which CSV record the filter excludes, which it keeps, and their measured values. Explain in plain text.'
const CHAT_TOOLS = ['artifact', 'artifact_runtime', 'ask_user_question', 'attachment_csv', 'scene', 'skill']

async function verifyChatTools(world: WebScaffold, id: SessionId): Promise<void> {
  const events = await readPersistedEvents(world, id)
  const headers = events.flatMap(event => event.type === 'request/header' ? [event.data.header] : [])
  expect(headers.length).toBeGreaterThan(0)
  for (const header of headers) expect((header.tools ?? []).map(tool => tool.name).sort()).toEqual(CHAT_TOOLS)
  for (const event of events) {
    if (event.type === 'tool/call') expect(CHAT_TOOLS).toContain(event.data.name)
  }
}

function envelope(text: string): unknown {
  return JSON.parse(text.slice(text.indexOf('\n') + 1))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function objectField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function rpcRequest(request: Request): unknown {
  return objectField(objectField(objectField(request.postDataJSON(), 'payload'), 'args'), 'request')
}

function chartCall(
  events: Awaited<ReturnType<typeof readPersistedEvents>>, operation: 'create_chart' | 'update_chart',
  upsert: { readonly seq: number; readonly data: { readonly artifactId: string; readonly revision: number } },
) {
  const { artifactId, revision } = upsert.data
  for (const call of events.toReversed()) {
    if (call.seq >= upsert.seq || call.type !== 'tool/call' || call.data.name !== 'attachment_csv') continue
    const args: unknown = JSON.parse(call.data.arguments)
    if (objectField(args, 'operation') !== operation || objectField(args, 'artifactId') !== artifactId) continue
    const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId)
    if (result?.type !== 'tool/result' || result.data.message.isError === true) continue
    const resultText = result.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const chart: unknown = JSON.parse(resultText)
    if (objectField(chart, 'artifactId') === artifactId && objectField(chart, 'revision') === revision) {
      return { arguments: args, callSeq: call.seq, resultText }
    }
  }
  throw new Error(`No successful durable ${operation} result for CSV chart ${artifactId} revision ${revision}`)
}

async function expectBarLabelsFit(chart: Locator, groups: readonly { key: string; value: number }[]): Promise<void> {
  for (const group of groups) {
    const label = chart.getByText(String(group.value), { exact: true }).first()
    await label.waitFor({ state: 'visible' })
    const fits = await label.evaluate((node) => {
      const list = node.closest('ul')
      if (list === null) return false
      const text = document.createRange()
      text.selectNodeContents(node)
      const digits = text.getBoundingClientRect()
      const bounds = list.getBoundingClientRect()
      return digits.left >= bounds.left + list.clientLeft - 1
        && digits.right <= bounds.left + list.clientLeft + list.clientWidth + 1
    })
    expect(fits, `CSV bar label clipped for ${group.key}`).toBe(true)
  }
}

async function expectReadingsFit(replay: Locator, readings: Readonly<Record<string, string>>): Promise<void> {
  for (const [field, expected] of Object.entries(readings)) {
    const reading = replay.locator(`[data-csv-reading="${field}"]`)
    expect(await reading.textContent()).toBe(expected)
    await reading.scrollIntoViewIfNeeded()
    const visible = await reading.evaluate((node) => {
      const text = document.createRange()
      text.selectNodeContents(node)
      const bounds = text.getBoundingClientRect()
      const centre = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      return centre !== null && node.contains(centre) && bounds.left >= 0 && bounds.right <= window.innerWidth
    })
    expect(visible, `Locked CSV reading obscured at mobile width (${field})`).toBe(true)
  }
}

async function narrowCsvViewport(page: Page): Promise<void> {
  const collapse = page.getByRole('button', { name: 'Collapse sidebar', exact: true }).and(page.locator('[data-sidebar-toggle]'))
  if (await collapse.isVisible()) await collapse.click()
  await page.setViewportSize({ width: 390, height: 844 })
}

interface CsvLiveBrowser {
  readonly browser: Browser
  readonly page: Page
  readonly world: WebScaffold
  readonly evidence: string
  readonly ask: (prompt: string, sessionId?: SessionId, useExistingDraft?: boolean) => Promise<SessionId>
  readonly stage: (name: string) => void
  readonly console: ReturnType<typeof watchConsole>
  readonly providerSaw: (prompt: string, text: string) => boolean
  readonly providerUserText: (prompt: string) => readonly string[]
  readonly requestCount: () => number
  readonly setDiagnosticPage: (page: Page) => void
}

type SelectAnswerPhrase = (source: Locator, phrase: string) => Promise<void>

async function createCsvBranch({ page, world, evidence, ask, stage, providerSaw, providerUserText, requestCount }: CsvLiveBrowser,
  branchQuestion: string, csv = CSV, selectPhrase?: SelectAnswerPhrase) {
  const conversation = (id: SessionId) => page.locator(`[data-conversation-session="${id}"]`)
  const selected = (id: SessionId) => page.locator(`[data-row-key="session:${id}"][aria-selected="true"]`)

  const userAgent = await page.evaluate(() => navigator.userAgent)
  expect(userAgent).toMatch(/\bEdg\//u)
  stage('csv-select-chat-and-open-branch')
  const preset = (await world.ctx.agentPresets.list()).find(candidate => candidate.id === 'chat')
  expect(preset?.id).toBe('chat')
  expect(preset?.broken).toBeUndefined()
  await page.getByRole('button', { name: 'Standard mode', exact: true }).click()
  await page.getByRole('menuitem', { name: /^Chat\b/u }).click()
  await page.getByRole('button', { name: 'Chat', exact: true }).waitFor({ state: 'visible' })
  const model = page.getByRole('button', { name: /^Select model, current DeepSeek/u }).first()
  await model.click()
  await page.getByRole('menuitem', { name: /^Effort/u }).click()
  await page.getByRole('menuitemradio', { name: 'Low', exact: true }).click()
  await expect.poll(() => model.getAttribute('aria-label')).toMatch(/reasoning effort Low/u)
  const parentQuestion = 'What does it mean to group measurements by trial type? Answer in one sentence.'
  const parentId = await ask(selectPhrase === undefined ? parentQuestion : `${parentQuestion} Include the exact words “${INQUIRY_PHRASE}”.`)
  const parent = conversation(parentId)
  const parentSession = world.ctx.agents.get(parentId)?.session
  if (parentSession === undefined) throw new Error('The selected Chat session did not open')
  expect(world.ctx.agentPresets.presetForSession(parentSession)).toBe('chat')
  await verifyChatTools(world, parentId)
  const parentEventsBeforeBranch = await readPersistedEvents(world, parentId)
  expect(parentEventsBeforeBranch.filter(event => event.type === 'tool/call' || event.type === 'artifact/upsert')).toEqual([])
  const callsBeforeBranch = requestCount()
  const openInquiry = async (select: SelectAnswerPhrase) => {
    const source = parentEventsBeforeBranch.findLast(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text.includes(INQUIRY_PHRASE)))
    const end = parentEventsBeforeBranch.findLast(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')
    if (source?.type !== 'assistant/message' || end?.type !== 'turn/end') throw new Error('The original CSV answer has no inquiry phrase')
    const messageId = source.data.message.id
    const sourceAnswer = parent.locator(`[data-chat-message-seq="${source.seq}"][data-chat-message-id="${messageId}"]`)
    const span = sourceAnswer.locator('span[data-markdown-source-start][data-markdown-source-end]:visible')
      .filter({ hasText: INQUIRY_PHRASE }).first()
    const offset = await span.getAttribute('data-markdown-source-start')
    const displayed = await span.textContent()
    if (offset === null || displayed === null) throw new Error('The CSV inquiry phrase is not mapped to the saved answer')
    const start = Number(offset) + displayed.indexOf(INQUIRY_PHRASE)
    const reference = { messageSeq: source.seq, messageId, start, end: start + INQUIRY_PHRASE.length, excerpt: INQUIRY_PHRASE }
    await select(span, INQUIRY_PHRASE)
    const trigger = page.locator('[data-chat-inquiry-create]')
    await trigger.waitFor({ state: 'visible' })
    await page.screenshot({ path: join(evidence, 'csv-inquiry-selected-phrase.png') })
    const [forked] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/fork'), trigger.click(),
    ])
    expect(rpcRequest(forked.request())).toMatchObject({ sessionId: parentId, atSeq: end.seq, inquiry: reference })
    return { sourceAnswer, reference }
  }
  const inquiry = selectPhrase === undefined ? undefined : await openInquiry(selectPhrase)
  if (inquiry === undefined) await parent.getByRole('button', { name: 'Branch into a new conversation', exact: true }).last().click()
  const branchAgent = () => world.ctx.agents.roots().find(agent => agent.session.header.parentSession === parentId)
  await expect.poll(() => branchAgent()?.id).toBeDefined()
  const childId = branchAgent()!.id
  const child = conversation(childId)
  await selected(childId).waitFor({ state: 'visible' })
  expect(branchAgent()?.session.header.agentPreset).toBe('chat')
  if (inquiry !== undefined) expect(branchAgent()?.session.header).toMatchObject({ parentSession: parentId, inquiry: inquiry.reference })

  stage('csv-upload-and-provider-grouping')
  const bytes = Buffer.from(csv)
  const attachmentId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  await child.locator('input[type="file"][multiple]').setInputFiles([{ name: FILE_NAME, mimeType: 'text/csv', buffer: bytes }])
  await child.getByRole('group', { name: 'Pending attachments' }).getByTitle(FILE_NAME).waitFor({ state: 'visible' })
  const prompt = inquiry === undefined ? CSV_REQUEST : `> ${INQUIRY_PHRASE}\n\n${CSV_REQUEST}`
  if (inquiry === undefined) await ask(CSV_REQUEST, childId)
  else {
    await expect.poll(() => child.locator('[data-composer-quote] [data-quote-preview-text]').textContent()).toBe(INQUIRY_PHRASE)
    const editor = child.locator('[data-composer-input][contenteditable="true"]')
    await editor.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
    await page.keyboard.insertText(CSV_REQUEST)
    expect(requestCount()).toBe(callsBeforeBranch)
    const settled = world.whenTurnSettled()
    await child.getByRole('button', { name: 'Send message', exact: true }).click()
    expect(await settled).toBe(childId)
  }
  await verifyChatTools(world, childId)
  const first = await readPersistedEvents(world, childId)
  const upload = first.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (upload?.type !== 'user/message') throw new Error('The CSV turn did not persist a user message')
  expect(upload.data.content.filter(block => block.type === 'text')).toEqual([{ type: 'text', text: prompt }])
  expect(upload.data.content.filter(block => block.type === 'file')).toEqual([
    { type: 'file', attachment: { name: FILE_NAME, bytes: bytes.length, attachmentId } },
  ])
  const hint = providerUserText(prompt).find(block => block.includes(FILE_NAME))
  expect(hint).toContain(attachmentId)
  expect(hint).toContain('attachment_csv')
  expect(hint).not.toMatch(/\b[A-Za-z]:[\\/]|(?:^|\s)[\\/]{2}|read-only copy saved at/u)
  expect(hint).not.toContain(world.harnessHome)
  expect(hint).not.toContain(csv)

  const source = first.find(event => event.type === 'artifact/upsert' && event.data.format === 'scene' && event.data.spec.kind === 'csv-bar-chart')
  if (source?.type !== 'artifact/upsert' || source.data.format !== 'scene' || source.data.spec.kind !== 'csv-bar-chart') {
    throw new Error('Expected one native CSV bar chart generated from the attached CSV')
  }
  const current = first.findLast(event => event.type === 'artifact/upsert' && event.data.artifactId === source.data.artifactId)
  if (current?.type !== 'artifact/upsert' || current.data.format !== 'scene' || current.data.spec.kind !== 'csv-bar-chart') {
    throw new Error('The latest revision must still be a native CSV bar chart')
  }
  const chart = current.data
  const chartSpec = current.data.spec
  const recipe = { attachmentId, groupBy: 'Trial', valueColumn: 'LatencyMs' }
  const firstChartCall = chartCall(first, 'create_chart', source)
  expect(firstChartCall.arguments).toEqual({ ...recipe, operation: 'create_chart', aggregate: 'mean',
    artifactId: source.data.artifactId, title: source.data.title })
  expect(source.seq).toBeGreaterThan(firstChartCall.callSeq)
  expect(source.data).toMatchObject({ revision: 1, presentation: 'inline', spec: chartSpec })
  expect(chart.presentation).toBe('inline')
  expect(chartSpec).toEqual({ kind: 'csv-bar-chart', ...recipe, aggregate: 'mean', rowCount: 6, groups: GROUPS })
  for (const event of first) {
    if (event.type === 'artifact/upsert' && event.data.artifactId === chart.artifactId) expect(event.data).toMatchObject({ spec: chartSpec })
  }
  const grouped: unknown = JSON.parse(firstChartCall.resultText)
  expect(grouped).toMatchObject({ ...chartSpec, artifactId: source.data.artifactId, revision: 1, title: source.data.title })
  expect(providerSaw(prompt, firstChartCall.resultText)).toBe(true)
  const card = child.getByRole('complementary', { name: `Artifact: ${chart.title}`, exact: true }).filter({ has: page.locator('[data-csv-bar-chart]') })
  await expandOwningTurnProcess(page, card)
  const chartView = card.locator('[data-csv-bar-chart]')
  await chartView.waitFor({ state: 'visible' })
  expect(await card.getAttribute('data-placement')).toBe('inline')
  expect(await card.getAttribute('data-artifact-revision')).toBe(String(chart.revision))
  await expectBarLabelsFit(chartView, GROUPS)

  stage('csv-lock-group-reading')
  const activeGroup = (key: string) => chartView.locator(`[data-csv-group-key="${key}"]`)
  const callsBeforeInteraction = requestCount()
  for (const group of GROUPS) {
    await activeGroup(group.key).click()
    await expect.poll(() => activeGroup(group.key).getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => chartView.locator('[data-csv-reading="value"]').textContent()).toBe(String(group.value))
    expect(await chartView.locator('[data-csv-reading="count"]').textContent()).toBe(String(group.count))
  }
  await activeGroup('Warm').focus()
  await activeGroup('Warm').press('Space')
  await card.getByRole('button', { name: 'Use for next question', exact: true }).click()
  const review = card.getByRole('region', { name: 'Review CSV reading', exact: true })
  await review.waitFor({ state: 'visible' })
  expect(await review.getByText(`Revision ${chart.revision}`, { exact: true }).isVisible()).toBe(true)
  expect(await review.locator('[data-csv-reading="key"]').textContent()).toBe('Warm')
  expect(await review.locator('[data-csv-reading="value"]').textContent()).toBe('30')
  expect(await review.locator('[data-csv-reading="count"]').textContent()).toBe('2')
  expect(await review.locator('[data-csv-reading="aggregate"]').textContent()).toMatch(/mean/iu)
  await review.screenshot({ path: join(evidence, 'csv-lock-warm.png') })
  await review.getByRole('button', { name: 'Attach readings', exact: true }).click()
  await child.locator('[data-artifact-prompt-context="current-csv-bar-chart"]').waitFor({ state: 'visible' })
  await activeGroup('Cold').click()
  await expect.poll(() => chartView.locator('[data-csv-reading="value"]').textContent()).toBe('50')
  expect(requestCount()).toBe(callsBeforeInteraction)

  stage('csv-model-answer-from-locked-reading')
  await ask(branchQuestion, childId)
  const branchEvents = await readPersistedEvents(world, childId)
  const locked = branchEvents.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (locked?.type !== 'user/message') throw new Error('The branch follow-up did not persist a user message')
  const attached = locked.data.content.find(block => block.type === 'text' && block.text !== branchQuestion)
  if (attached?.type !== 'text') throw new Error('The CSV follow-up lost the locked chart reading')
  const lockedReading = { kind: 'current-csv-bar-chart', artifact: chart, groupKey: 'Warm', values: { key: 'Warm', value: 30, count: 2 } }
  expect(envelope(attached.text)).toMatchObject({ kind: 'artifact-question-context', sessionId: childId, facts: lockedReading })
  expect(providerSaw(branchQuestion, attached.text)).toBe(true)
  await verifyChatTools(world, childId)
  return { userAgent, parentId, childId, parent, child, selected, parentEventsBeforeBranch, attachmentId, chart, chartSpec, recipe, grouped,
    branchEvents, questionSeq: locked.seq, lockedReading, inquiry }
}

async function adoptCsvReading(
  { world, evidence, stage, requestCount }: CsvLiveBrowser, branch: Awaited<ReturnType<typeof createCsvBranch>>,
) {
  const { parentId, childId, parent, child, selected, parentEventsBeforeBranch, branchEvents, questionSeq, lockedReading } = branch
  const conclusion = branchEvents.findLast(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text'))
  if (conclusion?.type !== 'assistant/message') throw new Error('Expected the real model to conclude the branch with the locked reading')
  const text = conclusion.data.message.content.filter(block => block.type === 'text')
  const answer = text.map(block => block.text).join('\n')
  expect(answer).toMatch(/\bWarm\b/u)
  expect(answer).toMatch(new RegExp(`\\b${lockedReading.values.value}\\b`, 'u'))

  stage('csv-return-locked-reading')
  const callsBeforeReturn = requestCount()
  const action = child.locator(`[data-branch-result-seq="${conclusion.seq}"]:visible`)
  await action.getByRole('button', { name: 'Return with evidence', exact: true }).click()
  expect(await action.getByRole('radio', { name: 'Question readings', exact: true }).isChecked()).toBe(true)
  const review = action.locator('[data-branch-question-preview]')
  expect(await review.innerText()).toContain(`${lockedReading.artifact.title} · revision ${lockedReading.artifact.revision} · Warm`)
  expect(await review.locator('[data-csv-reading="key"]').textContent()).toBe('Warm')
  expect(await review.locator('[data-csv-reading="value"]').textContent()).toBe(String(lockedReading.values.value))
  expect(await review.locator('[data-csv-reading="count"]').textContent()).toBe(String(lockedReading.values.count))
  const shot = lockedReading.artifact.revision === 1 ? 'csv-return-review.png' : `csv-return-review-revision-${lockedReading.artifact.revision}.png`
  await review.screenshot({ path: join(evidence, shot) })
  await action.getByRole('button', { name: 'Confirm return with evidence', exact: true }).click()
  await selected(parentId).waitFor({ state: 'visible' })
  await expect.poll(async () => (await readPersistedEvents(world, parentId)).length).toBe(parentEventsBeforeBranch.length + 1)
  const parentEvents = await readPersistedEvents(world, parentId)
  expect(parentEvents.slice(0, -1)).toEqual(parentEventsBeforeBranch)
  const adopted = parentEvents.at(-1)
  if (adopted?.type !== 'user/message' || adopted.data.source.kind !== 'branch-result') throw new Error('The main conversation lost the adopted evidence')
  const returned = parent.locator(`[data-artifact-branch-evidence][data-chat-message-id="${adopted.data.id}"]`
    + `[data-chat-message-seq="${adopted.seq}"] [data-artifact-branch-evidence-item="question"]`)
  await returned.waitFor({ state: 'visible' })
  expect(adopted.data.source).toMatchObject({ branchSessionId: childId, resultSeq: conclusion.seq })
  expect(adopted.data.content.slice(0, -1)).toEqual(text)
  const adoptedBlock = adopted.data.content.at(-1)
  if (adoptedBlock?.type !== 'text') throw new Error('The returned conclusion had no locked CSV reading')
  expect(envelope(adoptedBlock.text)).toMatchObject({ kind: 'branch-result-artifact-evidence', branchSessionId: childId,
    evidence: { kind: 'question', questionSeq, facts: lockedReading } })
  return { answer, callsBeforeReturn, parentEvents, returned, adopted, adoptedBlock }
}

/** Exercise immutable CSV chart evidence and executable revision export through the normal web UI. */
export async function exerciseCsvJourney(live: CsvLiveBrowser): Promise<void> {
  const { browser, page, world, evidence, stage, console, providerSaw, requestCount } = live
  const branch = await createCsvBranch(live, BRANCH_QUESTION)
  const { userAgent, parentId, childId, child, selected, attachmentId, chart, chartSpec, recipe, grouped,
    branchEvents, questionSeq, lockedReading } = branch
  const revised = branchEvents.findLast(event => event.type === 'artifact/upsert')
  if (revised?.type !== 'artifact/upsert' || revised.data.format !== 'scene') throw new Error('The CSV chart did not receive a revision')
  const sumRevision = chart.revision + 1
  expect(branchEvents.filter(event => event.type === 'artifact/upsert' && event.seq > questionSeq)).toEqual([revised])
  const updated = chartCall(branchEvents, 'update_chart', revised)
  const sumSpec = { ...chartSpec, aggregate: 'sum', groups: TOTALS }
  expect(updated.arguments).toEqual({ ...recipe, operation: 'update_chart', aggregate: 'sum', artifactId: chart.artifactId,
    baseRevision: chart.revision, title: revised.data.title })
  expect(revised.seq).toBeGreaterThan(updated.callSeq)
  expect(revised.data).toMatchObject({ artifactId: chart.artifactId, revision: sumRevision, spec: sumSpec })
  expect(revised.data.spec).toEqual(sumSpec)
  expect(JSON.parse(updated.resultText)).toMatchObject({ ...sumSpec, artifactId: chart.artifactId,
    revision: sumRevision, title: revised.data.title })
  expect(providerSaw(BRANCH_QUESTION, updated.resultText)).toBe(true)
  const revisedCard = child.getByRole('complementary', { name: `Artifact: ${revised.data.title}`, exact: true })
  await expandOwningTurnProcess(page, revisedCard)
  expect(await revisedCard.getAttribute('data-artifact-revision')).toBe(String(sumRevision))
  const sumChart = revisedCard.locator('[data-csv-bar-chart]')
  await sumChart.locator('[data-csv-group-key="Warm"]').click()
  await expect.poll(() => sumChart.locator('[data-csv-reading="value"]').textContent()).toBe('60')
  expect(await sumChart.locator('[data-csv-reading="count"]').textContent()).toBe('2')
  expect(await sumChart.locator('[data-csv-reading="aggregate"]').textContent()).toMatch(/sum/iu)
  await sumChart.screenshot({ path: join(evidence, 'csv-sum-warm.png') })
  const { answer, callsBeforeReturn, parentEvents, returned } = await adoptCsvReading(live, branch)
  expect(answer).toMatch(/\b60(?:\.0+)?\b/u)

  stage('csv-reload-locked-reading')
  const warningStart = console.warnings.length
  await page.reload()
  await returned.waitFor({ state: 'visible' })
  acknowledgeReloadConnectionLoss(console, warningStart)
  await returned.getByRole('button', { name: 'Replay experiment', exact: true }).click()
  const replay = returned.locator(`[data-artifact-question-replay-revision="${chart.revision}"]`)
  const chartReplay = replay.locator('[data-csv-bar-chart]')
  await chartReplay.waitFor({ state: 'visible' })
  expect(await replay.getAttribute('data-artifact-question-replay-id')).toBe(chart.artifactId)
  expect(await replay.locator('[data-csv-reading="key"]').textContent()).toBe('Warm')
  expect(await replay.locator('[data-csv-reading="value"]').textContent()).toBe('30')
  expect(await replay.locator('[data-csv-reading="count"]').textContent()).toBe('2')
  expect(await replay.locator('[data-csv-reading="aggregate"]').textContent()).toMatch(/mean/iu)
  await expectBarLabelsFit(chartReplay, GROUPS)
  await replay.screenshot({ path: join(evidence, 'csv-main-replay-after-refresh.png') })

  stage('csv-user-download-historical-revision')
  await page.locator(`[data-row-key="session:${childId}"]`).click()
  await selected(childId).waitFor({ state: 'visible' })
  const current = child.getByRole('complementary', { name: `Artifact: ${revised.data.title}`, exact: true })
  await expandOwningTurnProcess(page, current)
  expect(await current.getAttribute('data-artifact-revision')).toBe(String(sumRevision))
  await child.getByText('Revision history', { exact: true }).click()
  await child.getByRole('button', { name: `View revision ${chart.revision}`, exact: true }).click()
  const historical = child.locator(`[data-artifact-history-revision="${chart.revision}"]`)
  const ready = page.waitForEvent('download')
  await historical.getByRole('button', { name: 'Export HTML', exact: true }).click()
  const download = await ready
  expect(download.suggestedFilename()).toMatch(/\.html$/u)
  const path = join(evidence, `csv-chart-revision-${chart.revision}.html`)
  await download.saveAs(path)
  const html = await readFile(path, 'utf8')
  const offline = await browser.newPage()
  try {
    const externalRequests: string[] = []
    await offline.route('**/*', async (route) => { externalRequests.push(route.request().url()); await route.abort() })
    await offline.setContent(html, { waitUntil: 'load' })
    const exportedChart = offline.locator('#csv-group-chart')
    await exportedChart.waitFor({ state: 'visible' })
    const exportedSpec = await offline.locator('#csv-export-spec').textContent()
    expect(JSON.parse(exportedSpec ?? 'null')).toEqual(chartSpec)
    await exportedChart.locator('button[data-group-key="Warm"]').click()
    expect(await offline.locator('[data-csv-export-value]').textContent()).toBe('30')
    expect(await offline.locator('[data-csv-export-count]').textContent()).toBe('2')
    expect(await offline.locator('[data-csv-export-aggregate]').getAttribute('data-csv-export-aggregate')).toBe('mean')
    const origin = await offline.locator('#artifact-export-origin-data').textContent()
    expect(JSON.parse(origin ?? 'null')).toMatchObject({ sessionId: childId, artifactId: chart.artifactId, revision: chart.revision })
    expect(externalRequests).toEqual([])
  } finally { await offline.close() }

  stage('csv-narrow-replay')
  await page.locator(`[data-row-key="session:${parentId}"]`).click()
  await selected(parentId).waitFor({ state: 'visible' })
  await returned.waitFor({ state: 'visible' })
  if (!await chartReplay.isVisible()) await returned.getByRole('button', { name: 'Replay experiment', exact: true }).click()
  await narrowCsvViewport(page)
  await expectBarLabelsFit(chartReplay, GROUPS)
  await expectReadingsFit(replay, { key: 'Warm', aggregate: 'Mean of LatencyMs', value: '30', count: '2' })
  await replay.screenshot({ path: join(evidence, 'csv-main-replay-narrow.png') })
  expect(await readPersistedEvents(world, parentId)).toEqual(parentEvents)
  expect(requestCount()).toBe(callsBeforeReturn)
  expect(console.warnings).toEqual([])
  await writeFile(join(evidence, 'csv-readings.json'), JSON.stringify({ attachmentId, mean: grouped, sum: sumSpec, locked: { ...lockedReading,
    artifact: { artifactId: chart.artifactId, revision: chart.revision, title: chart.title } }, latestRevision: sumRevision, exportedRevision: chart.revision, userAgent }, null, 2) + '\n', 'utf8')
}

async function expectCsvReading(scope: Locator, group: string, metric: RegExp, value: string, count = '2'): Promise<void> {
  await expect.poll(() => scope.locator('[data-csv-reading="value"]').textContent()).toBe(value)
  await expect.poll(() => scope.locator('[data-csv-reading="key"]').textContent()).toBe(group)
  expect(await scope.locator('[data-csv-reading="aggregate"]').textContent()).toMatch(metric)
  expect(await scope.locator('[data-csv-reading="count"]').textContent()).toBe(count)
}

async function expectCsvFilter(reading: Locator): Promise<void> {
  await expect.poll(() => reading.locator('[data-csv-reading="filter"]').textContent()).toBe('Batch = B')
}

async function applyBatchFilter(analysis: Locator): Promise<void> {
  await analysis.locator('[data-csv-filter-column]').selectOption(BATCH_FILTER.column)
  await analysis.locator('[data-csv-filter-value]').selectOption({ label: BATCH_FILTER.value })
  await analysis.locator('[data-csv-filter-apply]').click()
}

async function expectWarmParticipatingRows(scope: Locator, filtered: boolean) {
  const participation = scope.locator('[data-csv-participating-rows]')
  const rows = participation.locator('[data-csv-participating-record]')
  const expected = filtered ? [{ record: '5', filterValue: 'B', value: '35' }]
    : [{ record: '4', value: '25' }, { record: '5', value: '35' }]
  await expect.poll(() => rows.count()).toBe(expected.length)
  expect(await participation.getByRole('columnheader').allTextContents()).toEqual(filtered
    ? [expect.stringMatching(/record/iu), 'Batch', 'LatencyMs'] : [expect.stringMatching(/record/iu), 'LatencyMs'])
  const reading = {
    records: await Promise.all((await rows.all()).map(async row => ({
      record: await row.getAttribute('data-csv-participating-record'),
      ...(filtered ? { filterValue: await row.locator('[data-csv-participating-cell="filter"]').textContent() } : {}),
      value: await row.locator('[data-csv-participating-cell="value"]').textContent(),
    }))),
    total: await participation.locator('[data-csv-participating-total]').textContent(),
  }
  expect(reading).toEqual({ records: expected, total: String(expected.length) })
  return reading
}

type CsvMessageIdentity = { sessionId: SessionId; eventSeq: number; messageId: string }

const RETURNED_ROWS_ENDPOINT = '/api/artifactBranchResults/csvReturnedParticipatingRows'
const COMPARE_RETURNS_ENDPOINT = '/api/artifactBranchResults/compareCsvReturns'
const CSV_REGROUP_ROUTES = new Set(['recalculateCsv', 'lockCsv', 'csvFilterOptions', 'csvParticipatingRows', 'compareCsvQuestionToReturn',
  'csvQuestionParticipatingRows'].map(endpoint => `/api/artifactBranchResults/${endpoint}`))

async function openCsvReplayRows(page: Page, replay: Locator, endpoint: 'csvReturnedParticipatingRows' | 'csvQuestionParticipatingRows',
  identity: CsvMessageIdentity): Promise<void> {
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === `/api/artifactBranchResults/${endpoint}`),
    replay.locator('[data-csv-participating-rows-open]').click(),
  ])
  expect(objectField(objectField(response.request().postDataJSON(), 'payload'), 'args')).toEqual({ request: { ...identity, offset: 0 } })
  expect(await response.json()).toMatchObject({ result: { ok: true } })
}

/** Open one locked CSV reading from its original inquiry, then explicitly inspect the two contributing records. */
export async function exerciseCsvInquiryResult(live: CsvLiveBrowser, selectPhrase: SelectAnswerPhrase): Promise<void> {
  const { page, world, evidence, stage, requestCount, console } = live
  await page.setViewportSize({ width: 1440, height: 1280 })
  const branch = await createCsvBranch(live, BRANCH_READING_QUESTION, CSV, selectPhrase)
  const { inquiry, parentId, childId, parent, child, selected, chart, attachmentId, branchEvents, questionSeq } = branch
  if (inquiry === undefined) throw new Error('The locked native CSV chart did not come from an inquiry')
  const { adopted, parentEvents, callsBeforeReturn } = await adoptCsvReading(live, branch)
  const returnedAddress = { sessionId: parentId, eventSeq: adopted.seq, messageId: adopted.data.id }
  const result = inquiry.sourceAnswer.getByRole('button', { name: 'View returned result', exact: true })
    .and(inquiry.sourceAnswer.locator(`[data-inquiry-result="${childId}"]`))
  const returned = parent.locator(`[data-artifact-branch-evidence][data-chat-message-id="${adopted.data.id}"]`
    + `[data-chat-message-seq="${adopted.seq}"]`)
  const control = returned.locator('[data-chat-message-control="artifact-branch-result"]')
  const chartReplay = returned.locator(`[data-artifact-question-replay-revision="${chart.revision}"]`)
  const observed: string[] = []
  const watch = (request: Request): void => { observed.push(new URL(request.url()).pathname) }
  const reads = vi.spyOn(world.ctx.attachments, 'readFileStream')
  page.on('request', watch)
  const snapshots: Awaited<ReturnType<typeof expectWarmParticipatingRows>>[] = []
  const open = async (phase: string): Promise<void> => {
    const readsBefore = reads.mock.calls.length
    await result.click()
    await expect.poll(() => control.evaluate(element => element.ownerDocument.activeElement === element)).toBe(true)
    await chartReplay.locator('[data-csv-bar-chart]').waitFor({ state: 'visible' })
    expect(await chartReplay.getAttribute('data-artifact-question-replay-id')).toBe(chart.artifactId)
    await expectCsvReading(chartReplay, 'Warm', /mean/iu, '30', '2')
    expect(await chartReplay.locator('[data-csv-participating-rows]').count()).toBe(0)
    expect(reads.mock.calls).toHaveLength(readsBefore)
    expect(observed.filter(path => path === RETURNED_ROWS_ENDPOINT)).toHaveLength(readsBefore)
    await openCsvReplayRows(page, chartReplay, 'csvReturnedParticipatingRows', returnedAddress)
    snapshots.push(await expectWarmParticipatingRows(chartReplay, false))
    expect(reads.mock.calls).toHaveLength(readsBefore + 1)
    expect(reads.mock.calls.at(-1)?.[0].attachmentId).toBe(attachmentId)
    await chartReplay.evaluate((element) => { element.scrollIntoView({ block: 'center' }) })
    await chartReplay.screenshot({ path: join(evidence, `csv-inquiry-returned-rows-${phase}.png`) })
  }
  try {
    stage('csv-inquiry-open-return-and-inspect-exact-rows')
    await open('before-refresh')
    stage('csv-inquiry-refresh-and-inspect-same-return')
    const warnings = console.warnings.length
    await page.reload()
    await result.waitFor({ state: 'visible' })
    await open('after-refresh')
    acknowledgeReloadConnectionLoss(console, warnings)
    expect(snapshots[1]).toEqual(snapshots[0])
    await inquiry.sourceAnswer.locator(`[data-inquiry-branch="${childId}"]`).click()
    await selected(childId).waitFor({ state: 'visible' })
    await child.locator(`[data-chat-message-seq="${questionSeq}"]`).getByText(BRANCH_READING_QUESTION, { exact: true }).waitFor({ state: 'visible' })
    expect(await readPersistedEvents(world, parentId)).toEqual(parentEvents)
    expect(await readPersistedEvents(world, childId)).toEqual(branchEvents)
    expect(requestCount()).toBe(callsBeforeReturn)
    expect(observed.filter(path => path === '/api/session/prompt' || CSV_REGROUP_ROUTES.has(path))).toEqual([])
    expect(observed.filter(path => path === RETURNED_ROWS_ENDPOINT)).toHaveLength(2)
    expect(reads.mock.calls).toHaveLength(2)
    expect(console.warnings).toEqual([])
    expect(console.pageErrors).toEqual([])
    await writeFile(join(evidence, 'csv-inquiry-result-acceptance.json'), JSON.stringify({
      userAgent: branch.userAgent, parentId, childId, inquiry: inquiry.reference, returned: returnedAddress,
      revision: chart.revision, locked: branch.lockedReading.values, participatingRows: snapshots[1]?.records,
      focusedExactReturnBeforeAndAfterRefresh: true, reopenedSameChild: true, extraProviderRequests: 0,
      regroupRequests: 0, rawReadsForChartReplay: 0, explicitAuthenticatedRowsRequests: 2, explicitRawReads: 2,
    }, null, 2) + '\n')
  } finally {
    page.off('request', watch)
    reads.mockRestore()
  }
}

async function lockCsvUpdate(live: CsvLiveBrowser, branch: Awaited<ReturnType<typeof createCsvBranch>>, aggregate: 'sum' | 'max') {
  const { ask, evidence, page, providerSaw, requestCount, stage, world } = live
  const { child, childId, chartSpec, recipe, questionSeq, lockedReading: previous } = branch
  const chart = previous.artifact
  const groups = aggregate === 'sum' ? TOTALS : MAXIMUMS
  const metric = aggregate === 'sum' ? 'sum' : 'maximum'
  const metricLabel = new RegExp(metric, 'iu')
  const [warm, cold] = [groups[1], groups[2]]
  const updatePrompt = `Use update_chart on the same native CSV chart to show the ${metric} of LatencyMs by Trial. `
    + 'Keep the same attachment and columns. After the chart renders, briefly say what changed.'
  const conclusionPrompt = aggregate === 'sum' ? BRANCH_TOTAL_QUESTION
    : 'Using only my attached bar chart reading, state the selected group, maximum latency, and sample count in one sentence.'
  stage(`csv-inquiry-update-same-chart-to-${aggregate}`)
  await ask(updatePrompt, childId)
  const afterUpdate = await readPersistedEvents(world, childId)
  const revised = afterUpdate.findLast(event => event.type === 'artifact/upsert' && event.data.artifactId === chart.artifactId)
  if (revised?.type !== 'artifact/upsert' || revised.data.format !== 'scene' || revised.data.spec.kind !== 'csv-bar-chart') {
    throw new Error('The updated artifact is not a native CSV chart')
  }
  const updatedChart = { ...revised.data, spec: revised.data.spec }
  const update = chartCall(afterUpdate, 'update_chart', revised)
  expect(afterUpdate.filter(event => event.type === 'artifact/upsert' && event.seq > questionSeq)).toEqual([revised])
  expect(updatedChart.revision).toBe(chart.revision + 1)
  expect(updatedChart.spec).toEqual({ ...chartSpec, aggregate, groups })
  expect(update.arguments).toMatchObject({ ...recipe, operation: 'update_chart', aggregate, artifactId: chart.artifactId,
    baseRevision: chart.revision })
  expect(providerSaw(updatePrompt, update.resultText)).toBe(true)
  const card = child.getByRole('complementary', { name: `Artifact: ${updatedChart.title}`, exact: true })
    .and(child.locator(`[data-artifact-revision="${updatedChart.revision}"]`))
  await expandOwningTurnProcess(page, card)
  const view = card.locator('[data-csv-bar-chart]')
  const callsBeforeLock = requestCount()
  await view.locator('[data-csv-group-key="Warm"]').click()
  await card.getByRole('button', { name: 'Use for next question', exact: true }).click()
  const review = card.getByRole('region', { name: 'Review CSV reading', exact: true })
  await expectCsvReading(review, warm.key, metricLabel, String(warm.value))
  expect(await review.getByText(`Revision ${updatedChart.revision}`, { exact: true }).isVisible()).toBe(true)
  await review.screenshot({ path: join(evidence, `csv-lock-warm-${aggregate}.png`) })
  await review.getByRole('button', { name: 'Attach readings', exact: true }).click()
  await child.locator('[data-artifact-prompt-context="current-csv-bar-chart"]').waitFor({ state: 'visible' })
  await view.locator('[data-csv-group-key="Cold"]').click()
  await expectCsvReading(view, cold.key, metricLabel, String(cold.value))
  expect(requestCount()).toBe(callsBeforeLock)

  stage(`csv-inquiry-answer-from-locked-${aggregate}`)
  await ask(conclusionPrompt, childId)
  const branchEvents = await readPersistedEvents(world, childId)
  expect(branchEvents.filter(event => event.type === 'artifact/upsert')).toEqual(afterUpdate.filter(event => event.type === 'artifact/upsert'))
  const locked = branchEvents.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (locked?.type !== 'user/message') throw new Error(`The ${aggregate} follow-up did not persist a user message`)
  const attached = locked.data.content.find(block => block.type === 'text' && block.text !== conclusionPrompt)
  if (attached?.type !== 'text') throw new Error(`The ${aggregate} follow-up lost the locked chart reading`)
  const lockedReading = { ...previous, artifact: updatedChart, values: warm }
  expect(envelope(attached.text)).toEqual({ kind: 'artifact-question-context', sessionId: childId, facts: lockedReading })
  expect(providerSaw(conclusionPrompt, attached.text)).toBe(true)
  return { ...branch, branchEvents, questionSeq: locked.seq, lockedReading }
}

function csvInquiryChoice(page: Page, sourceAnswer: Locator, childId: SessionId, firstMessageId: MessageId) {
  const trigger = sourceAnswer.getByRole('button', { name: 'View returned result', exact: true })
    .and(sourceAnswer.locator(`[data-inquiry-result="${childId}"]`))
  const menu = page.getByRole('menu').filter({ has: page.locator(`[data-inquiry-return-message-id="${firstMessageId}"]`) })
  return { trigger, menu }
}

function csvReturnComparisonControls(page: Page, trigger: Locator, menu: Locator) {
  const item = menu.getByRole('menuitem', { name: 'Compare returned results', exact: true })
    .filter({ has: page.locator('[data-inquiry-compare-action]') })
  const dialog = page.getByRole('dialog', { name: 'Compare CSV returns', exact: true })
  const firstInput = dialog.getByRole('combobox', { name: 'First return', exact: true }).and(dialog.locator('[data-inquiry-compare-first]'))
  const secondInput = dialog.getByRole('combobox', { name: 'Second return', exact: true }).and(dialog.locator('[data-inquiry-compare-second]'))
  const ready = dialog.locator('[data-inquiry-return-comparison]')
  const compare = dialog.getByRole('button', { name: 'View comparison', exact: true }).and(dialog.locator('[data-inquiry-compare-open]'))
  const open = async (): Promise<void> => {
    await trigger.click()
    await item.click()
    await dialog.waitFor({ state: 'visible' })
  }
  return { dialog, firstInput, secondInput, ready, compare, open }
}

async function replayCsvReturnComparison(live: CsvLiveBrowser, trigger: Locator, menu: Locator, sessionId: SessionId,
  first: Omit<CsvMessageIdentity, 'sessionId'>, second: Omit<CsvMessageIdentity, 'sessionId'>, observed: readonly string[]) {
  const { page, evidence, stage, console } = live
  const { dialog, firstInput, secondInput, ready, compare, open } = csvReturnComparisonControls(page, trigger, menu)
  const comparisonRequests = (): number => observed.filter(path => path === COMPARE_RETURNS_ENDPOINT).length
  const receive = async (action: () => Promise<void>, file: string): Promise<void> => {
    const [response] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === COMPARE_RETURNS_ENDPOINT),
      action(),
    ])
    expect(rpcRequest(response.request())).toEqual({ sessionId, first, second, offset: 0 })
    const body: unknown = await response.json()
    expect(objectField(body, 'result')).toMatchObject({ ok: true, value: warmComparisonPage(false) })
    expect(await firstInput.inputValue()).toBe(first.messageId)
    expect(await secondInput.inputValue()).toBe(second.messageId)
    await expectWarmComparisonView(ready, false)
    expect(await ready.locator('[data-csv-comparison-method-changed]').textContent()).toBe('Calculation method changed')
    expect(await ready.locator('[data-csv-comparison-filter-changed], [data-csv-comparison-membership-changed]').count()).toBe(0)
    await dialog.screenshot({ path: join(evidence, file), animations: 'disabled' })
  }

  stage('csv-inquiry-compare-two-saved-returns')
  await open()
  await firstInput.selectOption(first.messageId)
  await secondInput.selectOption(second.messageId)
  expect(comparisonRequests()).toBe(0)
  await receive(() => compare.click(), 'csv-inquiry-return-comparison.png')
  expect(comparisonRequests()).toBe(1)

  stage('csv-inquiry-reopen-same-return-comparison-after-refresh')
  const warnings = console.warnings.length
  await page.reload()
  await trigger.waitFor({ state: 'visible' })
  expect(await dialog.isVisible()).toBe(false)
  expect(comparisonRequests()).toBe(1)
  await receive(open, 'csv-inquiry-return-comparison-after-refresh.png')
  expect(comparisonRequests()).toBe(2)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await expect.poll(() => trigger.evaluate(element => element === document.activeElement)).toBe(true)
  acknowledgeReloadConnectionLoss(console, warnings)
  return { first, second, ...warmComparisonPage(false), restoredSamePairAfterRefresh: true, compareRequests: comparisonRequests() }
}

async function createCsvInquiryReturns(live: CsvLiveBrowser, selectPhrase: SelectAnswerPhrase) {
  const branch = await createCsvBranch(live, BRANCH_READING_QUESTION, CSV, selectPhrase)
  const { inquiry, childId, selected } = branch
  if (inquiry === undefined) throw new Error('The CSV results did not come from an inquiry')
  const first = await adoptCsvReading(live, branch)
  await inquiry.sourceAnswer.locator(`[data-inquiry-branch="${childId}"]`).click()
  await selected(childId).waitFor({ state: 'visible' })
  const sumBranch = await lockCsvUpdate(live, branch, 'sum')
  const second = await adoptCsvReading(live, { ...sumBranch, parentEventsBeforeBranch: first.parentEvents })
  expect(second.adopted.seq).toBeGreaterThan(first.adopted.seq)
  expect(second.adopted.data.id).not.toBe(first.adopted.data.id)
  return { branch, inquiry, first, second, sumBranch }
}

/** Choose and compare independently locked revisions returned from the same original inquiry answer. */
export async function exerciseCsvInquiryResultChoice(live: CsvLiveBrowser, selectPhrase: SelectAnswerPhrase): Promise<void> {
  const { page, world, evidence, stage, requestCount, console } = live
  await page.setViewportSize({ width: 1440, height: 1280 })
  const { branch, inquiry, first, second, sumBranch } = await createCsvInquiryReturns(live, selectPhrase)
  const { parentId, childId, parent, child, selected, attachmentId } = branch
  const choices = [
    { returned: first, reading: branch.lockedReading, metric: 'Mean of LatencyMs', file: 'mean' },
    { returned: second, reading: sumBranch.lockedReading, metric: 'Sum of LatencyMs', file: 'sum' },
  ]
  const { trigger, menu } = csvInquiryChoice(page, inquiry.sourceAnswer, childId, first.adopted.data.id)
  const observed: string[] = []
  const watch = (request: Request): void => { observed.push(new URL(request.url()).pathname) }
  const reads = vi.spyOn(world.ctx.attachments, 'readFileStream')
  page.on('request', watch)
  try {
    stage('csv-inquiry-refresh-and-choose-each-return')
    const warnings = console.warnings.length
    await page.reload()
    await trigger.waitFor({ state: 'visible' })
    expect(await trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    expect(await parent.locator('[data-artifact-branch-evidence] [data-csv-bar-chart]').count()).toBe(0)

    const snapshots = []
    for (const [index, { returned, reading, metric, file }] of choices.entries()) {
      const { artifact, values } = reading
      const { seq: eventSeq, data: { id: messageId } } = returned.adopted
      await trigger.click()
      await menu.waitFor({ state: 'visible' })
      const items = menu.getByRole('menuitem').filter({ has: page.locator('[data-inquiry-return-message-id]') })
      expect(await items.count()).toBe(choices.length)
      for (const [position, choice] of choices.entries()) {
        const item = items.nth(position)
        expect(await item.locator('[data-inquiry-return-message-id]').getAttribute('data-inquiry-return-message-id'))
          .toBe(choice.returned.adopted.data.id)
        expect(await item.innerText()).toContain(`Warm · ${choice.metric} · ${choice.reading.values.value}`)
        expect(await item.innerText()).toContain(`Return ${position + 1} · Revision ${choice.reading.artifact.revision}`)
      }
      if (index === 0) await menu.screenshot({ path: join(evidence, 'csv-inquiry-return-chooser-after-refresh.png') })
      await items.filter({ has: page.locator(`[data-inquiry-return-message-id="${messageId}"]`) }).click()
      await menu.waitFor({ state: 'hidden' })
      const card = parent.locator(`[data-artifact-branch-evidence][data-chat-message-id="${messageId}"][data-chat-message-seq="${eventSeq}"]`)
      const control = card.locator('[data-chat-message-control="artifact-branch-result"]')
      await expect.poll(() => control.evaluate(element => element.ownerDocument.activeElement === element)).toBe(true)
      const replay = card.locator(`[data-artifact-question-replay-revision="${artifact.revision}"]`)
      await replay.locator('[data-csv-bar-chart]').waitFor({ state: 'visible' })
      expect(await replay.getAttribute('data-artifact-question-replay-id')).toBe(artifact.artifactId)
      await expectCsvReading(replay, values.key, new RegExp(`^${metric}$`, 'u'), String(values.value), String(values.count))
      expect(await replay.locator('[data-csv-participating-rows]').count()).toBe(0)
      expect(reads.mock.calls).toHaveLength(index)
      expect(observed.filter(path => path === RETURNED_ROWS_ENDPOINT)).toHaveLength(index)
      const identity = { sessionId: parentId, eventSeq, messageId }
      await openCsvReplayRows(page, replay, 'csvReturnedParticipatingRows', identity)
      const snapshot = await expectWarmParticipatingRows(replay, false)
      expect(reads.mock.calls).toHaveLength(index + 1)
      expect(reads.mock.calls.at(-1)?.[0].attachmentId).toBe(attachmentId)
      await replay.screenshot({ path: join(evidence, `csv-inquiry-choice-${file}-after-refresh.png`) })
      snapshots.push({ ...identity, artifactId: artifact.artifactId, revision: artifact.revision, metric, reading: values, ...snapshot })
    }
    acknowledgeReloadConnectionLoss(console, warnings)
    const comparison = await replayCsvReturnComparison(live, trigger, menu, parentId,
      { eventSeq: first.adopted.seq, messageId: first.adopted.data.id },
      { eventSeq: second.adopted.seq, messageId: second.adopted.data.id }, observed)
    expect(reads.mock.calls.slice(2).map(([request]) => request.attachmentId)).toEqual([attachmentId, attachmentId])
    await inquiry.sourceAnswer.locator(`[data-inquiry-branch="${childId}"]`).click()
    await selected(childId).waitFor({ state: 'visible' })
    await child.locator(`[data-chat-message-seq="${sumBranch.questionSeq}"]`)
      .getByText(BRANCH_TOTAL_QUESTION, { exact: true }).waitFor({ state: 'visible' })
    expect(await readPersistedEvents(world, parentId)).toEqual(second.parentEvents)
    expect(await readPersistedEvents(world, childId)).toEqual(sumBranch.branchEvents)
    expect(requestCount()).toBe(second.callsBeforeReturn)
    expect(observed.filter(path => path === '/api/session/prompt' || CSV_REGROUP_ROUTES.has(path))).toEqual([])
    expect(observed.filter(path => path === RETURNED_ROWS_ENDPOINT)).toHaveLength(2)
    expect(observed.filter(path => path === COMPARE_RETURNS_ENDPOINT)).toHaveLength(2)
    expect(reads.mock.calls).toHaveLength(4)
    expect(console.warnings).toEqual([])
    expect(console.pageErrors).toEqual([])
    await writeFile(join(evidence, 'csv-inquiry-return-choice-acceptance.json'), JSON.stringify({ userAgent: branch.userAgent,
      parentId, childId, inquiry: inquiry.reference, returns: snapshots, comparison, focusedExactReturn: true, reopenedSameChild: true,
      extraProviderRequests: 0, regroupRequests: 0, rawReadsForChartReplay: 0, explicitAuthenticatedRowsRequests: 2,
      rawReadsForExplicitRows: 2, rawReadsForExplicitComparison: 2,
    }, null, 2) + '\n')
  } finally {
    page.off('request', watch)
    reads.mockRestore()
  }
}

/** Validate the model's explanation of the fixed Warm mean/sum comparison. */
export function expectWarmComparisonAnswer(answer: string): void {
  const plain = answer.replaceAll('*', '').replaceAll('`', '')
  expect(plain).toMatch(/\b(?:mean|average)\b[\s\S]{0,130}\b30\b|\b30\b[\s\S]{0,130}\b(?:mean|average)\b/iu)
  expect(plain).toMatch(/\b(?:sum|total)\b[\s\S]{0,130}\b60\b|\b60\b[\s\S]{0,130}\b(?:sum|total)\b/iu)
  expect(plain).toMatch(/\b(?:row|record)s?\s*#?\s*4\b|\|\s*4\s*\|/iu)
  expect(plain).toMatch(/\b(?:row|record)s?\s*#?\s*5\b|\b(?:rows?|records?)\s*#?\s*4\b[^.\n]{0,25}\b5\b|\|\s*5\s*\|/iu)
  expect(plain).toMatch(/\b25\b/u)
  expect(plain).toMatch(/\b35\b/u)
  expect(plain).toMatch(/\b(?:same|unchanged|both kept|both retained|both included|none excluded)\b/iu)
  for (const sentence of plain.split(/[.\n!?]+/u)) {
    if (/\b(?:no|not|neither|cannot|can't|doesn't|didn't|isn't)\b/iu.test(sentence)) continue
    expect(sentence).not.toMatch(/\b(?:rose|risen|fell|fallen|increased|decreased|grew|dropped)\b[^.\n]{0,35}\b30\b[^.\n]{0,35}\b60\b/iu)
  }
}

/** Lock a reviewed pair, browse another real return, and send only the reviewed page to the real provider. */
export async function exerciseAttachedCsvInquiryReturns(live: CsvLiveBrowser, selectPhrase: SelectAnswerPhrase): Promise<void> {
  const { page, world, evidence, stage, requestCount, ask, providerUserText, console } = live
  await page.setViewportSize({ width: 1440, height: 1280 })
  const { branch, inquiry, first, second, sumBranch } = await createCsvInquiryReturns(live, selectPhrase)
  const { parentId, childId, parent, selected, attachmentId } = branch
  await inquiry.sourceAnswer.locator(`[data-inquiry-branch="${childId}"]`).click()
  await selected(childId).waitFor({ state: 'visible' })
  const maxBranch = await lockCsvUpdate(live, sumBranch, 'max')
  const third = await adoptCsvReading(live, { ...maxBranch, parentEventsBeforeBranch: second.parentEvents })
  const address = ({ adopted }: typeof first) => ({ eventSeq: adopted.seq, messageId: adopted.data.id })
  const returned = (reading: typeof first, artifact: typeof branch.lockedReading.artifact) => ({
    ...address(reading), artifactId: artifact.artifactId, revision: artifact.revision,
  })
  const mean = returned(first, branch.lockedReading.artifact)
  const sum = returned(second, sumBranch.lockedReading.artifact)
  const max = returned(third, maxBranch.lockedReading.artifact)
  const { trigger, menu } = csvInquiryChoice(page, inquiry.sourceAnswer, childId, mean.messageId)
  const { dialog, firstInput, secondInput, ready, compare, open } = csvReturnComparisonControls(page, trigger, menu)
  const chip = parent.locator('[data-artifact-prompt-context="csv-question-comparison"]')
  const observed: string[] = []
  const watch = (request: Request): void => { observed.push(new URL(request.url()).pathname) }
  const compareCount = (): number => observed.filter(path => path === COMPARE_RETURNS_ENDPOINT).length
  const saveDraftEndpoint = '/api/artifactBranchResults/saveCsvComparisonDraft'
  const promptCount = (): number => observed.filter(path => path === '/api/session/prompt').length
  const reads = vi.spyOn(world.ctx.attachments, 'readFileStream')
  const before = requestCount()
  page.on('request', watch)
  const selectPair = async (choice: typeof second, side: typeof sum, aggregate: 'sum' | 'max') => {
    await firstInput.selectOption(mean.messageId)
    await secondInput.selectOption(side.messageId)
    const [response] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === COMPARE_RETURNS_ENDPOINT),
      compare.click(),
    ])
    expect(rpcRequest(response.request())).toEqual({ sessionId: parentId, first: address(first), second: address(choice), offset: 0 })
    const body: unknown = await response.json()
    const comparison = warmComparisonPage(false, aggregate)
    const facts = { kind: 'csv-question-comparison', sessionId: parentId, comparison, returns: { branchSessionId: childId, first: mean,
      second: side } }
    expect(body).toMatchObject({ result: { ok: true, value: comparison } })
    const attachment = objectField(objectField(objectField(body, 'result'), 'value'), 'attachment')
    const proof = objectField(attachment, 'proof')
    if (typeof proof !== 'string' || proof.length === 0) throw new Error('The selected return comparison was not signed')
    expect(attachment).toEqual({ facts, proof })
    await expectWarmComparisonView(ready, false, aggregate)
    expect(await ready.locator('[data-csv-comparison-method-changed]').textContent()).toBe('Calculation method changed')
    expect(await ready.locator('[data-csv-comparison-filter-changed], [data-csv-comparison-membership-changed]').count()).toBe(0)
    return { facts, proof }
  }
  try {
    stage('csv-inquiry-review-and-lock-mean-to-sum')
    await open()
    const reviewed = await selectPair(second, sum, 'sum')
    await ready.getByRole('button', { name: 'Review and attach to next question', exact: true }).click()
    const review = dialog.locator('[data-csv-compare-review]')
    await expectWarmComparisonView(review, false)
    await review.screenshot({ path: join(evidence, 'csv-inquiry-review-locked-comparison.png'), animations: 'disabled' })
    const [saved] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === saveDraftEndpoint),
      review.getByRole('button', { name: 'Attach comparison', exact: true }).click(),
    ])
    expect(rpcRequest(saved.request())).toEqual({ sessionId: parentId, expectedReceiptId: null, attachment: reviewed })
    const savedBody: unknown = await saved.json()
    const receiptId = objectField(objectField(objectField(savedBody, 'result'), 'value'), 'receiptId')
    if (typeof receiptId !== 'string' || receiptId.length === 0) throw new Error('The confirmed comparison did not return a draft receipt')
    expect(savedBody).toMatchObject({ result: { ok: true, value: { receiptId, facts: reviewed.facts } } })
    await review.waitFor({ state: 'hidden' })
    await chip.waitFor({ state: 'attached' })
    expect(compareCount()).toBe(1)
    expect(reads.mock.calls).toHaveLength(1)

    stage('csv-inquiry-browse-mean-to-maximum-without-replacing-lock')
    if (!(await dialog.isVisible())) await open()
    const alternate = await selectPair(third, max, 'max')
    expect(alternate.facts).not.toEqual(reviewed.facts)
    await dialog.screenshot({ path: join(evidence, 'csv-inquiry-alternate-comparison.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await chip.getByRole('button', { name: 'Review attached comparison', exact: true }).click()
    await expectWarmComparisonRecords(chip.locator('[data-csv-compare-draft-page]'), false)
    await expectCsvReading(chip.locator('[data-csv-compare-reading="locked"]'), 'Warm', /sum/iu, '60')
    expect(compareCount()).toBe(2)
    expect(observed.filter(path => path === saveDraftEndpoint)).toHaveLength(1)
    expect(reads.mock.calls.map(([request]) => request.attachmentId)).toEqual([attachmentId, attachmentId])
    expect(requestCount()).toBe(before)
    expect(promptCount()).toBe(0)
    expect(await readPersistedEvents(world, parentId)).toEqual(third.parentEvents)
    expect(await readPersistedEvents(world, childId)).toEqual(maxBranch.branchEvents)

    stage('csv-inquiry-send-only-reviewed-mean-to-sum')
    expect(await ask(REVIEWED_INQUIRY_EXPLANATION, parentId)).toBe(parentId)
    const history = await readPersistedEvents(world, parentId)
    expect(history.slice(0, third.parentEvents.length)).toEqual(third.parentEvents)
    const sent = history.find(event => event.type === 'user/message' && event.data.source.kind === 'user'
      && event.data.content.some(block => block.type === 'text' && block.text === REVIEWED_INQUIRY_EXPLANATION))
    if (sent?.type !== 'user/message') throw new Error('The CSV inquiry comparison prompt was not stored')
    const attached = sent.data.content[1]
    if (attached?.type !== 'text') throw new Error('The inquiry comparison question lost its confirmed comparison')
    const context = attached.text
    expect(context.startsWith(CSV_COMPARISON_QUESTION_PREFIX)).toBe(true)
    expect(envelope(context)).toEqual({ kind: 'artifact-question-context', sessionId: parentId, facts: reviewed.facts })
    const changes = csvComparisonChangesText(reviewed.facts.comparison)
    expect(sent.data.content).toEqual([REVIEWED_INQUIRY_EXPLANATION, context, changes].map(text => ({ type: 'text', text })))
    const modelBlocks = providerUserText(REVIEWED_INQUIRY_EXPLANATION)
    // The provider coalesces adjacent user-role returns with the later authored question.
    const questionIndex = modelBlocks.indexOf(REVIEWED_INQUIRY_EXPLANATION)
    expect(questionIndex).toBeGreaterThanOrEqual(0)
    expect(modelBlocks.slice(0, questionIndex)).toEqual([first, second, third].flatMap(result =>
      result.adopted.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])))
    expectComparisonProviderText(modelBlocks.slice(questionIndex), REVIEWED_INQUIRY_EXPLANATION, context, changes)
    expect(modelBlocks.every(text => !text.includes(reviewed.proof) && !text.includes(receiptId) && !text.includes(CSV))).toBe(true)
    expect(history.filter(event => event.seq > sent.seq && event.type === 'tool/call')).toEqual([])
    const answer = history.findLast(event => event.seq > sent.seq && event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text'))
    if (answer?.type !== 'assistant/message') throw new Error('The real model did not explain the confirmed comparison')
    const answerText = answer.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expectWarmComparisonAnswer(answerText)
    expect(requestCount()).toBe(before + 1)
    expect(promptCount()).toBe(1)

    stage('csv-inquiry-replay-sent-comparison-after-refresh')
    const warnings = console.warnings.length
    await page.reload()
    const question = parent.locator(`[data-chat-message-id="${sent.data.id}"][data-chat-message-seq="${sent.seq}"]`)
    await question.getByText(REVIEWED_INQUIRY_EXPLANATION, { exact: true }).waitFor({ state: 'visible' })
    await question.getByRole('button', { name: 'Replay attached comparison', exact: true }).click()
    const replay = question.locator('[data-csv-compare-attached] [data-csv-compare]')
    await expectWarmComparisonView(replay, false)
    await replay.screenshot({ path: join(evidence, 'csv-inquiry-sent-comparison-after-refresh.png'), animations: 'disabled' })
    acknowledgeReloadConnectionLoss(console, warnings)
    expect(await chip.count()).toBe(0)
    expect(await readPersistedEvents(world, parentId)).toEqual(history)
    expect(await readPersistedEvents(world, childId)).toEqual(maxBranch.branchEvents)
    expect(observed.filter(path => CSV_REGROUP_ROUTES.has(path) || path === RETURNED_ROWS_ENDPOINT)).toEqual([])
    expect(compareCount()).toBe(2)
    expect(reads.mock.calls).toHaveLength(2)
    expect(requestCount()).toBe(before + 1)
    expect(promptCount()).toBe(1)
    expect(console.warnings).toEqual([])
    expect(console.pageErrors).toEqual([])
    await writeFile(join(evidence, 'csv-inquiry-comparison-send-acceptance.json'), JSON.stringify({ userAgent: branch.userAgent,
      locked: reviewed.facts, alternate: alternate.facts, sent: { eventSeq: sent.seq, messageId: sent.data.id }, answer: answerText,
      providerRequestsBeforeSend: 0, explicitProviderRequests: 1, providerRequestsAfterSend: 0, regroupRequests: 0,
      explicitCompareReads: 2, sentReplayReads: 0, restoredExactReviewedPage: true,
    }, null, 2) + '\n')
  } finally {
    page.off('request', watch)
    reads.mockRestore()
  }
}

function warmComparisonRows(filtered: boolean): ArtifactCsvComparisonPage['rows'] {
  return filtered
    ? [{ record: 4, status: 'excluded', value: '25', currentFilterValue: 'A' }, { record: 5, status: 'kept', value: '35', currentFilterValue: 'B' }]
    : [{ record: 4, status: 'kept', value: '25' }, { record: 5, status: 'kept', value: '35' }]
}

function warmComparisonPage(filtered: boolean, aggregate: 'sum' | 'max' = 'sum'): ArtifactCsvComparisonPage {
  const count = filtered ? 1 : 2
  return { original: { groupKey: 'Warm', aggregate: 'mean', value: 30, count: 2, valueColumn: 'LatencyMs' },
    current: { groupKey: 'Warm', aggregate, value: filtered || aggregate === 'max' ? 35 : 60, count, valueColumn: 'LatencyMs',
      ...(filtered ? { filter: BATCH_FILTER } : {}) },
    rows: warmComparisonRows(filtered), kept: count, excluded: filtered ? 1 : 0, added: 0, total: 2, offset: 0 }
}

async function expectWarmComparison(page: Page, replay: Locator, identity: CsvMessageIdentity, filtered: boolean) {
  const trigger = replay.getByRole('button', { name: 'Compare with original return', exact: true })
  const comparison = replay.locator('[data-csv-compare]')
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/artifactBranchResults/compareCsvQuestionToReturn'),
    trigger.click(),
  ])
  expect(objectField(objectField(response.request().postDataJSON(), 'payload'), 'args')).toEqual({ request: { ...identity, offset: 0 } })
  const result = warmComparisonPage(filtered)
  const body: unknown = await response.json()
  expect(body).toMatchObject({ result: { ok: true, value: result } })
  const attachment = objectField(objectField(objectField(body, 'result'), 'value'), 'attachment')
  await expectWarmComparisonView(comparison, filtered)
  return { result, attachment }
}

async function expectWarmComparisonView(comparison: Locator, filtered: boolean, aggregate: 'sum' | 'max' = 'sum'): Promise<void> {
  const expected = warmComparisonPage(filtered, aggregate)
  const original = comparison.locator('[data-csv-compare-reading="original"]')
  const locked = comparison.locator('[data-csv-compare-reading="locked"]')
  await expectCsvReading(original, 'Warm', /mean/iu, '30')
  expect(await original.locator('[data-csv-reading="filter"]').textContent()).toBe('No filter')
  await expectCsvReading(locked, 'Warm', aggregate === 'sum' ? /sum/iu : /maximum/iu, String(expected.current.value),
    String(expected.current.count))
  if (filtered) await expectCsvFilter(locked)
  else expect(await locked.locator('[data-csv-reading="filter"]').textContent()).toBe('No filter')
  const { kept, excluded, added } = expected
  const counts = { kept, excluded, added }
  for (const [status, count] of Object.entries(counts)) {
    expect(await comparison.locator(`[data-csv-compare-count="${status}"]`).textContent()).toBe(String(count))
  }
  await expectWarmComparisonRecords(comparison, filtered)
}

async function expectWarmComparisonRecords(comparison: Locator, filtered: boolean): Promise<void> {
  const expectedRows = warmComparisonRows(filtered)
  const rows = comparison.locator('[data-csv-compare-record]')
  await expect.poll(() => rows.count()).toBe(expectedRows.length)
  expect(await comparison.getByRole('columnheader', { name: 'Batch', exact: true }).count()).toBe(filtered ? 1 : 0)
  for (const expected of expectedRows) {
    const row = rows.and(comparison.locator(`[data-csv-compare-record="${expected.record}"]`))
    expect(await row.getAttribute('data-csv-compare-status')).toBe(expected.status)
    expect(await row.locator('[data-csv-compare-cell="status"]').textContent()).toBe(expected.status === 'kept' ? 'Kept' : 'Excluded')
    expect(await row.locator('[data-csv-compare-cell="value"]').textContent()).toBe(expected.value)
    if ('currentFilterValue' in expected) {
      expect(await row.locator('[data-csv-compare-cell="current-filter"]').textContent()).toBe(expected.currentFilterValue)
    }
  }
}

async function expectCsvTableFit(records: Locator): Promise<void> {
  await records.evaluate((table) => { table.scrollIntoView({ block: 'center', inline: 'nearest' }) })
  await expect.poll(() => records.evaluate((table) => {
    const { left, right } = table.getBoundingClientRect()
    const width = window.visualViewport?.width ?? window.innerWidth
    return left >= 0 && right <= width && [...table.querySelectorAll('tbody th, tbody td')].every((cell) => {
      const text = document.createRange()
      text.selectNodeContents(cell)
      const bounds = text.getBoundingClientRect()
      const centre = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      return centre !== null && cell.contains(centre) && bounds.left >= 0 && bounds.right <= width
    })
  }), { message: 'The CSV table records are visible at mobile width' }).toBe(true)
}

async function readCsvComparisonDraft(world: WebScaffold, sessionId: SessionId): Promise<unknown> {
  const method = 'artifactBranchResults/readCsvComparisonDraft'
  const response = await world.hostFetch(`/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request: { sessionId } } } }),
  })
  expect(response.ok).toBe(true)
  const responseBody: unknown = await response.json()
  const result = objectField(responseBody, 'result')
  expect(objectField(result, 'ok')).toBe(true)
  return objectField(result, 'value')
}

const CSV_DRAFT_BIND_ROUTE = '/api/artifactBranchResults/bindCsvComparisonDraftRequest'
const CSV_DRAFT_CHECK_ROUTE = '/api/artifactBranchResults/checkCsvComparisonDraftRequest'
const SESSION_PROMPT_ROUTE = '/api/session/prompt'

type PendingPromptGate = ReturnType<typeof holdCsvPromptAdmission>

/** Pause the exact prompt inside the real Host's reserved admission job. */
function holdCsvPromptAdmission(world: WebScaffold, sessionId: SessionId) {
  const sessionInputs = world.ctx.sessionInputs
  const originalRun = sessionInputs.run.bind(sessionInputs)
  const reserved = Promise.withResolvers<string>()
  const release = Promise.withResolvers<boolean>()
  sessionInputs.run = function <T>(...args: Parameters<typeof originalRun<T>>) {
    const [target, identity, input, job] = args
    const content = objectField(input, 'content')
    if (target !== sessionId || identity.kind !== 'rpc' || !Array.isArray(content)
      || !content.some(part => objectField(part, 'text') === EXPLAIN_COMPARISON_QUESTION)) {
      return originalRun(...args)
    }
    return originalRun(target, identity, input, async (frozen) => {
      try {
        expect(sessionInputs.hasPendingPrompt(target, identity.requestId)).toBe(true)
        reserved.resolve(identity.requestId)
        if (!await release.promise) throw new Error('Fixture ended admission before accepting the prompt')
        return await job(frozen)
      } catch (error) {
        reserved.reject(error)
        throw error
      }
    })
  }
  return { reserved: reserved.promise, release(admit: boolean) {
    sessionInputs.run = originalRun
    release.resolve(admit)
  } }
}

/** Keep the browser's submission unanswered until it closes, optionally starting its real Host admission once. */
async function interceptCsvDraftSubmit(page: Page, composer: Locator, sessionId: SessionId, receiptId: string, gate?: PendingPromptGate) {
  const submitted = Promise.withResolvers<unknown>()
  const release = Promise.withResolvers<undefined>()
  let intercepted = 0
  let forwarded = 0
  let browserClear = 0
  let routeTimeout: ReturnType<typeof setTimeout> | undefined
  const unadmittedRoute = Promise.withResolvers<Route>()
  await page.route('**/api/artifactBranchResults/clearCsvComparisonDraft', async (route) => {
    browserClear++
    await route.abort()
  })
  let upstream: Promise<unknown> | undefined
  await page.route(`**${SESSION_PROMPT_ROUTE}`, async (route) => {
    intercepted++
    try {
      if (intercepted !== 1) throw new Error('The browser attempted a duplicate submit before receiving acknowledgement')
      if (gate !== undefined) {
        // The context API client owns this upstream HTTP request independently of the intercepted Page.
        const request = route.request()
        const incomingHeaders = await request.allHeaders()
        const { host: _host, 'content-length': _contentLength, ...headers } = incomingHeaders
        const data = request.postDataBuffer()
        if (data === null) throw new Error('The intercepted prompt is missing its body')
        upstream = page.context().request.post(request.url(), { data, headers, maxRetries: 0 }).then(async (response) => {
          try { return await response.json() as unknown } finally { await response.dispose() }
        })
        forwarded++
        void upstream.catch((error: unknown) => { submitted.reject(error) })
        expect(await gate.reserved).toBe(objectField(rpcRequest(request), 'requestId'))
      }
      submitted.resolve(rpcRequest(route.request()))
      if (gate === undefined) unadmittedRoute.resolve(route)
    } catch (error) { submitted.reject(error) }
    await release.promise
  })
  try {
    routeTimeout = setTimeout(() => { submitted.reject(new Error('The browser did not submit the bound comparison draft')) }, 15_000)
    const [bindResponse, prompt] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === CSV_DRAFT_BIND_ROUTE),
      submitted.promise,
      composer.press('Enter'),
    ])
    const requestId = objectField(prompt, 'requestId')
    if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('The composer submit did not identify its request')
    expect(await bindResponse.json()).toMatchObject({ result: { ok: true, value: { bound: true } } })
    const bind = rpcRequest(bindResponse.request())
    expect(objectField(bind, 'sessionId')).toBe(sessionId)
    expect(objectField(bind, 'requestId')).toBe(requestId)
    expect(objectField(bind, 'receiptId') === receiptId).toBe(true)
    const expectedContexts = [{ kind: 'artifact', value: { kind: 'csv-comparison-draft', receiptId } }]
    expect(JSON.stringify(objectField(prompt, 'contexts')) === JSON.stringify(expectedContexts)).toBe(true)
    expect(objectField(prompt, 'content')).toEqual([{ type: 'text', text: EXPLAIN_COMPARISON_QUESTION }])
    return { requestId, assertOnce() {
      expect(intercepted).toBe(1)
      expect(forwarded).toBe(gate === undefined ? 0 : 1)
      expect(browserClear).toBe(0)
    }, async expectUpstreamResult(accepted: boolean) {
      expect(upstream).toBeDefined()
      expect(await upstream).toMatchObject({ result: accepted ? { ok: true, value: { accepted: true } } : { ok: false } })
    }, async close() {
      try {
        if (gate === undefined) {
          // Abort explicitly before closing the tab. Chromium can release a paused request during teardown.
          await page.route(`**${CSV_DRAFT_CHECK_ROUTE}`, async () => { await release.promise })
          await (await unadmittedRoute.promise).abort()
        }
        await page.close()
      } finally { release.resolve(undefined) }
    } }
  } catch (error) {
    release.resolve(undefined)
    throw error
  } finally {
    clearTimeout(routeTimeout)
  }
}

interface CsvExplanationInputs {
  readonly parent: Locator
  readonly returned: Locator
  readonly filteredReplay: Locator
  readonly filteredQuestion: CsvMessageIdentity
  readonly reviewedComparison: Awaited<ReturnType<typeof expectWarmComparison>>
  readonly adopted: Omit<CsvMessageIdentity, 'sessionId'> & { artifactId: string; revision: number }
  readonly attachmentId: string
  readonly csv: string
}

async function exerciseCsvComparisonExplanation(live: CsvLiveBrowser, {
  parent: originalParent, returned, filteredReplay, filteredQuestion, reviewedComparison, adopted, attachmentId, csv,
}: CsvExplanationInputs): Promise<void> {
  const { world, stage, ask, requestCount, providerUserText, evidence } = live
  const { sessionId } = filteredQuestion
  let page = live.page
  let console = live.console
  let parent = originalParent
  const rowFor = (text: string) => parent.locator('[data-chat-flow-kind="user"]:visible').filter({ hasText: text })
  await page.setViewportSize({ width: 1440, height: 960 })

  stage('csv-send-unfiltered-comparison-source')
  const beforeUnfiltered = requestCount()
  await returned.locator('[data-csv-continue-analysis]').click()
  const analysis = returned.locator('[data-csv-analysis]')
  await analysis.locator('[data-csv-analysis-aggregate]').selectOption('sum')
  await expectCsvReading(analysis.locator('[data-csv-analysis-current]'), 'Warm', /sum/iu, '60')
  await analysis.getByRole('button', { name: 'Use for next question', exact: true }).click()
  const readingReview = analysis.getByRole('region', { name: 'Review CSV reading', exact: true })
  await expectCsvReading(readingReview, 'Warm', /sum/iu, '60')
  await readingReview.getByRole('button', { name: 'Attach readings', exact: true }).click()
  expect(requestCount()).toBe(beforeUnfiltered)
  await ask(UNFILTERED_COMPARISON_QUESTION, sessionId)
  const afterUnfiltered = await readPersistedEvents(world, sessionId)
  const alternate = afterUnfiltered.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (alternate?.type !== 'user/message') throw new Error('The unfiltered comparison source question was not stored')
  const alternateRow = rowFor(UNFILTERED_COMPARISON_QUESTION)
  await alternateRow.getByRole('button', { name: 'Replay experiment', exact: true }).click()
  const alternateReplay = alternateRow.locator('[data-artifact-question-replay-id]')
  await expectCsvReading(alternateReplay, 'Warm', /sum/iu, '60')
  expect(await alternateReplay.locator('[data-csv-reading="filter"]').count()).toBe(0)

  stage('csv-review-and-attach-filtered-comparison')
  const beforeAttach = requestCount()
  const beforeReviewEvents = await readPersistedEvents(world, sessionId)
  const { result, attachment } = reviewedComparison
  await filteredReplay.getByRole('button', { name: 'Compare with original return', exact: true }).click()
  await expectWarmComparisonView(filteredReplay.locator('[data-csv-compare]'), true)
  const signedFacts = objectField(attachment, 'facts')
  const changesText = csvComparisonChangesText(objectField(signedFacts, 'comparison') as Parameters<typeof csvComparisonChangesText>[0])
  const changesBlock = { type: 'text', text: changesText } as const
  const proof = objectField(attachment, 'proof')
  if (typeof proof !== 'string' || proof.length === 0) throw new Error('The reviewed comparison has no Host-issued attachment proof')
  expect(signedFacts).toEqual({ kind: 'csv-question-comparison', sessionId,
    question: { eventSeq: filteredQuestion.eventSeq, messageId: filteredQuestion.messageId },
    source: { eventSeq: adopted.eventSeq, messageId: adopted.messageId, artifactId: adopted.artifactId, revision: adopted.revision },
    comparison: result })

  await filteredReplay.locator('[data-csv-compare-attach]').click()
  const review = filteredReplay.locator('[data-csv-compare-review]')
  await expectWarmComparisonView(review, true)
  await review.screenshot({ path: join(evidence, 'csv-review-comparison-attachment.png') })
  const [saveResponse] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/artifactBranchResults/saveCsvComparisonDraft'),
    review.locator('[data-csv-compare-confirm]').click(),
  ])
  const saveRequest = objectField(objectField(objectField(saveResponse.request().postDataJSON(), 'payload'), 'args'), 'request')
  expect(typeof saveRequest === 'object' && saveRequest !== null && objectField(saveRequest, 'expectedReceiptId') === null).toBe(true)
  const saveResult = objectField(await saveResponse.json(), 'result')
  expect(objectField(saveResult, 'ok')).toBe(true)
  const savedDraft = objectField(saveResult, 'value')
  const receiptId = objectField(savedDraft, 'receiptId')
  if (typeof receiptId !== 'string' || receiptId.length === 0) throw new Error('The comparison draft has no Host receipt')
  expect(objectField(savedDraft, 'facts')).toEqual(signedFacts)
  const draftChip = () => parent.locator('[data-artifact-prompt-context="csv-question-comparison"]')
  const draftInput = () => parent.locator('[data-composer-input]')
  const chip = draftChip()
  await chip.waitFor({ state: 'visible' })
  await writeComposerDraft(page, draftInput(), EXPLAIN_COMPARISON_QUESTION)
  let hostRestarted = false
  const verifyUnsentDraft = async (image: string, pendingRequestId?: string, text = EXPLAIN_COMPARISON_QUESTION): Promise<void> => {
    const composer = draftInput()
    const chip = draftChip()
    await expect.poll(() => composer.textContent()).toBe(text)
    await expectCsvReading(chip.locator('[data-csv-compare-reading="original"]'), 'Warm', /mean/iu, '30')
    const locked = chip.locator('[data-csv-compare-reading="locked"]')
    await expectCsvReading(locked, 'Warm', /sum/iu, '35', '1')
    await expectCsvFilter(locked)
    expect(await chip.locator('[data-csv-compare-count="kept"]').textContent()).toBe('1')
    expect(await chip.locator('[data-csv-compare-count="excluded"]').textContent()).toBe('1')
    const draft = await readCsvComparisonDraft(world, sessionId)
    expect(objectField(draft, 'facts')).toEqual(signedFacts)
    expect(objectField(draft, 'receiptId') === receiptId).toBe(true)
    expect(objectField(draft, 'pendingRequestId')).toBe(pendingRequestId)
    expect(requestCount()).toBe(beforeAttach)
    const events = await readPersistedEvents(world, sessionId)
    if (hostRestarted) {
      expect(events.slice(0, beforeReviewEvents.length)).toEqual(beforeReviewEvents)
      expect(events.slice(beforeReviewEvents.length).every(event => event.type === 'session/end-seed')).toBe(true)
    } else expect(events).toEqual(beforeReviewEvents)
    await chip.getByRole('button', { name: 'Review attached comparison', exact: true }).click()
    await expectWarmComparisonRecords(chip.locator('[data-csv-compare-draft-page]'), true)
    await parent.locator('[data-composer-seat]').screenshot({ path: join(evidence, image) })
    await chip.getByRole('button', { name: 'Review attached comparison', exact: true }).click()
  }

  stage('csv-restore-confirmed-draft-after-edge-refresh')
  const origin = new URL(page.url()).origin
  const beforeDraftReload = console.warnings.length
  await page.reload()
  await verifyUnsentDraft('csv-comparison-draft-after-edge-refresh.png')
  acknowledgeReloadConnectionLoss(console, beforeDraftReload)

  stage('csv-restore-confirmed-draft-after-host-restart')
  const oldHost = world.ctx
  const beforeHostRestart = console.warnings.length
  await world.restart()
  hostRestarted = true
  expect(world.ctx).not.toBe(oldHost)
  expect(new URL(world.baseUrl).origin).toBe(origin)
  await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
  expect(new URL(page.url()).origin).toBe(origin)
  await verifyUnsentDraft('csv-comparison-draft-after-host-restart.png')
  acknowledgeReloadConnectionLoss(console, beforeHostRestart)

  stage('csv-open-alternate-after-restart')
  await alternateRow.getByRole('button', { name: 'Replay experiment', exact: true }).click()
  await expectWarmComparison(page, alternateReplay, { sessionId, eventSeq: alternate.seq, messageId: alternate.data.id }, false)
  await verifyUnsentDraft('csv-filtered-comparison-draft-after-opening-other.png')

  const reopen = async (requestId: string, accepted: boolean, pending = false) => {
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
    page = await page.context().newPage()
    live.setDiagnosticPage(page)
    await page.setViewportSize({ width: 1440, height: 960 })
    console = watchConsole(page)
    const automatic: string[] = []
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path === SESSION_PROMPT_ROUTE || path === CSV_DRAFT_BIND_ROUTE
        || /\/(?:clearCsvComparisonDraft|compareCsvQuestionToReturn)$/u.test(path)) automatic.push(path)
    })
    parent = page.locator(`[data-conversation-session="${sessionId}"]`)
    const [checked] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === CSV_DRAFT_CHECK_ROUTE),
      page.goto(world.authenticatedUrl, { waitUntil: 'load' }),
    ])
    expect(new URL(page.url()).origin).toBe(origin)
    expect(rpcRequest(checked.request())).toEqual({ sessionId, requestId })
    expect(await checked.json()).toMatchObject({ result: { ok: true, value: { accepted, ...(pending ? { pending: true } : {}) } } })
    return () => [...automatic]
  }

  stage('csv-close-tab-before-prompt-admission')
  const beforeAdmission = await readPersistedEvents(world, sessionId)
  const unadmitted = await interceptCsvDraftSubmit(page, draftInput(), sessionId, receiptId)
  try {
    expect(requestCount()).toBe(beforeAttach)
    expect(await readPersistedEvents(world, sessionId)).toEqual(beforeAdmission)
    unadmitted.assertOnce()
  } finally { await unadmitted.close() }

  stage('csv-reopen-unadmitted-draft')
  const beforeAdmissionTraffic = await reopen(unadmitted.requestId, false)
  await verifyUnsentDraft('csv-comparison-draft-before-admission-restored.png')
  const beforeAdmissionRequests = beforeAdmissionTraffic()
  expect(beforeAdmissionRequests).toEqual([])

  const sendButton = () => parent.getByRole('button', { name: 'Send message', exact: true })
  const pendingStatus = () => parent.locator('[data-csv-comparison-draft-state="awaiting-confirmation"]')
  const viewSentQuestion = () => parent.getByRole('button', { name: 'View sent question', exact: true })
    .and(parent.locator('[data-csv-view-sent-question]'))
  const editedAfterRefusal = `${EXPLAIN_COMPARISON_QUESTION} Please keep the explanation concise.`
  const editedAfterAcceptance = 'From the attached comparison, report both sample counts and their difference in one sentence.'
  const recoverPending = async (image: string, accept: boolean, editedDraft: string) => {
    stage(accept ? 'csv-close-tab-during-successful-admission' : 'csv-close-tab-during-refused-admission')
    const gate = holdCsvPromptAdmission(world, sessionId)
    let navigations = 0
    try {
      const attempt = await interceptCsvDraftSubmit(page, draftInput(), sessionId, receiptId, gate)
      try { attempt.assertOnce() } finally { await attempt.close() }
      const traffic = await reopen(attempt.requestId, false, true)
      page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations++ })
      await pendingStatus().waitFor({ state: 'visible' })
      expect(await pendingStatus().textContent()).toMatch(/waiting for the host to confirm the question/iu)
      await verifyUnsentDraft(image, attempt.requestId)
      expect(await draftChip().getByRole('button', { name: 'Remove question context', exact: true }).isEnabled()).toBe(false)
      expect(await draftInput().getAttribute('contenteditable')).toBe('true')
      expect(await sendButton().evaluate(button => button instanceof HTMLButtonElement && button.disabled)).toBe(true)
      // Use pointer coordinates so the native disabled button receives the gesture without bypassing browser semantics.
      await sendButton().scrollIntoViewIfNeeded()
      const bounds = await sendButton().boundingBox()
      if (bounds === null) throw new Error('The disabled Send button has no visible bounds')
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await draftInput().press('Enter')
      await expect.poll(() => draftInput().textContent()).toBe(EXPLAIN_COMPARISON_QUESTION)
      await writeComposerDraft(page, draftInput(), editedDraft)
      await expect.poll(() => draftInput().textContent()).toBe(editedDraft)
      expect(await pendingStatus().isVisible()).toBe(true)
      expect(await sendButton().isEnabled()).toBe(false)
      expect(await parent.locator('[data-csv-comparison-draft-outcome]').count()).toBe(0)
      expect(traffic()).toEqual([])
      gate.release(accept)
      await attempt.expectUpstreamResult(accept)
      return { requestId: attempt.requestId, traffic, navigations: () => navigations }
    } finally { gate.release(false) }
  }

  const refused = await recoverPending('csv-comparison-draft-awaiting-before-refusal.png', false, editedAfterRefusal)
  stage('csv-reenable-send-after-unaccepted-admission')
  await pendingStatus().waitFor({ state: 'hidden' })
  const unconfirmedNotice = parent.getByRole('status').and(parent.locator('[data-csv-comparison-draft-outcome="unconfirmed"]'))
  await unconfirmedNotice.waitFor({ state: 'visible' })
  expect(await unconfirmedNotice.textContent()).toBe('The host has not received the previous question yet.')
  expect(await viewSentQuestion().count()).toBe(0)
  await expect.poll(() => sendButton().isEnabled()).toBe(true)
  await verifyUnsentDraft('csv-comparison-send-reenabled-after-refusal.png', undefined, editedAfterRefusal)
  const afterRefusalRequests = refused.traffic()
  expect(afterRefusalRequests).toEqual([])
  expect(refused.navigations()).toBe(0)
  await writeComposerDraft(page, draftInput(), EXPLAIN_COMPARISON_QUESTION)

  const admitted = await recoverPending('csv-comparison-draft-awaiting-admission.png', true, editedAfterAcceptance)

  stage('csv-admit-original-without-browser-reload')
  const pendingAccepted = rowFor(EXPLAIN_COMPARISON_QUESTION)
  await pendingAccepted.waitFor({ state: 'visible' })
  await pendingStatus().waitFor({ state: 'hidden' })
  const acceptedNotice = parent.getByRole('status').and(parent.locator('[data-csv-comparison-draft-outcome="accepted"]'))
  await acceptedNotice.waitFor({ state: 'visible' })
  expect(await acceptedNotice.textContent()).toBe('The previous question was sent.')
  await draftChip().waitFor({ state: 'hidden' })
  await expect.poll(() => draftInput().textContent()).toBe(editedAfterAcceptance)
  expect(admitted.navigations()).toBe(0)
  expect(admitted.traffic()).toEqual([])
  await viewSentQuestion().waitFor({ state: 'visible' })
  await parent.locator('[data-composer-seat]').screenshot({ path: join(evidence, 'csv-accepted-outcome-and-preserved-draft.png') })

  stage('csv-provider-explains-locked-comparison')
  await expect.poll(async () => {
    const events = await readPersistedEvents(world, sessionId)
    return events.slice(beforeAdmission.length).some(event => event.type === 'turn/end')
  }, { timeout: 60_000 }).toBe(true)
  expect(requestCount()).toBe(beforeAttach + 1)
  const afterExplanation = await readPersistedEvents(world, sessionId)
  const explanation = afterExplanation.find(event => event.type === 'user/message' && event.data.source.kind === 'user'
    && 'rpcId' in event.data.source && event.data.source.rpcId === admitted.requestId)
  if (explanation?.type !== 'user/message') throw new Error('The CSV explanation question was not stored')
  expect(afterExplanation.filter(event => event.type === 'user/message' && event.data.source.kind === 'user'
    && event.data.content.some(block => block.type === 'text' && block.text === EXPLAIN_COMPARISON_QUESTION))).toEqual([explanation])
  expect(afterExplanation.some(event => event.type === 'user/message' && event.data.source.kind === 'user'
    && 'rpcId' in event.data.source && (event.data.source.rpcId === unadmitted.requestId || event.data.source.rpcId === refused.requestId)))
    .toBe(false)
  const attached = explanation.data.content.find(block => block.type === 'text' && block.text !== EXPLAIN_COMPARISON_QUESTION)
  if (attached?.type !== 'text') throw new Error('The explanation lost the confirmed CSV comparison')
  expect(attached.text).toContain('The user confirmed the following CSV comparison for this question.')
  expect(envelope(attached.text)).toEqual({ kind: 'artifact-question-context', sessionId, facts: signedFacts })
  expect(explanation.data.content).toEqual([{ type: 'text', text: EXPLAIN_COMPARISON_QUESTION }, attached, changesBlock])
  const modelBlocks = providerUserText(EXPLAIN_COMPARISON_QUESTION)
  expectComparisonProviderText(modelBlocks, EXPLAIN_COMPARISON_QUESTION, attached.text, changesText)
  expect(modelBlocks).not.toContain(editedAfterAcceptance)
  expect([attached.text, ...modelBlocks].every(block => !block.includes(proof) && !block.includes(receiptId))).toBe(true)
  expect(modelBlocks.every(block => !block.includes(csv) && !block.includes('read-only copy saved at'))).toBe(true)
  expect(afterExplanation.filter(event => event.seq > explanation.seq && event.type === 'tool/call')).toEqual([])
  const answer = afterExplanation.findLast(event => event.seq > explanation.seq && event.type === 'assistant/message'
    && event.data.message.content.some(block => block.type === 'text'))
  if (answer?.type !== 'assistant/message') throw new Error('The provider did not explain the locked comparison')
  const text = answer.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  expect(text).toMatch(/\bmean\b[\s\S]{0,250}\b30\b|\b30\b[\s\S]{0,100}\bmean\b/iu)
  expect(text).toMatch(/\b(?:sum(?:s|med|ming)?|totals?)\b[\s\S]{0,90}\b60\b|\b60\b[\s\S]{0,80}\b(?:sum(?:s|med|ming)?|totals?)\b/iu)
  expect(text).toMatch(/\b25\b/u)
  expect(text).toMatch(/\b35\b/u)
  expect(text).toMatch(/\bBatch\b[^.\n]{0,35}\bB\b/iu)
  const sentences = text.split(/(?<=[.!?])\s+|\n+/u)
  expect(sentences.some(sentence => /(?:record\s*#?|#)\s*4\b/iu.test(sentence)
    && /\b(?:exclud\w*|remov\w*|drop\w*|filter\w* out)/iu.test(sentence))).toBe(true)
  expect(sentences.some(sentence => /(?:record\s*#?|#)\s*5\b/iu.test(sentence)
    && /\b(?:kept|keeps?|retain\w*|remain\w*|includ\w*|passes|leaves)/iu.test(sentence))).toBe(true)

  stage('csv-view-exact-sent-question-from-recovery')
  const requestsBeforeGuidance = requestCount()
  const draftCaret = () => draftInput().evaluate((input) => {
    const selection = input.ownerDocument.getSelection()
    if (input.ownerDocument.activeElement !== input || selection?.isCollapsed !== true
      || selection.anchorNode === null || !input.contains(selection.anchorNode)) return null
    const range = input.ownerDocument.createRange()
    range.selectNodeContents(input)
    range.setEnd(selection.anchorNode, selection.anchorOffset)
    return range.toString().length
  })
  const caretFromEnd = 7
  const expectedCaret = editedAfterAcceptance.length - caretFromEnd
  const placeDraftCaret = async (caret = expectedCaret): Promise<void> => {
    await draftInput().click()
    await draftInput().press('End')
    for (let index = 0; index < caretFromEnd; index++) await draftInput().press('ArrowLeft')
    await expect.poll(draftCaret).toBe(caret)
  }
  await placeDraftCaret()
  const sentQuestion = rowFor(EXPLAIN_COMPARISON_QUESTION)
  expect(await sentQuestion.getAttribute('data-chat-message-id')).toBe(explanation.data.id)
  expect(await sentQuestion.getAttribute('data-chat-message-seq')).toBe(String(explanation.seq))
  const sentAttachment = sentQuestion.locator('[data-csv-compare-attached]')
  const sentToggle = sentAttachment.getByRole('button', { name: 'Replay attached comparison', exact: true })
    .and(sentAttachment.locator('[data-chat-message-control="artifact-csv-comparison"]'))
  const sentComparison = sentAttachment.locator('[data-csv-compare]')
  const returnToDraft = (attachment: Locator) => attachment.getByRole('button', { name: 'Return to draft', exact: true })
    .and(attachment.locator('[data-csv-return-to-draft]'))
  await sentToggle.waitFor({ state: 'visible' })
  expect(await sentToggle.getAttribute('aria-expanded')).toBe('false')
  expect(await returnToDraft(sentAttachment).count()).toBe(0)
  await viewSentQuestion().click()
  await expectFocusedComparison(sentToggle)
  await expectWarmComparisonView(sentComparison, true)
  expect(admitted.navigations()).toBe(0)
  expect(admitted.traffic()).toEqual([])
  expect(requestCount()).toBe(requestsBeforeGuidance)
  expect(await readPersistedEvents(world, sessionId)).toEqual(afterExplanation)
  await expect.poll(() => draftInput().textContent()).toBe(editedAfterAcceptance)
  await returnToDraft(sentAttachment).waitFor({ state: 'visible' })
  await sentAttachment.screenshot({ path: join(evidence, 'csv-view-sent-question-expanded.png') })

  stage('csv-return-to-existing-draft-and-caret')
  await returnToDraft(sentAttachment).focus()
  await page.keyboard.press('Enter')
  await expect.poll(draftCaret).toBe(expectedCaret)
  await expect.poll(() => draftInput().textContent()).toBe(editedAfterAcceptance)
  expect(await returnToDraft(sentAttachment).count()).toBe(0)
  expect(admitted.navigations()).toBe(0)
  expect(admitted.traffic()).toEqual([])
  expect(requestCount()).toBe(requestsBeforeGuidance)
  expect(await readPersistedEvents(world, sessionId)).toEqual(afterExplanation)
  await parent.locator('[data-composer-seat]').screenshot({ path: join(evidence, 'csv-returned-to-draft.png') })
  await parent.getByRole('button', { name: 'Dismiss send status', exact: true }).click()
  await acceptedNotice.waitFor({ state: 'hidden' })
  await expect.poll(() => draftInput().textContent()).toBe(editedAfterAcceptance)

  stage('csv-replay-after-pending-admission')
  const beforeReplay = requestCount()
  const afterAdmissionTraffic = admitted.traffic
  const replayWarnings = console.warnings.length
  await page.reload()
  await expect.poll(() => draftInput().textContent()).toBe(editedAfterAcceptance)
  await draftChip().waitFor({ state: 'hidden' })
  const attachedReplay = rowFor(EXPLAIN_COMPARISON_QUESTION).locator('[data-csv-compare-attached]')
  await attachedReplay.getByRole('button', { name: 'Replay attached comparison', exact: true }).click()
  const comparison = attachedReplay.locator('[data-csv-compare]')
  await expectWarmComparisonView(comparison, true)
  expect(await returnToDraft(attachedReplay).count()).toBe(0)
  await draftChip().waitFor({ state: 'hidden' })
  await expect.poll(() => draftInput().textContent()).toBe(editedAfterAcceptance)
  expect(await readCsvComparisonDraft(world, sessionId)).toBeNull()
  await comparison.screenshot({ path: join(evidence, 'csv-attached-comparison-after-pending-admission.png') })
  const afterAdmissionRequests = afterAdmissionTraffic()
  expect(afterAdmissionRequests).toEqual([])
  expect(requestCount()).toBe(beforeReplay)
  expect(await readPersistedEvents(world, sessionId)).toEqual(afterExplanation)
  acknowledgeReloadConnectionLoss(console, replayWarnings)
  expect(console.warnings).toEqual([])
  expect(console.pageErrors).toEqual([])
  const callsAfterReplay = requestCount()
  await writeFile(join(evidence, 'csv-comparison-explanation.json'), JSON.stringify({ facts: signedFacts,
    alternate: { value: 60, count: 2 }, answer: text, callsBeforeAttach: beforeAttach, callsBeforeReplay: beforeReplay,
    callsAfterReplay, restoredAfterEdgeRefresh: true, restoredAfterHostRestart: true,
    recoveredBeforeAdmission: { forwarded: 0, automaticRequests: beforeAdmissionRequests },
    recoveredRefusedAdmission: { forwarded: 1, automaticRequests: afterRefusalRequests, outcome: 'unconfirmed',
      draftEditPreserved: true, attachmentPreserved: true, sendEnabled: true },
    recoveredPendingAdmission: { forwarded: 1, automaticRequests: afterAdmissionRequests, outcome: 'accepted',
      draftEditPreserved: true, restoredEditAfterRefresh: true, attachmentCleared: true, guidedHistoricalReplay: true,
      caretRestored: expectedCaret, normalReplayHasReturn: false } },
  null, 2) + '\n', 'utf8')

  const store = world.ctx.attachments
  const originalRead = store.readFileStream.bind(store)
  let originalReads = 0
  store.readFileStream = (ref, signal) => {
    if (ref.attachmentId !== attachmentId) return originalRead(ref, signal)
    originalReads++
    throw new Error('Historical reuse attempted to read the original fixture CSV')
  }
  try {
    stage('csv-review-and-reuse-sent-comparison')
    const reviewRequests: Request[] = []
    const saveRequests: Request[] = []
    const lookupRequests: string[] = []
    const promptRequests: Request[] = []
    const watchReuse = (request: Request) => {
      const path = new URL(request.url()).pathname
      if (path === SESSION_PROMPT_ROUTE) promptRequests.push(request)
      if (path.endsWith('/reviewSentCsvComparison')) reviewRequests.push(request)
      if (path.endsWith('/saveCsvComparisonDraft')) saveRequests.push(request)
      const name = path.split('/').at(-1) ?? ''
      if (['compareCsvQuestionToReturn', 'csvParticipatingRows', 'csvQuestionParticipatingRows', 'csvReturnedParticipatingRows',
        'csvFilterOptions', 'recalculateCsv', 'lockCsv'].includes(name)) lookupRequests.push(path)
    }
    page.on('request', watchReuse)
    try {
      const reuse = attachedReplay.getByRole('button', { name: 'Reuse comparison in next question', exact: true })
        .and(attachedReplay.locator('[data-csv-compare-reuse]'))
      await reuse.click()
      const review = attachedReplay.getByRole('region', { name: 'Review comparison to attach', exact: true })
        .and(attachedReplay.locator('[data-csv-compare-review]'))
      await expectWarmComparisonView(review, true)
      expect(reviewRequests).toHaveLength(0)
      expect(saveRequests).toHaveLength(0)
      expect(requestCount()).toBe(callsAfterReplay)
      await review.getByRole('button', { name: 'Cancel', exact: true }).click()
      await review.waitFor({ state: 'hidden' })
      await expect.poll(() => draftInput().textContent()).toBe(editedAfterAcceptance)
      expect(await draftChip().count()).toBe(0)
      expect(reviewRequests).toHaveLength(0)
      expect(saveRequests).toHaveLength(0)
      await reuse.click()
      await expectWarmComparisonView(review, true)
      await review.screenshot({ path: join(evidence, 'csv-reuse-historical-comparison-review.png') })

      const [reviewResponse, saveResponse] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/artifactBranchResults/reviewSentCsvComparison'),
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/artifactBranchResults/saveCsvComparisonDraft'),
        review.getByRole('button', { name: 'Attach comparison', exact: true }).click(),
      ])
      const reusedFrom = { eventSeq: explanation.seq, messageId: explanation.data.id }
      expect(rpcRequest(reviewResponse.request())).toEqual({ sessionId, ...reusedFrom })
      const reviewResult = objectField(await reviewResponse.json(), 'result')
      expect(objectField(reviewResult, 'ok')).toBe(true)
      const refreshedAttachment = objectField(reviewResult, 'value')
      expect(signedFacts).not.toHaveProperty('reusedFrom')
      const reusedFacts = { ...(signedFacts as Record<string, unknown>), reusedFrom }
      expect(objectField(refreshedAttachment, 'facts')).toEqual(reusedFacts)
      const reuseProof = objectField(refreshedAttachment, 'proof')
      if (typeof reuseProof !== 'string' || reuseProof.length === 0) throw new Error('The historical review has no Host-issued attachment proof')
      const save = rpcRequest(saveResponse.request())
      expect(objectField(save, 'sessionId')).toBe(sessionId)
      expect(objectField(save, 'expectedReceiptId')).toBeNull()
      expect(objectField(objectField(save, 'attachment'), 'facts')).toEqual(reusedFacts)
      const saveResult = objectField(await saveResponse.json(), 'result')
      expect(objectField(saveResult, 'ok')).toBe(true)
      const restoredDraft = objectField(saveResult, 'value')
      expect(objectField(restoredDraft, 'facts')).toEqual(reusedFacts)
      const reuseReceipt = objectField(restoredDraft, 'receiptId')
      if (typeof reuseReceipt !== 'string' || reuseReceipt.length === 0) throw new Error('The reattached comparison has no Host draft receipt')

      const checkReusedDraft = async (): Promise<void> => {
        const chip = draftChip()
        await chip.waitFor({ state: 'visible' })
        const locked = chip.locator('[data-csv-compare-reading="locked"]')
        await expectCsvReading(locked, 'Warm', /sum/iu, '35', '1')
        await expectCsvFilter(locked)
        await expect.poll(() => draftInput().textContent()).toBe(editedAfterAcceptance)
        expect(await readCsvComparisonDraft(world, sessionId)).toEqual(restoredDraft)
        expect(await readPersistedEvents(world, sessionId)).toEqual(afterExplanation)
        expect(requestCount()).toBe(callsAfterReplay)
      }
      const viewSourceQuestion = (container: Locator) => container.getByRole('button', { name: 'View source question', exact: true })
        .and(container.locator('[data-csv-view-source-question]'))
      const returnToComparison = (attachment: Locator) => attachment.getByRole('button', { name: 'Return to comparison', exact: true })
        .and(attachment.locator('[data-csv-return-to-comparison]'))
      const sourceRow = rowFor(EXPLAIN_COMPARISON_QUESTION)
      const sourceAttachment = sourceRow.locator('[data-csv-compare-attached]')
      const sourceToggle = sourceAttachment.locator('[data-chat-message-control="artifact-csv-comparison"]')
      const expectFocusedSource = async (): Promise<void> => {
        await expectFocusedComparison(sourceToggle)
        expect(await sourceRow.getAttribute('data-chat-message-id')).toBe(reusedFrom.messageId)
        expect(await sourceRow.getAttribute('data-chat-message-seq')).toBe(String(reusedFrom.eventSeq))
        await expectWarmComparisonView(sourceAttachment.locator('[data-csv-compare]'), true)
        expect(await viewSourceQuestion(sourceAttachment).count()).toBe(0)
      }
      const reloadAtSource = async (): Promise<void> => {
        const warnings = console.warnings.length
        await page.reload()
        await expectFocusedSource()
        acknowledgeReloadConnectionLoss(console, warnings)
      }
      await checkReusedDraft()
      await expect.poll(() => draftInput().evaluate(input => input.ownerDocument.activeElement === input)).toBe(true)
      expect(reviewRequests).toHaveLength(1)
      expect(saveRequests).toHaveLength(1)
      expect(lookupRequests).toEqual([])

      stage('csv-restore-reused-comparison-draft')
      const reuseWarnings = console.warnings.length
      await page.reload()
      await checkReusedDraft()
      acknowledgeReloadConnectionLoss(console, reuseWarnings)
      const composerSource = viewSourceQuestion(parent.locator('[data-composer-seat]'))
      await composerSource.waitFor({ state: 'visible' })
      await placeDraftCaret()
      stage('csv-follow-reused-draft-to-source')
      await composerSource.click()
      await expectFocusedSource()
      await checkReusedDraft()
      await returnToDraft(sourceAttachment).waitFor({ state: 'visible' })
      expect(await returnToComparison(sourceAttachment).count()).toBe(0)
      stage('csv-reload-at-source-from-reused-draft')
      await reloadAtSource()
      await checkReusedDraft()
      await returnToDraft(sourceAttachment).waitFor({ state: 'visible' })
      expect(await returnToComparison(sourceAttachment).count()).toBe(0)
      await sourceRow.screenshot({ path: join(evidence, 'csv-source-question-from-reused-draft.png') })
      stage('csv-return-from-source-to-reused-draft')
      await returnToDraft(sourceAttachment).focus()
      await page.keyboard.press('Enter')
      await expect.poll(draftCaret).toBe(expectedCaret)
      await checkReusedDraft()
      expect(promptRequests).toHaveLength(0)
      expect(await returnToDraft(sourceAttachment).count()).toBe(0)
      await parent.locator('[data-composer-seat]').screenshot({ path: join(evidence, 'csv-source-return-to-reused-draft.png') })
      const draftReview = draftChip().getByRole('button', { name: 'Review attached comparison', exact: true })
      await draftReview.click()
      await expectWarmComparisonRecords(draftChip().locator('[data-csv-compare-draft-page]'), true)
      await parent.locator('[data-composer-seat]').screenshot({ path: join(evidence, 'csv-reused-comparison-draft-after-refresh.png') })
      await draftReview.click()

      stage('csv-reload-after-consuming-draft-source-visit')
      const consumedDraftWarnings = console.warnings.length
      await page.reload()
      await checkReusedDraft()
      await composerSource.waitFor({ state: 'visible' })
      await expect.poll(() => sourceToggle.getAttribute('aria-expanded')).toBe('false')
      expect(await returnToDraft(sourceAttachment).count()).toBe(0)
      expect(await returnToComparison(sourceAttachment).count()).toBe(0)
      expect(promptRequests).toHaveLength(0)
      acknowledgeReloadConnectionLoss(console, consumedDraftWarnings)

      stage('csv-submit-reused-comparison-in-next-question')
      const [settled] = await Promise.all([world.whenTurnSettled(), draftInput().press('Enter')])
      expect(settled).toBe(sessionId)
      expect(promptRequests).toHaveLength(1)
      expect(requestCount()).toBe(callsAfterReplay + 1)
      const afterReuse = await readPersistedEvents(world, sessionId)
      expect(afterReuse.find(event => event.seq === explanation.seq)).toEqual(explanation)
      const next = afterReuse.find(event => event.seq > explanation.seq && event.type === 'user/message' && event.data.source.kind === 'user'
        && event.data.content.some(block => block.type === 'text' && block.text === editedAfterAcceptance))
      if (next?.type !== 'user/message') throw new Error('The next question was not admitted with the reused CSV comparison')
      const reusedBlock = next.data.content.find(block => block.type === 'text' && block.text !== editedAfterAcceptance)
      if (reusedBlock?.type !== 'text') throw new Error('The sent question has no reused comparison attachment')
      expect(next.data.content).toEqual([{ type: 'text', text: editedAfterAcceptance }, reusedBlock, changesBlock])
      expect(envelope(reusedBlock.text)).toEqual({ kind: 'artifact-question-context', sessionId, facts: reusedFacts })
      const reusedModelBlocks = providerUserText(editedAfterAcceptance)
      expectComparisonProviderText(reusedModelBlocks, editedAfterAcceptance, reusedBlock.text, changesText)
      expect(reusedModelBlocks.every(block => !block.includes(reuseProof) && !block.includes(reuseReceipt))).toBe(true)
      expect(afterReuse.filter(event => event.seq > next.seq && event.type === 'tool/call')).toEqual([])
      const nextAnswer = afterReuse.findLast(event => event.seq > next.seq && event.type === 'assistant/message'
        && event.data.message.content.some(block => block.type === 'text'))
      if (nextAnswer?.type !== 'assistant/message') throw new Error('The model did not answer the question about the reused comparison')
      const nextText = nextAnswer.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      expect(nextText).toMatch(/\b(?:2|two)\b/iu)
      expect(nextText).toMatch(/\b(?:1|one)\b/iu)
      await draftChip().waitFor({ state: 'hidden' })
      await expect.poll(() => draftInput().textContent()).toBe('')

      stage('csv-reload-and-follow-reused-sent-question-to-source')
      const sentReuseWarnings = console.warnings.length
      await page.reload()
      await expect.poll(() => draftInput().textContent()).toBe('')
      await draftChip().waitFor({ state: 'hidden' })
      const unsentHistoryDraft = 'For later, compare a different group.'
      await writeComposerDraft(page, draftInput(), unsentHistoryDraft)
      const nextRow = rowFor(editedAfterAcceptance)
      const nextAttachment = nextRow.locator('[data-csv-compare-attached]')
      const nextToggle = nextAttachment.getByRole('button', { name: 'Replay attached comparison', exact: true })
        .and(nextAttachment.locator('[data-chat-message-control="artifact-csv-comparison"]'))
      const nextRef = { eventSeq: next.seq, messageId: next.data.id }
      const nextComparison = nextAttachment.locator('[data-csv-compare]')
      const expectFocusedNext = async (narrow = false): Promise<void> => {
        if (narrow) {
          await expect.poll(() => nextToggle.getAttribute('aria-expanded')).toBe('true')
          await expect.poll(() => nextToggle.evaluate(element => element.ownerDocument.activeElement === element)).toBe(true)
        } else await expectFocusedComparison(nextToggle)
        expect(await nextRow.getAttribute('data-chat-message-id')).toBe(nextRef.messageId)
        expect(await nextRow.getAttribute('data-chat-message-seq')).toBe(String(nextRef.eventSeq))
        await expectWarmComparisonView(nextComparison, true)
      }
      await nextToggle.click()
      await expectWarmComparisonView(nextComparison, true)
      expect(await returnToDraft(nextAttachment).count()).toBe(0)
      expect(await returnToComparison(nextAttachment).count()).toBe(0)
      await nextComparison.screenshot({ path: join(evidence, 'csv-reused-comparison-next-question-replay.png') })
      await viewSourceQuestion(nextAttachment).click()
      await expectFocusedSource()
      await returnToComparison(sourceAttachment).waitFor({ state: 'visible' })
      expect(await returnToDraft(sourceAttachment).count()).toBe(0)
      acknowledgeReloadConnectionLoss(console, sentReuseWarnings)
      stage('csv-reload-at-source-from-sent-comparison')
      await reloadAtSource()
      await expect.poll(() => draftInput().textContent()).toBe(unsentHistoryDraft)
      await returnToComparison(sourceAttachment).waitFor({ state: 'visible' })
      expect(await returnToDraft(sourceAttachment).count()).toBe(0)
      await sourceRow.screenshot({ path: join(evidence, 'csv-source-question-from-sent-comparison.png') })
      stage('csv-return-from-source-to-reused-sent-comparison')
      await returnToComparison(sourceAttachment).focus()
      await page.keyboard.press('Enter')
      await expectFocusedNext()
      expect(await returnToComparison(sourceAttachment).count()).toBe(0)
      await nextRow.screenshot({ path: join(evidence, 'csv-source-return-to-reused-sent-comparison.png') })
      await expect.poll(() => draftInput().textContent()).toBe(unsentHistoryDraft)
      expect(await draftChip().count()).toBe(0)
      expect(await readCsvComparisonDraft(world, sessionId)).toBeNull()
      expect(await readPersistedEvents(world, sessionId)).toEqual(afterReuse)

      stage('csv-reload-after-consuming-sent-comparison-source-visit')
      const consumedHistoryWarnings = console.warnings.length
      await page.reload()
      await expect.poll(() => draftInput().textContent()).toBe(unsentHistoryDraft)
      await expect.poll(() => sourceToggle.getAttribute('aria-expanded')).toBe('false')
      expect(await returnToComparison(sourceAttachment).count()).toBe(0)
      expect(await readPersistedEvents(world, sessionId)).toEqual(afterReuse)
      acknowledgeReloadConnectionLoss(console, consumedHistoryWarnings)

      stage('csv-attach-middle-comparison-to-draft')
      await nextToggle.click()
      await nextAttachment.getByRole('button', { name: 'Reuse comparison in next question', exact: true }).click()
      const middleReview = nextAttachment.getByRole('region', { name: 'Review comparison to attach', exact: true })
      await expectWarmComparisonView(middleReview, true)
      const [middleReviewResponse, middleSaveResponse] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/artifactBranchResults/reviewSentCsvComparison'),
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/artifactBranchResults/saveCsvComparisonDraft'),
        middleReview.getByRole('button', { name: 'Attach comparison', exact: true }).click(),
      ])
      expect(rpcRequest(middleReviewResponse.request())).toEqual({ sessionId, ...nextRef })
      const middleSaveResult = objectField(await middleSaveResponse.json(), 'result')
      expect(objectField(middleSaveResult, 'ok')).toBe(true)
      const nestedDraft = objectField(middleSaveResult, 'value')
      expect(objectField(nestedDraft, 'facts')).toEqual({ ...reusedFacts, reusedFrom: nextRef })
      const checkNestedDraft = async (): Promise<void> => {
        await expect.poll(() => draftInput().textContent()).toBe(unsentHistoryDraft)
        await draftChip().waitFor({ state: 'visible' })
        const locked = draftChip().locator('[data-csv-compare-reading="locked"]')
        await expectCsvReading(locked, 'Warm', /sum/iu, '35', '1')
        await expectCsvFilter(locked)
        expect(await readCsvComparisonDraft(world, sessionId)).toEqual(nestedDraft)
        expect(await readPersistedEvents(world, sessionId)).toEqual(afterReuse)
      }
      await checkNestedDraft()
      const nestedCaret = unsentHistoryDraft.length - caretFromEnd
      await placeDraftCaret(nestedCaret)
      const sourceTrail = (attachment: Locator) => attachment.getByRole('navigation', { name: 'Source path', exact: true })
        .and(attachment.locator('[data-csv-source-trail]'))
      const sourceTrailStop = (trail: Locator, message: typeof nextRef) => trail.locator(
        `[data-csv-source-trail-stop][data-csv-source-event-seq="${message.eventSeq}"][data-csv-source-message-id="${message.messageId}"]`,
      )
      const sourceTrailDraft = (trail: Locator) => trail.locator('[data-csv-source-trail-stop="draft"]')
        .getByRole('button', { name: 'Draft', exact: true })
      const expectEarliestTrail = async (): Promise<void> => {
        const trail = sourceTrail(sourceAttachment)
        await sourceTrailDraft(trail).waitFor({ state: 'visible' })
        await sourceTrailStop(trail, nextRef).getByRole('button').waitFor({ state: 'visible' })
        const earliest = sourceTrailStop(trail, reusedFrom)
        expect(await earliest.getAttribute('aria-current')).toBe('location')
        expect(await earliest.getByRole('button').count()).toBe(0)
        expect(await trail.locator('[data-csv-source-trail-stop]').evaluateAll(stops => stops.map(stop =>
          stop.getAttribute('data-csv-source-message-id')))).toEqual([null, nextRef.messageId, reusedFrom.messageId])
      }
      stage('csv-draft-to-middle-and-earliest-source')
      await composerSource.click()
      await expectFocusedNext()
      await returnToDraft(nextAttachment).waitFor({ state: 'visible' })
      await viewSourceQuestion(nextAttachment).click()
      await expectFocusedSource()
      await returnToComparison(sourceAttachment).waitFor({ state: 'visible' })
      expect(await returnToDraft(sourceAttachment).count()).toBe(0)

      stage('csv-reload-at-earliest-of-two-sources')
      await reloadAtSource()
      await checkNestedDraft()
      await returnToComparison(sourceAttachment).waitFor({ state: 'visible' })
      expect(await returnToDraft(sourceAttachment).count()).toBe(0)
      await expectEarliestTrail()
      await sourceRow.screenshot({ path: join(evidence, 'csv-multilevel-earliest-source-after-reload.png') })

      stage('csv-return-through-middle-to-original-draft')
      await returnToComparison(sourceAttachment).focus()
      await page.keyboard.press('Enter')
      await expectFocusedNext()
      await returnToDraft(nextAttachment).waitFor({ state: 'visible' })
      expect(await returnToComparison(sourceAttachment).count()).toBe(0)
      expect(await returnToComparison(nextAttachment).count()).toBe(0)
      await nextRow.screenshot({ path: join(evidence, 'csv-multilevel-return-to-middle.png') })

      stage('csv-reload-at-middle-after-first-return')
      const middleWarnings = console.warnings.length
      await page.reload()
      await expectFocusedNext()
      await checkNestedDraft()
      await returnToDraft(nextAttachment).waitFor({ state: 'visible' })
      expect(await returnToComparison(sourceAttachment).count()).toBe(0)
      acknowledgeReloadConnectionLoss(console, middleWarnings)
      await returnToDraft(nextAttachment).focus()
      await page.keyboard.press('Enter')
      await expect.poll(draftCaret).toBe(nestedCaret)
      await checkNestedDraft()
      await returnToDraft(nextAttachment).waitFor({ state: 'hidden' })
      await parent.locator('[data-composer-seat]').screenshot({ path: join(evidence, 'csv-multilevel-return-to-draft.png') })

      stage('csv-reload-after-consuming-multilevel-source-visit')
      const multilevelWarnings = console.warnings.length
      await page.reload()
      await checkNestedDraft()
      await composerSource.waitFor({ state: 'visible' })
      await expect.poll(() => sourceToggle.getAttribute('aria-expanded')).toBe('false')
      await expect.poll(() => nextToggle.getAttribute('aria-expanded')).toBe('false')
      expect(await returnToComparison(sourceAttachment).count()).toBe(0)
      expect(await returnToDraft(nextAttachment).count()).toBe(0)
      acknowledgeReloadConnectionLoss(console, multilevelWarnings)

      const {
        pageHistoryPattern, rejectEarlierPage, holdEarlierPage, deliverEarlierPage, watchEarlierPages, unavailableEarlierPages,
        matchingHistoryRequest,
      } = createCsvHistoryControls(page, sessionId, nextRef.eventSeq)
      const shortenHistory = async (): Promise<() => number> => await interceptCsvHistorySnapshot(page, sessionId, (snapshot) => {
        const records = snapshot.records.filter(record => record.event.seq >= nextRef.eventSeq)
        expect(records[0]?.event.seq).toBe(nextRef.eventSeq)
        expect(records.length).toBeLessThan(snapshot.records.length)
        return { ...snapshot, records, hasMore: true }
      })
      const changeEarlierHistoryLink = async (): Promise<() => number> => {
        const wrongSourceId = randomUUID()
        return await interceptCsvHistorySnapshot(page, sessionId, (snapshot) => {
          const matching = snapshot.records.find(item => item.event.seq === nextRef.eventSeq)
          if (matching?.event.type !== 'user/message' || objectField(matching.event.data, 'id') !== nextRef.messageId
            || !isRecord(matching.event.data)) throw new Error('The replay snapshot is missing the exact middle comparison question')
          const data = matching.event.data as Record<string, JsonValue>
          const content = data.content
          if (!Array.isArray(content)) throw new Error('The middle question is missing its comparison blocks')
          let editedBlocks = 0
          const changed = content.map((block) => {
            if (block === null || typeof block !== 'object' || Array.isArray(block) || block.type !== 'text'
              || typeof block.text !== 'string' || !block.text.startsWith(CSV_COMPARISON_QUESTION_PREFIX)) return block
            const body = envelope(block.text)
            if (!isRecord(body) || !isRecord(body.facts) || body.facts.kind !== 'csv-question-comparison') return block
            expect(body.facts.reusedFrom).toEqual(reusedFrom)
            editedBlocks++
            const brokenFacts = { ...body.facts, reusedFrom: { ...reusedFrom, messageId: wrongSourceId } }
            return { ...block, text: block.text.slice(0, block.text.indexOf('\n') + 1) + JSON.stringify({ ...body, facts: brokenFacts }) }
          })
          expect(editedBlocks).toBe(1)
          const invalidRecord = { ...matching, event: { ...matching.event, data: { ...data, content: changed } } }
          return { ...snapshot, records: snapshot.records.map(record => record === matching ? invalidRecord : record) }
        })
      }
      const openSavedEarliest = async (): Promise<void> => {
        await placeDraftCaret(nestedCaret)
        await composerSource.click()
        await expectFocusedNext()
        await viewSourceQuestion(nextAttachment).click()
        await expectFocusedSource()
        await expectEarliestTrail()
      }
      const middleRecovery = sourceTrail(nextAttachment)
      const expectVerifiedDraftPrefix = async (): Promise<void> => {
        await expectFocusedNext()
        await sourceTrailDraft(middleRecovery).waitFor({ state: 'visible' })
        expect(await sourceTrailStop(middleRecovery, nextRef).getAttribute('aria-current')).toBe('location')
        expect(await sourceTrailStop(middleRecovery, reusedFrom).count()).toBe(0)
        await checkNestedDraft()
      }
      const returnByBreadcrumb = async (trail: Locator): Promise<void> => {
        await sourceTrailDraft(trail).focus()
        await page.keyboard.press('Enter')
        await expect.poll(draftCaret).toBe(nestedCaret)
        await checkNestedDraft()
        await trail.waitFor({ state: 'hidden' })
      }

      stage('csv-reload-source-trail-with-unavailable-earlier-page')
      await openSavedEarliest()
      const shortenedRestoreHistory = await shortenHistory()
      const unavailableRestoreWarnings = console.warnings.length
      const unavailableRecovery = nextAttachment.locator('[data-csv-source-recovery="unavailable"]')
      const retryRestore = nextAttachment.getByRole('button', { name: 'Retry', exact: true })
        .and(nextAttachment.locator('[data-csv-source-recovery-retry]'))
      await page.route(pageHistoryPattern, rejectEarlierPage)
      try {
        await page.reload()
        await expectVerifiedDraftPrefix()
        expect(shortenedRestoreHistory()).toBe(1)
        await unavailableRecovery.waitFor({ state: 'visible' })
        expect(await unavailableRecovery.textContent()).toContain('Some earlier sources are unavailable.')
        await retryRestore.waitFor({ state: 'visible' })
        expect(unavailableEarlierPages()).toBe(1)
        expect(await sourceRow.count()).toBe(0)
        await nextRow.screenshot({ path: join(evidence, 'csv-active-source-trail-reload-unavailable.png') })
      } finally {
        await page.unroute(pageHistoryPattern, rejectEarlierPage)
      }
      stage('csv-retry-active-source-trail-and-return-to-draft')
      const [restoredEarlierPage] = await Promise.all([
        page.waitForResponse(response => matchingHistoryRequest(response.request())),
        retryRestore.click(),
      ])
      expect(objectField(objectField(await restoredEarlierPage.json(), 'result'), 'ok')).toBe(true)
      await expectFocusedSource()
      await expectEarliestTrail()
      await checkNestedDraft()
      await unavailableRecovery.waitFor({ state: 'hidden' })
      const recoveredEarliestTrail = sourceTrail(sourceAttachment)
      await sourceRow.screenshot({ path: join(evidence, 'csv-active-source-trail-retry-restored-earliest.png') })
      await returnByBreadcrumb(recoveredEarliestTrail)
      acknowledgeReloadConnectionLoss(console, unavailableRestoreWarnings)
      const unavailableRestorePages = unavailableEarlierPages()

      stage('csv-return-to-draft-before-retry-history-response')
      await openSavedEarliest()
      const shortenedWaitingHistory = await shortenHistory()
      const waitingHistoryWarnings = console.warnings.length
      await page.route(pageHistoryPattern, rejectEarlierPage)
      try {
        await page.reload()
        await expectVerifiedDraftPrefix()
        expect(shortenedWaitingHistory()).toBe(1)
        await retryRestore.waitFor({ state: 'visible' })
        expect(unavailableEarlierPages()).toBe(unavailableRestorePages + 1)
        expect(await sourceRow.count()).toBe(0)
      } finally {
        await page.unroute(pageHistoryPattern, rejectEarlierPage)
      }

      const draftReturnRetry = await holdEarlierPage()
      try {
        await retryRestore.click()
        await draftReturnRetry.waitForResponse()
        expect(await sourceRow.count()).toBe(0)
        await nextRow.screenshot({ path: join(evidence, 'csv-active-source-trail-late-retry-pending.png') })
        await returnByBreadcrumb(middleRecovery)
        await unavailableRecovery.waitFor({ state: 'hidden' })

        stage('csv-keep-draft-when-retried-history-arrives')
        await draftReturnRetry.deliver()
        // The successful page reached the browser and can mount the old message without reopening its comparison.
        await sourceRow.waitFor({ state: 'attached' })
        expect(await sourceToggle.getAttribute('aria-expanded')).toBe('false')
        await expect.poll(draftCaret).toBe(nestedCaret)
        await checkNestedDraft()
        expect(await page.locator('[data-csv-source-trail]').count()).toBe(0)
        expect(draftReturnRetry.count()).toBe(1)
        await parent.locator('[data-composer-seat]').screenshot({ path: join(evidence, 'csv-active-source-trail-late-retry-stayed-draft.png') })
      } finally {
        await draftReturnRetry.close()
      }
      acknowledgeReloadConnectionLoss(console, waitingHistoryWarnings)
      const lateRetryReloadWarnings = console.warnings.length
      await page.reload()
      await checkNestedDraft()
      await composerSource.waitFor({ state: 'visible' })
      await expect.poll(() => sourceToggle.getAttribute('aria-expanded')).toBe('false')
      await expect.poll(() => nextToggle.getAttribute('aria-expanded')).toBe('false')
      expect(await page.locator('[data-csv-source-trail]').count()).toBe(0)
      acknowledgeReloadConnectionLoss(console, lateRetryReloadWarnings)

      stage('csv-reload-source-trail-with-invalid-earlier-link')
      await openSavedEarliest()
      const brokenRestoreHistory = await changeEarlierHistoryLink()
      const invalidRestoreWarnings = console.warnings.length
      const invalidRestorePaging = watchEarlierPages()
      try {
        await page.reload()
        await expectVerifiedDraftPrefix()
        expect(brokenRestoreHistory()).toBe(1)
        await sourceRow.waitFor({ state: 'attached' })
        expect(await sourceToggle.getAttribute('aria-expanded')).toBe('false')
        const invalidRecovery = nextAttachment.locator('[data-csv-source-recovery="invalid"][data-csv-source-recovery-level="2"]')
        await invalidRecovery.waitFor({ state: 'visible' })
        expect(await invalidRecovery.textContent()).toContain('Source at level 2 is invalid.')
        expect(await retryRestore.count()).toBe(0)
        expect(await unavailableRecovery.count()).toBe(0)
        await nextRow.screenshot({ path: join(evidence, 'csv-active-source-trail-reload-invalid.png') })
        await returnByBreadcrumb(middleRecovery)
        expect(invalidRestorePaging.count()).toBe(0)
        await parent.locator('[data-composer-seat]').screenshot({ path: join(evidence, 'csv-active-source-trail-returned-to-draft.png') })
      } finally {
        invalidRestorePaging.stop()
      }
      acknowledgeReloadConnectionLoss(console, invalidRestoreWarnings)
      const unmodifiedRestoreWarnings = console.warnings.length
      await page.reload()
      await checkNestedDraft()
      await composerSource.waitFor({ state: 'visible' })
      await expect.poll(() => nextToggle.getAttribute('aria-expanded')).toBe('false')
      await expect.poll(() => sourceToggle.getAttribute('aria-expanded')).toBe('false')
      acknowledgeReloadConnectionLoss(console, unmodifiedRestoreWarnings)
      const unavailableBeforePreview = unavailableEarlierPages()

      stage('csv-reload-and-jump-by-source-breadcrumb')
      await openSavedEarliest()
      await reloadAtSource()
      await expectEarliestTrail()
      const earliestTrail = sourceTrail(sourceAttachment)
      const middleStop = sourceTrailStop(earliestTrail, nextRef).getByRole('button')
      await expect.poll(() => middleStop.textContent()).toContain(editedAfterAcceptance.slice(0, 24))
      await expect.poll(() => sourceTrailStop(earliestTrail, reusedFrom).textContent()).toContain(EXPLAIN_COMPARISON_QUESTION.slice(0, 24))
      await earliestTrail.screenshot({ path: join(evidence, 'csv-source-breadcrumb-after-reload.png') })
      await narrowCsvViewport(page)
      await expect.poll(() => earliestTrail.evaluate((nav) => {
        const viewport = nav.ownerDocument.documentElement.clientWidth
        return [nav, ...nav.querySelectorAll('[data-csv-source-trail-stop]')].every((stop) => {
          const rect = stop.getBoundingClientRect()
          return rect.left >= -1 && rect.right <= viewport + 1 && stop.scrollWidth <= stop.clientWidth + 1
        })
      })).toBe(true)
      await expect.poll(async () => {
        const geometry = await earliestTrail.evaluate((nav) => {
          const host = nav.closest('[data-conversation-scroll]')
          const composer = host?.querySelector('[data-composer-seat]')
          if (host === null || composer == null) throw new Error('The chat scrollport is not mounted')
          const viewport = host.getBoundingClientRect()
          const available = composer.getBoundingClientRect().top - viewport.top
          const targets = [...nav.querySelectorAll('button, [aria-current]')]
          const unobscured = targets.length === 3 && targets.every((target) => {
            const bounds = target.getBoundingClientRect()
            const hit = nav.ownerDocument.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
            return hit !== null && target.contains(hit)
          })
          const bounds = nav.getBoundingClientRect()
          const delta = bounds.y + bounds.height / 2 - viewport.y - available / 2
          return { x: viewport.x + viewport.width / 2, y: viewport.y + Math.min(64, available / 2), delta, unobscured }
        })
        if (geometry.unobscured) return true
        // The sticky composer masks part of the scroll element from scrollIntoView.
        await page.mouse.move(geometry.x, geometry.y)
        await page.mouse.wheel(0, geometry.delta)
        return false
      }, { message: 'The CSV breadcrumb stops are unobscured at mobile width' }).toBe(true)
      await earliestTrail.screenshot({ path: join(evidence, 'csv-source-breadcrumb-after-reload-narrow.png') })
      await middleStop.click()
      await expectFocusedNext(true)
      await page.setViewportSize({ width: 1440, height: 960 })
      const middleTrail = sourceTrail(nextAttachment)
      await sourceTrailDraft(middleTrail).waitFor({ state: 'visible' })
      expect(await sourceTrailStop(middleTrail, nextRef).getAttribute('aria-current')).toBe('location')
      expect(await sourceTrailStop(middleTrail, reusedFrom).count()).toBe(0)
      expect(await earliestTrail.count()).toBe(0)
      expect(await middleTrail.locator('[data-csv-source-trail-stop]').count()).toBe(2)
      await checkNestedDraft()
      await nextRow.screenshot({ path: join(evidence, 'csv-source-breadcrumb-jump-to-middle.png') })

      stage('csv-jump-by-source-breadcrumb-directly-to-draft')
      await viewSourceQuestion(nextAttachment).click()
      await expectFocusedSource()
      await expectEarliestTrail()
      await sourceTrailDraft(earliestTrail).focus()
      await page.keyboard.press('Enter')
      await expect.poll(draftCaret).toBe(nestedCaret)
      await checkNestedDraft()
      await earliestTrail.waitFor({ state: 'hidden' })
      expect(await middleTrail.count()).toBe(0)
      await parent.locator('[data-composer-seat]').screenshot({ path: join(evidence, 'csv-source-breadcrumb-jump-to-draft.png') })

      stage('csv-reload-after-breadcrumb-draft-jump')
      const breadcrumbWarnings = console.warnings.length
      await page.reload()
      await checkNestedDraft()
      await composerSource.waitFor({ state: 'visible' })
      await expect.poll(() => sourceToggle.getAttribute('aria-expanded')).toBe('false')
      await expect.poll(() => nextToggle.getAttribute('aria-expanded')).toBe('false')
      expect(await page.locator('[data-csv-source-trail]').count()).toBe(0)
      acknowledgeReloadConnectionLoss(console, breadcrumbWarnings)

      stage('csv-preview-full-source-chain-without-leaving-draft')
      const previewSourceChain = (attachment: Locator) => attachment.getByRole('button', { name: 'View full source chain', exact: true })
        .and(attachment.locator('[data-csv-view-full-source-chain]'))
      const sourceChainDialog = page.getByRole('dialog', { name: 'Source chain', exact: true })
      const sourceChain = sourceChainDialog.locator('[data-csv-full-source-chain]')
      const sourceChainStop = (message: typeof nextRef) => sourceChain.locator(
        `[data-csv-source-chain-stop][data-csv-source-event-seq="${message.eventSeq}"][data-csv-source-message-id="${message.messageId}"]`,
      ).getByRole('button')
      const expectSourceChainPreview = async (): Promise<void> => {
        await sourceChain.waitFor({ state: 'visible' })
        expect(await sourceChain.locator('[data-csv-source-chain-stop]').evaluateAll(stops => stops.map(stop =>
          stop.getAttribute('data-csv-source-message-id')))).toEqual([nextRef.messageId, reusedFrom.messageId])
        expect(await sourceChainStop(nextRef).textContent()).toContain(editedAfterAcceptance.slice(0, 24))
        expect(await sourceChainStop(reusedFrom).textContent()).toContain(EXPLAIN_COMPARISON_QUESTION.slice(0, 24))
      }
      const checkDraftSourceChainPreview = async (): Promise<void> => {
        await expectSourceChainPreview()
        expect(await sourceToggle.getAttribute('aria-expanded')).toBe('false')
        expect(await nextToggle.getAttribute('aria-expanded')).toBe('false')
        expect(await page.locator('[data-csv-source-trail]').count()).toBe(0)
        await checkNestedDraft()
      }
      await placeDraftCaret(nestedCaret)
      await previewSourceChain(draftChip()).click()
      await checkDraftSourceChainPreview()
      await sourceChainDialog.screenshot({ path: join(evidence, 'csv-full-source-chain-preview.png') })
      await page.keyboard.press('Escape')
      await sourceChainDialog.waitFor({ state: 'hidden' })
      await checkNestedDraft()
      expect(await page.locator('[data-csv-source-trail]').count()).toBe(0)

      stage('csv-skip-directly-to-earliest-source-from-preview')
      await previewSourceChain(draftChip()).click()
      await checkDraftSourceChainPreview()
      await sourceChainStop(reusedFrom).click()
      await sourceChainDialog.waitFor({ state: 'hidden' })
      await expectFocusedSource()
      expect(await nextToggle.getAttribute('aria-expanded')).toBe('false')
      await expectEarliestTrail()
      await checkNestedDraft()
      await earliestTrail.screenshot({ path: join(evidence, 'csv-full-chain-direct-jump-to-earliest.png') })

      stage('csv-reload-direct-source-jump-and-return-to-draft')
      await reloadAtSource()
      await expectEarliestTrail()
      await checkNestedDraft()
      expect(await nextToggle.getAttribute('aria-expanded')).toBe('false')
      await earliestTrail.screenshot({ path: join(evidence, 'csv-full-chain-direct-jump-after-reload.png') })
      await sourceTrailDraft(earliestTrail).focus()
      await page.keyboard.press('Enter')
      await expect.poll(draftCaret).toBe(nestedCaret)
      await checkNestedDraft()
      await earliestTrail.waitFor({ state: 'hidden' })
      await parent.locator('[data-composer-seat]').screenshot({ path: join(evidence, 'csv-full-chain-returned-to-draft.png') })
      expect(promptRequests).toHaveLength(1)
      const modelRequestsBeforeHistoricalQuestion = requestCount()
      expect(modelRequestsBeforeHistoricalQuestion).toBe(callsAfterReplay + 1)
      expect(reviewRequests).toHaveLength(2)
      expect(saveRequests).toHaveLength(2)

      stage('csv-send-comparison-for-historical-full-chain')
      const historicalQuestion = 'Using only the attached comparison, name the retained batch in one short sentence.'
      await writeComposerDraft(page, draftInput(), historicalQuestion)
      const [historicalSettled] = await Promise.all([world.whenTurnSettled(), draftInput().press('Enter')])
      expect(historicalSettled).toBe(sessionId)
      expect(promptRequests).toHaveLength(2)
      const modelRequestsAfterHistoricalQuestion = requestCount()
      expect(modelRequestsAfterHistoricalQuestion).toBe(modelRequestsBeforeHistoricalQuestion + 1)
      const afterHistorical = await readPersistedEvents(world, sessionId)
      const historical = afterHistorical.find(event => event.seq > next.seq && event.type === 'user/message' && event.data.source.kind === 'user'
        && event.data.content.some(block => block.type === 'text' && block.text === historicalQuestion))
      if (historical?.type !== 'user/message') throw new Error('The third comparison question was not admitted')
      const historicalBlock = historical.data.content.find(block => block.type === 'text' && block.text !== historicalQuestion)
      if (historicalBlock?.type !== 'text') throw new Error('The third comparison question has no attachment')
      expect(envelope(historicalBlock.text)).toEqual({ kind: 'artifact-question-context', sessionId, facts: objectField(nestedDraft, 'facts') })
      expect(historical.data.content).toEqual([{ type: 'text', text: historicalQuestion }, historicalBlock, changesBlock])
      expectComparisonProviderText(providerUserText(historicalQuestion), historicalQuestion, historicalBlock.text, changesText)
      expect(afterHistorical.filter(event => event.seq > historical.seq && event.type === 'tool/call')).toEqual([])
      await draftChip().waitFor({ state: 'hidden' })
      await expect.poll(() => draftInput().textContent()).toBe('')

      stage('csv-preview-partial-source-chain-from-sent-question')
      const shortenedHistory = await shortenHistory()
      const beforeHistoryPreviewReload = console.warnings.length
      await page.reload()
      await expect.poll(() => draftInput().textContent()).toBe('')
      const unrelatedDraft = 'Compare these numbers later, with separate notes.'
      await writeComposerDraft(page, draftInput(), unrelatedDraft)
      const historicalRef = { eventSeq: historical.seq, messageId: historical.data.id }
      const historicalRow = rowFor(historicalQuestion)
      const historicalReplay = historicalRow.locator('[data-csv-compare-attached]')
      const historicalToggle = historicalReplay.locator('[data-chat-message-control="artifact-csv-comparison"]')
      const historicalComparison = historicalReplay.locator('[data-csv-compare]')
      const expectExactHistoricalComparison = async (): Promise<void> => {
        expect(await historicalRow.getAttribute('data-chat-message-id')).toBe(historicalRef.messageId)
        expect(await historicalRow.getAttribute('data-chat-message-seq')).toBe(String(historicalRef.eventSeq))
        await expectWarmComparisonView(historicalComparison, true)
      }
      const checkUnrelatedDraft = async (): Promise<void> => {
        await expect.poll(() => draftInput().textContent()).toBe(unrelatedDraft)
        expect(await draftChip().count()).toBe(0)
        expect(await readCsvComparisonDraft(world, sessionId)).toBeNull()
        expect(await readPersistedEvents(world, sessionId)).toEqual(afterHistorical)
      }
      await historicalToggle.click()
      await expectExactHistoricalComparison()
      expect(shortenedHistory()).toBe(1)
      expect(await sourceRow.count()).toBe(0)
      const partialNotice = sourceChainDialog.getByRole('status').and(sourceChainDialog.locator('[data-csv-source-chain-status="incomplete"]'))
      const retrySources = sourceChainDialog.getByRole('button', { name: 'Retry', exact: true })
      const expectPartialSourceChain = async (): Promise<void> => {
        await partialNotice.waitFor({ state: 'visible' })
        expect(await partialNotice.textContent()).toBe('Some earlier sources are unavailable.')
        await retrySources.waitFor({ state: 'visible' })
        await sourceChainStop(nextRef).waitFor({ state: 'visible' })
        expect(await sourceChain.locator('[data-csv-source-chain-stop]').count()).toBe(1)
        expect(await sourceChainStop(nextRef).textContent()).toContain(editedAfterAcceptance.slice(0, 24))
        expect(await sourceChainStop(reusedFrom).count()).toBe(0)
        expect(await sourceRow.count()).toBe(0)
        await checkUnrelatedDraft()
      }
      await page.route(pageHistoryPattern, rejectEarlierPage)
      try {
        await previewSourceChain(historicalReplay).click()
        await expectPartialSourceChain()
        expect(unavailableEarlierPages() - unavailableBeforePreview).toBe(1)
        await sourceChainDialog.screenshot({ path: join(evidence, 'csv-history-source-chain-partial.png') })
        await sourceChainStop(nextRef).click()
        await sourceChainDialog.waitFor({ state: 'hidden' })
        await expectFocusedNext()
        expect(await sourceRow.count()).toBe(0)
        await checkUnrelatedDraft()
        const verifiedTrail = sourceTrail(nextAttachment)
        await sourceTrailStop(verifiedTrail, historicalRef).getByRole('button').waitFor({ state: 'visible' })
        expect(await sourceTrailStop(verifiedTrail, nextRef).getAttribute('aria-current')).toBe('location')
        expect(await sourceTrailStop(verifiedTrail, reusedFrom).count()).toBe(0)
        await verifiedTrail.screenshot({ path: join(evidence, 'csv-history-source-chain-partial-jump.png') })
        await sourceTrailStop(verifiedTrail, historicalRef).getByRole('button').click()
        await expectFocusedComparison(historicalToggle)
        await expectExactHistoricalComparison()
        await previewSourceChain(historicalReplay).click()
        await expectPartialSourceChain()
        expect(unavailableEarlierPages() - unavailableBeforePreview).toBe(2)
      } finally {
        await page.unroute(pageHistoryPattern, rejectEarlierPage)
      }
      stage('csv-retry-earlier-source-history-in-place')
      const [backwardPage] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/page'
          && objectField(rpcRequest(response.request()), 'beforeSeq') === nextRef.eventSeq),
        retrySources.click(),
      ])
      expect(objectField(objectField(await backwardPage.json(), 'result'), 'ok')).toBe(true)
      const unavailablePreviewPages = unavailableEarlierPages() - unavailableBeforePreview
      await expectSourceChainPreview()
      await partialNotice.waitFor({ state: 'hidden' })
      expect(await retrySources.count()).toBe(0)
      await checkUnrelatedDraft()
      await sourceChainDialog.screenshot({ path: join(evidence, 'csv-history-source-chain-recovered.png') })
      await page.keyboard.press('Escape')
      await sourceChainDialog.waitFor({ state: 'hidden' })
      acknowledgeReloadConnectionLoss(console, beforeHistoryPreviewReload)

      stage('csv-distinguish-invalid-source-link-from-unavailable-history')
      const invalidHistory = await changeEarlierHistoryLink()
      const invalidWarnings = console.warnings.length
      await page.reload()
      await checkUnrelatedDraft()
      await historicalToggle.click()
      await expectExactHistoricalComparison()
      expect(invalidHistory()).toBe(1)
      await sourceRow.waitFor({ state: 'attached' })
      const invalidPaging = watchEarlierPages()
      try {
        await previewSourceChain(historicalReplay).click()
        const invalidNotice = sourceChainDialog.locator('[data-csv-source-chain-status="invalid"][data-csv-source-chain-level="2"]')
        await invalidNotice.waitFor({ state: 'visible' })
        expect(await invalidNotice.textContent()).toBe('Source at level 2 is invalid.')
        expect(await retrySources.count()).toBe(0)
        expect(await partialNotice.count()).toBe(0)
        await sourceChainStop(nextRef).waitFor({ state: 'visible' })
        expect(await sourceChain.locator('[data-csv-source-chain-stop]').count()).toBe(1)
        expect(await sourceChainStop(reusedFrom).count()).toBe(0)
        await checkUnrelatedDraft()
        await sourceChainDialog.screenshot({ path: join(evidence, 'csv-history-source-chain-invalid-link.png') })
        await sourceChainStop(nextRef).click()
        await sourceChainDialog.waitFor({ state: 'hidden' })
        await expectFocusedNext()
        const verifiedTrail = sourceTrail(nextAttachment)
        await sourceTrailStop(verifiedTrail, historicalRef).getByRole('button').waitFor({ state: 'visible' })
        expect(await sourceTrailStop(verifiedTrail, nextRef).getAttribute('aria-current')).toBe('location')
        expect(await sourceTrailStop(verifiedTrail, reusedFrom).count()).toBe(0)
        expect(invalidPaging.count()).toBe(0)
        await checkUnrelatedDraft()
        await nextRow.screenshot({ path: join(evidence, 'csv-history-source-chain-invalid-link-verified-jump.png') })
        await sourceTrailStop(verifiedTrail, historicalRef).getByRole('button').click()
        await expectFocusedComparison(historicalToggle)
        await expectExactHistoricalComparison()
        await verifiedTrail.waitFor({ state: 'hidden' })
        acknowledgeReloadConnectionLoss(console, invalidWarnings)
      } finally {
        invalidPaging.stop()
      }

      stage('csv-preview-full-source-chain-from-sent-question')
      const restoredHistoryWarnings = console.warnings.length
      await page.reload()
      await checkUnrelatedDraft()
      await historicalToggle.click()
      await expectExactHistoricalComparison()
      expect(await previewSourceChain(sourceAttachment).count()).toBe(0)
      await previewSourceChain(historicalReplay).click()
      await expectSourceChainPreview()
      expect(await nextToggle.getAttribute('aria-expanded')).toBe('false')
      expect(await sourceToggle.getAttribute('aria-expanded')).toBe('false')
      expect(await page.locator('[data-csv-source-trail]').count()).toBe(0)
      await checkUnrelatedDraft()
      await sourceChainDialog.screenshot({ path: join(evidence, 'csv-history-full-source-chain-preview.png') })
      await page.keyboard.press('Escape')
      await sourceChainDialog.waitFor({ state: 'hidden' })
      await checkUnrelatedDraft()
      await expectExactHistoricalComparison()
      acknowledgeReloadConnectionLoss(console, restoredHistoryWarnings)

      stage('csv-jump-from-sent-question-directly-to-earliest')
      const historyOriginStop = sourceTrailStop(earliestTrail, historicalRef).getByRole('button')
      const expectHistoryTrail = async (fromDraft: boolean): Promise<void> => {
        await historyOriginStop.waitFor({ state: 'visible' })
        await sourceTrailStop(earliestTrail, nextRef).getByRole('button').waitFor({ state: 'visible' })
        expect(await sourceTrailStop(earliestTrail, reusedFrom).getAttribute('aria-current')).toBe('location')
        const historyIds = [historicalRef.messageId, nextRef.messageId, reusedFrom.messageId]
        expect(await earliestTrail.locator('[data-csv-source-trail-stop]').evaluateAll(stops => stops.map(stop =>
          stop.getAttribute('data-csv-source-message-id')))).toEqual(fromDraft ? [null, ...historyIds] : historyIds)
      }
      await previewSourceChain(historicalReplay).click()
      await expectSourceChainPreview()
      await sourceChainStop(reusedFrom).click()
      await sourceChainDialog.waitFor({ state: 'hidden' })
      await expectFocusedSource()
      expect(await nextToggle.getAttribute('aria-expanded')).toBe('false')
      await expectHistoryTrail(false)
      await checkUnrelatedDraft()
      await reloadAtSource()
      await expectHistoryTrail(false)
      await checkUnrelatedDraft()
      await earliestTrail.screenshot({ path: join(evidence, 'csv-history-full-chain-earliest-after-reload.png') })
      await historyOriginStop.focus()
      await page.keyboard.press('Enter')
      await expectFocusedComparison(historicalToggle)
      await expectExactHistoricalComparison()
      await earliestTrail.waitFor({ state: 'hidden' })
      await checkUnrelatedDraft()
      await historicalRow.screenshot({ path: join(evidence, 'csv-history-full-chain-returned-to-origin.png') })

      stage('csv-extend-active-draft-route-from-sent-preview')
      await historicalReplay.getByRole('button', { name: 'Reuse comparison in next question', exact: true }).click()
      const deepestReview = historicalReplay.getByRole('region', { name: 'Review comparison to attach', exact: true })
      await expectWarmComparisonView(deepestReview, true)
      const [deepestReviewResponse, deepestSaveResponse] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/artifactBranchResults/reviewSentCsvComparison'),
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/artifactBranchResults/saveCsvComparisonDraft'),
        deepestReview.getByRole('button', { name: 'Attach comparison', exact: true }).click(),
      ])
      expect(rpcRequest(deepestReviewResponse.request())).toEqual({ sessionId, ...historicalRef })
      const deepestSave = objectField(await deepestSaveResponse.json(), 'result')
      expect(objectField(deepestSave, 'ok')).toBe(true)
      const deepestDraft = objectField(deepestSave, 'value')
      expect(objectField(deepestDraft, 'facts')).toEqual({ ...reusedFacts, reusedFrom: historicalRef })
      const historyCaret = unrelatedDraft.length - caretFromEnd
      await composerSource.waitFor({ state: 'visible' })
      await placeDraftCaret(historyCaret)
      await composerSource.click()
      await expectFocusedComparison(historicalToggle)
      await sourceTrailDraft(sourceTrail(historicalReplay)).waitFor({ state: 'visible' })
      await previewSourceChain(historicalReplay).click()
      await expectSourceChainPreview()
      await sourceChainStop(reusedFrom).click()
      await sourceChainDialog.waitFor({ state: 'hidden' })
      await expectFocusedSource()
      await expectHistoryTrail(true)
      await earliestTrail.screenshot({ path: join(evidence, 'csv-history-full-chain-extended-draft-route.png') })

      stage('csv-reload-old-source-path-before-switching-to-new-path')
      const shortenedSwitchHistory = await shortenHistory()
      const beforeSwitchWarnings = console.warnings.length
      const beforeSwitchFailures = unavailableEarlierPages()
      await page.route(pageHistoryPattern, rejectEarlierPage)
      try {
        await page.reload()
        await expectFocusedNext()
        await retryRestore.waitFor({ state: 'visible' })
        await sourceTrailStop(middleRecovery, historicalRef).getByRole('button').waitFor({ state: 'visible' })
        expect(await sourceTrailStop(middleRecovery, nextRef).getAttribute('aria-current')).toBe('location')
        expect(shortenedSwitchHistory()).toBe(1)
        expect(unavailableEarlierPages()).toBe(beforeSwitchFailures + 1)
        expect(await sourceRow.count()).toBe(0)
      } finally {
        await page.unroute(pageHistoryPattern, rejectEarlierPage)
      }
      const historyTrail = sourceTrail(historicalReplay)
      const expectNewSourcePath = async (): Promise<void> => {
        await expectFocusedComparison(historicalToggle)
        await expectExactHistoricalComparison()
        await sourceTrailDraft(historyTrail).waitFor({ state: 'visible' })
        expect(await sourceTrailStop(historyTrail, historicalRef).getAttribute('aria-current')).toBe('location')
        expect(await historyTrail.locator('[data-csv-source-trail-stop]').evaluateAll(stops => stops.map(stop =>
          stop.getAttribute('data-csv-source-message-id')))).toEqual([null, historicalRef.messageId])
        expect(await middleRecovery.count()).toBe(0)
        expect(await earliestTrail.count()).toBe(0)
        await expect.poll(() => draftInput().textContent()).toBe(unrelatedDraft)
        expect(await readCsvComparisonDraft(world, sessionId)).toEqual(deepestDraft)
        expect(await readPersistedEvents(world, sessionId)).toEqual(afterHistorical)
      }
      const newPathRetry = await holdEarlierPage()
      try {
        stage('csv-open-different-source-path-while-earlier-retry-pending')
        await retryRestore.click()
        await newPathRetry.waitForResponse()
        expect(await sourceRow.count()).toBe(0)
        await nextRow.screenshot({ path: join(evidence, 'csv-source-switch-old-retry-pending.png') })
        await placeDraftCaret(historyCaret)
        await composerSource.click()
        await expectNewSourcePath()
        await unavailableRecovery.waitFor({ state: 'hidden' })

        stage('csv-keep-new-source-path-when-old-retry-arrives')
        await newPathRetry.deliver()
        await sourceRow.waitFor({ state: 'attached' })
        expect(await sourceToggle.getAttribute('aria-expanded')).toBe('false')
        await expectNewSourcePath()
        expect(newPathRetry.count()).toBe(1)
        await historicalRow.screenshot({ path: join(evidence, 'csv-source-switch-kept-new-path-after-late-retry.png') })
      } finally {
        await newPathRetry.close()
      }
      acknowledgeReloadConnectionLoss(console, beforeSwitchWarnings)
      stage('csv-reload-only-the-new-source-path')
      const newPathWarnings = console.warnings.length
      await page.reload()
      await expectNewSourcePath()
      expect(await nextToggle.getAttribute('aria-expanded')).toBe('false')
      expect(await sourceToggle.getAttribute('aria-expanded')).toBe('false')
      await historicalRow.screenshot({ path: join(evidence, 'csv-source-switch-only-new-path-after-reload.png') })
      acknowledgeReloadConnectionLoss(console, newPathWarnings)

      await sourceTrailDraft(historyTrail).click()
      await expect.poll(draftCaret).toBe(historyCaret)
      await expect.poll(() => draftInput().textContent()).toBe(unrelatedDraft)
      expect(await readCsvComparisonDraft(world, sessionId)).toEqual(deepestDraft)
      expect(await readPersistedEvents(world, sessionId)).toEqual(afterHistorical)

      stage('csv-prepare-independent-session-with-frozen-source-history')
      const originSession = world.ctx.agents.get(sessionId)?.session
      const finalRecordedTurn = afterHistorical.findLast(event => event.type === 'turn/end')
      if (originSession === undefined || finalRecordedTurn === undefined) throw new Error('The real source comparison recording ended without a turn')
      const otherId = randomUUID()
      const otherMiddle = { ...nextRef, messageId: MessageId(randomUUID()) }
      const otherEarliest = { ...reusedFrom, messageId: MessageId(randomUUID()) }
      const otherOrigin = { ...historicalRef, messageId: MessageId(randomUUID()) }
      const otherMiddleTitle = 'In the other session, explain the sample counts in this comparison.'
      const otherOriginTitle = 'In the other session, identify the batch retained by the attached comparison.'
      const otherEarliestTitle = 'In the other session, explain the original mean and the filtered comparison.'
      // Keep the authenticated live-recorded evidence and event order, and give the second Session its own message addresses.
      const otherRecording = rawSessionLog(originSession).split('\n').slice(0, finalRecordedTurn.seq + 2).join('\n')
        .replaceAll(sessionId, otherId)
        .replaceAll(nextRef.messageId, otherMiddle.messageId)
        .replaceAll(reusedFrom.messageId, otherEarliest.messageId)
        .replaceAll(historicalRef.messageId, otherOrigin.messageId)
        .replaceAll(editedAfterAcceptance, otherMiddleTitle)
        .replaceAll(historicalQuestion, otherOriginTitle)
        .replaceAll(EXPLAIN_COMPARISON_QUESTION, otherEarliestTitle)
      const otherSession = await seedSession(world, otherRecording, otherId, 'chat')
      const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
      await workspace.attachSession(otherSession)
      const sessionRow = (target: SessionId) => page.locator(`[data-row-key="session:${target}"]`)
      const otherConversation = page.locator(`[data-conversation-session="${otherSession}"]`)
      const otherRow = (target: typeof otherOrigin) => otherConversation.locator(
        `[data-chat-message-id="${target.messageId}"][data-chat-message-seq="${target.eventSeq}"]`,
      )
      const otherOriginReplay = otherRow(otherOrigin).locator('[data-csv-compare-attached]')
      const otherSourceReplay = otherRow(otherMiddle).locator('[data-csv-compare-attached]')
      const otherSourceToggle = otherSourceReplay.locator('[data-chat-message-control="artifact-csv-comparison"]')
      const otherTrail = sourceTrail(otherSourceReplay)
      const openDraftHistoryChain = async (): Promise<void> => {
        await composerSource.click()
        await expectNewSourcePath()
        await previewSourceChain(historicalReplay).click()
        await expectSourceChainPreview()
        await sourceChainStop(reusedFrom).click()
        await sourceChainDialog.waitFor({ state: 'hidden' })
        await expectFocusedSource()
        await expectHistoryTrail(true)
      }
      const catalogWarnings = console.warnings.length
      await page.reload()
      const otherWorkspaceRow = page.locator(`[data-row-key="workspace:${workspace.id}"]`)
      await otherWorkspaceRow.waitFor({ state: 'visible' })
      if (await otherWorkspaceRow.getAttribute('aria-expanded') !== 'true') await otherWorkspaceRow.click()
      await sessionRow(otherSession).click()
      await otherRow(otherOrigin).getByText(otherOriginTitle, { exact: true }).waitFor({ state: 'visible' })
      const otherHistory = await readPersistedEvents(world, otherSession)
      await sessionRow(sessionId).click()
      await composerSource.waitFor({ state: 'visible' })
      acknowledgeReloadConnectionLoss(console, catalogWarnings)
      await openDraftHistoryChain()

      stage('csv-hold-old-session-retry-before-switching-sessions')
      const shortenedCrossSessionHistory = await shortenHistory()
      const crossSessionWarnings = console.warnings.length
      const beforeCrossSessionFailures = unavailableEarlierPages()
      await page.route(pageHistoryPattern, rejectEarlierPage)
      try {
        await page.reload()
        await expectFocusedNext()
        await retryRestore.waitFor({ state: 'visible' })
        expect(shortenedCrossSessionHistory()).toBe(1)
        expect(unavailableEarlierPages()).toBe(beforeCrossSessionFailures + 1)
        expect(await sourceRow.count()).toBe(0)
      } finally {
        await page.unroute(pageHistoryPattern, rejectEarlierPage)
      }
      const expectOtherSessionSource = async (): Promise<void> => {
        await expect.poll(() => sessionRow(otherSession).getAttribute('aria-selected')).toBe('true')
        await parent.waitFor({ state: 'hidden' })
        await expectFocusedComparison(otherSourceToggle)
        await expectWarmComparisonView(otherSourceReplay.locator('[data-csv-compare]'), true)
        expect(await sourceTrailStop(otherTrail, otherMiddle).getAttribute('aria-current')).toBe('location')
        expect(await otherTrail.locator('[data-csv-source-trail-stop]').evaluateAll(stops => stops.map(stop =>
          stop.getAttribute('data-csv-source-message-id')))).toEqual([otherOrigin.messageId, otherMiddle.messageId])
        expect(await otherRow(otherEarliest).locator('[data-chat-message-control="artifact-csv-comparison"]').getAttribute('aria-expanded'))
          .toBe('false')
        expect(await readCsvComparisonDraft(world, sessionId)).toEqual(deepestDraft)
        expect(await readPersistedEvents(world, sessionId)).toEqual(afterHistorical)
        expect(await readPersistedEvents(world, otherSession)).toEqual(otherHistory)
      }
      const openOtherComparison = async (): Promise<void> => {
        const toggle = otherOriginReplay.locator('[data-chat-message-control="artifact-csv-comparison"]')
        if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
        await viewSourceQuestion(otherOriginReplay).click()
        await expectOtherSessionSource()
      }
      const crossSessionRetry = await holdEarlierPage()
      try {
        await retryRestore.click()
        await crossSessionRetry.waitForResponse()
        await nextRow.screenshot({ path: join(evidence, 'csv-cross-session-old-retry-pending.png') })

        stage('csv-switch-session-and-open-its-own-comparison')
        await sessionRow(otherSession).click()
        await openOtherComparison()

        stage('csv-keep-new-session-when-old-history-response-arrives')
        await crossSessionRetry.deliver()
        await expectOtherSessionSource()
        expect(crossSessionRetry.count()).toBe(1)
        await otherRow(otherMiddle).screenshot({ path: join(evidence, 'csv-cross-session-source-after-old-response.png') })
      } finally {
        await crossSessionRetry.close()
      }
      acknowledgeReloadConnectionLoss(console, crossSessionWarnings)

      stage('csv-reload-only-the-new-session-source')
      const crossSessionReloadWarnings = console.warnings.length
      await page.reload()
      await expectOtherSessionSource()
      expect(await page.locator('[data-csv-source-trail]:visible').count()).toBe(1)
      await otherRow(otherMiddle).screenshot({ path: join(evidence, 'csv-cross-session-source-after-reload.png') })
      acknowledgeReloadConnectionLoss(console, crossSessionReloadWarnings)

      stage('csv-retain-first-session-in-right-sidebar-before-rapid-roundtrip')
      await sessionRow(sessionId).click()
      await composerSource.waitFor({ state: 'visible' })
      await openDraftHistoryChain()
      const reloadDegradedHistory = async (): Promise<void> => {
        const shortened = await shortenHistory()
        const warnings = console.warnings.length
        const beforeFailures = unavailableEarlierPages()
        await page.route(pageHistoryPattern, rejectEarlierPage)
        try {
          await page.reload()
          await expectFocusedNext()
          await retryRestore.waitFor({ state: 'visible' })
          expect(shortened()).toBe(1)
          expect(unavailableEarlierPages()).toBe(beforeFailures + 1)
          expect(await sourceRow.count()).toBe(0)
        } finally {
          await page.unroute(pageHistoryPattern, rejectEarlierPage)
        }
        acknowledgeReloadConnectionLoss(console, warnings)
      }
      await reloadDegradedHistory()
      const retainedSidebar = page.locator(`[data-sidebar-right-session="${sessionId}"]:not([data-sidebar-right-session] [data-sidebar-right-session])`)
      await page.locator('[data-sidebar-right-expand]').click()
      await retainedSidebar.locator('[data-sidebar-right-guide-entry="fixture-retained-sidebar"]').click()
      const retainedBody = retainedSidebar.locator('[data-fixture-retained-sidebar]')
      const checkRetainedBody = async <T>(visit: (expectSameSidebar: () => Promise<void>) => Promise<T>): Promise<T> => {
        await retainedBody.waitFor({ state: 'visible' })
        const sameSidebarBody = await retainedBody.elementHandle()
        if (sameSidebarBody === null) throw new Error('The retained sidebar body was not mounted')
        const expectSameSidebar = async (): Promise<void> => {
          expect(await retainedBody.evaluate((current, previous) => current === previous, sameSidebarBody)).toBe(true)
        }
        try { return await visit(expectSameSidebar) } finally { await sameSidebarBody.dispose() }
      }
      const switchToOtherWhileRetained = async (expectSameSidebar: () => Promise<void>): Promise<void> => {
        await sessionRow(otherSession).click()
        await otherRow(otherOrigin).getByText(otherOriginTitle, { exact: true }).waitFor({ state: 'visible' })
        await parent.waitFor({ state: 'hidden' })
        await retainedSidebar.waitFor({ state: 'attached' })
        expect(await retainedSidebar.getAttribute('hidden')).not.toBeNull()
        await expectSameSidebar()
      }
      const returnToRetainedFallback = async (expectSameSidebar: () => Promise<void>): Promise<void> => {
        await sessionRow(sessionId).click()
        await parent.waitFor({ state: 'visible' })
        await expectSameSidebar()
        expect(await sourceRow.count()).toBe(0)
        if (await nextToggle.getAttribute('aria-expanded') === 'false') await nextToggle.click()
        await retryRestore.waitFor({ state: 'visible' })
        expect(await retryRestore.getAttribute('aria-disabled')).toBe('false')
        await nextToggle.focus()
        await expectFocusedNext()
      }
      const switchAwayAndReturn = async (): Promise<void> => {
        await checkRetainedBody(async (expectSameSidebar) => {
          await switchToOtherWhileRetained(expectSameSidebar)
          await returnToRetainedFallback(expectSameSidebar)
        })
      }
      const roundtripRetry = await holdEarlierPage()
      try {
        await retryRestore.click()
        await roundtripRetry.waitForResponse()
        expect(await sourceRow.count()).toBe(0)
        expect(await retryRestore.getAttribute('aria-disabled')).toBe('true')
        await page.screenshot({ path: join(evidence, 'csv-retained-session-roundtrip-retry-pending.png') })

        stage('csv-switch-away-and-back-with-original-sidebar-binding')
        await switchAwayAndReturn()

        stage('csv-deliver-old-history-after-return-to-retained-session')
        await deliverEarlierPage(roundtripRetry, nextRef.eventSeq)
        await sourceRow.waitFor({ state: 'attached' })
        expect(await sourceToggle.getAttribute('aria-expanded')).toBe('false')
        await expectFocusedNext()
        expect(await sourceTrailStop(middleRecovery, nextRef).getAttribute('aria-current')).toBe('location')
        expect(await earliestTrail.count()).toBe(0)
        expect(await retryRestore.getAttribute('aria-disabled')).toBe('false')
        expect(roundtripRetry.count()).toBe(1)
        await page.screenshot({ path: join(evidence, 'csv-retained-session-roundtrip-late-page-kept-fallback.png') })
      } finally {
        await roundtripRetry.close()
      }

      stage('csv-explicitly-retry-after-return-to-retained-session')
      await retryRestore.click()
      await expectFocusedSource()
      await expectHistoryTrail(true)
      expect(await unavailableRecovery.count()).toBe(0)
      await reloadAtSource()
      await expectHistoryTrail(true)
      expect(await page.locator('[data-csv-source-trail]:visible').count()).toBe(1)
      await expect.poll(() => draftInput().textContent()).toBe(unrelatedDraft)
      expect(await readCsvComparisonDraft(world, sessionId)).toEqual(deepestDraft)
      expect(await readPersistedEvents(world, sessionId)).toEqual(afterHistorical)
      expect(await readPersistedEvents(world, otherSession)).toEqual(otherHistory)
      await page.screenshot({ path: join(evidence, 'csv-retained-session-roundtrip-fresh-retry-restored-after-reload.png') })

      const { firstOverlap, retainedRetryScenarios } = await runRetainedCsvRetryScenarios({
        page, retainedSessionId: sessionId, otherSessionId: otherSession, fallback: nextRef, retainedTarget: reusedFrom,
        otherOrigin, otherTarget: otherMiddle, roundTrips: 8, stage, evidence,
        openRetainedSource: async () => {
          if (!await earliestTrail.isVisible()) await openDraftHistoryChain()
        },
        readTraffic: () => [promptRequests.length, requestCount(), originalReads, lookupRequests.length],
        reloadAndCheck: async (check) => {
          const warnings = console.warnings.length
          await page.reload()
          await check()
          acknowledgeReloadConnectionLoss(console, warnings)
        },
        assertPath: async (path) => {
          if (path === 'fallback') await expectFocusedNext()
          else if (path === 'retained') {
            await expectFocusedSource()
            await expectHistoryTrail(true)
            await expect.poll(() => draftInput().textContent()).toBe(unrelatedDraft)
          } else await expectOtherSessionSource()
        },
        assertUnchanged: async () => {
          expect(await readCsvComparisonDraft(world, sessionId)).toEqual(deepestDraft)
          expect(await readPersistedEvents(world, sessionId)).toEqual(afterHistorical)
          expect(await readPersistedEvents(world, otherSession)).toEqual(otherHistory)
        },
      })
      expect(promptRequests).toHaveLength(2)
      expect(requestCount()).toBe(modelRequestsAfterHistoricalQuestion)
      expect(reviewRequests).toHaveLength(3)
      expect(saveRequests).toHaveLength(3)
      expect(lookupRequests).toEqual([])
      expect(originalReads).toBe(0)
      expect(console.warnings).toEqual([])
      expect(console.pageErrors).toEqual([])
      await writeFile(join(evidence, 'csv-historical-comparison-reuse.json'), JSON.stringify({ facts: reusedFacts,
        reviewRequests: reviewRequests.length, saveRequests: saveRequests.length, promptRequests: promptRequests.length,
        lookupRequests, originalReads,
        modelRequestsBeforeReuse: callsAfterReplay, modelRequestsAfterNextQuestion: modelRequestsBeforeHistoricalQuestion,
        modelRequestsAfterHistoricalQuestion, restoredDraftAfterRefresh: true,
        cancelPreservedDraft: true, composerSourceAfterRefresh: true, sentSourceAfterRefresh: true,
        sourceReloadFromDraft: true, sourceReloadFromSent: true, consumedVisitsStayClosedAfterReload: true,
        multilevelSourceReload: { middle: nextRef, earliest: reusedFrom, draftCaret: nestedCaret,
          partialReturnRestoredAfterReload: true, consumedAfterReload: true },
        breadcrumb: { restoredAfterReload: true, exactMiddleExpanded: true, truncatedAtMiddle: true,
          directDraftJumpCaret: nestedCaret, sameReceipt: true, clearedAfterReload: true },
        fullSourceChain: { order: [nextRef, reusedFrom], previewStayedInDraft: true, directJumpSkippedMiddle: true,
          directJumpRestoredAfterReload: true, draftCaret: nestedCaret, sameReceipt: true },
        historicalFullSourceChain: { origin: historicalRef, order: [nextRef, reusedFrom], unmodifiedPreview: true,
          directJumpRestoredAfterReload: true, exactOriginRestored: true, draftPrefixPreserved: true, draftCaret: historyCaret },
        partialSourceChain: { verified: nextRef, recovered: reusedFrom, unavailableEarlierPages: unavailablePreviewPages,
          verifiedQuestionWasUsable: true, retryRecoveredInPlace: true },
        invalidSourceChain: { verified: nextRef, invalidLevel: 2, retryOffered: false, invalidOlderPageRequests: invalidPaging.count(),
          verifiedQuestionWasUsable: true, fullChainRestoredAfterReload: true },
        activeSourceTrailRecovery: { fallback: nextRef, earliest: reusedFrom, unavailableRestorePages,
          retryRestoredEarliest: true, invalidLevel: 2, invalidOlderPageRequests: invalidRestorePaging.count(),
          invalidRetryOffered: false, draftCaret: nestedCaret, sameReceipt: true },
        lateSourceTrailRetry: { delayedOlderPageRequests: draftReturnRetry.count(), responseAppliedWithoutNavigation: true,
          draftCaret: nestedCaret, sameReceipt: true, noRouteAfterReload: true },
        lateRetryWithNewSourcePath: { oldFallback: nextRef, newSource: historicalRef,
          delayedOlderPageRequests: newPathRetry.count(), newFocusPreserved: true, onlyNewRouteAfterReload: true,
          draftCaret: historyCaret, sameReceipt: true },
        lateRetryAfterSessionSwitch: { oldSession: sessionId, newSession: otherSession, oldFallback: nextRef,
          newSource: otherMiddle, newOrigin: otherOrigin, delayedOlderPageRequests: crossSessionRetry.count(),
          newFocusPreserved: true, onlyNewRouteAfterReload: true, oldDraftReceiptPreserved: true },
        lateRetryAfterRetainedSessionRoundtrip: { retainedSession: sessionId, visitedSession: otherSession, fallback: nextRef,
          expectedTarget: reusedFrom, delayedOlderPageRequests: roundtripRetry.count(), browserResponseFinished: true,
          sameSidebarBodyKept: true, staleFocusRetained: true, deliberateRetryRestoredTarget: true, pathRestoredAfterReload: true },
        overlappingRetryAfterRetainedRoundtrip: { ...firstOverlap, fallback: nextRef, expectedTarget: reusedFrom,
          joinedInFlightHistoryLoad: true,
          freshPendingAfterFirstPage: true, fallbackFocusPreserved: true, freshRetryRestoredTarget: true, pathRestoredAfterReload: true,
          promptRequests: 0, modelRequests: 0, originalReads: 0, csvLookups: 0 },
        retainedRetryScenarios,
        sourceReturnToDraftCaret: expectedCaret, sourceReturnToComparison: true, historyDraftPreserved: true, nextAnswer: nextText,
      }, null, 2) + '\n', 'utf8')
    } finally { page.off('request', watchReuse) }
  } finally { store.readFileStream = originalRead }
}

/** Compare an adopted CSV reading with a host-calculated result and attach that result in the parent conversation. */
export async function exerciseContinuedCsvJourney(live: CsvLiveBrowser, filtered = false): Promise<void> {
  const { page, world, evidence, stage, ask, console, providerSaw, providerUserText, requestCount } = live
  const parentQuestion = filtered ? FILTER_READING_QUESTION : MAIN_READING_QUESTION
  const csv = filtered ? FILTER_CSV : CSV
  const totals = filtered ? FILTERED_TOTALS : TOTALS
  const warm = totals[1]
  const cold = totals[2]
  const branch = await createCsvBranch(live, BRANCH_READING_QUESTION, csv)
  const { parentId, childId, parent, attachmentId, chart, chartSpec, userAgent } = branch
  const { returned, adopted, parentEvents, callsBeforeReturn } = await adoptCsvReading(live, branch)
  expect(branch.branchEvents.filter(event => event.type === 'artifact/upsert' && event.seq > branch.questionSeq)).toEqual([])
  const parentUploads = parentEvents.flatMap(event => event.type === 'user/message' ? event.data.content.filter(block => block.type === 'file') : [])
  expect(parentUploads).toEqual([])
  expect(requestCount()).toBe(callsBeforeReturn)

  stage('csv-continue-compare-and-lock')
  const continueAnalysis = returned.locator('[data-csv-continue-analysis]')
  await continueAnalysis.click()
  const analysis = returned.locator('[data-csv-analysis]')
  const aggregate = analysis.locator('[data-csv-analysis-aggregate]')
  const original = analysis.locator('[data-csv-analysis-original]')
  const current = analysis.locator('[data-csv-analysis-current]')
  await expectCsvReading(original, 'Warm', /mean/iu, '30')
  await aggregate.selectOption('sum')
  await expectCsvReading(current, 'Warm', /sum/iu, '60')
  await expectCsvReading(original, 'Warm', /mean/iu, '30')
  expect(requestCount()).toBe(callsBeforeReturn)
  expect(await readPersistedEvents(world, parentId)).toEqual(parentEvents)
  await analysis.screenshot({ path: join(evidence, 'csv-mean-and-sum.png') })

  if (filtered) {
    stage('csv-filter-and-inspect-participating-rows')
    await applyBatchFilter(analysis)
    await expectCsvReading(current, 'Warm', /sum/iu, '35', '1')
    await expectCsvReading(original, 'Warm', /sum/iu, '60')
    await expectCsvFilter(current)
    await analysis.locator('[data-csv-participating-rows-open]').click()
    await expectWarmParticipatingRows(analysis, true)
    await analysis.screenshot({ path: join(evidence, 'csv-filtered-participating-row.png') })
    expect(requestCount()).toBe(callsBeforeReturn)
    expect(await readPersistedEvents(world, parentId)).toEqual(parentEvents)
  }
  await analysis.getByRole('button', { name: 'Use for next question', exact: true }).click()
  const review = analysis.getByRole('region', { name: 'Review CSV reading', exact: true })
  await expectCsvReading(review, 'Warm', /sum/iu, String(warm.value), String(warm.count))
  if (filtered) await expectCsvFilter(review)
  await review.getByRole('button', { name: 'Attach readings', exact: true }).click()
  const chip = parent.locator('[data-artifact-prompt-context="current-csv-bar-chart"]')
  await chip.waitFor({ state: 'visible' })
  if (filtered) {
    await analysis.locator('[data-csv-filter-clear]').click()
    await expectCsvReading(current, 'Warm', /sum/iu, '60')
    await expectCsvReading(chip, 'Warm', /sum/iu, '35', '1')
    await expectCsvFilter(chip)
    await applyBatchFilter(analysis)
    await expectCsvReading(current, 'Warm', /sum/iu, '35', '1')
  }
  await analysis.locator('[data-csv-group-key="Cold"]').click()
  await expectCsvReading(original, 'Cold', filtered ? /sum/iu : /mean/iu, filtered ? '100' : '50')
  await expectCsvReading(current, 'Cold', /sum/iu, String(cold.value), String(cold.count))
  await expectCsvReading(chip, 'Warm', /sum/iu, String(warm.value), String(warm.count))
  if (filtered) await expectCsvFilter(chip)
  await analysis.screenshot({ path: join(evidence, 'csv-live-cold-after-lock.png') })
  await chip.screenshot({ path: join(evidence, 'csv-locked-warm-composer.png') })
  const callsBeforeAsk = requestCount()
  expect(callsBeforeAsk).toBe(callsBeforeReturn)
  const beforeSend = await readPersistedEvents(world, parentId)
  expect(beforeSend.filter(event => event.type === 'turn/start')).toEqual(parentEvents.filter(event => event.type === 'turn/start'))
  expect(beforeSend.filter(event => event.type === 'tool/call')).toEqual([])
  const materialized = beforeSend.findLast(event => event.type === 'artifact/upsert')
  if (materialized?.type !== 'artifact/upsert') throw new Error('The confirmed analysis has no durable parent-local chart')
  const lockedArtifact = materialized.data
  expect(lockedArtifact.artifactId).not.toBe(chart.artifactId)
  expect(lockedArtifact).toMatchObject({ format: 'scene', spec: { ...chartSpec, aggregate: 'sum', groups: totals,
    rowCount: filtered ? 3 : 6, ...(filtered ? { filter: BATCH_FILTER } : {}) } })
  expect(lockedArtifact).toMatchObject({ csvContinuation: { groupKey: 'Warm', source: {
    sessionId: parentId, eventSeq: adopted.seq, messageId: adopted.data.id, artifactId: chart.artifactId, revision: chart.revision,
  } } })
  expect(await parent.getByRole('complementary', { name: `Artifact: ${lockedArtifact.title}`, exact: true }).count()).toBe(0)
  expect(await readPersistedEvents(world, childId)).toEqual(branch.branchEvents)

  stage('csv-parent-provider-uses-locked-sum')
  await ask(parentQuestion, parentId)
  const afterSend = await readPersistedEvents(world, parentId)
  const question = afterSend.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (question?.type !== 'user/message') throw new Error('The continued analysis follow-up was not stored')
  const attachment = question.data.content.find(block => block.type === 'text' && block.text !== parentQuestion)
  if (attachment?.type !== 'text') throw new Error('The model did not receive a confirmed CSV reading')
  expect(attachment.text).toContain('This is the newly confirmed CSV calculation for the current question.')
  const newReading = { kind: 'current-csv-bar-chart', artifact: lockedArtifact,
    groupKey: 'Warm', values: warm }
  expect(envelope(attachment.text)).toMatchObject({ kind: 'artifact-question-context', sessionId: parentId, facts: newReading })
  expect(providerSaw(parentQuestion, attachment.text)).toBe(true)
  const providerText = providerUserText(parentQuestion)
  expect(providerText).toContain(attachment.text)
  expect(providerText.every(block => !block.includes(csv) && !block.includes('read-only copy saved at'))).toBe(true)
  expect(afterSend.find(event => event.seq === adopted.seq)).toEqual(adopted)
  expect(afterSend.filter(event => event.type === 'tool/call')).toEqual([])
  const response = afterSend.findLast(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text'))
  if (response?.type !== 'assistant/message') throw new Error('The model did not answer the continued CSV question')
  const answer = response.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  expect(answer).toMatch(/\bWarm\b/iu)
  expect(answer).toMatch(/\b(?:sum(?:med)?|total(?:led|ed)?)\b/iu)
  expect(answer).toMatch(filtered ? /\b35(?:\.0+)?\b/u : /\b60(?:\.0+)?\b/u)
  expect(answer).toMatch(filtered ? /\b(?:1|one)\b/iu : /\b(?:2|two)\b/iu)
  if (filtered) expect(answer).toMatch(/\bBatch\b[^.\n]{0,30}\bB\b/iu)

  stage('csv-parent-refresh-replays-both')
  const callsBeforeRefresh = requestCount()
  const warningStart = console.warnings.length
  await page.reload()
  await returned.waitFor({ state: 'visible' })
  acknowledgeReloadConnectionLoss(console, warningStart)
  const questionRow = parent.locator('[data-chat-flow-kind="user"]:visible').filter({ hasText: parentQuestion })
  await returned.getByRole('button', { name: 'Replay experiment', exact: true }).click()
  const originalReplay = returned.locator(`[data-artifact-question-replay-id="${chart.artifactId}"]`)
  await expectCsvReading(originalReplay, 'Warm', /mean/iu, '30')
  expect(await originalReplay.getAttribute('data-artifact-question-replay-revision')).toBe(String(chart.revision))
  await originalReplay.screenshot({ path: join(evidence, 'csv-original-after-refresh.png') })
  await questionRow.getByRole('button', { name: 'Replay experiment', exact: true }).click()
  const lockedReplay = questionRow.locator(`[data-artifact-question-replay-id="${lockedArtifact.artifactId}"]`)
  await expectCsvReading(lockedReplay, 'Warm', /sum/iu, String(warm.value), String(warm.count))
  expect(await lockedReplay.getAttribute('data-artifact-question-replay-revision')).toBe(String(lockedArtifact.revision))
  if (filtered) await expectCsvFilter(lockedReplay)
  await lockedReplay.screenshot({ path: join(evidence, 'csv-locked-sum-after-refresh.png') })
  let replayedOriginalRows: Awaited<ReturnType<typeof expectWarmParticipatingRows>> | undefined
  let replayedLockedRows: Awaited<ReturnType<typeof expectWarmParticipatingRows>> | undefined
  if (filtered) {
    stage('csv-replay-original-participating-rows')
    const beforeOriginalRows = await readPersistedEvents(world, parentId)
    await openCsvReplayRows(page, originalReplay, 'csvReturnedParticipatingRows', {
      sessionId: parentId, eventSeq: adopted.seq, messageId: adopted.data.id,
    })
    replayedOriginalRows = await expectWarmParticipatingRows(originalReplay, false)
    await expectCsvReading(originalReplay, 'Warm', /mean/iu, '30')
    expect(await originalReplay.locator('[data-csv-reading="filter"]').count()).toBe(0)
    expect(requestCount()).toBe(callsBeforeRefresh)
    expect(await readPersistedEvents(world, parentId)).toEqual(beforeOriginalRows)
    expect(await readPersistedEvents(world, childId)).toEqual(branch.branchEvents)
    await originalReplay.screenshot({ path: join(evidence, 'csv-original-participating-rows-after-refresh.png') })

    stage('csv-replay-locked-participating-rows')
    const beforeLockedRows = await readPersistedEvents(world, parentId)
    await openCsvReplayRows(page, lockedReplay, 'csvQuestionParticipatingRows', {
      sessionId: parentId, eventSeq: question.seq, messageId: question.data.id,
    })
    replayedLockedRows = await expectWarmParticipatingRows(lockedReplay, true)
    await expectWarmParticipatingRows(originalReplay, false)
    await expectCsvReading(lockedReplay, 'Warm', /sum/iu, '35', '1')
    await expectCsvFilter(lockedReplay)
    expect(requestCount()).toBe(callsBeforeRefresh)
    expect(await readPersistedEvents(world, parentId)).toEqual(beforeLockedRows)
    expect(await readPersistedEvents(world, childId)).toEqual(branch.branchEvents)
    await lockedReplay.screenshot({ path: join(evidence, 'csv-locked-participating-row-after-refresh.png') })
    await lockedReplay.locator('[data-csv-participating-rows-open]').click()
  }
  stage('csv-replay-compare-to-original')
  expect(await originalReplay.locator('[data-csv-compare-open]').count()).toBe(0)
  const beforeComparison = await readPersistedEvents(world, parentId)
  const reviewedComparison = await expectWarmComparison(page, lockedReplay, {
    sessionId: parentId, eventSeq: question.seq, messageId: question.data.id,
  }, filtered)
  const comparison = lockedReplay.locator('[data-csv-compare]')
  await comparison.screenshot({ path: join(evidence, 'csv-compare-with-original-after-refresh.png') })
  expect(await readPersistedEvents(world, parentId)).toEqual(beforeComparison)
  expect(await readPersistedEvents(world, childId)).toEqual(branch.branchEvents)
  if (filtered) {
    stage('csv-filtered-reading-narrow-replay')
    await narrowCsvViewport(page)
    await expectCsvTableFit(comparison.getByRole('table'))
    await comparison.screenshot({ path: join(evidence, 'csv-compare-with-original-narrow.png') })
    await lockedReplay.locator('[data-csv-compare-open]').click()
    await expectCsvTableFit(originalReplay.locator('[data-csv-participating-rows] table'))
    await originalReplay.screenshot({ path: join(evidence, 'csv-original-participating-rows-narrow.png') })
    await expectBarLabelsFit(lockedReplay, FILTERED_TOTALS)
    await expectReadingsFit(lockedReplay, { key: 'Warm', filter: 'Batch = B', aggregate: 'Sum of LatencyMs', value: '35', count: '1' })
    await lockedReplay.locator('[data-csv-participating-rows-open]').click()
    await expectCsvTableFit(lockedReplay.locator('[data-csv-participating-rows] table'))
    await lockedReplay.screenshot({ path: join(evidence, 'csv-filtered-reading-narrow.png') })
  }
  expect(requestCount()).toBe(callsBeforeRefresh)
  expect((await readPersistedEvents(world, parentId)).find(event => event.seq === question.seq)).toEqual(question)
  expect(console.warnings).toEqual([])
  await writeFile(join(evidence, 'csv-continuation-readings.json'), JSON.stringify({
    attachmentId, original: { ...branch.lockedReading, artifact: { artifactId: chart.artifactId, revision: chart.revision } },
    confirmed: { ...newReading, artifact: { artifactId: lockedArtifact.artifactId, revision: lockedArtifact.revision },
      ...(filtered ? { filter: BATCH_FILTER } : {}) },
    comparison: { switchedGroup: 'Cold', value: cold.value }, replayedOriginalRows, replayedLockedRows,
    replayedComparison: reviewedComparison.result,
    callsBeforeReturn, callsBeforeAsk, callsBeforeRefresh, userAgent,
  }, null, 2) + '\n', 'utf8')
  if (filtered) {
    await exerciseCsvComparisonExplanation(live, { parent, returned, filteredReplay: lockedReplay,
      filteredQuestion: { sessionId: parentId, eventSeq: question.seq, messageId: question.data.id },
      reviewedComparison,
      adopted: { eventSeq: adopted.seq, messageId: adopted.data.id, artifactId: chart.artifactId, revision: chart.revision },
      attachmentId, csv })
    expect(await readPersistedEvents(world, childId)).toEqual(branch.branchEvents)
    expect(console.warnings).toEqual([])
  }
}
