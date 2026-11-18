// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { acknowledgeReloadConnectionLoss, assertFixtureInventory, launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const fixture = fileURLToPath(new URL('./fixtures/replay/csv-filtered-question-replay', import.meta.url))
const fixtureName = 'session.v4.jsonl'

async function expectSourceLookupFailure(page: Page, panel: Locator, opener: Locator, endpoint: string, alert: RegExp): Promise<void> {
  const retry = panel.getByRole('button', { name: 'Retry', exact: true })
  for (const trigger of [opener, retry]) {
    const [response] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === `/api/artifactBranchResults/${endpoint}`),
      trigger.click(),
    ])
    expect(await response.json()).toMatchObject({ result: { ok: false } })
    await expect.poll(() => panel.getByRole('alert').textContent()).toMatch(alert)
    expect(await panel.getByRole('table').count()).toBe(0)
    expect(await retry.isEnabled()).toBe(true)
  }
}

async function expectReplayReading(replay: Locator, readings: Readonly<Record<string, string>>): Promise<void> {
  await expect.poll(() => replay.locator('[data-csv-reading="value"]').textContent()).toBe(readings.value)
  for (const [field, value] of Object.entries(readings)) {
    expect(await replay.locator(`[data-csv-reading="${field}"]`).textContent()).toBe(value)
  }
}

it.skipIf(webSnapshotMode() === 'record')('keeps the returned and locked CSV readings when source lookups fail', async () => {
  await assertFixtureInventory(fixture, [fixtureName])
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  const session = await seedSession(scaffold, await readFile(join(fixture, fixtureName), 'utf8'), 'csv-filtered-question-replay', 'chat')
  await workspace.attachSession(session)
  const executablePath = process.env.AGENTRANS_PLAYWRIGHT_EXECUTABLE_PATH
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.locator(`[data-row-key="session:${session}"]`).click()
  const question = page.locator('[data-chat-flow-kind="user"]:visible').filter({ hasText: 'Summarize my confirmed filtered latency.' })
  await question.waitFor({ state: 'visible' })
  const warnings = console.warnings.length
  await page.reload()
  const evidence = page.locator('[data-artifact-branch-evidence-item="question"]:visible')
  await evidence.getByRole('button', { name: 'Replay experiment', exact: true }).click()
  const original = evidence.locator('[data-artifact-question-replay-id="trial-latency"]')
  await question.getByRole('button', { name: 'Replay experiment', exact: true }).click()
  const replay = question.locator('[data-artifact-question-replay-id="continued-csv-11111111111111111111111111111111"]')
  const rowsAlert = /could not load participating rows/iu
  await expectSourceLookupFailure(page, original.locator('[data-csv-participating-rows]'),
    original.locator('[data-csv-participating-rows-open]'), 'csvReturnedParticipatingRows', rowsAlert)
  await expectSourceLookupFailure(page, replay.locator('[data-csv-participating-rows]'),
    replay.locator('[data-csv-participating-rows-open]'), 'csvQuestionParticipatingRows', rowsAlert)
  await expectSourceLookupFailure(page, replay.locator('[data-csv-compare]'),
    replay.getByRole('button', { name: 'Compare with original return', exact: true }), 'compareCsvQuestionToReturn', /could not load the comparison/iu)
  await expectReplayReading(original, { key: 'Warm', aggregate: 'Mean of LatencyMs', value: '30', count: '2' })
  expect(await original.locator('[data-csv-reading="filter"]').count()).toBe(0)
  await expectReplayReading(replay, { key: 'Warm', aggregate: 'Sum of LatencyMs', value: '35', count: '1', filter: 'Batch = B' })
  expect(await page.getByRole('complementary', { name: 'Artifact: Filtered sample latency', exact: true }).count()).toBe(0)
  acknowledgeReloadConnectionLoss(console, warnings)
  expect(console.warnings).toEqual([])
  expect(console.pageErrors).toEqual([])
})
