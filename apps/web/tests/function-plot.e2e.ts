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

const DIR = fileURLToPath(new URL('./fixtures/replay/function-plot', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: function plot Artifact', () => {
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

  it('changes function parameters and confirms the inspected analysis', async () => {
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(1)
    const firstTurn = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await firstTurn
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Function plot Session is not live')
    const session = agent.session

    const processControls = page.locator('[data-turn-process], [data-process-activity]')
    for (let index = 0; index < await processControls.count(); index++) {
      const control = processControls.nth(index)
      if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
    }
    const artifactFrame = page.locator('iframe[data-artifact-frame]').filter({ visible: true }).last()
    await artifactFrame.waitFor({ state: 'visible', timeout: 15_000 })
    const frame = page.locator('iframe[data-artifact-frame]:visible').last().contentFrame()

    await frame.locator('#integral').click()
    await frame.locator('#zoom-in').click()
    await frame.locator('#step').click()
    await expect.poll(() => frame.locator('#parameter-value').textContent()).toBe('1.10')
    await expect.poll(() => frame.locator('#readout').textContent()).toContain('f′(x)=0.550')
    await frame.locator('#confirm').click()
    await page.getByText('Action: plot.inspected', { exact: true }).waitFor({ state: 'visible' })
    const secondTurn = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: 'Send to Agent', exact: true }).click()
    expect(await secondTurn).toBe(sessionId)

    expect(session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action' ? [event.data] : [])).toHaveLength(1)
    expect(session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
    const actions = session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action' ? [event.data] : [])
    const block = actions[0]?.content[0]
    if (block?.type !== 'text') throw new Error('Function plot did not produce one text block')
    const payload = JSON.parse(block.text) as {
      payload: {
        time?: number
        selected?: string
        gravity?: number
        position: { x: number; y: number }
        velocity: { x: number; y: number }
        derivative?: number
        integral?: number
      }
    }
    expect(payload).toMatchObject({
      kind: 'artifact_action', artifactId: 'function-plot', revision: 1, action: 'plot.inspected',
      payload: { x: 1, parameter: 1.1, zoom: 1.25 },
    })
    expect(payload.payload.derivative).toBeCloseTo(0.55, 8)
    expect(payload.payload.integral).toBeCloseTo(1.1 / 12, 5)
    await page.getByText('At x=1, the derivative is 0.55 and the integral is approximately 0.0917.', { exact: true }).waitFor({ state: 'visible' })
    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  })
})
