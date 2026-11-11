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

// This authored replay exercises model tool output through the shipped Web app;
// it is a keyless regression case, not evidence of a live model generation.
const DIR = fileURLToPath(new URL('./fixtures/replay/scene-particle-runtime', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const TITLE = 'Projectile runtime'

interface ParticleObservation {
  readonly time: number
  readonly particles: readonly { readonly id: string; readonly x: number; readonly y: number; readonly vx: number; readonly vy: number }[]
}

function expectSixSteps(observation: ParticleObservation): void {
  expect(observation.time).toBeCloseTo(0.2, 12)
  expect(observation.particles).toHaveLength(2)
  const alpha = observation.particles.find(particle => particle.id === 'alpha')
  const beta = observation.particles.find(particle => particle.id === 'beta')
  expect(alpha?.x).toBeCloseTo(1.6, 10)
  expect(alpha?.y).toBeCloseTo(1 + 8 * 0.2 - 9.8 * (1 / 30) ** 2 * 6 * 5 / 2, 10)
  expect(alpha?.vx).toBeCloseTo(3, 10)
  expect(alpha?.vy).toBeCloseTo(6.04, 10)
  expect(beta?.x).toBeCloseTo(-0.8, 10)
  expect(beta?.y).toBeCloseTo(2 - 9.8 * (1 / 30) ** 2 * 6 * 5 / 2, 10)
  expect(beta?.vx).toBeCloseTo(1, 10)
  expect(beta?.vy).toBeCloseTo(-1.96, 10)
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: native particle runtime', () => {
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

  it('keeps an inspected run across view changes and exports its current checkpoint before confirmation', async () => {
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(1)
    const firstTurn = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await firstTurn
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Particle-runtime Session is not live')
    const actions = () => agent.session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'artifact-action' ? [event.data] : [])

    const processControls = page.locator('[data-turn-process], [data-process-activity]')
    for (let index = 0; index < await processControls.count(); index++) {
      const control = processControls.nth(index)
      if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
    }
    const card = page.locator(`section[aria-label="Artifact: ${TITLE}"]:visible`).last()
    await card.locator('canvas[aria-label="Interactive particle simulation"]').waitFor({ state: 'visible' })
    for (let index = 0; index < 6; index++) await card.getByRole('button', { name: 'Step', exact: true }).click()
    const current = () => page.locator('[data-particle-step="6"][data-particle-time="0.2"]:visible').last()
    await current().waitFor({ state: 'visible' })
    expect(actions()).toEqual([])

    await card.getByRole('button', { name: 'View source', exact: true }).click()
    await card.getByLabel('HTML source', { exact: true }).waitFor({ state: 'visible' })
    await card.getByRole('button', { name: 'Show preview', exact: true }).click()
    await current().waitFor({ state: 'visible' })
    for (const placement of ['Expand', 'Float', 'Inline']) {
      await page.getByRole('button', { name: placement, exact: true }).click()
      await current().waitFor({ state: 'visible' })
    }
    expect(actions()).toEqual([])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)

    const downloadReady = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export animation', exact: true }).click()
    const download = await downloadReady
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      const bytes: unknown = chunk
      if (!(bytes instanceof Uint8Array)) throw new Error('Export download did not contain binary chunks')
      chunks.push(Buffer.from(bytes))
    }
    const html = Buffer.concat(chunks).toString('utf8')
    const exportedContext = await browser.newContext()
    let exportedObservation: ParticleObservation
    try {
      const requests: string[] = []
      await exportedContext.route('**/*', async (route) => {
        requests.push(route.request().url())
        await route.abort()
      })
      const exported = await exportedContext.newPage()
      const errors: string[] = []
      exported.on('pageerror', error => errors.push(error.message))
      await exported.setContent(html, { waitUntil: 'load' })
      expect(await exported.locator('#time').textContent()).toBe('0.20 s')
      exportedObservation = await exported.evaluate<ParticleObservation>('particleBaseState')
      expectSixSteps(exportedObservation)
      await exported.locator('#scrub').fill('0.5')
      await exported.locator('#scrub').dispatchEvent('input')
      expect(await exported.locator('#time').textContent()).not.toBe('0.20 s')
      await exported.locator('#scrub').fill('0')
      await exported.locator('#scrub').dispatchEvent('input')
      expect(await exported.locator('#time').textContent()).toBe('0.20 s')
      expect(errors).toEqual([])
      expect(requests).toEqual([])
    } finally {
      await exportedContext.close()
    }
    expect(actions()).toEqual([])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)

    const secondTurn = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: 'Confirm analysis', exact: true }).click()
    expect(await secondTurn).toBe(sessionId)
    expect(actions()).toHaveLength(1)
    const block = actions()[0]?.content[0]
    if (block?.type !== 'text') throw new Error('Particle-runtime action did not contain text')
    const recorded = JSON.parse(block.text) as { artifactId: string; revision: number; action: string; payload: ParticleObservation }
    expect(recorded).toMatchObject({ artifactId: 'projectile-runtime', revision: 1, action: 'physics.inspected' })
    expectSixSteps(recorded.payload)
    expect(recorded.payload.particles).toEqual(exportedObservation.particles.map(({ id, x, y, vx, vy }) => ({ id, x, y, vx, vy })))
    await page.getByText('The inspected run and its export refer to the same six-step experiment.', { exact: true }).waitFor({ state: 'visible' })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(tripwire.pageErrors).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  })
})
