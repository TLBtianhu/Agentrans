// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, fixtureUserPrompts, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

const DIR = fileURLToPath(new URL('./fixtures/replay/artifact-current-comparison-unknown', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: unconfirmed current comparison', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const requests: Record<string, unknown>[] = []

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
    await page.route('**/api/artifacts/submitAction', async (route) => {
      const envelope = object(route.request().postDataJSON())
      requests.push(object(object(object(envelope.payload).args).request))
      if (requests.length !== 1) { await route.continue(); return }
      const response = await route.fetch()
      try {
        expect(object(object(await response.json()).result).ok).toBe(true)
        await route.abort('failed')
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

  it('retries the original identified comparison after losing an accepted response, then explicitly sends new values', async () => {
    const questions = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(questions).toHaveLength(1)
    const input = page.locator('[data-composer-input]').first()
    const first = scaffold.whenTurnSettled()
    await input.fill(questions[0]!)
    await input.press('Enter')
    const sessionId = await first
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Comparison Session is not live')
    const expand = async (): Promise<void> => {
      const controls = page.locator('[data-turn-process], [data-process-activity]')
      for (let index = 0; index < await controls.count(); index++) {
        const control = controls.nth(index)
        if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
      }
    }
    await expand()
    const group = page.locator('section[data-comparison-group="uncertain-study"]')
    await group.waitFor({ state: 'visible' })
    const compare = group.getByRole('button', { name: 'Compare results', exact: true })
    await expect.poll(() => compare.isEnabled()).toBe(true)
    const actions = () => agent.session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'artifact-action' ? [event.data] : [])
    const facts = (index: number): Record<string, unknown> => {
      const block = actions()[index]?.content[0]
      if (block?.type !== 'text') throw new Error('Comparison action text was lost')
      return object(object(JSON.parse(block.text)).payload)
    }
    const second = scaffold.whenTurnSettled()
    await compare.click()
    expect(await second).toBe(sessionId)
    const unconfirmed = group.locator('[data-artifact-action-submission="unknown"]')
    await unconfirmed.waitFor({ state: 'visible' })
    expect(await unconfirmed.getByRole('alert').textContent()).toContain('retry uses this original request')
    expect(await group.getByRole('button', { name: 'Retry comparison', exact: true }).count()).toBe(0)
    expect(await compare.isEnabled()).toBe(false)
    expect(actions()).toHaveLength(1)
    const original = facts(0)
    expect(original).toMatchObject({ control: { state: { count: 1 } }, variant: { state: { count: 10 } } })

    for (const [role, count] of [['control', 2], ['variant', 11]] as const) {
      const card = group.getByRole('complementary', { name: `Artifact: Uncertain ${role}`, exact: true })
      const id = await card.locator('[data-artifact-frame]').getAttribute('data-artifact-runtime-id')
      const received = page.evaluate(({ id, count }) => new Promise<undefined>((resolve, reject) => {
        const timer = setTimeout(() => { window.removeEventListener('message', listener); reject(new Error('Program state report did not arrive')) }, 3000)
        const listener = (event: MessageEvent): void => {
          const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
          const data: unknown = event.data
          if (!record(data) || data.kind !== 'artifact-runtime-state' || !record(data.identity)
            || data.identity.runtimeId !== id || !record(data.state) || data.state.count !== count) return
          clearTimeout(timer)
          window.removeEventListener('message', listener)
          resolve(undefined)
        }
        window.addEventListener('message', listener)
      }), { id, count })
      await card.frameLocator('[data-artifact-frame]').getByRole('button', { name: 'Advance', exact: true }).click()
      await received
    }
    await unconfirmed.getByText('Original action request', { exact: true }).click()
    expect(JSON.parse(await unconfirmed.locator('pre').textContent() ?? '')).toEqual(requests[0])
    expect(requests[0]?.payload).toEqual(original)
    expect(actions()[0]?.id).toBe(requests[0]?.requestId)
    expect(await compare.isEnabled()).toBe(false)
    expect(requests).toHaveLength(1)
    expect(actions()).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
    const screenshotDirectory = process.env.DSH_INTERACTION_JOURNEY_SCREENSHOT_DIR
    if (screenshotDirectory !== undefined) await page.screenshot({ path: join(screenshotDirectory, 'comparison-unknown.png'), fullPage: true })

    await unconfirmed.getByRole('button', { name: 'Retry original action', exact: true }).click()
    await group.getByText('Comparison sent to Agent.', { exact: true }).waitFor({ state: 'visible' })
    expect(await unconfirmed.count()).toBe(0)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(actions()).toHaveLength(1)
    expect(facts(0)).toEqual(original)
    const third = scaffold.whenTurnSettled()
    await compare.click()
    expect(await third).toBe(sessionId)
    expect(requests).toHaveLength(3)
    expect(actions()).toHaveLength(2)
    expect(requests[2]?.requestId).not.toBe(requests[0]?.requestId)
    expect(actions()[1]?.id).toBe(requests[2]?.requestId)
    expect(facts(1)).toMatchObject({ control: { state: { count: 2 } }, variant: { state: { count: 11 } } })
    expect(facts(0)).toEqual(original)

    const warningStart = tripwire.warnings.length
    await page.reload()
    await group.waitFor({ state: 'visible' })
    await expand()
    await expect.poll(() => compare.isEnabled()).toBe(true)
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(await unconfirmed.count()).toBe(0)
    expect(actions()).toHaveLength(2)
    expect(facts(0)).toEqual(original)
    expect(requests).toHaveLength(3)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(3)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(2)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  }, 120_000)
})
