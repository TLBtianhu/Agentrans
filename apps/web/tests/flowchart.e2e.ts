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

const DIR = fileURLToPath(new URL('./fixtures/replay/flowchart', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: flowchart Artifact', () => {
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

  it('selects a concept, advances the flow, and confirms the current map state', async () => {
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(1)
    const firstTurn = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await firstTurn
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Flowchart Session is not live')
    const session = agent.session

    const processControls = page.locator('[data-turn-process], [data-process-activity]')
    for (let index = 0; index < await processControls.count(); index++) {
      const control = processControls.nth(index)
      if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
    }
    const artifactFrame = page.locator('iframe[data-artifact-frame]').filter({ visible: true }).last()
    await artifactFrame.waitFor({ state: 'visible', timeout: 15_000 })
    const frame = page.locator('iframe[data-artifact-frame]:visible').last().contentFrame()

    await frame.locator('[data-node-id="manipulate"]').click()
    await frame.locator('#step').click()
    await expect.poll(() => frame.locator('#selected-value').textContent()).toBe('Feedback')
    await frame.locator('#zoom-in').click()
    await expect.poll(() => frame.locator('#zoom-value').textContent()).toBe('1.25×')
    await frame.locator('#confirm').click()
    await page.getByText('Action: flow.inspected', { exact: true }).waitFor({ state: 'visible' })
    const secondTurn = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: 'Send to Agent', exact: true }).click()
    expect(await secondTurn).toBe(sessionId)

    const actions = session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action' ? [event.data] : [])
    expect(actions).toHaveLength(1)
    const block = actions[0]?.content[0]
    if (block?.type !== 'text') throw new Error('Flowchart did not produce one text block')
    expect(JSON.parse(block.text)).toEqual({
      kind: 'artifact_action', artifactId: 'concept-flow', revision: 1, action: 'flow.inspected',
      payload: { selected: 'feedback', step: 3, zoom: 1.25 },
    })
    await page.getByText('Feedback is where the loop turns observation into revision.', { exact: true }).waitFor({ state: 'visible' })
    expect(session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  })
})
