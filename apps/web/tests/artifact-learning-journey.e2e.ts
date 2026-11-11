// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Download, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSessionLog } from '@agentrans/llm-replay'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

const DIR = fileURLToPath(new URL('./fixtures/replay/artifact-learning-journey', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const TITLE = 'Projectile learning lab'

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}

async function downloadedText(download: Download): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of await download.createReadStream()) {
    const bytes: unknown = chunk
    if (!(bytes instanceof Uint8Array)) throw new Error('Export did not contain binary chunks')
    chunks.push(Buffer.from(bytes))
  }
  return Buffer.concat(chunks).toString('utf8')
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: one experiment from question to preserved export', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    process.env.AGENTRANS_TEST_CUSTOM_KEY = 'local-test-key'
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE, compareReplaySession: false, paceMs: 10,
      extraOverlayPath: fileURLToPath(new URL('./teaching-custom-provider.overlay.yml', import.meta.url)),
      replayProviders: [{ id: 'custom-provider', name: 'Custom Lab',
        models: [{ id: 'user-model', name: 'Custom Lab Model', contextWindow: 8192 }] }],
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
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally { delete process.env.AGENTRANS_TEST_CUSTOM_KEY }
    }
  })

  it('keeps the question, saved conditions and exported file on their original revision while the same experiment evolves', async () => {
    const prompts = parseSessionLog(await readFile(FIXTURE, 'utf8')).flatMap((event) => {
      if (event.type !== 'user/message' || event.data.source.kind !== 'user') return []
      const block = event.data.content[0]
      return block?.type === 'text' ? [block.text] : []
    })
    expect(prompts).toHaveLength(2)
    const input = page.locator('[data-composer-input]').first()
    const card = () => page.getByRole('complementary', { name: `Artifact: ${TITLE}`, exact: true })
    const savedRow = (label: string) => card().locator('section[aria-label="Saved observations"] li')
      .filter({ has: page.getByText(label, { exact: true }) })
    const expand = async (): Promise<void> => {
      const controls = page.locator('[data-turn-process], [data-process-activity]')
      for (let index = 0; index < await controls.count(); index++) {
        const control = controls.nth(index)
        if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
      }
    }
    const first = scaffold.whenTurnSettled()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await first
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Learning Session is not live')
    const events = () => agent.session.snapshotEvents()
    const turns = () => events().filter(event => event.type === 'turn/start').length
    const questions = () => events().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user' ? [event.data] : [])
    const exportEvents = () => events().flatMap(event => event.type === 'artifact/export' ? [event.data] : [])
    const observations = () => events().flatMap(event => event.type === 'artifact/observations' ? event.data.observations : [])
    await expand()
    await card().locator('canvas[aria-label="Interactive particle simulation"]').waitFor({ state: 'visible' })
    for (let step = 0; step < 6; step++) await card().getByRole('button', { name: 'Step', exact: true }).click()
    await card().getByRole('textbox', { name: 'Observation name', exact: true }).fill('Original six steps')
    await card().getByRole('button', { name: 'Save observation', exact: true }).click()
    await savedRow('Original six steps').waitFor({ state: 'visible' })
    const observationId = await savedRow('Original six steps').getAttribute('data-observation-id')
    expect(observationId).toBeTruthy()
    const original = observations().find(observation => observation.observationId === observationId)
    expect(original).toMatchObject({ artifact: { revision: 1 }, checkpoint: { runtimeVersion: 1, stepCount: 6 } })
    expect(turns()).toBe(1)
    expect(questions()).toHaveLength(1)

    await card().getByRole('button', { name: 'Use for next question', exact: true }).click()
    const liveChoice = () => page.locator('[data-artifact-prompt-context="current-particle"]:visible')
    await liveChoice().waitFor({ state: 'visible' })
    const second = scaffold.whenTurnSettled()
    await input.fill(prompts[1]!)
    await input.press('Enter')
    expect(await second).toBe(sessionId)
    await expand()
    await expect.poll(() => card().getAttribute('data-artifact-revision')).toBe('2')
    await card().locator('[data-particle-step="0"]').waitFor({ state: 'visible' })
    await liveChoice().getByRole('alert').waitFor({ state: 'visible' })
    expect(await liveChoice().getByRole('alert').textContent()).toBe(
      'This source changed or is no longer available. Choose a current experiment again, or remove this context before sending.',
    )
    await liveChoice().getByRole('button', { name: 'Remove question context', exact: true }).click()
    expect(await liveChoice().count()).toBe(0)
    const question = questions()[1]!
    expect(question.content).toHaveLength(2)
    const questionContext = question.content[1]
    if (questionContext?.type !== 'text') throw new Error('Question lost the selected experiment')
    const context = object(JSON.parse(questionContext.text.slice(questionContext.text.indexOf('\n') + 1)))
    const facts = object(context.facts)
    expect(context.sessionId).toBe(sessionId)
    expect(facts).toMatchObject({ kind: 'current-particle', checkpoint: { runtimeVersion: 1, stepCount: 6 } })
    expect(facts.artifact).toEqual(original?.artifact)
    expect(facts.values).toEqual(original?.values)
    expect(events().flatMap(event => event.type === 'artifact/upsert' ? [event.data.revision] : [])).toEqual([1, 2])

    for (let step = 0; step < 3; step++) await card().getByRole('button', { name: 'Step', exact: true }).click()
    await card().getByRole('textbox', { name: 'Observation name', exact: true }).fill('Revised three steps')
    await card().getByRole('button', { name: 'Save observation', exact: true }).click()
    await savedRow('Revised three steps').waitFor({ state: 'visible' })
    const revised = observations().find(observation => observation.label === 'Revised three steps')
    expect(revised).toMatchObject({ artifact: { revision: 2, spec: { gravity: { y: -4 } } }, checkpoint: { stepCount: 3 } })
    expect(revised?.values.particles.find(particle => particle.id === 'alpha')?.x).toBeCloseTo(10.3, 10)
    await savedRow('Original six steps').getByRole('button', { name: 'Restore', exact: true }).click()
    await card().getByText('Saved observation Original six steps · revision 1', { exact: true }).waitFor({ state: 'visible' })
    await card().locator('[data-particle-step="6"][data-particle-time="0.2"]').waitFor({ state: 'visible' })
    expect(await card().getAttribute('data-artifact-revision')).toBe('1')
    const downloadReady = page.waitForEvent('download')
    await card().getByRole('button', { name: 'Export animation', exact: true }).click()
    const html = await downloadedText(await downloadReady)
    expect(exportEvents().map(record => record.status)).toEqual(['pending', 'ready'])
    const exported = exportEvents()[1]!
    expect(exported.request.source).toEqual({ kind: 'observation', artifactId: 'learning-projectiles', observationId })
    expect(exported.frozen.artifact).toEqual(original?.artifact)
    expect(exported.frozen.checkpoint).toEqual(original?.checkpoint)
    const exportId = exported.request.exportId
    const offline = await browser.newContext()
    try {
      const requests: string[] = []
      await offline.route('**/*', async (route) => { requests.push(route.request().url()); await route.abort() })
      const standalone = await offline.newPage()
      const errors: string[] = []
      standalone.on('pageerror', error => errors.push(error.message))
      await standalone.setContent(html, { waitUntil: 'load' })
      const base: unknown = await standalone.evaluate('particleBaseState')
      const state = object(base)
      expect(state.time).toBe(0.2)
      expect(state.particles).toEqual(original?.values.particles.map(particle => ({ ...particle, mass: particle.id === 'alpha' ? 1 : 2 })))
      expect(object(JSON.parse(await standalone.locator('#artifact-export-origin-data').textContent() ?? 'null')))
        .toMatchObject({ exportId, sessionId, artifactId: 'learning-projectiles', revision: 1, observationId })
      expect(requests).toEqual([])
      expect(errors).toEqual([])
    } finally { await offline.close() }
    await card().getByRole('button', { name: 'Use for next question', exact: true }).click()
    await page.locator('[data-artifact-prompt-context="observation"]:visible').waitFor({ state: 'visible' })
    await card().getByRole('button', { name: 'Return to latest', exact: true }).click()
    await card().locator('[data-particle-step="3"]').waitFor({ state: 'visible' })
    expect(await card().getAttribute('data-artifact-revision')).toBe('2')
    expect(turns()).toBe(2)
    expect(questions()).toHaveLength(2)
    expect(events().filter(event => event.type === 'tool/call')).toHaveLength(2)
    expect(events().filter(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action')).toEqual([])

    const warningStart = tripwire.warnings.length
    await page.reload()
    await page.getByText(prompts[1]!, { exact: true }).waitFor({ state: 'visible' })
    await expand()
    await savedRow('Original six steps').waitFor({ state: 'visible' })
    await savedRow('Revised three steps').waitFor({ state: 'visible' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(await card().getAttribute('data-artifact-revision')).toBe('2')
    expect(await page.locator('[data-artifact-prompt-context]:visible').count()).toBe(0)
    const row = card().locator(`[data-export-id="${exportId}"][data-export-status="ready"]`)
    await row.waitFor({ state: 'visible' })
    const repeatedDownload = page.waitForEvent('download')
    await row.getByRole('button', { name: 'Download HTML', exact: true }).click()
    expect(await downloadedText(await repeatedDownload)).toBe(html)
    const displayed = page.locator('details[data-artifact-question-context]:visible').last()
    await displayed.waitFor({ state: 'visible' })
    await displayed.locator('summary').click()
    expect(await displayed.locator('[data-artifact-question-context-raw]').textContent()).toBe(questionContext.text)
    expect(exportEvents().map(record => record.status)).toEqual(['pending', 'ready'])
    expect(turns()).toBe(2)
    expect(questions()).toHaveLength(2)
    expect(events().filter(event => event.type === 'tool/call')).toHaveLength(2)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  }, 120_000)
})
