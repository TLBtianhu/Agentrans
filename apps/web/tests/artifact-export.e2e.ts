// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type Download } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, fixtureUserPrompts, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

const DIR = fileURLToPath(new URL('./fixtures/replay/artifact-export', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}

async function downloadedText(download: Download): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of await download.createReadStream()) {
    const bytes: unknown = chunk
    if (!(bytes instanceof Uint8Array)) throw new Error('Export did not contain binary chunks')
    chunks.push(Buffer.from(bytes))
  }
  return Buffer.concat(chunks).toString('utf8')
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: fixed-source Artifact export', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const requests: unknown[] = []
  let loseFirstSuccess = true

  beforeAll(async () => {
    process.env.AGENTRANS_TEST_CUSTOM_KEY = 'local-test-key'
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE, compareReplaySession: false, paceMs: 10,
      extraOverlayPath: fileURLToPath(new URL('./teaching-custom-provider.overlay.yml', import.meta.url)),
      replayProviders: [{ id: 'custom-provider', name: 'Custom Lab',
        models: [{ id: 'user-model', name: 'Custom Lab Model', contextWindow: 8192 }] }],
    })
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.route('**/api/artifactExports/create', async (route) => {
      const envelope: unknown = route.request().postDataJSON()
      requests.push(object(object(object(envelope).payload).args).input)
      const response = await route.fetch()
      try {
        const envelope: unknown = await response.json()
        if (object(object(envelope).result).ok === true && loseFirstSuccess) {
          loseFirstSuccess = false
          await route.abort('failed')
          return
        }
        await route.fulfill({ response })
      } finally { await response.dispose() }
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  })

  afterAll(async () => {
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally { delete process.env.AGENTRANS_TEST_CUSTOM_KEY }
    }
  })

  it('recovers a lost receipt and downloads the same saved source after revision changes and reload', async () => {
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    const input = page.locator('[data-composer-input]').first()
    const first = scaffold.whenTurnSettled()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await first
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Export Session is not live')
    const group = () => page.locator('section[data-comparison-group="saved-gravity-study"]:visible').last()
    const card = () => group().locator('[data-comparison-role="control"] section[data-artifact-revision]')
    const saved = () => card().locator('section[aria-label="Saved observations"] li')
      .filter({ has: page.getByText('Export A', { exact: true }) })
    const records = () => agent.session.snapshotEvents().flatMap(event => event.type === 'artifact/export' ? [event.data] : [])
    const processControls = page.locator('[data-turn-process], [data-process-activity]')
    for (let index = 0; index < await processControls.count(); index++) {
      const control = processControls.nth(index)
      if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
    }
    await card().locator('canvas[aria-label="Interactive particle simulation"]').waitFor({ state: 'visible' })
    for (let step = 0; step < 6; step++) await card().getByRole('button', { name: 'Step', exact: true }).click()
    await card().getByRole('textbox', { name: 'Observation name', exact: true }).fill('Export A')
    await card().getByRole('button', { name: 'Save observation', exact: true }).click()
    await saved().waitFor({ state: 'visible' })
    const observationId = await saved().getAttribute('data-observation-id')
    await saved().getByRole('button', { name: 'Use for comparison', exact: true }).click()
    await card().getByRole('button', { name: 'Export animation', exact: true }).click()
    await card().getByRole('button', { name: 'Retry export', exact: true }).waitFor({ state: 'visible' })
    expect(records().map(item => item.status)).toEqual(['pending', 'ready'])
    const original = records()[0]!
    const exportId = original.request.exportId
    expect(original.request.source).toEqual({ kind: 'observation', artifactId: 'gravity-control', observationId })
    expect(original.frozen.artifact.revision).toBe(1)
    expect(original.frozen.checkpoint).toEqual({ runtimeVersion: 1, stepCount: 6 })
    const downloadReady = page.waitForEvent('download')
    await card().getByRole('button', { name: 'Retry export', exact: true }).click()
    const originalHtml = await downloadedText(await downloadReady)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    expect(records().map(item => item.status)).toEqual(['pending', 'ready'])

    const update = scaffold.whenTurnSettled()
    await input.fill(prompts[1]!)
    await input.press('Enter')
    expect(await update).toBe(sessionId)
    await page.getByText('Both current sources are revision 2. The selected observations still describe revision 1.', { exact: true })
      .waitFor({ state: 'visible' })
    const warningStart = tripwire.warnings.length
    await page.reload()
    const row = () => card().locator(`[data-export-id="${exportId}"][data-export-status="ready"]`)
    await row().waitFor({ state: 'visible' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(await card().getAttribute('data-artifact-revision')).toBe('2')
    const secondDownload = page.waitForEvent('download')
    await row().getByRole('button', { name: 'Download HTML', exact: true }).click()
    expect(await downloadedText(await secondDownload)).toBe(originalHtml)
    expect(requests).toHaveLength(2)
    expect(records()).toHaveLength(2)
    const exported = await browser.newPage()
    try {
      const offlineRequests: string[] = []
      await exported.route('**/*', async (route) => { offlineRequests.push(route.request().url()); await route.abort() })
      await exported.setContent(originalHtml, { waitUntil: 'load' })
      expect(await exported.locator('#time').textContent()).toBe('0.20 s')
      const originText = await exported.locator('#artifact-export-origin-data').textContent()
      expect(object(JSON.parse(originText ?? 'null'))).toMatchObject({ exportId, sessionId, artifactId: 'gravity-control', revision: 1, observationId })
      expect(offlineRequests).toEqual([])
    } finally { await exported.close() }
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action')).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  })
})
