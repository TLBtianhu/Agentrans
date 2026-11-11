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

const DIR = fileURLToPath(new URL('./fixtures/replay/particle-system', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: particle-system Artifact', () => {
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
    const executablePath = process.env.AGENTRANS_PLAYWRIGHT_EXECUTABLE_PATH
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

  it('advances fixed time steps and confirms the physical state', async () => {
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(1)
    const firstTurn = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await firstTurn
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Particle-system Session is not live')
    const session = agent.session

    const processControls = page.locator('[data-turn-process], [data-process-activity]')
    for (let index = 0; index < await processControls.count(); index++) {
      const control = processControls.nth(index)
      if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
    }
    const artifactFrame = page.locator('iframe[data-artifact-frame]').filter({ visible: true }).last()
    await artifactFrame.waitFor({ state: 'visible', timeout: 15_000 })
    const frame = page.locator('iframe[data-artifact-frame]:visible').last().contentFrame()

    for (let index = 0; index < 6; index++) await frame.locator('#step').click()
    await expect.poll(() => frame.locator('#time-value').textContent()).toBe('0.20')
    await expect.poll(() => frame.locator('#readout').textContent()).toContain('vy=6.04')
    await frame.locator('#confirm').click()
    await page.getByText('Action: physics.inspected', { exact: true }).waitFor({ state: 'visible' })
    const secondTurn = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: 'Send to Agent', exact: true }).click()
    expect(await secondTurn).toBe(sessionId)

    const actions = session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action' ? [event.data] : [])
    expect(actions).toHaveLength(1)
    const block = actions[0]?.content[0]
    if (block?.type !== 'text') throw new Error('Particle-system did not produce one text block')
    const payload = JSON.parse(block.text) as {
      payload: {
        time?: number
        selected?: string
        gravity?: number
        position: { x: number; y: number }
        velocity: { x: number; y: number }
      }
    }
    expect(payload).toMatchObject({
      kind: 'artifact_action', artifactId: 'projectile-motion', revision: 1, action: 'physics.inspected',
      payload: { selected: 'alpha', gravity: 9.8 },
    })
    expect(payload.payload.time).toBeCloseTo(0.2, 8)
    expect(payload.payload.position.x).toBeCloseTo(1.6, 8)
    expect(payload.payload.position.y).toBeCloseTo(2.3713333333333337, 8)
    expect(payload.payload.velocity.x).toBeCloseTo(3, 8)
    expect(payload.payload.velocity.y).toBeCloseTo(6.04, 8)
    await page.getByText('After 0.2 s, alpha is still rising, but gravity has reduced its vertical velocity.', { exact: true }).waitFor({ state: 'visible' })
    expect(session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  })
})
