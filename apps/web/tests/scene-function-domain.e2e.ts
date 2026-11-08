// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertFixtureInventory, fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

const DIR = fileURLToPath(new URL('./fixtures/replay/scene-function-domain', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const LABEL = '</script><script>globalThis.sceneExportProbe=1</script><img src=x onerror="globalThis.sceneExportProbe=2">'

describe.skipIf(webSnapshotMode() === 'record')('web e2e: function domain and animation export', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    process.env.AGENTRANS_TEST_CUSTOM_KEY = 'local-test-key'
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      compareReplaySession: false,
      paceMs: 10,
      extraOverlayPath: fileURLToPath(new URL('./teaching-custom-provider.overlay.yml', import.meta.url)),
      replayProviders: [{
        id: 'custom-provider', name: 'Custom Lab',
        models: [{ id: 'user-model', name: 'Custom Lab Model', contextWindow: 8192 }],
      }],
    })
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try {
        await scaffold?.close()
      } finally {
        delete process.env.AGENTRANS_TEST_CUSTOM_KEY
      }
    }
  })

  it('keeps a square-root boundary usable and exports model labels as text', async () => {
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(1)
    const firstTurn = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await firstTurn
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Function-domain Session is not live')

    const processControls = page.locator('[data-turn-process], [data-process-activity]')
    for (let index = 0; index < await processControls.count(); index++) {
      const control = processControls.nth(index)
      if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
    }
    await page.locator('canvas[aria-label="Interactive function plot"]:visible').last().waitFor({ state: 'visible' })
    await page.locator('span').filter({ hasText: LABEL }).first().waitFor({ state: 'visible' })
    expect(tripwire.pageErrors).toEqual([])

    const downloadReady = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export animation', exact: true }).click()
    const download = await downloadReady
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    const html = Buffer.concat(chunks).toString('utf8')
    const exportedContext = await browser.newContext()
    try {
      const requests: string[] = []
      await exportedContext.route('**/*', async (route) => {
        requests.push(route.request().url())
        await route.abort()
      })
      const exported = await exportedContext.newPage()
      const errors: string[] = []
      exported.on('pageerror', error => errors.push(error.message))
      await exported.setContent(html, { waitUntil: 'load' })
      expect(await exported.locator('#legend').textContent()).toBe(LABEL)
      expect(await exported.locator('img').count()).toBe(0)
      expect(await exported.evaluate(() => Object.hasOwn(globalThis, 'sceneExportProbe'))).toBe(false)
      await exported.locator('#scrub').fill('0.5')
      await exported.locator('#scrub').dispatchEvent('input')
      expect(errors).toEqual([])
      expect(requests).toEqual([])
    } finally {
      await exportedContext.close()
    }

    const secondTurn = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: 'Confirm analysis', exact: true }).click()
    expect(await secondTurn).toBe(sessionId)
    const actions = agent.session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'artifact-action' ? [event.data] : [])
    expect(actions).toHaveLength(1)
    const block = actions[0]?.content[0]
    if (block?.type !== 'text') throw new Error('Function-domain action did not contain text')
    expect(JSON.parse(block.text)).toMatchObject({
      artifactId: 'square-root-boundary', action: 'plot.inspected',
      payload: { x: 0, parameters: {}, derivative: null, integral: 0 },
    })
    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  })
})
