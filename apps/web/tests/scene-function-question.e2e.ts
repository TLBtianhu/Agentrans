// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {} from '@agentrans/artifact/types'
import { parseSessionLog } from '@agentrans/llm-replay'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifySentPlotDownload } from './artifact-sent-plot-download-support.ts'
import { createCsvHistoryControls, interceptCsvHistorySnapshot } from './csv-source-retry-browser.ts'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory,
  launchWebScaffold, readPersistedEvents, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

const DIR = fileURLToPath(new URL('./fixtures/replay/scene-function-question', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const TWO_FUNCTIONS = join(DIR, 'two-functions.override.json')
const TITLE = 'Slope and area lab'
const ARTIFACT_ID = 'function-question-line'

describe.skipIf(webSnapshotMode() === 'record')('web e2e: function readings in a question', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    process.env.AGENTRANS_TEST_CUSTOM_KEY = 'local-test-key'
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE, replayOverride: TWO_FUNCTIONS, compareReplaySession: false, paceMs: 10,
      extraOverlayPath: fileURLToPath(new URL('./teaching-custom-provider.overlay.yml', import.meta.url)),
      replayProviders: [{ id: 'custom-provider', name: 'Custom Lab',
        models: [{ id: 'user-model', name: 'Custom Lab Model', contextWindow: 8192 }] }],
    })
    const executablePath = process.env.AGENTRANS_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  })

  afterAll(async () => {
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally { delete process.env.AGENTRANS_TEST_CUSTOM_KEY }
    }
  })

  it('recovers a locked second function after a history read fails, then downloads it after a source revision', async () => {
    const prompts = parseSessionLog(await readFile(FIXTURE, 'utf8')).flatMap((event) => {
      if (event.type !== 'user/message' || event.data.source.kind !== 'user') return []
      const block = event.data.content[0]
      return block?.type === 'text' ? [block.text] : []
    })
    expect(prompts).toHaveLength(2)
    const input = page.locator('[data-composer-input]').first()
    const card = page.getByRole('complementary', { name: `Artifact: ${TITLE}`, exact: true })
    const canvas = card.getByRole('img', { name: 'Interactive function plot', exact: true })
    const step = card.getByRole('button', { name: 'Step', exact: true })
    const liveParameter = card.locator('label').filter({ hasText: /^Parameter a\b/ }).locator('output')
    const review = card.getByRole('region', { name: 'Review function readings', exact: true })
    const choice = page.locator('[data-artifact-prompt-context="current-function-plot"]:visible')
    const visibleNumber = async (selector: string): Promise<number> => {
      const text = await review.locator(selector).textContent()
      if (text === null || text.trim() === '') throw new Error(`Missing reviewed number in ${selector}`)
      return Number(text)
    }
    const readouts = async () => ({
      x: await visibleNumber('[data-function-question-value="x"]'),
      parameters: { a: await visibleNumber('[data-function-question-parameter="a"]') },
      values: {
        value: await visibleNumber('[data-function-question-value="value"]'),
        derivative: await visibleNumber('[data-function-question-value="derivative"]'),
        integral: await visibleNumber('[data-function-question-value="integral"]'),
      },
    })
    const cardTurn = () => card.evaluate(element => element.closest('[data-chat-turn]')?.getAttribute('data-chat-turn'))
    const first = scaffold.whenTurnSettled()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await first
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Function question Session is not live')
    const events = () => agent.session.snapshotEvents()
    const initialSystem = events().find(event => event.type === 'system/message')
    const guidance = initialSystem?.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(guidance).toContain('For explanations, answer directly in text when that is sufficient.')
    expect(guidance).toContain('A derivative at one point is a text answer.')
    expect(guidance).toContain('use the native scene tool directly.')
    const turns = () => events().filter(event => event.type === 'turn/start').length
    const questions = () => events().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user' ? [event.data] : [])
    const revisions = () => events().flatMap(event => event.type === 'artifact/upsert' ? [event.data] : [])

    await canvas.waitFor({ state: 'visible' })
    expect(await cardTurn()).toBe('1')
    expect(await card.getAttribute('data-placement')).toBe('inline')
    await card.getByRole('combobox', { name: 'Trace function', exact: true }).selectOption('scaled')
    await step.click()
    await expect.poll(() => liveParameter.textContent()).toBe('1.25')
    await card.getByRole('button', { name: 'Use for next question', exact: true }).click()
    await review.waitFor({ state: 'visible' })
    const readings = await readouts()
    expect(readings).toMatchObject({ x: 1, parameters: { a: 1.25 }, values: { value: 2.5 } })
    expect(readings.values.derivative).toBeCloseTo(2.5, 10)
    expect(readings.values.integral).toBeCloseTo(1.25, 10)
    expect(await choice.count()).toBe(0)

    await step.click()
    await expect.poll(() => liveParameter.textContent()).toBe('1.50')
    expect(await readouts()).toEqual(readings)
    await review.getByRole('button', { name: 'Attach readings', exact: true }).click()
    await choice.waitFor({ state: 'visible' })
    await step.click()
    await expect.poll(() => liveParameter.textContent()).toBe('1.75')
    expect(turns()).toBe(1)
    expect(questions()).toHaveLength(1)

    const upsert = events().find(event => event.type === 'artifact/upsert')
    if (upsert === undefined) throw new Error('Expected the revision the draft refers to')
    const cutoff = upsert.seq + 1
    const savedDraft = () => page.evaluate(id => sessionStorage.getItem(`dsh.artifact.function-plot-draft.v1.${id}`), sessionId)
    const originalDraft = await savedDraft()
    if (originalDraft === null) throw new Error('Expected the locked readings in this tab before reload')
    const beforeRestore = await readPersistedEvents(scaffold, sessionId)
    const edited = await interceptCsvHistorySnapshot(page, sessionId, snapshot => ({
      ...snapshot, records: snapshot.records.filter(record => record.event.seq >= cutoff), hasMore: true,
    }))
    const history = createCsvHistoryControls(page, sessionId, cutoff)
    await page.route(history.pageHistoryPattern, history.rejectEarlierPage)
    const restoreWarnings = tripwire.warnings.length
    try {
      await page.reload()
      await expect.poll(edited).toBe(1)
      await expect.poll(history.unavailableEarlierPages).toBe(1)
      const retry = choice.getByRole('button', { name: 'Retry loading readings', exact: true })
      await retry.waitFor({ state: 'visible' })
      await input.fill(prompts[1]!)
      const send = page.getByRole('button', { name: 'Send message', exact: true })
      expect(await send.isEnabled()).toBe(false)
      expect(await savedDraft()).toBe(originalDraft)
      expect(await readPersistedEvents(scaffold, sessionId)).toEqual(beforeRestore)

      await page.unroute(history.pageHistoryPattern, history.rejectEarlierPage)
      await retry.click()
      await retry.waitFor({ state: 'hidden' })
      await canvas.waitFor({ state: 'visible' })
      await expect.poll(() => send.isEnabled()).toBe(true)
      await expect.poll(() => choice.textContent()).toContain('Revision 1 · x = 1')
      expect(await savedDraft()).toBe(originalDraft)
      expect(await readPersistedEvents(scaffold, sessionId)).toEqual(beforeRestore)
      acknowledgeReloadConnectionLoss(tripwire, restoreWarnings)
    } finally { await page.unroute(history.pageHistoryPattern, history.rejectEarlierPage) }

    const second = scaffold.whenTurnSettled()
    await input.fill(prompts[1]!)
    await input.press('Enter')
    expect(await second).toBe(sessionId)
    await expect.poll(() => card.getAttribute('data-artifact-revision')).toBe('2')
    expect(await cardTurn()).toBe('2')
    expect(await card.getAttribute('data-placement')).toBe('inline')
    await canvas.waitFor({ state: 'visible' })
    await card.getByText('Offset line', { exact: true }).filter({ visible: true }).first().waitFor({ state: 'visible' })
    await expect.poll(() => liveParameter.textContent()).toBe('2.00')
    expect(revisions().map(revision => [revision.artifactId, revision.revision])).toEqual([[ARTIFACT_ID, 1], [ARTIFACT_ID, 2]])

    const question = events().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
    const source = revisions()[0]
    if (question?.type !== 'user/message' || source?.format !== 'scene' || source.spec.kind !== 'function-plot') {
      throw new Error('The locked question and its original function plot must be in history')
    }
    const address = { eventSeq: question.seq, messageId: question.data.id }
    expect(question.data.content).toHaveLength(2)
    const attachment = question.data.content[1]
    if (attachment?.type !== 'text') throw new Error('The second question has no function readings')
    expect(attachment.text).toContain('Derivative and integral readings are numerical approximations.')
    expect(JSON.parse(attachment.text.slice(attachment.text.indexOf('\n') + 1))).toEqual({
      kind: 'artifact-question-context', sessionId,
      facts: { kind: 'current-function-plot', artifact: revisions()[0], functionId: 'scaled', ...readings },
    })
    expect(events().filter(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action')).toEqual([])

    const warningStart = tripwire.warnings.length
    await page.reload()
    await page.getByText(prompts[1]!, { exact: true }).waitFor({ state: 'visible' })
    await canvas.waitFor({ state: 'visible' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(await card.getAttribute('data-artifact-revision')).toBe('2')
    expect(await cardTurn()).toBe('2')
    expect(await choice.count()).toBe(0)

    const historicalQuestion = page.locator(`[data-chat-message-id="${address.messageId}"][data-chat-message-seq="${address.eventSeq}"]:visible`)
      .filter({ hasText: prompts[1]! })
    const displayed = historicalQuestion.locator('details[data-artifact-question-context]')
    const toggle = historicalQuestion.getByRole('button', { name: 'Replay experiment', exact: true })
    const replay = historicalQuestion.locator('[data-artifact-question-replay-panel]')
    await toggle.waitFor({ state: 'visible' })
    expect(await displayed.getAttribute('open')).toBeNull()
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    expect(await replay.isVisible()).toBe(false)
    const savedEvents = await readPersistedEvents(scaffold, sessionId)
    const existingRoots = scaffold.ctx.agents.roots().map(root => root.id)
    await verifySentPlotDownload({
      browser, page, card: historicalQuestion, directory: scaffold.workspaceCwd, sessionId, question: address,
      source: { ...source, spec: source.spec }, baseline: { functionId: 'scaled', ...readings },
    })
    expect(await readPersistedEvents(scaffold, sessionId)).toEqual(savedEvents)
    expect(scaffold.ctx.agents.roots().map(root => root.id)).toEqual(existingRoots)
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    await toggle.press('Space')
    const replayCanvas = replay.getByRole('img', { name: 'Function plot preview', exact: true })
    await replayCanvas.waitFor({ state: 'visible' })
    const canvasBox = await replayCanvas.boundingBox()
    if (canvasBox === null) throw new Error('Function replay canvas has no visible bounds')
    await expect.poll(async () => Number(await replayCanvas.getAttribute('width'))).toBe(Math.round(canvasBox.width))
    await expect.poll(async () => Number(await replayCanvas.getAttribute('height'))).toBeGreaterThanOrEqual(Math.round(canvasBox.height))
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    const panelId = await replay.getAttribute('id')
    expect(panelId).toBeTruthy()
    expect(await toggle.getAttribute('aria-controls')).toBe(panelId)
    await replay.locator(`[data-artifact-question-replay-id="${ARTIFACT_ID}"][data-artifact-question-replay-revision="1"]`)
      .waitFor({ state: 'visible' })
    expect(await replay.locator('[data-function-id="scaled"][data-current]').innerText()).toBe('Scaled line')
    expect(await replay.locator('[data-function-source-parameter="a"]').innerText()).toBe(String(readings.parameters.a))
    for (const [field, value] of Object.entries({ x: readings.x, ...readings.values })) {
      expect(await replay.locator(`[data-function-source-value="${field}"]`).innerText()).toBe(String(value))
    }
    expect(await replay.getByRole('button', { name: 'Step', exact: true }).count()).toBe(0)
    expect(await replay.getByRole('button', { name: 'Use for next question', exact: true }).count()).toBe(0)
    expect(await replay.getByRole('slider').count()).toBe(0)
    expect(await displayed.getAttribute('open')).toBeNull()
    expect(await card.getAttribute('data-artifact-revision')).toBe('2')
    expect(await liveParameter.textContent()).toBe('2.00')
    await toggle.click()
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    expect(await replay.isVisible()).toBe(false)

    await page.getByText('Revision history', { exact: true }).click()
    await page.getByRole('button', { name: 'View revision 1', exact: true }).click()
    const previous = page.getByRole('region', { name: `Artifact revision 1: ${TITLE}`, exact: true })
    await previous.getByRole('img', { name: 'Function plot preview', exact: true }).waitFor({ state: 'visible' })
    await previous.getByText('Linear', { exact: true }).waitFor({ state: 'visible' })
    expect(await previous.locator('[data-function-source-parameter="a"]').textContent()).toBe('1')
    const previousValue = previous.getByText('f(x)', { exact: true }).locator('..').getByText('1.000', { exact: true })
    await previousValue.waitFor({ state: 'visible' })
    expect(await previous.getAttribute('data-artifact-history-revision')).toBe('1')
    expect(await previous.getByRole('button', { name: 'Step', exact: true }).count()).toBe(0)
    expect(await previous.getByRole('button', { name: 'Use for next question', exact: true }).count()).toBe(0)
    expect(await card.getAttribute('data-artifact-revision')).toBe('2')
    await displayed.locator('summary').click()
    expect(await displayed.locator('[data-artifact-question-context-raw]').textContent()).toBe(attachment.text)
    expect(turns()).toBe(2)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl', 'two-functions.override.json'])
  }, 120_000)
})
