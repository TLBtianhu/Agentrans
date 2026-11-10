/** Teaching Artifact: predict, manipulate, compare, and receive Agent feedback. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertFixtureInventory, fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

const DIR = fileURLToPath(new URL('./fixtures/replay/teaching-artifact', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: teaching Artifact', () => {
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

  it('compares prediction with the launch result and updates the Artifact after confirmation', async () => {
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(1)
    const firstTurn = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await firstTurn
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Teaching Session is not live')
    const session = agent.session

    const processControls = page.locator('[data-turn-process], [data-process-activity]')
    for (let index = 0; index < await processControls.count(); index++) {
      const control = processControls.nth(index)
      if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
    }
    const artifactFrame = page.locator('iframe[data-artifact-frame]').filter({ visible: true }).last()
    await artifactFrame.waitFor({ state: 'visible', timeout: 15_000 })
    const frame = page.locator('iframe[data-artifact-frame]:visible').last().contentFrame()

    await frame.locator('#angle').selectOption('45')
    await frame.locator('#predict-hit').click()
    await frame.locator('#launch').click()
    await expect.poll(() => frame.locator('#result').textContent()).toContain('prediction matched')
    await page.getByText('Action: shot.completed', { exact: true }).waitFor({ state: 'visible' })

    const scene = page.locator('section[data-placement]')
    await page.getByRole('button', { name: 'Float', exact: true }).click()
    expect(await scene.getAttribute('data-placement')).toBe('pip')
    await page.getByText('Action: shot.completed', { exact: true }).waitFor({ state: 'visible' })
    await page.getByText('From this conversation', { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'Inline', exact: true }).click()
    expect(await scene.getAttribute('data-placement')).toBe('inline')
    await page.getByText('Action: shot.completed', { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'Dock', exact: true }).click()
    expect(await scene.getAttribute('data-placement')).toBe('beside')
    await page.getByRole('button', { name: 'Expand', exact: true }).click()
    expect(await scene.getAttribute('data-placement')).toBe('focus')
    await page.getByText('Action: shot.completed', { exact: true }).waitFor({ state: 'visible' })

    expect(session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action' ? [event.data] : [])).toHaveLength(0)
    expect(session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)

    const secondTurn = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: 'Send to Agent', exact: true }).click()
    expect(await secondTurn).toBe(sessionId)

    const actions = session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action' ? [event.data] : [])
    expect(actions).toHaveLength(1)
    expect(actions[0]?.source).toEqual({ kind: 'artifact-action', artifactId: 'projectile-lab', revision: 1 })
    const block = actions[0]?.content[0]
    if (block?.type !== 'text') throw new Error('Teaching action did not produce one text block')
    expect(JSON.parse(block.text)).toEqual({
      kind: 'artifact_action', artifactId: 'projectile-lab', revision: 1, action: 'shot.completed',
      payload: { angle: 45, predictedHit: true, actualHit: true },
    })

    await page.getByText('Revision 2', { exact: true }).waitFor({ state: 'visible' })
    const updatedFrame = page.locator('iframe[data-artifact-frame]:visible').last().contentFrame()
    await expect.poll(() => updatedFrame.locator('#feedback').textContent()).toBe('Prediction matched: 45° reached the target.')
    await page.getByText('Your prediction was correct: 45° reached the target.', { exact: true }).waitFor({ state: 'visible' })
    expect(session.snapshotEvents().flatMap(event => event.type === 'artifact/upsert' ? [event.data.revision] : [])).toEqual([1, 2])
    expect(session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  })
})
