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

// Authored model output exercises the real Web composition without a model key.
const DIR = fileURLToPath(new URL('./fixtures/replay/scene-saved-observations', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const TITLE = 'Saved projectile observations'

interface ParticleObservation {
  readonly time: number
  readonly particles: readonly { readonly id: string; readonly x: number; readonly y: number; readonly vx: number; readonly vy: number }[]
}

function expectOriginalSixSteps(observation: ParticleObservation): void {
  expect(observation.time).toBeCloseTo(0.2, 12)
  expect(observation.particles).toHaveLength(2)
  const alpha = observation.particles.find(particle => particle.id === 'alpha')
  expect(alpha?.x).toBeCloseTo(1.6, 10)
  expect(alpha?.y).toBeCloseTo(1 + 8 * 0.2 - 9.8 * (1 / 30) ** 2 * 6 * 5 / 2, 10)
  expect(alpha?.vx).toBeCloseTo(3, 10)
  expect(alpha?.vy).toBeCloseTo(6.04, 10)
}

async function downloadParticleObservation(page: Page, browser: Browser): Promise<ParticleObservation> {
  const downloadReady = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export animation', exact: true }).click()
  const download = await downloadReady
  const chunks: Buffer[] = []
  for await (const chunk of await download.createReadStream()) {
    const bytes: unknown = chunk
    if (!(bytes instanceof Uint8Array)) throw new Error('Export download did not contain binary chunks')
    chunks.push(Buffer.from(bytes))
  }
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
    await exported.setContent(Buffer.concat(chunks).toString('utf8'), { waitUntil: 'load' })
    const observation = await exported.evaluate<ParticleObservation>('particleBaseState')
    expect(await exported.locator('#time').textContent()).toBe(`${observation.time.toFixed(2)} s`)
    expect(errors).toEqual([])
    expect(requests).toEqual([])
    return observation
  } finally {
    await exportedContext.close()
  }
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: saved particle observations', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    process.env.AGENTRANS_TEST_CUSTOM_KEY = 'local-test-key'
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE, compareReplaySession: false, paceMs: 10,
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

  it('restores saved experiments after reload and keeps old revisions separate until explicit send', async () => {
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(2)
    const firstTurn = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await firstTurn
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Saved-observation Session is not live')
    const actions = () => agent.session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'artifact-action' ? [event.data] : [])
    const turns = () => agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length
    const card = () => page.locator(`section[aria-label="Artifact: ${TITLE}"]:visible`).last()
    const savedRow = (label: string) => card().locator('section[aria-label="Saved observations"] li')
      .filter({ has: page.getByText(label, { exact: true }) })
    const step = () => card().getByRole('button', { name: 'Step', exact: true }).click()

    await card().locator('canvas[aria-label="Interactive particle simulation"]').waitFor({ state: 'visible' })
    for (let index = 0; index < 6; index++) await step()
    await card().getByRole('textbox', { name: 'Observation name', exact: true }).fill('A')
    await card().getByRole('button', { name: 'Save observation', exact: true }).click()
    await savedRow('A').getByRole('button', { name: 'Restore', exact: true }).waitFor({ state: 'visible' })
    const observationId = await savedRow('A').getAttribute('data-observation-id')
    expect(observationId).toBeTruthy()
    for (let index = 0; index < 3; index++) await step()
    await card().getByRole('textbox', { name: 'Observation name', exact: true }).fill('B')
    await card().getByRole('button', { name: 'Save observation', exact: true }).click()
    await savedRow('B').getByRole('button', { name: 'Restore', exact: true }).waitFor({ state: 'visible' })
    expect(actions()).toEqual([])
    expect(turns()).toBe(1)

    const warningStart = tripwire.warnings.length
    await page.reload()
    await savedRow('A').waitFor({ state: 'visible' })
    await savedRow('B').waitFor({ state: 'visible' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    const search = page.getByRole('button', { name: 'Search sessions', exact: true })
    if (await search.getAttribute('aria-expanded') !== 'true') await search.click()
    await page.getByRole('textbox', { name: 'Search session names', exact: true }).fill('Save and restore')
    const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
    await expect.poll(() => results.count()).toBe(1)
    await results.click()
    await savedRow('A').waitFor({ state: 'visible' })
    await savedRow('B').getByRole('button', { name: 'Restore', exact: true }).click()
    await card().locator('[data-particle-step="9"]').waitFor({ state: 'visible' })
    await savedRow('A').getByRole('button', { name: 'Restore', exact: true }).click()
    await card().locator('[data-particle-step="6"][data-particle-time="0.2"]').waitFor({ state: 'visible' })
    expectOriginalSixSteps(await downloadParticleObservation(page, browser))
    expect(actions()).toEqual([])
    expect(turns()).toBe(1)

    await card().getByRole('button', { name: 'Return to latest', exact: true }).click()
    const secondTurn = scaffold.whenTurnSettled()
    await input.fill(prompts[1]!)
    await input.press('Enter')
    expect(await secondTurn).toBe(sessionId)
    await page.getByText('The current source is revision 2; your saved observations still belong to revision 1.', { exact: true })
      .waitFor({ state: 'visible' })
    await expect.poll(() => card().getAttribute('data-artifact-revision')).toBe('2')
    await savedRow('A').getByRole('button', { name: 'Restore', exact: true }).click()
    await card().getByText('Saved observation A · revision 1', { exact: true }).waitFor({ state: 'visible' })
    expect(await card().getAttribute('data-artifact-revision')).toBe('1')
    const restored = await downloadParticleObservation(page, browser)
    expectOriginalSixSteps(restored)
    await card().getByRole('button', { name: 'Return to latest', exact: true }).click()
    expect(await card().getAttribute('data-artifact-revision')).toBe('2')
    const latest = await downloadParticleObservation(page, browser)
    expect(latest.time).toBe(0)
    expect(latest.particles.find(particle => particle.id === 'alpha')?.x).toBe(10)
    expect(actions()).toEqual([])
    expect(turns()).toBe(2)

    const sent = scaffold.whenTurnSettled()
    await savedRow('A').getByRole('button', { name: 'Send to Agent', exact: true }).click()
    expect(await sent).toBe(sessionId)
    expect(actions()).toHaveLength(1)
    const block = actions()[0]?.content[0]
    if (block?.type !== 'text') throw new Error('Saved observation did not enter one text block')
    const recorded = JSON.parse(block.text) as {
      artifactId: string
      revision: number
      action: string
      payload: ParticleObservation & { observationId: string; label: string; runtimeVersion: number; stepCount: number }
    }
    expect(recorded).toMatchObject({
      artifactId: 'saved-projectiles', revision: 1, action: 'physics.inspected',
      payload: { observationId, label: 'A', runtimeVersion: 1, stepCount: 6 },
    })
    expectOriginalSixSteps(recorded.payload)
    expect(recorded.payload.particles).toEqual(restored.particles.map(({ id, x, y, vx, vy }) => ({ id, x, y, vx, vy })))
    await page.getByText('Observation A is the original six-step experiment, even though the current source has changed.', { exact: true })
      .waitFor({ state: 'visible' })
    expect(turns()).toBe(3)
    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  })
})
