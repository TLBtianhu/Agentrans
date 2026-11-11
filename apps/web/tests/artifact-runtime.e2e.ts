// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brandString } from '@agentrans/brand'
import type { ArtifactId } from '@agentrans/artifact/types'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, fixtureUserPrompts, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

const DIR = fileURLToPath(new URL('./fixtures/replay/artifact-runtime', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')

describe.skipIf(webSnapshotMode() === 'record')('web e2e: reported Artifact runtime readiness', () => {
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

  it('acknowledges actual commands, logs an error inspection and repairs the same source with a new runtime', async () => {
    const questions = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(questions).toHaveLength(3)
    const input = page.locator('[data-composer-input]').first()
    const first = scaffold.whenTurnSettled()
    await input.fill(questions[0]!)
    await input.press('Enter')
    const sessionId = await first
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Runtime Session is not live')
    const inspect = (id: string, revision = 1) => scaffold.ctx.artifactRuntime.inspect(agent, brandString<ArtifactId>(id), revision)
    const card = (title: string) => page.getByRole('complementary', { name: `Artifact: ${title}`, exact: true })
    const expand = async (): Promise<void> => {
      const controls = page.locator('[data-turn-process], [data-process-activity]')
      for (let index = 0; index < await controls.count(); index++) {
        const control = controls.nth(index)
        if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
      }
    }
    await expand()
    const comparison = page.locator('section[data-comparison-group="runtime-study"]')
    await comparison.waitFor({ state: 'visible' })
    await expect.poll(() => inspect('runtime-control').runs.some(run => run.status === 'ready')).toBe(true)
    await expect.poll(() => inspect('runtime-variant').runs.some(run => run.status === 'ready')).toBe(true)
    await expect.poll(() => inspect('runtime-legacy').runs.length).toBeGreaterThan(0)
    expect(inspect('runtime-legacy').runs.every(run => run.status === 'starting')).toBe(true)
    expect(inspect('runtime-legacy').sourceCapabilities.observe).toBe('unsupported')
    expect(await comparison.getByRole('button', { name: 'Play all', exact: true }).count()).toBe(0)
    expect(await comparison.getByRole('button', { name: 'Pause all', exact: true }).count()).toBe(0)
    const originalVariant = inspect('runtime-variant').runs.map(run => run.runtimeId)
    await comparison.getByRole('button', { name: 'Step all', exact: true }).click()
    await expect.poll(() => inspect('runtime-variant').runs.some(run => run.status === 'error' && run.error.message.includes('Variant step failed'))).toBe(true)
    expect(await card('Runtime control').frameLocator('[data-artifact-frame]').locator('#count').textContent()).toBe('1')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action')).toHaveLength(0)

    const second = scaffold.whenTurnSettled()
    await input.fill(questions[1]!)
    await input.press('Enter')
    expect(await second).toBe(sessionId)
    await expect.poll(() => card('Runtime variant').getAttribute('data-artifact-revision')).toBe('2')
    await expect.poll(() => inspect('runtime-variant', 2).runs.some(run => run.status === 'ready')).toBe(true)
    expect(inspect('runtime-variant', 2).runs.every(run => !originalVariant.includes(run.runtimeId))).toBe(true)
    await comparison.getByRole('button', { name: 'Step all', exact: true }).click()
    await expect.poll(() => card('Runtime variant').frameLocator('[data-artifact-frame]').locator('#count').textContent()).toBe('1')
    await expect.poll(() => comparison.getByRole('button', { name: 'Step all', exact: true }).isEnabled()).toBe(true)

    const third = scaffold.whenTurnSettled()
    await input.fill(questions[2]!)
    await input.press('Enter')
    expect(await third).toBe(sessionId)
    const events = agent.session.snapshotEvents()
    const calls = new Set(events.flatMap(event => event.type === 'tool/call' && event.data.name === 'artifact_runtime' ? [event.data.callId] : []))
    const results = events.flatMap(event => event.type === 'tool/result' && calls.has(event.data.message.toolCallId) ? [event.data.message] : [])
    expect(results).toHaveLength(3)
    const facts = results.map((result) => {
      const block = result.content[0]
      if (block?.type !== 'text') throw new Error('Runtime inspection must be logged as tool text')
      return JSON.parse(block.text) as ReturnType<typeof inspect>
    })
    expect(facts[0]).toMatchObject({ artifactId: 'runtime-variant', revision: 1, reportAuthority: 'client-reported' })
    expect(facts[0]?.runs.some(run => run.status === 'error')).toBe(true)
    expect(facts[1]).toMatchObject({ artifactId: 'runtime-control', revision: 1 })
    expect(facts[2]).toMatchObject({ artifactId: 'runtime-variant', revision: 2 })
    expect(facts.slice(1).every(fact => fact.runs.some(run => run.status === 'ready'))).toBe(true)
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(3)
    expect(events.filter(event => event.type === 'turn/start')).toHaveLength(3)

    const originalControl = inspect('runtime-control').runs.map(run => run.runtimeId)
    await card('Runtime control').getByRole('button', { name: 'View source', exact: true }).click()
    await expect.poll(() => inspect('runtime-control').runs.length).toBe(0)
    await card('Runtime control').getByRole('button', { name: 'Show preview', exact: true }).click()
    await expect.poll(() => inspect('runtime-control').runs.some(run => run.status === 'ready')).toBe(true)
    expect(inspect('runtime-control').runs.every(run => !originalControl.includes(run.runtimeId))).toBe(true)

    const beforeReload = inspect('runtime-variant', 2).runs.map(run => run.runtimeId)
    const warningStart = tripwire.warnings.length
    await page.reload()
    await comparison.waitFor({ state: 'visible' })
    await expand()
    await expect.poll(() => inspect('runtime-variant', 2).runs.some(run => run.status === 'ready')).toBe(true)
    expect(inspect('runtime-variant', 2).runs.every(run => !beforeReload.includes(run.runtimeId))).toBe(true)
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await browser.close()
    await expect.poll(() => inspect('runtime-control').runs.length).toBe(0)
    await expect.poll(() => inspect('runtime-variant', 2).runs.length).toBe(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(3)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  }, 120_000)
})
