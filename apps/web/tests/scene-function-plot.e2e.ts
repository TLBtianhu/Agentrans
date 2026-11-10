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

const DIR = fileURLToPath(new URL('./fixtures/replay/scene-function-plot', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: SceneSpec function plot', () => {
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

  it('renders a SceneSpec natively and confirms computed analysis', async () => {
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(1)
    const firstTurn = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await firstTurn
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('SceneSpec Session is not live')
    const session = agent.session

    const processControls = page.locator('[data-turn-process], [data-process-activity]')
    for (let index = 0; index < await processControls.count(); index++) {
      const control = processControls.nth(index)
      if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
    }
    const canvas = page.locator('canvas[aria-label="Interactive function plot"]:visible').last()
    await canvas.waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByRole('button', { name: 'Step', exact: true }).click()
    await expect.poll(() => page.locator('label[for="scene-parameter"] output').textContent()).toBe('0.25')
    await page.getByRole('button', { name: 'Confirm analysis', exact: true }).click()
    const secondTurn = scaffold.whenTurnSettled()
    expect(await secondTurn).toBe(sessionId)

    const actions = session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action' ? [event.data] : [])
    expect(actions).toHaveLength(1)
    const block = actions[0]?.content[0]
    if (block?.type !== 'text') throw new Error('SceneSpec did not produce one text block')
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
      kind: 'artifact_action', artifactId: 'damped-oscillator', revision: 1, action: 'plot.inspected',
      payload: { x: 1, parameters: { d: 0.25, f: 1.2 }, zoom: 1 },
    })
    expect(payload.payload.derivative).toBeCloseTo(1.63, 1)
    expect(payload.payload.integral).toBeCloseTo(0.09733365849704698, 8)
    await page.getByText('At x=1, damping 0.25 gives a local derivative of approximately 1.63.', { exact: true }).waitFor({ state: 'visible' })
    expect(session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  })
})
