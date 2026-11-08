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

const DIR = fileURLToPath(new URL('./fixtures/replay/artifact-stable-actions', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: stable Artifact action admission', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const requests: Record<string, unknown>[] = []
  const dropped = new Set<string>()

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
      const request = object(object(object(envelope.payload).args).request)
      requests.push(request)
      const action = request.action
      if (typeof action !== 'string' || action === 'queue.b' || dropped.has(action)) { await route.continue(); return }
      dropped.add(action)
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

  it('retries the original native revision and removes only the acknowledged HTML queue item', async () => {
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(1)
    const first = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await first
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Stable action Session is not live')
    const actions = () => agent.session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'artifact-action' ? [event.data] : [])
    const turns = () => agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length
    const action = (index: number): Record<string, unknown> => {
      const block = actions()[index]?.content[0]
      if (block?.type !== 'text') throw new Error('Artifact action text was lost')
      return object(JSON.parse(block.text))
    }
    const expand = async (): Promise<void> => {
      const controls = page.locator('[data-turn-process], [data-process-activity]')
      for (let index = 0; index < await controls.count(); index++) {
        const control = controls.nth(index)
        if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
      }
    }
    const native = page.getByRole('complementary', { name: 'Artifact: Stable native lab', exact: true })
    const html = page.getByRole('complementary', { name: 'Artifact: Stable HTML queue', exact: true })
    await expand()
    await native.locator('canvas[aria-label="Interactive particle simulation"]').waitFor({ state: 'visible' })
    for (let step = 0; step < 6; step++) await native.getByRole('button', { name: 'Step', exact: true }).click()
    await native.locator('[data-particle-step="6"]').waitFor({ state: 'visible' })
    expect(turns()).toBe(1)
    expect(actions()).toHaveLength(0)
    const second = scaffold.whenTurnSettled()
    await native.getByRole('button', { name: 'Confirm analysis', exact: true }).click()
    expect(await second).toBe(sessionId)
    await expect.poll(() => native.getAttribute('data-artifact-revision')).toBe('2')
    const nativeUnknown = native.locator('[data-artifact-action-submission="unknown"]')
    await nativeUnknown.waitFor({ state: 'visible' })
    expect(actions()).toHaveLength(1)
    expect(requests).toHaveLength(1)
    expect(action(0)).toMatchObject({ artifactId: 'stable-native', revision: 1, action: 'physics.inspected',
      payload: { time: 0.75, particles: [{ id: 'p', x: 0.75, y: 0.28125, vx: 1, vy: -0.5 }] } })
    expect(actions()[0]?.id).toBe(requests[0]?.requestId)
    await nativeUnknown.getByText('Original action request', { exact: true }).click()
    expect(JSON.parse(await nativeUnknown.locator('pre').textContent() ?? '')).toEqual(requests[0])
    expect(requests[0]?.revision).toBe(1)
    expect(await native.getByRole('button', { name: 'Confirm analysis', exact: true }).isEnabled()).toBe(false)
    const screenshotDirectory = process.env.DSH_INTERACTION_JOURNEY_SCREENSHOT_DIR
    if (screenshotDirectory !== undefined) {
      await page.setViewportSize({ width: 1440, height: 1800 })
      await native.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(screenshotDirectory, 'stable-native-unknown.png'), fullPage: true })
      await page.setViewportSize({ width: 1440, height: 960 })
    }
    await nativeUnknown.getByRole('button', { name: 'Retry original action', exact: true }).click()
    await native.getByText('Action sent to Agent.', { exact: true }).waitFor({ state: 'visible' })
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    expect(actions()).toHaveLength(1)
    expect(turns()).toBe(2)
    expect(await native.getAttribute('data-artifact-revision')).toBe('2')

    await html.locator('[data-artifact-frame]').waitFor({ state: 'visible' })
    await html.frameLocator('[data-artifact-frame]').getByRole('button', { name: 'Queue A', exact: true }).click()
    await html.getByText('Action: queue.a', { exact: true }).waitFor({ state: 'visible' })
    await html.frameLocator('[data-artifact-frame]').getByRole('button', { name: 'Queue B', exact: true }).click()
    await html.getByText('2 actions pending', { exact: true }).waitFor({ state: 'visible' })
    expect(turns()).toBe(2)
    const third = scaffold.whenTurnSettled()
    await html.getByRole('button', { name: 'Send to Agent', exact: true }).click()
    expect(await third).toBe(sessionId)
    const htmlUnknown = html.locator('[data-artifact-action-submission="unknown"]')
    await htmlUnknown.waitFor({ state: 'visible' })
    expect(requests).toHaveLength(3)
    expect(actions()).toHaveLength(2)
    expect(action(1)).toMatchObject({ artifactId: 'stable-html', revision: 1, action: 'queue.a', payload: { value: 'A' } })
    expect(actions()[1]?.id).toBe(requests[2]?.requestId)
    expect(await html.getByRole('button', { name: 'Send to Agent', exact: true }).isEnabled()).toBe(false)
    await htmlUnknown.getByRole('button', { name: 'Retry original action', exact: true }).click()
    await html.getByText('Action: queue.b', { exact: true }).waitFor({ state: 'visible' })
    expect(requests).toHaveLength(4)
    expect(requests[3]).toEqual(requests[2])
    expect(actions()).toHaveLength(2)
    expect(turns()).toBe(3)
    expect(await html.getByText('Action: queue.a', { exact: true }).count()).toBe(0)
    const fourth = scaffold.whenTurnSettled()
    await html.getByRole('button', { name: 'Send to Agent', exact: true }).click()
    expect(await fourth).toBe(sessionId)
    expect(requests).toHaveLength(5)
    expect(requests[4]?.requestId).not.toBe(requests[2]?.requestId)
    expect(actions()).toHaveLength(3)
    expect(actions()[2]?.id).toBe(requests[4]?.requestId)
    expect(action(2)).toMatchObject({ action: 'queue.b', payload: { value: 'B' } })
    await html.getByRole('button', { name: 'Send to Agent', exact: true }).waitFor({ state: 'hidden' })
    expect(turns()).toBe(4)

    const recorded = actions().map(message => message.content)
    const warningStart = tripwire.warnings.length
    await page.reload()
    await page.getByText('I received action B as a separate confirmed input.', { exact: true }).waitFor({ state: 'visible' })
    await expand()
    await native.waitFor({ state: 'visible' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(await page.locator('[data-artifact-action-submission]').count()).toBe(0)
    expect(actions().map(message => message.content)).toEqual(recorded)
    expect(requests).toHaveLength(5)
    expect(turns()).toBe(4)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(3)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  }, 120_000)
})
