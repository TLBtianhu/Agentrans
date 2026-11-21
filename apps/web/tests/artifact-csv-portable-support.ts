/** Live DeepSeek and Edge acceptance for transferring a saved CSV comparison through JSON. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IMPORTED_CSV_COMPARISON_QUESTION_PREFIX, IMPORTED_CSV_SINGLE_SOURCE_TEXT, csvComparisonChangesText } from '@agentrans/artifact/runtime-values'
import { SessionId } from '@agentrans/session'
import type { Locator, Page, Request } from 'playwright'
import { expect, vi } from 'vitest'
import { compareReading, expectComparisonProviderText, seedWitnessedCsvComparisons } from './csv-comparison-browser-fixture.ts'
import { acknowledgeReloadConnectionLoss, readPersistedEvents, type watchConsole, type WebScaffold } from './scaffold.ts'
import { writeComposerDraft } from './support.ts'

const QUESTION = 'Using only the attached evidence, explain both recorded readings and how I supplied the evidence. '
  + 'Identify the excluded and retained records by their original numbers and values. Answer without calling tools.'
const EXPORT_ENDPOINT = '/api/artifactBranchResults/exportSentCsvComparisonJson'
const IMPORT_ENDPOINT = '/api/artifactBranchResults/importCsvComparison'
const SAVE_ENDPOINT = '/api/artifactBranchResults/saveCsvComparisonDraft'
const PROMPT_ENDPOINT = '/api/session/prompt'
const FORBIDDEN = new Set(['compareCsvQuestionToReturn', 'compareCsvReturns', 'csvFilterOptions', 'csvParticipatingRows',
  'csvQuestionParticipatingRows', 'csvReturnedParticipatingRows', 'lockCsv', 'recalculateCsv']
  .map(endpoint => `/api/artifactBranchResults/${endpoint}`))

interface CsvPortableBrowser {
  readonly page: Page
  readonly world: WebScaffold
  readonly evidence: string
  readonly requests: readonly unknown[]
  readonly ask: (prompt: string, sessionId?: SessionId, useExistingDraft?: boolean) => Promise<SessionId>
  readonly providerUserText: (question: string) => readonly string[]
  readonly stage: (name: string) => void
  readonly console: ReturnType<typeof watchConsole>
}

function requestData(request: Request): unknown {
  return (request.postDataJSON() as { payload: { args: { request: unknown } } }).payload.args.request
}

/** Check the four sent blocks for an imported single-page comparison. */
export function expectImportedSingleProviderText(blocks: readonly string[], question: string, context: string, changes: string): void {
  expect(blocks.slice(0, 4)).toEqual([question, context, IMPORTED_CSV_SINGLE_SOURCE_TEXT, changes])
  expect(blocks.filter(block => block === IMPORTED_CSV_SINGLE_SOURCE_TEXT)).toHaveLength(1)
  expectComparisonProviderText([...blocks.slice(0, 2), ...blocks.slice(3)], question, context, changes)
}

function expectImportedSingleAnswer(answer: string): void {
  const plain = answer.replace(/[*`_]/gu, '').replace(/‑/gu, '-').replace(/\.json\b/giu, ' JSON')
  expect(plain).toMatch(/\bWarm\b/iu)
  expect(plain).toMatch(/\b(?:mean|average)\b[\s\S]{0,125}\b30\b|\b30\b[\s\S]{0,125}\b(?:mean|average)\b/iu)
  expect(plain).toMatch(/\b(?:sum|total)\b[\s\S]{0,125}\b35\b|\b35\b[\s\S]{0,125}\b(?:sum|total)\b/iu)
  expect(plain).toMatch(/\bBatch\b[^.?!\n]{0,35}\bB\b/iu)
  const lines = plain.split(/\n+/u)
  for (const [record, value, status] of [
    [4, 25, /\b(?:exclud\w*|remov\w*|filter\w* out|left out|does not contribute)\b/iu],
    [5, 35, /\b(?:kept|retain\w*|includ\w*|remain\w*|contribut\w*)\b/iu],
  ] as const) {
    const identity = new RegExp(`\\b(?:row|record)\\s*#?\\s*${record}\\b|\\|\\s*${record}\\s*\\||#\\s*${record}\\b`, 'iu')
    const reading = new RegExp(`\\b${value}\\b`, 'u')
    expect(lines.some(line => identity.test(line) && reading.test(line) && status.test(line))).toBe(true)
  }

  const saved = /\b(?:versioned|version\s*1|v1|locked|saved)\b/.source
  expect(plain).toMatch(new RegExp(`${saved}[^.?!\\n]{0,65}\\bJSON\\b|\\bJSON\\b[^.?!\\n]{0,65}${saved}`, 'iu'))
  expect(plain).toMatch(/\bJSON\b[^.?!\n]{0,45}\bcomparison\b|\bcomparison\b[^.?!\n]{0,45}\bJSON\b/iu)
  const transfer = '\\b(?:import(?:ed|ing)?|upload(?:ed|ing)?|attach(?:ed|ing)?|provid(?:ed|ing)|suppl(?:ied|ying))\\b'
  const negation = /\b(?:not|never|rather than|instead of)\b[^,.;!?\n]*$/iu
  const negated = (index: number): boolean => negation.test(plain.slice(Math.max(0, index - 40), index))
  const jsonTransfer = new RegExp(`${transfer}[^.?!\\n]{0,100}\\bJSON\\b|\\bJSON\\b[^.?!\\n]{0,100}${transfer}`, 'giu')
  expect([...plain.matchAll(jsonTransfer)].some(match => !negated(match.index) && !negation.test(match[0]))).toBe(true)
  const csv = /\b(?:CSV\b(?![\s-]+(?:comparison|snapshot|export|records?|rows?|readings?|evidence)\b)|[\w-]+\.csv\b)/iu.source
  const qualifiers = '(?:(?:a|an|the|your|my|raw|original|underlying|actual|source|directly)\\s+)*'
  const csvImport = new RegExp(`${transfer}\\s+${qualifiers}${csv}|${csv}(?:\\s+(?:file|dataset))?\\s+(?:was|got)\\s+${transfer}`, 'giu')
  expect([...plain.matchAll(csvImport)].filter(match => !negated(match.index)).map(match => match[0])).toEqual([])
}

async function expectImportedPage(scope: Locator): Promise<void> {
  const attribution = scope.locator('[data-csv-comparison-attribution="user-imported"]')
  await attribution.waitFor({ state: 'visible' })
  expect(await attribution.textContent()).toBe('User imported')
  await compareReading(scope, 'original', { key: 'Warm', aggregate: 'Mean of LatencyMs', filter: 'No filter', value: '30', count: '2' })
  await compareReading(scope, 'locked', { key: 'Warm', aggregate: 'Sum of LatencyMs', filter: 'Batch = B', value: '35', count: '1' })
  await scope.getByText('Showing 1–2 of 2 records', { exact: true }).waitFor({ state: 'visible' })
  for (const [status, count] of Object.entries({ kept: '1', excluded: '1', added: '0' })) {
    expect(await scope.locator(`[data-csv-compare-count="${status}"]`).textContent()).toBe(count)
  }
  const rows = scope.locator('tr[data-csv-compare-record]')
  expect(await rows.evaluateAll(items => items.map(row => ({
    record: row.getAttribute('data-csv-compare-record'), status: row.getAttribute('data-csv-compare-status'),
    batch: row.querySelector('[data-csv-compare-cell="current-filter"]')?.textContent,
    value: row.querySelector('[data-csv-compare-cell="value"]')?.textContent,
  })))).toEqual([
    { record: '4', status: 'excluded', batch: 'A', value: '25' },
    { record: '5', status: 'kept', batch: 'B', value: '35' },
  ])
}

/** Open a separate empty Chat through the Web catalog and choose the acceptance model settings. */
export async function openFreshCsvChat(page: Page, world: WebScaffold, sourceSession: SessionId): Promise<SessionId> {
  await page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).click()
  const destinationRoot = page.locator('[data-conversation-session]:visible')
  await expect.poll(async () => {
    const selected = await destinationRoot.getAttribute('data-conversation-session')
    return selected !== null && selected !== sourceSession
  }).toBe(true)
  const standard = page.getByRole('button', { name: 'Standard mode', exact: true })
  const chat = page.getByRole('button', { name: 'Chat', exact: true })
  await standard.or(chat).waitFor({ state: 'visible' })
  if (await standard.isVisible()) {
    await standard.click()
    await page.getByRole('menuitem', { name: /^Chat\b/u }).click()
  }
  await chat.waitFor({ state: 'visible' })
  const model = page.getByRole('button', { name: /^Select model, current DeepSeek/u }).first()
  await model.click()
  await page.getByRole('menuitem', { name: /^Effort/u }).click()
  await page.getByRole('menuitemradio', { name: 'Low', exact: true }).click()
  await expect.poll(() => model.getAttribute('aria-label')).toMatch(/reasoning effort Low/u)
  const destination = SessionId(await destinationRoot.getAttribute('data-conversation-session') ?? '')
  expect(destination).not.toBe(sourceSession)
  const agent = world.ctx.agents.get(destination)
  if (agent === undefined) throw new Error('The new Chat Session is unavailable')
  expect(world.ctx.agentPresets.composedPreset(agent.ctx)).toBe('chat')
  expect(await world.ctx.sessions.flush(agent.session)).toBe(true)
  const eventsBeforeImport = await readPersistedEvents(world, destination)
  expect(eventsBeforeImport.filter(event => event.type === 'user/message' || event.type === 'turn/start')).toEqual([])
  return destination
}

/** Select a downloaded comparison with the composer's native file chooser. */
export async function openCsvImportFile(page: Page, conversation: Locator, portableFile: string) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    conversation.getByRole('button', { name: 'Import CSV comparison', exact: true }).click(),
  ])
  expect(await chooser.element().getAttribute('data-csv-import-comparison-input')).not.toBeNull()
  const [importResponse] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === IMPORT_ENDPOINT),
    chooser.setFiles(portableFile),
  ])
  return importResponse
}

/** Save the exact JSON exported from the specified visible sent card. */
export async function downloadSentCsvComparisonJson(page: Page, sentComparison: Locator, eventSeq: number, evidence: string,
  label = 'Download comparison as JSON') {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    sentComparison.getByRole('button', { name: label, exact: true }).click(),
  ])
  expect(download.suggestedFilename()).toBe(`csv-comparison-${eventSeq}.json`)
  const portableFile = join(evidence, download.suggestedFilename())
  await download.saveAs(portableFile)
  return { portableFile, json: await readFile(portableFile, 'utf8') }
}

/** Download the original witness, import it into a new Chat, send it, and replay the persisted imported page. */
export async function exercisePortableCsvComparison(live: CsvPortableBrowser): Promise<void> {
  const { page, world, evidence, requests, ask, providerUserText, stage, console } = live
  const userAgent = await page.evaluate(() => navigator.userAgent)
  expect(userAgent).toMatch(/\bEdg\//u)
  const { sessionId: sourceSession, filtered, comparison, source, question } = await seedWitnessedCsvComparisons(world, 'csv-portable-source')
  const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
  await workspace.attachSession(sourceSession)
  const forbidden: string[] = []
  const browserRequests = new Map<string, Request[]>()
  const tracked = new Set([EXPORT_ENDPOINT, IMPORT_ENDPOINT, SAVE_ENDPOINT, PROMPT_ENDPOINT])
  const watchRequest = (request: Request): void => {
    const { pathname } = new URL(request.url())
    if (FORBIDDEN.has(pathname)) forbidden.push(pathname)
    if (!tracked.has(pathname)) return
    const previous = browserRequests.get(pathname) ?? []
    previous.push(request)
    browserRequests.set(pathname, previous)
  }
  const csvReads = vi.spyOn(world.ctx.attachments, 'readFileStream').mockImplementation(() => {
    throw new Error('The portable saved comparison must not open a source CSV')
  })
  page.on('request', watchRequest)
  const expectNoCsvWork = (): void => {
    expect(forbidden).toEqual([])
    expect(csvReads).not.toHaveBeenCalled()
  }
  const expectNoSend = (): void => {
    expectNoCsvWork()
    expect(requests).toHaveLength(0)
    expect(browserRequests.get(PROMPT_ENDPOINT) ?? []).toHaveLength(0)
  }
  const reloadChecking = async (check: () => Promise<void>): Promise<void> => {
    const warnings = console.warnings.length
    await page.reload()
    await check()
    acknowledgeReloadConnectionLoss(console, warnings)
  }
  try {
    stage('csv-portable-download-exact-sent-page')
    const workspaceRow = page.locator(`[data-row-key="workspace:${workspace.id}"]`)
    await reloadChecking(async () => { await workspaceRow.waitFor({ state: 'visible' }) })
    if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
    await page.locator(`[data-row-key="session:${sourceSession}"]`).click()
    const sent = page.locator(`[data-chat-message-id="${filtered.messageId}"][data-chat-message-seq="${filtered.eventSeq}"]`)
    const sentComparison = sent.locator('[data-csv-compare-attached]')
    await sentComparison.getByRole('button', { name: 'Replay attached comparison', exact: true }).click()
    await compareReading(sentComparison, 'locked', { key: 'Warm', filter: 'Batch = B', value: '35', count: '1' })
    const { portableFile, json } = await downloadSentCsvComparisonJson(page, sentComparison, filtered.eventSeq, evidence)
    const format = { format: 'agentrans-csv-comparison', version: 1, comparison }
    expect(JSON.parse(json)).toEqual(format)
    expect(browserRequests.get(EXPORT_ENDPOINT)?.map(requestData)).toEqual([filtered])
    for (const id of [sourceSession, source.messageId, source.artifactId, question.messageId, filtered.messageId]) {
      expect(json).not.toContain(id)
    }
    expectNoSend()

    stage('csv-portable-create-new-chat')
    const destination = await openFreshCsvChat(page, world, sourceSession)
    const conversation = page.locator(`[data-conversation-session="${destination}"]`)

    stage('csv-portable-import-preview')
    const importResponse = await openCsvImportFile(page, conversation, portableFile)
    const importedFacts = { kind: 'csv-question-comparison', sessionId: destination, attribution: 'user-imported', comparison }
    expect(await importResponse.json()).toMatchObject({ result: { ok: true, value: { facts: importedFacts } } })
    expect(browserRequests.get(IMPORT_ENDPOINT)?.map(requestData)).toEqual([{ sessionId: destination, json }])
    const review = page.locator('[data-csv-import-review]')
    await expectImportedPage(review)
    expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId: destination })).toBeNull()
    expect(browserRequests.get(SAVE_ENDPOINT) ?? []).toHaveLength(0)
    expectNoSend()
    await review.screenshot({ path: join(evidence, 'csv-import-review.png') })

    stage('csv-portable-confirm-and-reload-draft')
    const [save] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === SAVE_ENDPOINT),
      review.getByRole('button', { name: 'Attach comparison', exact: true }).click(),
    ])
    expect(await save.json()).toMatchObject({ result: { ok: true, value: { facts: importedFacts } } })
    const chip = conversation.locator('[data-artifact-prompt-context="csv-question-comparison"]')
    await chip.waitFor({ state: 'visible' })
    const input = conversation.locator('[data-composer-input]')
    await writeComposerDraft(page, input, QUESTION)
    await reloadChecking(async () => {
      await chip.waitFor({ state: 'visible' })
      await expect.poll(() => input.textContent()).toBe(QUESTION)
    })
    const restored = await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId: destination })
    if (restored === null) throw new Error('Missing saved imported comparison after refresh')
    expect(restored.facts).toEqual(importedFacts)
    const draftReview = chip.getByRole('button', { name: 'Review attached comparison', exact: true })
    await draftReview.click()
    await expectImportedPage(chip)
    await conversation.locator('[data-composer-seat]').screenshot({ path: join(evidence, 'csv-imported-draft-after-refresh.png') })
    await draftReview.click()
    expectNoSend()

    stage('csv-portable-send-to-real-deepseek')
    expect(await ask(QUESTION, destination, true)).toBe(destination)
    const events = await readPersistedEvents(world, destination)
    const selected = events.find(event => event.type === 'user/message' && event.data.content.some(block =>
      block.type === 'text' && block.text === QUESTION))
    if (selected?.type !== 'user/message') throw new Error('Missing sent portable comparison question')
    const [prompt, context, sourceDescription, changes] = selected.data.content
    expect(prompt).toEqual({ type: 'text', text: QUESTION })
    if (context?.type !== 'text' || !context.text.startsWith(IMPORTED_CSV_COMPARISON_QUESTION_PREFIX)) {
      throw new Error('Missing imported CSV comparison attribution on the prompt')
    }
    const envelope = { kind: 'artifact-question-context', sessionId: destination, facts: importedFacts }
    expect(JSON.parse(context.text.slice(IMPORTED_CSV_COMPARISON_QUESTION_PREFIX.length))).toEqual(envelope)
    expect(sourceDescription).toEqual({ type: 'text', text: IMPORTED_CSV_SINGLE_SOURCE_TEXT })
    const expectedChanges = csvComparisonChangesText(comparison)
    expect(changes).toEqual({ type: 'text', text: expectedChanges })
    expect(selected.data.content).toHaveLength(4)
    const providerText = providerUserText(QUESTION)
    expectImportedSingleProviderText(providerText, QUESTION, context.text, expectedChanges)
    expect(providerText.filter(block => block.startsWith(IMPORTED_CSV_COMPARISON_QUESTION_PREFIX))).toHaveLength(1)
    const privateSource = [json.trim(), 'agentrans-csv-comparison', '"proof"', '"receiptId"', restored.receiptId, sourceSession,
      source.messageId, source.artifactId, question.messageId, filtered.messageId]
    expect(providerText.every(block => privateSource.every(value => !block.includes(value)))).toBe(true)
    expect(requests).toHaveLength(1)
    expect(browserRequests.get(PROMPT_ENDPOINT)).toHaveLength(1)
    expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId: destination })).toBeNull()
    const response = events.findLast(event => event.type === 'assistant/message')
    if (response?.type !== 'assistant/message') throw new Error('DeepSeek did not answer the imported comparison question')
    const answer = response.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expectImportedSingleAnswer(answer)
    expect(events.filter(event => event.type === 'tool/call')).toEqual([])

    stage('csv-portable-replay-sent-after-edge-refresh')
    const row = conversation.locator(`[data-chat-message-id="${selected.data.id}"][data-chat-message-seq="${selected.seq}"]`)
    const replay = row.locator('[data-csv-compare-attached]')
    await reloadChecking(async () => {
      await replay.getByRole('button', { name: 'Replay attached comparison', exact: true }).click()
      await expectImportedPage(replay)
    })
    expect(await replay.locator('[data-csv-view-source-question], [data-csv-view-full-source-chain]').count()).toBe(0)
    expect(await readPersistedEvents(world, destination)).toEqual(events)
    await row.screenshot({ path: join(evidence, 'csv-imported-comparison-after-refresh.png') })
    expect(requests).toHaveLength(1)
    expect(browserRequests.get(PROMPT_ENDPOINT)).toHaveLength(1)
    expect(browserRequests.get(IMPORT_ENDPOINT)).toHaveLength(1)
    expect(browserRequests.get(SAVE_ENDPOINT)).toHaveLength(1)
    expectNoCsvWork()
    expect(console.warnings).toEqual([])
    expect(console.pageErrors).toEqual([])
    await writeFile(join(evidence, 'csv-portable-acceptance.json'), JSON.stringify({ userAgent, file: format, imported: envelope, answer,
      source: filtered, destination: { sessionId: destination, eventSeq: selected.seq, messageId: selected.data.id },
      providerRequests: requests.length, providerRequestsBeforeExplicitSend: 0, promptRequests: 1,
      modelIdentifiedJsonImport: true,
      resumedDraftAfterReload: true, replayedSentAfterReload: true, csvReads: csvReads.mock.calls.length, csvRecomputes: forbidden.length,
    }, null, 2) + '\n')
  } finally {
    page.off('request', watchRequest)
    csvReads.mockRestore()
  }
}
