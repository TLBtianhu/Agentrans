// @vitest-environment node
import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IMPORTED_CSV_SINGLE_SOURCE_TEXT } from '@agentrans/artifact/runtime-values'
import { chromium, type Locator, type Request } from 'playwright'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { inspectImportedPair } from './artifact-csv-explanation-portable-support.ts'
import { selectDraftOffsets, selectedDraftOffsets, visitCsvExplanationDraftSources } from './artifact-csv-explanation-support.ts'
import { openCsvImportFile } from './artifact-csv-portable-support.ts'
import { inspectImportedReturns } from './artifact-csv-return-portable-support.ts'
import {
  csvReturnLink, expectFocused, expectWarmReturnComparison, frozenCsvReturnCards, visitCsvReturnDraftSources, walkImportedCsvSourceChain,
} from './artifact-csv-return-source-support.ts'
import {
  compareReading, expectCsvComparisonRecords, seedIdenticalImportedCsvExplanationSources, seedImportedCsvExplanationSourceChain,
  seedIdenticalImportedCsvReturnSources, seedImportedCsvReturnSourceChain, seedImportedCsvSourceKinds, seedSentImportedCsvSingle,
  seedWitnessedCsvExplanation, seedWitnessedCsvExplanationDraft,
  seedWitnessedCsvReturnComparison, seedWitnessedCsvReturnComparisonDraft,
} from './csv-comparison-browser-fixture.ts'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, readPersistedEvents, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const SOURCE_TRAIL_KEY = 'dsh.artifact.csv-comparison-source.v1'
const REVIEW_SENT = '/api/artifactBranchResults/reviewSentCsvComparison'
const IMPORT_CSV = '/api/artifactBranchResults/importCsvComparison'
const SAVE_DRAFT = '/api/artifactBranchResults/saveCsvComparisonDraft'
const FORBIDDEN = new Set([
  '/api/session/prompt', REVIEW_SENT, IMPORT_CSV, SAVE_DRAFT,
  ...['compareCsvQuestionToReturn', 'compareCsvReturns', 'csvFilterOptions', 'csvParticipatingRows', 'csvQuestionParticipatingRows',
    'csvReturnedParticipatingRows', 'lockCsv', 'recalculateCsv', 'reviewCsvComparisonExplanation', 'exportSentCsvComparisonJson',
    'bindCsvComparisonDraftRequest', 'clearCsvComparisonDraft']
    .map(endpoint => `/api/artifactBranchResults/${endpoint}`),
])

type ExplanationFixture = Awaited<ReturnType<typeof seedWitnessedCsvExplanation>>
type CsvAddress = Pick<ExplanationFixture['alternate'], 'eventSeq' | 'messageId'>
type ExplanationStep = 'aggregation' | 'filtering'

function toggle(target: Locator): Locator {
  return target.getByRole('button', { name: 'Replay attached comparison', exact: true })
}

function explanationStep(container: Locator, kind: ExplanationStep): Locator {
  return container.locator(`[data-csv-explanation-step="${kind}"]`)
}

async function expectPairedStep(step: Locator, kind: ExplanationStep): Promise<void> {
  const filtering = kind === 'filtering'
  await compareReading(step, 'original', { key: 'Warm', aggregate: filtering ? 'Sum of LatencyMs' : 'Mean of LatencyMs',
    filter: 'No filter', value: filtering ? '60' : '30', count: '2' })
  await compareReading(step, 'locked', { key: 'Warm', aggregate: 'Sum of LatencyMs', filter: filtering ? 'Batch = B' : 'No filter',
    value: filtering ? '35' : '60', count: filtering ? '1' : '2' })
  await expectCsvComparisonRecords(step, filtering)
}

async function expectSource(target: Locator, isFiltered: boolean): Promise<void> {
  await expect.poll(() => toggle(target).getAttribute('aria-expanded')).toBe('true')
  await compareReading(target, 'original', { key: 'Warm', aggregate: 'Mean of LatencyMs', filter: 'No filter', value: '30', count: '2' })
  await compareReading(target, 'locked', { key: 'Warm', aggregate: 'Sum of LatencyMs', filter: isFiltered ? 'Batch = B' : 'No filter',
    value: isFiltered ? '35' : '60', count: isFiltered ? '1' : '2' })
  await expectCsvComparisonRecords(target, isFiltered)
}

async function openExplanationReplay<T extends Pick<ExplanationFixture, 'sessionId'>>(
  name: string, seed: (world: WebScaffold, id: string) => Promise<T>,
) {
  const world = await launchWebScaffold({ compareReplaySession: false })
  onTestFinished(() => world.close())
  const recordStream = vi.fn(() => { throw new Error('Saved two-step navigation must not start a model stream') })
  const stopStreams = world.ctx.on('llm/stream', recordStream, { global: true })
  const reads = vi.spyOn(world.ctx.attachments, 'readFileStream').mockImplementation(() => {
    throw new Error('Saved two-step navigation must not open an attachment')
  })
  onTestFinished(() => { stopStreams(); reads.mockRestore() })
  const fixture = await seed(world, name)
  const { sessionId } = fixture
  const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
  await workspace.attachSession(sessionId)
  const executablePath = process.env.AGENTRANS_PLAYWRIGHT_EXECUTABLE_PATH
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 1280)
  onTestFailed(() => saveFailureShot(page, name))
  const console = watchConsole(page)
  const evidence = process.env.AGENTRANS_CSV_EXPLANATION_REPLAY_EVIDENCE_DIR
  if (evidence !== undefined) await mkdir(evidence, { recursive: true })
  const screenshot = async (target: Locator, name: string): Promise<void> => {
    if (evidence !== undefined) await target.screenshot({ path: join(evidence, name), animations: 'disabled' })
  }
  const requests: string[] = []
  const watchRequest = (request: Request): void => {
    const { pathname } = new URL(request.url())
    if (FORBIDDEN.has(pathname)) requests.push(pathname)
  }
  page.on('request', watchRequest)
  onTestFinished(() => { page.off('request', watchRequest) })
  const reload = async (check: () => Promise<void>): Promise<void> => {
    const warnings = console.warnings.length
    await page.reload()
    await check()
    acknowledgeReloadConnectionLoss(console, warnings)
  }

  await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
  await page.locator(`[data-row-key="session:${sessionId}"]`).click()
  await expect.poll(() => world.ctx.agents.get(sessionId)?.session.snapshotEvents().some(event => event.type === 'approval/policy')).toBe(true)
  const agent = world.ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('The saved paired comparison Session did not activate')
  await agent.whenIdle()
  expect(await world.ctx.sessions.flush(agent.session)).toBe(true)
  const before = await readPersistedEvents(world, sessionId)
  const conversation = page.locator(`[data-conversation-session="${sessionId}"]`)
  const card = ({ eventSeq, messageId }: CsvAddress): Locator => conversation
    .locator(`[data-chat-message-id="${messageId}"][data-chat-message-seq="${eventSeq}"] [data-csv-compare-attached]`)
  const storedTrail = () => page.evaluate(key => sessionStorage.getItem(key), SOURCE_TRAIL_KEY)
  const storedTrailData = async (): Promise<unknown> => {
    const saved: unknown = JSON.parse(await storedTrail() ?? 'null')
    return saved
  }
  const report = async (fields: Readonly<Record<string, unknown>>, expectedRequests: readonly string[] = []): Promise<void> => {
    expect(await readPersistedEvents(world, sessionId)).toEqual(before)
    expect(requests).toEqual(expectedRequests)
    expect(reads).not.toHaveBeenCalled()
    expect(recordStream).not.toHaveBeenCalled()
    expect(console.warnings).toEqual([])
    expect(console.pageErrors).toEqual([])
    if (evidence !== undefined) await writeFile(join(evidence, `${name}.json`), JSON.stringify({
      browser: await page.evaluate(() => navigator.userAgent), ...fields, requests,
      attachmentReads: reads.mock.calls.length, modelStreams: recordStream.mock.calls.length,
      csvRecomputes: requests.filter(path => path.endsWith('/recalculateCsv')).length, sessionLogUnchanged: true,
    }, null, 2) + '\n')
  }
  return { world, fixture, page, conversation, card, storedTrail, storedTrailData, screenshot, reload, report }
}

it.skipIf(webSnapshotMode() === 'record')('replays one imported locked CSV comparison and its source note after refresh', async () => {
  const { fixture, conversation, card, reload, report } = await openExplanationReplay('csv-imported-single-source', seedSentImportedCsvSingle)
  const replay = card(fixture.sent)
  const { eventSeq, messageId } = fixture.sent
  const raw = conversation.locator(`[data-chat-message-id="${messageId}"][data-chat-message-seq="${eventSeq}"]`)
    .locator('[data-artifact-question-context-raw]')
  await reload(async () => {
    await toggle(replay).click()
    await expectSource(replay, true)
    expect(await replay.locator('[data-csv-comparison-provenance="user-imported"]').textContent()).toBe('User imported')
    expect(await raw.textContent()).toContain(IMPORTED_CSV_SINGLE_SOURCE_TEXT)
    expect(await raw.isVisible()).toBe(false)
  })
  await report({ sent: fixture.sent, importedSourceFolded: true })
})

const importedLabels = {
  'single-page': 'JSON comparison with one locked page',
  'two-step-explanation': 'JSON two-step explanation with two original locked pages',
  'return-comparison': 'JSON comparison with two original return cards',
} as const
type ImportedCsvKind = keyof typeof importedLabels

async function expectImportedAttribution(scope: Locator, kind: ImportedCsvKind): Promise<void> {
  const badge = scope.locator('[data-csv-comparison-provenance="user-imported"]')
  await badge.waitFor({ state: 'visible' })
  expect(await badge.textContent()).toBe('User imported')
  const notes = scope.locator('[data-csv-import-source]')
  await expect.poll(() => notes.count()).toBe(1)
  await notes.waitFor({ state: 'visible' })
  expect(await notes.getAttribute('data-csv-import-source')).toBe(kind)
  expect(await notes.textContent()).toBe(importedLabels[kind])
}

async function inspectImportedEvidence(scope: Locator, kind: ImportedCsvKind): Promise<void> {
  const noCapture = (): Promise<void> => Promise.resolve()
  if (kind === 'two-step-explanation') await inspectImportedPair(scope, noCapture)
  else if (kind === 'return-comparison') await inspectImportedReturns(scope, noCapture)
  else {
    await compareReading(scope, 'original', { key: 'Warm', aggregate: 'Mean of LatencyMs', filter: 'No filter', value: '30', count: '2' })
    await compareReading(scope, 'locked', { key: 'Warm', aggregate: 'Sum of LatencyMs', filter: 'Batch = B', value: '35', count: '1' })
    await expectCsvComparisonRecords(scope, true)
  }
}

it.skipIf(webSnapshotMode() === 'record')('shows the exact JSON attribution for all three CSV imports in preview, draft, and history', async () => {
  const { world, fixture, page, conversation, card, screenshot, reload, report }
    = await openExplanationReplay('csv-imported-source-attribution', seedImportedCsvSourceKinds)
  const { sessionId, entries } = fixture
  expect(entries.map(entry => entry.kind)).toEqual(Object.keys(importedLabels))
  const scratch = await mkdtemp(join(tmpdir(), 'csv-import-attribution-'))
  const imports = entries.map(entry => ({ ...entry, file: join(scratch, `${entry.kind}.json`) }))
  onTestFinished(async () => {
    await Promise.all(imports.map(({ file }) => rm(file, { force: true })))
    await rmdir(scratch)
  })
  await Promise.all(imports.map(({ file, json }) => writeFile(file, json)))
  const chip = conversation.locator('[data-artifact-prompt-context="csv-question-comparison"]')
  const draftToggle = chip.getByRole('button', { name: 'Review attached comparison', exact: true })
  expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toBeNull()

  for (const { file, json, facts, kind } of imports) {
    const oldDraft = await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })
    const loaded = await openCsvImportFile(page, conversation, file)
    expect(loaded.request().postDataJSON()).toMatchObject({ payload: { args: { request: { sessionId, json } } } })
    expect(await loaded.json()).toMatchObject({ result: { ok: true, value: { facts } } })
    const preview = conversation.locator('[data-csv-import-review]')
    await expectImportedAttribution(preview, kind)
    await inspectImportedEvidence(preview, kind)
    await screenshot(preview, `csv-import-attribution-${kind}-preview.png`)
    expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toEqual(oldDraft)

    const [saved] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === SAVE_DRAFT),
      preview.getByRole('button', { name: 'Attach comparison', exact: true }).click(),
    ])
    const receipt = await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })
    if (receipt === null) throw new Error(`Missing draft after locking the ${kind} import`)
    expect(receipt.facts).toEqual(facts)
    expect(receipt.receiptId).not.toBe(oldDraft?.receiptId)
    expect(await saved.json()).toMatchObject({ result: { ok: true, value: receipt } })
    await preview.waitFor({ state: 'hidden' })
    await reload(async () => {
      await expectImportedAttribution(chip, kind)
      expect(await draftToggle.getAttribute('aria-expanded')).toBe('false')
      expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toEqual(receipt)
      await screenshot(chip, `csv-import-attribution-${kind}-locked-draft.png`)
      await draftToggle.click()
      await expectImportedAttribution(chip, kind)
      await inspectImportedEvidence(chip, kind)
      await draftToggle.click()
    })
  }

  await reload(async () => {
    for (const { sent, kind } of entries) {
      const history = card(sent)
      await expectImportedAttribution(history, kind)
      expect(await toggle(history).getAttribute('aria-expanded')).toBe('false')
      await toggle(history).click()
      await expectImportedAttribution(history, kind)
      await inspectImportedEvidence(history, kind)
      await screenshot(history, `csv-import-attribution-${kind}-sent-history.png`)
      await toggle(history).click()
    }
  })

  await report({ imports: entries.map(({ kind, sent }) => ({ kind, sent, label: importedLabels[kind] })),
    allExactPagesReplayed: true, visibleInPreviewAndLockedDraftAndHistory: true }, entries.flatMap(() => [IMPORT_CSV, SAVE_DRAFT]))
})

it.skipIf(webSnapshotMode() === 'record')('returns to the exact CSV explanation step after refreshing each source', async () => {
  const { fixture, conversation, card, storedTrail, storedTrailData, screenshot, reload, report }
    = await openExplanationReplay('csv-explanation-return', seedWitnessedCsvExplanation)
  const { sessionId, alternate, filtered, explanation } = fixture
  const pair = card(explanation)
  const step = (kind: ExplanationStep): Locator => explanationStep(pair, kind)
  const sourceButton = (kind: ExplanationStep): Locator => step(kind).locator('[data-csv-explanation-source]')
  const returns = conversation.locator('[data-csv-return-to-explanation]')

  for (const [kind, address] of [['aggregation', alternate], ['filtering', filtered]] as const) {
    const target = card(address)
    const back = target.getByRole('button', { name: 'Return to two-step explanation', exact: true })
    await toggle(pair).click()
    await expectPairedStep(step(kind), kind)
    await sourceButton(kind).click()
    await back.waitFor({ state: 'visible' })
    await expectSource(target, kind === 'filtering')
    await expectFocused(toggle(target))
    await expect.poll(storedTrailData).toEqual({ sessionId, trail: [{
      source: { eventSeq: address.eventSeq, messageId: address.messageId },
      origin: { kind: 'explanation', message: { eventSeq: explanation.eventSeq, messageId: explanation.messageId }, step: kind },
    }] })
    await reload(async () => {
      await back.waitFor({ state: 'visible' })
      expect(await returns.count()).toBe(1)
      expect(await toggle(pair).getAttribute('aria-expanded')).toBe('false')
      await expectSource(target, kind === 'filtering')
      await expectFocused(toggle(target))
    })
    await screenshot(target, `csv-explanation-${kind}-source-after-refresh.png`)
    if (kind === 'aggregation') await back.click()
    else await back.press('Enter')
    await expectFocused(sourceButton(kind))
    expect(await toggle(pair).getAttribute('aria-expanded')).toBe('true')
    await expectPairedStep(step(kind), kind)
    await expect.poll(() => returns.count()).toBe(0)
    await expect.poll(storedTrail).toBeNull()
    await screenshot(step(kind), `csv-explanation-returned-to-${kind}.png`)
    await reload(async () => {
      await toggle(pair).waitFor({ state: 'visible' })
      for (const saved of [explanation, alternate, filtered]) expect(await toggle(card(saved)).getAttribute('aria-expanded')).toBe('false')
      expect(await returns.count()).toBe(0)
      expect(await storedTrail()).toBeNull()
    })
  }

  await toggle(card(filtered)).click()
  await expectSource(card(filtered), true)
  expect(await returns.count()).toBe(0)
  await report({ explanation, aggregation: alternate, filtering: filtered,
    bothRestoredAfterReload: true, eachReturnFocusedItsStep: true, eachPostReturnReloadClean: true })
})

it.skipIf(webSnapshotMode() === 'record')('returns to either exact CSV return link after refreshing its source', async () => {
  const { fixture, conversation, card, storedTrail, storedTrailData, screenshot, reload, report }
    = await openExplanationReplay('csv-inquiry-comparison-return', seedWitnessedCsvReturnComparison)
  const { sessionId, sent, returns } = fixture
  const comparison = card(sent)
  const returnButtons = conversation.locator('[data-csv-return-to-comparison]')
  for (const { side, address, source, sourceControl, back, checkSource } of frozenCsvReturnCards(conversation, returns, 'comparison')) {
    await toggle(comparison).click()
    await expectWarmReturnComparison(comparison)
    await csvReturnLink(comparison, side).click()
    await checkSource()
    await expect.poll(storedTrailData).toEqual({ sessionId, trail: [{
      source: { eventSeq: address.eventSeq, messageId: address.messageId },
      origin: { kind: 'returned-comparison', message: { eventSeq: sent.eventSeq, messageId: sent.messageId }, side },
    }] })
    await reload(async () => {
      await checkSource()
      expect(await toggle(comparison).getAttribute('aria-expanded')).toBe('false')
    })
    await screenshot(source, `csv-inquiry-comparison-${side}-source-after-refresh.png`)
    if (side === 'first') await back.click()
    else await back.press('Enter')
    await expectFocused(csvReturnLink(comparison, side))
    expect(await toggle(comparison).getAttribute('aria-expanded')).toBe('true')
    await expectWarmReturnComparison(comparison)
    await expect.poll(storedTrail).toBeNull()
    expect(await returnButtons.count()).toBe(0)
    await screenshot(comparison, `csv-inquiry-comparison-returned-to-${side}.png`)
    await reload(async () => {
      await toggle(comparison).waitFor({ state: 'visible' })
      expect(await toggle(comparison).getAttribute('aria-expanded')).toBe('false')
      expect(await sourceControl.getAttribute('aria-expanded')).toBe('false')
      expect(await returnButtons.count()).toBe(0)
    })
  }
  await report({ sent, returns, restoredEachSourceAfterRefresh: true, focusedEachExactLinkOnReturn: true,
    eachPostReturnReloadClean: true })
})

it.skipIf(webSnapshotMode() === 'record')('restores the unsent CSV return comparison draft from either refreshed source', async () => {
  const { world, fixture, page, conversation, screenshot, reload, report }
    = await openExplanationReplay('csv-inquiry-comparison-draft-return', seedWitnessedCsvReturnComparisonDraft)
  const text = 'Use both locked Warm readings in this unsent comparison question.'
  const selections = await visitCsvReturnDraftSources({ world, page, conversation, ...fixture, text, reload, screenshot })
  await report({ returns: fixture.returns, comparison: fixture.draft.facts.comparison, draftText: text,
    exactSelectionAfterEachReturn: selections, sameReceiptAfterEachReturn: true,
    restoredEachSourceAfterRefresh: true, eachPostReturnReloadClean: true, noPromptSent: true })
})

it.skipIf(webSnapshotMode() === 'record')('returns from both refreshed CSV explanation sources to the exact unsent draft selection', async () => {
  const { world, fixture, page, conversation, card, screenshot, reload, report }
    = await openExplanationReplay('csv-explanation-draft-return', seedWitnessedCsvExplanationDraft)
  const { sessionId, alternate, filtered, draft } = fixture
  const text = 'Keep my unsent question about both locked CSV calculations.'
  await writeComposerDraft(page, conversation.locator('[data-composer-input]'), text)
  const selections = await visitCsvExplanationDraftSources({ page, world, sessionId, conversation, card,
    sources: { aggregation: alternate, filtering: filtered }, draft, text, reload, screenshot, reloadAfterReturn: true,
  })
  await report({ aggregation: alternate, filtering: filtered, draftText: text, sameReceiptAfterEachReturn: true,
    exactSelectionAfterEachReturn: selections, bothRestoredAfterReload: true, eachPostReturnReloadClean: true })
})

type IdenticalImportedSourceFixture = Awaited<ReturnType<typeof seedIdenticalImportedCsvExplanationSources>>

async function visitExactImportedDuplicate({ name, seed, inspect, reuseLabel, sourceKind, draftText }: {
  name: string
  seed: (world: WebScaffold, id: string) => Promise<IdenticalImportedSourceFixture>
  inspect: typeof inspectImportedPair
  reuseLabel: string
  sourceKind: 'imported-explanation' | 'imported-return-comparison'
  draftText: string
}): Promise<void> {
  const { world, fixture, page, conversation, card, storedTrail, storedTrailData, screenshot, reload, report }
    = await openExplanationReplay(name, seed)
  const { sessionId, first, second, reused, reusedFacts } = fixture
  const firstCard = card(first)
  const secondCard = card(second)
  const reusedCard = card(reused)
  const selection = { start: 8, end: 19 }
  const stepShots = (phase: string) => async (detail: Locator, kind: string): Promise<void> => {
    await detail.evaluate((element) => { element.scrollIntoView({ block: 'center' }) })
    await screenshot(detail, `${name}-${phase}-${kind}.png`)
  }
  const sourceButton = (scope: Locator): Locator => scope.getByRole('button', { name: 'View source question', exact: true })
    .and(scope.locator('[data-csv-view-source-question]'))
  const expectExactSecond = async (phase: string): Promise<void> => {
    await expect.poll(() => toggle(secondCard).getAttribute('aria-expanded')).toBe('true')
    await expectFocused(toggle(secondCard))
    expect(await toggle(firstCard).getAttribute('aria-expanded')).toBe('false')
    await inspect(secondCard, stepShots(phase))
    await screenshot(secondCard, `${name}-${phase}.png`)
  }
  expect(first.messageId).not.toBe(second.messageId)
  expect(first.eventSeq).not.toBe(second.eventSeq)
  const events = await readPersistedEvents(world, sessionId)
  const originals = events.flatMap(event => event.type === 'user/message'
    && (event.seq === first.eventSeq || event.seq === second.eventSeq) ? [event.data.content] : [])
  expect(originals).toHaveLength(2)
  expect(originals[1]).toEqual(originals[0])
  expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toBeNull()
  await toggle(secondCard).click()
  await secondCard.getByRole('button', { name: reuseLabel, exact: true }).click()
  const review = secondCard.locator('[data-csv-compare-review]')
  await inspect(review, stepShots('review'))
  expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toBeNull()
  const [reviewed, saved] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === REVIEW_SENT),
    page.waitForResponse(response => new URL(response.url()).pathname === SAVE_DRAFT),
    review.getByRole('button', { name: 'Attach comparison', exact: true }).click(),
  ])
  expect(reviewed.request().postDataJSON()).toMatchObject({ payload: { args: { request: second } } })
  expect(await reviewed.json()).toMatchObject({ result: { ok: true, value: { facts: reusedFacts } } })
  const receipt = await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })
  if (receipt === null) throw new Error('The reused imported draft was not saved')
  expect(receipt.facts).toEqual(reusedFacts)
  expect(await saved.json()).toMatchObject({ result: { ok: true, value: receipt } })
  const chip = conversation.locator('[data-artifact-prompt-context="csv-question-comparison"]')
  const input = conversation.locator('[data-composer-input][contenteditable="true"]')
  await chip.waitFor({ state: 'visible' })
  await writeComposerDraft(page, input, draftText)
  await reload(async () => {
    await expect.poll(() => input.textContent()).toBe(draftText)
    expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toEqual(receipt)
    await chip.getByRole('button', { name: 'Review attached comparison', exact: true }).click()
    await inspect(chip, stepShots('draft-after-refresh'), true)
    expect(await toggle(secondCard).getAttribute('aria-expanded')).toBe('false')
  })
  await selectDraftOffsets(page, input, selection)
  await sourceButton(chip).click()
  await expectExactSecond('from-draft')
  const exactSource = { eventSeq: second.eventSeq, messageId: second.messageId }
  const draftVisit = { source: exactSource, sourceKind, origin: { kind: 'draft', receiptId: receipt.receiptId, ...selection } }
  await expect.poll(storedTrailData).toMatchObject({ sessionId, trail: [draftVisit] })
  await reload(async () => { await expectExactSecond('draft-source-after-refresh') })
  await secondCard.getByRole('button', { name: 'Return to draft', exact: true }).click()
  await expect.poll(() => selectedDraftOffsets(input)).toEqual(selection)
  await expect.poll(() => input.textContent()).toBe(draftText)
  expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toEqual(receipt)
  await expect.poll(storedTrail).toBeNull()
  await reload(async () => {
    await toggle(reusedCard).click()
    await inspect(reusedCard, stepShots('history-after-refresh'), true)
    expect(await toggle(secondCard).getAttribute('aria-expanded')).toBe('false')
  })
  await sourceButton(reusedCard).click()
  await expectExactSecond('from-history')
  await expect.poll(storedTrailData).toEqual({ sessionId, trail: [{ source: exactSource, sourceKind,
    origin: { kind: 'comparison', message: { eventSeq: reused.eventSeq, messageId: reused.messageId } } }] })
  await reload(async () => { await expectExactSecond('history-source-after-refresh') })
  await secondCard.getByRole('button', { name: 'Return to comparison', exact: true }).click()
  await expectFocused(toggle(reusedCard))
  await inspect(reusedCard, stepShots('returned-to-history'), true)
  await expect.poll(storedTrail).toBeNull()
  expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toEqual(receipt)
  await expect.poll(() => input.textContent()).toBe(draftText)
  await report({ first, second, reused, exactSource, sourceKind, draftRestoredAfterReload: true, exactDraftSelection: selection,
    bothOriginalPagesVerified: true, firstNeverOpened: true, exactHistoryComparisonRestored: true }, [REVIEW_SENT, SAVE_DRAFT])
}

it.skipIf(webSnapshotMode() === 'record')('reopens the exact reused imported explanation among identical history questions', async () => {
  await visitExactImportedDuplicate({ name: 'csv-imported-reuse-explanation-source', seed: seedIdenticalImportedCsvExplanationSources,
    inspect: inspectImportedPair, reuseLabel: 'Reuse entire explanation', sourceKind: 'imported-explanation',
    draftText: 'Use the second imported explanation in this draft.' })
})

it.skipIf(webSnapshotMode() === 'record')('reopens the exact reused imported return comparison among identical history questions', async () => {
  await visitExactImportedDuplicate({ name: 'csv-imported-reuse-return-source', seed: seedIdenticalImportedCsvReturnSources,
    inspect: inspectImportedReturns, reuseLabel: 'Reuse entire return comparison', sourceKind: 'imported-return-comparison',
    draftText: 'Use the second imported return comparison in this draft.' })
})

type ImportedChainFixture = Awaited<ReturnType<typeof seedImportedCsvExplanationSourceChain>> & { decoy?: CsvAddress }

async function visitImportedSourceChain({ name, seed, inspect, sourceKind, draftText }: {
  name: string
  seed: (world: WebScaffold, id: string) => Promise<ImportedChainFixture>
  inspect: typeof inspectImportedPair
  sourceKind: 'imported-explanation' | 'imported-return-comparison'
  draftText: string
}): Promise<void> {
  const { world, fixture, page, conversation, card, storedTrail, screenshot, reload, report }
    = await openExplanationReplay(name, seed)
  const { sessionId, first, middle, latest, draft, decoy } = fixture
  const address = ({ eventSeq, messageId }: CsvAddress) => ({ eventSeq, messageId })
  const firstCard = card(first)
  const middleCard = card(middle)
  const latestCard = card(latest)
  const chip = conversation.locator('[data-artifact-prompt-context="csv-question-comparison"]')
  const input = conversation.locator('[data-composer-input][contenteditable="true"]')
  const expectedCaret = draftText.length - 7
  const selection = { start: expectedCaret, end: expectedCaret }
  const shots = (phase: string) => async (detail: Locator, part: string): Promise<void> => {
    await detail.evaluate((element) => { element.scrollIntoView({ block: 'center' }) })
    await screenshot(detail, `${name}-${phase}-${part}.png`)
  }
  const checkDraft = async (): Promise<void> => {
    await expect.poll(() => input.textContent()).toBe(draftText)
    expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toEqual(draft)
  }
  const checkDecoy = async (): Promise<void> => {
    if (decoy !== undefined) expect(await toggle(card(decoy)).getAttribute('aria-expanded')).toBe('false')
  }
  const inspectDraft = async (phase: string): Promise<void> => {
    const review = chip.getByRole('button', { name: 'Review attached comparison', exact: true })
    if (await review.getAttribute('aria-expanded') !== 'true') await review.click()
    await inspect(chip, shots(phase), true)
  }
  if (decoy !== undefined) {
    expect(address(decoy)).not.toEqual(address(first))
    const history = await readPersistedEvents(world, sessionId)
    const identical = history.flatMap(event => event.type === 'user/message'
      && (event.seq === decoy.eventSeq || event.seq === first.eventSeq) ? [event.data.content] : [])
    expect(identical).toHaveLength(2)
    expect(identical[1]).toEqual(identical[0])
    await checkDecoy()
  }
  await writeComposerDraft(page, input, draftText)
  await inspectDraft('draft-before-navigation')
  await selectDraftOffsets(page, input, selection)
  const chain = { page, conversation, sessionId, first, middle, decoy, sourceKind, reload, inspect, screenshot, checkDraft }
  await walkImportedCsvSourceChain({ ...chain, origin: { kind: 'draft', receiptId: draft.receiptId }, name: name + '-draft' })
  await expect.poll(() => selectedDraftOffsets(input)).toEqual(selection)
  await checkDraft()
  await expect.poll(storedTrail).toBeNull()
  await screenshot(conversation.locator('[data-composer-seat]'), `${name}-restored-draft.png`)
  await inspectDraft('restored-draft-attachment')

  await reload(async () => {
    await toggle(latestCard).click()
    await checkDraft()
  })
  await walkImportedCsvSourceChain({ ...chain, origin: { kind: 'comparison', message: address(latest) }, name: name + '-history' })
  await reload(async () => {
    await checkDraft()
    for (const target of [firstCard, middleCard, latestCard]) expect(await toggle(target).getAttribute('aria-expanded')).toBe('false')
    await checkDecoy()
    expect(await storedTrail()).toBeNull()
    expect(await conversation.locator('[data-csv-return-to-comparison], [data-csv-return-to-draft]').count()).toBe(0)
  })
  await inspectDraft('draft-after-clean-refresh')
  await report({ first, middle, latest, decoy, sourceKind, sameDraftReceiptAfterReturns: true, exactSelectionAfterReturn: expectedCaret,
    bothSourcePagesInspected: true, sourceVisitsRestoredAfterRefresh: true,
    steppedBackToBothOrigins: true, noSourceReopenedAfterReturns: true })
}

it.skipIf(webSnapshotMode() === 'record')('restores the full source chain of an imported explanation from draft and history', async () => {
  await visitImportedSourceChain({ name: 'csv-imported-explanation-full-chain', seed: seedImportedCsvExplanationSourceChain,
    inspect: inspectImportedPair, sourceKind: 'imported-explanation',
    draftText: 'Keep this exact unsent question while I check both earlier two-step explanations.' })
})

it.skipIf(webSnapshotMode() === 'record')('restores the full source chain of an imported return comparison from draft and history', async () => {
  await visitImportedSourceChain({ name: 'csv-imported-return-full-chain', seed: seedImportedCsvReturnSourceChain,
    inspect: inspectImportedReturns, sourceKind: 'imported-return-comparison',
    draftText: 'Keep my unsent question while I inspect both earlier imported return comparisons.' })
})
