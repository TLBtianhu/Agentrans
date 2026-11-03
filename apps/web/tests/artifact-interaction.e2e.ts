/** Real shipped-composition Artifact creation, revision, and confirmed interaction. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertFixtureInventory, fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/artifact-interaction', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: Artifact interaction', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      compareReplaySession: false,
      paceMs: 10,
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
      await scaffold?.close()
    }
  })

  it('renders the latest revision and admits an action only after user confirmation', async () => {
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(1)
    const firstTurn = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await firstTurn
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Artifact Session is not live')
    const session = agent.session

    const processControls = page.locator('[data-turn-process], [data-process-activity]')
    for (let index = 0; index < await processControls.count(); index++) {
      const control = processControls.nth(index)
      if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
    }

    const artifactFrame = page.locator('iframe[data-artifact-frame]').filter({ visible: true }).last()
    await artifactFrame.waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByText('Revision 2', { exact: true }).waitFor({ state: 'visible' })
    const upserts = session.snapshotEvents().flatMap(event => event.type === 'artifact/upsert' ? [event.data] : [])
    expect(upserts.map(snapshot => snapshot.revision)).toEqual([1, 2])
    expect(upserts[1]?.title).toBe('Interactive counter — revised')

    const frame = page.frameLocator('iframe[data-artifact-frame]:visible').last()
    await expect.poll(() => frame.locator('h1').textContent()).toBe('Revision two')
    await frame.locator('#increment').click()
    await expect.poll(() => frame.locator('#value').textContent()).toBe('1')
    await page.getByText('Action: counter.changed', { exact: true }).waitFor({ state: 'visible' })

    expect(session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action' ? [event.data] : [])).toHaveLength(0)
    expect(session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)

    const secondTurn = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: 'Send to Agent', exact: true }).click()
    expect(await secondTurn).toBe(sessionId)

    const actions = session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action' ? [event.data] : [])
    expect(actions).toHaveLength(1)
    expect(actions[0]?.source).toEqual({ kind: 'artifact-action', artifactId: 'counter', revision: 2 })
    const block = actions[0]?.content[0]
    if (block?.type !== 'text') throw new Error('Artifact action did not produce one text block')
    expect(JSON.parse(block.text)).toEqual({
      kind: 'artifact_action', artifactId: 'counter', revision: 2, action: 'counter.changed', payload: { value: 1 },
    })
    expect(session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
    await page.getByText('The counter action was recorded.', { exact: true }).waitFor({ state: 'visible' })
    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  })
})
