/** Live browser acceptance for explaining two independently recorded CSV calculation recipes. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  IMPORTED_CSV_COMPARISON_QUESTION_PREFIX, IMPORTED_CSV_SINGLE_SOURCE_TEXT, csvComparisonChanges, csvComparisonChangesText,
} from '@agentrans/artifact/runtime-values'
import type { SessionId } from '@agentrans/session'
import type { Locator, Page, Request } from 'playwright'
import { expect, vi } from 'vitest'
import {
  downloadSentCsvComparisonJson, expectImportedSingleProviderText, openCsvImportFile, openFreshCsvChat,
} from './artifact-csv-portable-support.ts'
import { compareReading, seedWitnessedCsvComparisons } from './csv-comparison-browser-fixture.ts'
import { acknowledgeReloadConnectionLoss, readPersistedEvents, type watchConsole, type WebScaffold } from './scaffold.ts'
import { writeComposerDraft } from './support.ts'

const EXPORT_ENDPOINT = '/api/artifactBranchResults/exportSentCsvComparisonJson'
const IMPORT_ENDPOINT = '/api/artifactBranchResults/importCsvComparison'
const SAVE_ENDPOINT = '/api/artifactBranchResults/saveCsvComparisonDraft'
const PROMPT_ENDPOINT = '/api/session/prompt'
const CSV_READ_ENDPOINTS = new Set(['compareCsvQuestionToReturn', 'csvFilterOptions', 'csvParticipatingRows',
  'csvQuestionParticipatingRows', 'csvReturnedParticipatingRows', 'lockCsv', 'recalculateCsv']
  .map(endpoint => `/api/artifactBranchResults/${endpoint}`))
type Comparison = Awaited<ReturnType<typeof seedWitnessedCsvComparisons>>['comparison']

interface CsvChangesBrowser {
  readonly page: Page
  readonly world: WebScaffold
  readonly evidence: string
  readonly requests: readonly unknown[]
  readonly ask: (prompt: string, sessionId?: SessionId, useExistingDraft?: boolean) => Promise<SessionId>
  readonly providerUserText: (question: string) => readonly string[]
  readonly stage: (name: string) => void
  readonly console: ReturnType<typeof watchConsole>
}

function rpcRequest(request: Request): unknown {
  return (request.postDataJSON() as { payload: { args: { request: unknown } } }).payload.args.request
}

async function expectChangedComparison(scope: Locator, comparison: Comparison, filtered: boolean): Promise<void> {
  const method = scope.locator('[data-csv-comparison-method-changed]')
  await method.waitFor({ state: 'visible' })
  expect(await method.textContent()).toBe('Calculation method changed')
  for (const [part, label] of [['filter', 'Filter changed'], ['membership', 'Participating records changed']] as const) {
    const notice = scope.locator(`[data-csv-comparison-${part}-changed]`)
    if (filtered) expect(await notice.textContent()).toBe(label)
    else expect(await notice.count()).toBe(0)
  }
  await compareReading(scope, 'original', { key: 'Warm', aggregate: 'Mean of LatencyMs', filter: 'No filter', value: '30', count: '2' })
  await compareReading(scope, 'locked', { key: 'Warm', aggregate: 'Sum of LatencyMs', filter: filtered ? 'Batch = B' : 'No filter',
    value: String(comparison.current.value), count: String(comparison.current.count) })
  await scope.getByText('Showing 1–2 of 2 records', { exact: true }).waitFor({ state: 'visible' })
  for (const status of ['kept', 'excluded', 'added'] as const) {
    expect(await scope.locator(`[data-csv-compare-count="${status}"]`).textContent()).toBe(String(comparison[status]))
  }
  const rows = scope.locator('tr[data-csv-compare-record]')
  expect(await rows.evaluateAll(items => items.map(row => ({
    record: Number(row.getAttribute('data-csv-compare-record')), status: row.getAttribute('data-csv-compare-status'),
    value: row.querySelector('[data-csv-compare-cell="value"]')?.textContent,
    ...(row.querySelector('[data-csv-compare-cell="current-filter"]') === null ? {}
      : { currentFilterValue: row.querySelector('[data-csv-compare-cell="current-filter"]')?.textContent }),
  })))).toEqual(comparison.rows)
}

function expectSpecificAnswer(answer: string, comparison: Comparison, filtered: boolean): void {
  const plain = answer.replaceAll('*', '').replaceAll('`', '')
  expect(plain).toMatch(/\bWarm\b/iu)
  expect(plain).toMatch(/\b(?:mean|average)\b[\s\S]{0,125}\b30\b|\b30\b[\s\S]{0,125}\b(?:mean|average)\b/iu)
  const lockedValue = comparison.current.value
  expect(plain).toMatch(new RegExp(`\\b(?:sum|total)\\b[\\s\\S]{0,125}\\b${lockedValue}\\b`
    + `|\\b${lockedValue}\\b[\\s\\S]{0,125}\\b(?:sum|total)\\b`, 'iu'))
  const lines = plain.split(/[\n;.!?]+/u)
  const kept = /\b(?:kept|retain\w*|remain\w*|included)\b/iu
  if (filtered) {
    expect(plain).toMatch(/\bBatch\b[^.\n]{0,35}\bB\b/iu)
    expect(lines.some(line => /\b(?:row|record)\s*#?\s*4\b|\|\s*4\s*\|/iu.test(line)
      && /\b(?:exclud\w*|remov\w*|filter\w* out)/iu.test(line))).toBe(true)
    expect(lines.some(line => /\b(?:row|record)\s*#?\s*5\b|\|\s*5\s*\|/iu.test(line) && kept.test(line))).toBe(true)
  } else {
    const listsBoth = /\b(?:rows?|records?)\s*#?\s*4\b[^.\n]{0,25}\b5\b/iu.test(plain)
    const keepsBoth = lines.some(line => /\|\s*4\s*\|/u.test(line) && kept.test(line))
      && lines.some(line => /\|\s*5\s*\|/u.test(line) && kept.test(line))
    expect(listsBoth || keepsBoth).toBe(true)
    expect(plain).toMatch(/\b(?:same|unchanged|both kept|both retained|both included|none excluded)\b/iu)
  }
  const movement = '\\b(?:ris(?:e|es|ing)|rose|risen|fall(?:s|ing)?|fell|fallen|drop(?:s|ped)?|(?:in|de)creas(?:e|es|ed))\\b'
  const pair = `\\b30\\b[^.\\n]{0,30}(?:to|→|->)\\s*\\b${lockedValue}\\b`
  const direction = new RegExp(`${movement}[^.\\n]{0,30}${pair}|${pair}[^.\\n]{0,30}${movement}`, 'iu')
  for (const clause of plain.split(/[\n.!?]+/u)) {
    if (/\b(?:not|no|neither|cannot|can't|doesn't|isn't)\b/iu.test(clause)) continue
    expect(clause).not.toMatch(direction)
  }
}

export async function exerciseCsvComparisonChanges({ page, world, evidence, requests, ask, providerUserText, stage, console }:
CsvChangesBrowser): Promise<void> {
  const userAgent = await page.evaluate(() => navigator.userAgent)
  expect(userAgent).toMatch(/\bEdg\//u)
  const { sessionId, filtered, alternate, comparison, alternateComparison, source, question }
    = await seedWitnessedCsvComparisons(world, 'csv-comparison-changes')
  const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
  await workspace.attachSession(sessionId)
  const cases = [
    { key: 'same-records', address: alternate, page: alternateComparison, filtered: false,
      prompt: 'For the attached trial comparison, explain how each reading was calculated and what happened to the contributing records. '
        + 'Use the record numbers and keep to the facts in the attachment.' },
    { key: 'filtered-records', address: filtered, page: comparison, filtered: true,
      prompt: 'Explain how each reading in this attached comparison was calculated. '
        + 'Describe any filter and what happened to the contributing records by record number.' },
  ] as const
  const observed: Request[] = []
  const rejectRead = vi.spyOn(world.ctx.attachments, 'readFileStream').mockImplementation(() => {
    throw new Error('Explaining a saved comparison must not read the original CSV')
  })
  const watch = (request: Request): void => { observed.push(request) }
  const requestsFor = (name: string): readonly Request[] => observed.filter(request => new URL(request.url()).pathname === name)
  const expectReadOnly = (sends: number): void => {
    expect(requests).toHaveLength(sends)
    expect(requestsFor(PROMPT_ENDPOINT)).toHaveLength(sends)
    expect(observed.filter(request => CSV_READ_ENDPOINTS.has(new URL(request.url()).pathname))).toEqual([])
    expect(rejectRead).not.toHaveBeenCalled()
  }
  page.on('request', watch)
  const reloadChecking = async (check: () => Promise<void>): Promise<void> => {
    const warnings = console.warnings.length
    await page.reload()
    await check()
    acknowledgeReloadConnectionLoss(console, warnings)
  }
  try {
    stage('csv-changes-open-witnessed-history')
    const workspaceRow = page.locator(`[data-row-key="workspace:${workspace.id}"]`)
    await reloadChecking(async () => { await workspaceRow.waitFor({ state: 'visible' }) })
    if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
    const sourceRow = page.locator(`[data-row-key="session:${sessionId}"]`)
    const conversationFor = (id: SessionId): Locator => page.locator(`[data-conversation-session="${id}"]`)
    const comparisonCard = (id: SessionId, address: Pick<typeof alternate, 'eventSeq' | 'messageId'>): Locator => conversationFor(id).locator(
      `[data-chat-message-id="${address.messageId}"][data-chat-message-seq="${address.eventSeq}"] [data-csv-compare-attached]`,
    )
    const open = async (id: SessionId, address: Pick<typeof alternate, 'eventSeq' | 'messageId'>): Promise<Locator> => {
      const card = comparisonCard(id, address)
      const toggle = card.getByRole('button', { name: 'Replay attached comparison', exact: true })
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
      return card
    }
    const outcomes: unknown[] = []
    const destinations = new Set<SessionId>()
    for (const [index, scenario] of cases.entries()) {
      stage(`csv-changes-review-${scenario.key}`)
      await sourceRow.click()
      const card = await open(sessionId, scenario.address)
      await expectChangedComparison(card, scenario.page, scenario.filtered)
      const { portableFile, json } = await downloadSentCsvComparisonJson(page, card, scenario.address.eventSeq, evidence)
      expect(JSON.parse(json)).toEqual({ format: 'agentrans-csv-comparison', version: 1, comparison: scenario.page })
      expect(requestsFor(EXPORT_ENDPOINT).map(rpcRequest)).toEqual(cases.slice(0, index + 1).map(item => item.address))
      const destination = await openFreshCsvChat(page, world, sessionId)
      expect(destinations.has(destination)).toBe(false)
      destinations.add(destination)
      const conversation = conversationFor(destination)
      const input = conversation.locator('[data-composer-input]')
      const chip = conversation.locator('[data-artifact-prompt-context="csv-question-comparison"]')
      const facts = { kind: 'csv-question-comparison', sessionId: destination, provenance: 'user-imported', comparison: scenario.page }
      const imported = await openCsvImportFile(page, conversation, portableFile)
      expect(rpcRequest(imported.request())).toEqual({ sessionId: destination, json })
      expect(await imported.json()).toMatchObject({ result: { ok: true, value: { facts } } })
      const review = conversation.locator('[data-csv-import-review]')
      await expectChangedComparison(review, scenario.page, scenario.filtered)
      await expect.poll(() => review.locator('[data-csv-comparison-provenance="user-imported"]').textContent()).toBe('User imported')
      await review.screenshot({ path: join(evidence, `csv-changes-${scenario.key}-review.png`) })
      expectReadOnly(index)
      expect(requestsFor(SAVE_ENDPOINT)).toHaveLength(index)
      const [saved] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === SAVE_ENDPOINT),
        review.getByRole('button', { name: 'Attach comparison', exact: true }).click(),
      ])
      expect(await saved.json()).toMatchObject({ result: { ok: true, value: { facts } } })
      await chip.waitFor({ state: 'visible' })
      await writeComposerDraft(page, input, scenario.prompt)
      expectReadOnly(index)

      stage(`csv-changes-send-${scenario.key}`)
      expect(await ask(scenario.prompt, destination, true)).toBe(destination)
      expectReadOnly(index + 1)
      const history = await readPersistedEvents(world, destination)
      const sent = history.find(event => event.type === 'user/message' && event.data.content.some(block =>
        block.type === 'text' && block.text === scenario.prompt))
      if (sent?.type !== 'user/message') throw new Error('Missing the sent comparison question')
      const [prompt, canonical, sourceDescription, appendix] = sent.data.content
      expect(prompt).toEqual({ type: 'text', text: scenario.prompt })
      if (canonical?.type !== 'text' || !canonical.text.startsWith(IMPORTED_CSV_COMPARISON_QUESTION_PREFIX)) {
        throw new Error('The sent question lost its canonical comparison')
      }
      expect(JSON.parse(canonical.text.slice(IMPORTED_CSV_COMPARISON_QUESTION_PREFIX.length)))
        .toEqual({ kind: 'artifact-question-context', sessionId: destination, facts })
      expect(sourceDescription).toEqual({ type: 'text', text: IMPORTED_CSV_SINGLE_SOURCE_TEXT })
      const changes = csvComparisonChanges(scenario.page)
      expect(changes).toEqual({ aggregation: { original: 'mean', current: 'sum', changed: true }, filterChanged: scenario.filtered,
        membership: { changed: scenario.filtered, kept: scenario.filtered ? 1 : 2, excluded: scenario.filtered ? 1 : 0, added: 0,
          reviewedRows: [{ record: 4, status: scenario.filtered ? 'excluded' : 'kept' }, { record: 5, status: 'kept' }] } })
      const changesText = csvComparisonChangesText(scenario.page)
      expect(appendix).toEqual({ type: 'text', text: changesText })
      expect(sent.data.content).toHaveLength(4)
      const modelText = providerUserText(scenario.prompt)
      expectImportedSingleProviderText(modelText, scenario.prompt, canonical.text, changesText)
      const privateSource = ['"proof"', '"receiptId"', sessionId, source.messageId, source.artifactId, question.messageId,
        scenario.address.messageId, json.trim()]
      expect(modelText.every(block => privateSource.every(value => !block.includes(value)))).toBe(true)
      const answerEvent = history.findLast(event => event.seq > sent.seq && event.type === 'assistant/message')
      if (answerEvent?.type !== 'assistant/message') throw new Error('DeepSeek did not answer the comparison question')
      const answer = answerEvent.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      expectSpecificAnswer(answer, scenario.page, scenario.filtered)
      expect(history.filter(event => event.seq > sent.seq && event.type === 'tool/call')).toEqual([])

      stage(`csv-changes-replay-${scenario.key}`)
      const address = { eventSeq: sent.seq, messageId: sent.data.id }
      await reloadChecking(async () => {
        await expectChangedComparison(await open(destination, address), scenario.page, scenario.filtered)
      })
      await comparisonCard(destination, address).screenshot({ path: join(evidence, `csv-changes-${scenario.key}-after-refresh.png`) })
      expectReadOnly(index + 1)
      outcomes.push({ case: scenario.key, saved: scenario.address, sent: { sessionId: destination, ...address },
        page: scenario.page, changes, answer,
        extraModelCallsForReviewAndRestore: 0, providerRequestsForSend: 1, reproducedAfterReload: true })
    }
    expect(requestsFor(IMPORT_ENDPOINT)).toHaveLength(cases.length)
    expect(requestsFor(SAVE_ENDPOINT)).toHaveLength(cases.length)
    expect(console.warnings).toEqual([])
    expect(console.pageErrors).toEqual([])
    await writeFile(join(evidence, 'csv-comparison-changes-acceptance.json'), JSON.stringify({ userAgent, outcomes,
      providerRequests: requests.length, csvReads: rejectRead.mock.calls.length, csvRecomputes: 0,
    }, null, 2) + '\n')
  } finally {
    page.off('request', watch)
    rejectRead.mockRestore()
  }
}
