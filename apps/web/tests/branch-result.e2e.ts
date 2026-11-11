/** Real manual fork, independent child answer, and confirmed branch-result return. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertFixtureInventory, fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

const DIR = fileURLToPath(new URL('./fixtures/replay/branch-result', import.meta.url))
const PARENT_FIXTURE = join(DIR, 'session.v4.jsonl')
const CHILD_FIXTURE = join(DIR, 'session.1.v4.jsonl')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: confirmed branch result', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      replayFixture: PARENT_FIXTURE,
      replayChildFixtures: [CHILD_FIXTURE],
      compareReplaySession: false,
      paceMs: 10,
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
      await scaffold?.close()
    }
  })

  it('returns only the confirmed child conclusion without waking the parent model', async () => {
    const parentPrompts = fixtureUserPrompts(await readFile(PARENT_FIXTURE, 'utf8'))
    expect(parentPrompts).toHaveLength(1)
    const firstTurn = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(parentPrompts[0]!)
    await input.press('Enter')
    const parentId = await firstTurn
    const parentAgent = scaffold.ctx.agents.get(parentId)
    if (parentAgent === undefined) throw new Error('Parent Session is not live')
    const parentSession = parentAgent.session

    await page.getByRole('button', { name: 'Branch into a new conversation', exact: true }).last().click()
    await expect.poll(() => scaffold.ctx.agents.roots().some(agent => agent.session.header.parentSession === parentId)).toBe(true)

    const childTurn = scaffold.whenTurnSettled()
    const childPrompts = fixtureUserPrompts(await readFile(CHILD_FIXTURE, 'utf8'))
    await input.fill(childPrompts.at(-1)!)
    await input.press('Enter')
    const childId = await childTurn
    expect(childId).not.toBe(parentId)
    const childAgent = scaffold.ctx.agents.get(childId)
    if (childAgent === undefined) throw new Error('Child Session is not live')
    await page.getByText('Child conclusion', { exact: true }).waitFor({ state: 'visible' })

    await page.getByRole('button', { name: 'Return to parent branch', exact: true }).last().click()
    const preview = page.getByText('Return this conclusion to the parent branch:', { exact: true }).locator('..')
    const previewText = await preview.textContent()
    expect(previewText).toContain('Child conclusion')
    expect(previewText).not.toContain('Child private reasoning')

    const parentResults = () => parentSession.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'branch-result' ? [event.data] : [])
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(parentResults()).toHaveLength(0)
    expect(parentSession.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)

    await page.getByRole('button', { name: 'Return to parent branch', exact: true }).last().click()
    await page.getByRole('button', { name: 'Confirm return', exact: true }).click()
    await page.getByText('Parent conclusion', { exact: true }).waitFor({ state: 'visible' })

    const results = parentResults()
    expect(results).toHaveLength(1)
    const childResult = childAgent.session.snapshotEvents().find(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text === 'Child conclusion'))
    if (childResult === undefined || childResult.type !== 'assistant/message') throw new Error('Child result message is missing')
    expect(results[0]?.source).toEqual({
      kind: 'branch-result', branchSessionId: childId, resultSeq: childResult.seq, resultMessageId: childResult.data.message.id, form: 'notice',
    })
    expect(results[0]?.content).toEqual([{ type: 'text', text: 'Child conclusion' }])
    expect(parentSession.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl', 'session.1.v4.jsonl'])
  })
})
