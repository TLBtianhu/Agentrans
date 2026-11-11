// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Agent } from '@agentrans/agent'
import { brandString } from '@agentrans/brand'
import type { ArtifactId } from '@agentrans/artifact/types'
import type { ArtifactRuntimeInspection } from '@agentrans/artifact-runtime/types'
import type { SessionEvent } from '@agentrans/session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, fixtureUserPrompts, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

const DIR = fileURLToPath(new URL('./fixtures/replay/artifact-runtime-wait', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')

interface RuntimeFact extends ArtifactRuntimeInspection {
  readonly wait: { readonly outcome: string; readonly limitMs: number }
  readonly budget: { readonly remainingQueries: number; readonly remainingRepairAttempts: number }
}

function toolResult(events: readonly SessionEvent[], callId: string) {
  const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === callId)
  if (result?.type !== 'tool/result') throw new Error(`Missing logged result for ${callId}`)
  return result.data.message
}

function runtimeFact(events: readonly SessionEvent[], callId: string): RuntimeFact {
  const result = toolResult(events, callId)
  expect(result.isError).toBe(false)
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error(`Missing runtime report text for ${callId}`)
  return JSON.parse(block.text) as RuntimeFact
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: bounded Artifact readiness and repair', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const firstQuery = Promise.withResolvers<Agent>()
  const legacyCreated = Promise.withResolvers<undefined>()

  beforeAll(async () => {
    process.env.AGENTRANS_TEST_CUSTOM_KEY = 'local-test-key'
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE, compareReplaySession: false, paceMs: 10,
      extraOverlayPath: fileURLToPath(new URL('./teaching-custom-provider.overlay.yml', import.meta.url)),
      replayProviders: [{ id: 'custom-provider', name: 'Custom Lab',
        models: [{ id: 'user-model', name: 'Custom Lab Model', contextWindow: 8192 }] }],
    })
    scaffold.ctx.on('tools/execute', (exec, next) => {
      if (exec.callId === 'wait-report-1' && exec.agent !== undefined) firstQuery.resolve(exec.agent)
      return next()
    })
    scaffold.ctx.on('session/event', (_session, event) => {
      if (event.type === 'artifact/upsert' && event.data.artifactId === 'bounded-legacy') legacyCreated.resolve(undefined)
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

  it('waits for real reports, stops at both budgets, and grants a fresh turn without replaying side effects', async () => {
    const questions = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(questions).toHaveLength(2)
    const input = page.locator('[data-composer-input]').first()
    const card = (title: string) => page.getByRole('complementary', { name: `Artifact: ${title}`, exact: true })
    const expand = async (): Promise<void> => {
      const controls = page.locator('[data-turn-process], [data-process-activity]')
      for (let index = 0; index < await controls.count(); index++) {
        const control = controls.nth(index)
        if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
      }
    }
    const first = scaffold.whenTurnSettled(60_000)
    await input.fill(questions[0]!)
    await input.press('Enter')
    const agent = await firstQuery.promise
    const artifactId = brandString<ArtifactId>('bounded-counter')
    const inspect = (revision: number) => scaffold.ctx.artifactRuntime.inspect(agent, artifactId, revision)
    await expand()
    await card('Bounded counter').waitFor({ state: 'visible' })
    expect(agent.session.snapshotEvents().some(event => event.type === 'tool/result' && event.data.message.toolCallId === 'wait-report-1')).toBe(false)
    await card('Bounded counter').frameLocator('[data-artifact-frame]').getByRole('button', { name: 'Initialize counter', exact: true }).click()
    const sessionId = await first
    expect(sessionId).toBe(agent.id)
    await expand()
    await expect.poll(() => card('Bounded counter').getAttribute('data-artifact-revision')).toBe('3')
    await expect.poll(() => card('Bounded counter').frameLocator('[data-artifact-frame]').locator('#count').textContent()).toBe('3')
    expect(inspect(3).runs.some(run => run.status === 'ready')).toBe(true)
    const events = agent.session.snapshotEvents()
    expect(events.flatMap(event => event.type === 'artifact/upsert' ? [event.data.revision] : [])).toEqual([1, 2, 3])
    expect(runtimeFact(events, 'wait-report-1')).toMatchObject({
      artifactId: 'bounded-counter', revision: 1, reportAuthority: 'client-reported',
      wait: { outcome: 'reported', limitMs: 5000 }, budget: { remainingQueries: 3, remainingRepairAttempts: 2 },
      runs: [{ status: 'error', error: { code: 'PROGRAM_ERROR', message: 'Counter initialization 1 failed' } }],
    })
    expect(runtimeFact(events, 'wait-report-2')).toMatchObject({
      revision: 2, wait: { outcome: 'reported' }, budget: { remainingQueries: 2, remainingRepairAttempts: 1 },
      runs: [{ status: 'error', error: { message: 'Counter initialization 2 failed' } }],
    })
    expect(runtimeFact(events, 'wait-report-3')).toMatchObject({
      revision: 3, wait: { outcome: 'reported' }, budget: { remainingQueries: 1, remainingRepairAttempts: 0 },
      runs: [{ status: 'ready', capabilities: { state: true, commands: [] } }],
    })
    expect(runtimeFact(events, 'wait-report-4')).toMatchObject({
      revision: 3, wait: { outcome: 'snapshot', limitMs: 0 }, budget: { remainingQueries: 0, remainingRepairAttempts: 0 },
    })
    expect(toolResult(events, 'wait-repair-denied')).toMatchObject({ isError: true, content: [{ type: 'text',
      text: 'Error: Artifact runtime repair budget exhausted (2 update attempts this turn). Stop automatic repairs and explain the reported error and unresolved result to the user.',
    }] })
    expect(toolResult(events, 'wait-query-denied')).toMatchObject({ isError: true, content: [{ type: 'text',
      text: 'Error: Artifact runtime query budget exhausted (4 attempts this turn). Explain the reports already received and any uncertainty; stop querying until a new turn.',
    }] })
    expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'tool/call')).toHaveLength(9)

    const second = scaffold.whenTurnSettled(60_000)
    await input.fill(questions[1]!)
    await input.press('Enter')
    await legacyCreated.promise
    await expand()
    await card('Bounded legacy').waitFor({ state: 'visible' })
    expect(await second).toBe(sessionId)
    await expand()
    const completed = agent.session.snapshotEvents()
    expect(runtimeFact(completed, 'wait-new-turn-report')).toMatchObject({
      revision: 4, wait: { outcome: 'reported' }, budget: { remainingQueries: 3, remainingRepairAttempts: 2 },
      runs: [{ status: 'ready' }],
    })
    const legacy = runtimeFact(completed, 'wait-legacy-report')
    expect(legacy).toMatchObject({
      artifactId: 'bounded-legacy', wait: { outcome: 'timeout', limitMs: 5000 },
      budget: { remainingQueries: 2, remainingRepairAttempts: 2 }, runs: [{ status: 'starting' }],
    })
    expect(completed.flatMap(event => event.type === 'artifact/upsert' && event.data.artifactId === artifactId ? [event.data.revision] : []))
      .toEqual([1, 2, 3, 4])
    expect(completed.filter(event => event.type === 'tool/call')).toHaveLength(13)
    expect(completed.filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(completed.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(2)
    expect(completed.filter(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action')).toHaveLength(0)

    const warningStart = tripwire.warnings.length
    await page.reload()
    await page.getByText(questions[1]!, { exact: true }).waitFor({ state: 'visible' })
    await expand()
    await card('Bounded counter').waitFor({ state: 'visible' })
    await expect.poll(() => inspect(4).runs.some(run => run.status === 'ready')).toBe(true)
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(runtimeFact(agent.session.snapshotEvents(), 'wait-legacy-report')).toEqual(legacy)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(13)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  }, 120_000)
})
