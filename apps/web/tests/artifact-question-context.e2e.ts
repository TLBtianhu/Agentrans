// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

// Authored model output exercises the actual composer and Host admission path.
const DIR = fileURLToPath(new URL('./fixtures/replay/artifact-question-context', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const TITLE = 'Projectile runtime'

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected object')
  return value as Record<string, unknown>
}

function ordinaryQuestions(fixture: string): string[] {
  return fixture.trim().split('\n').flatMap((line) => {
    const row = object(JSON.parse(line))
    if (row.type !== 'user/message') return []
    const message = object(row.data)
    if (object(message.source).kind !== 'user' || !Array.isArray(message.content)) return []
    const first = object(message.content[0])
    if (first.type !== 'text' || typeof first.text !== 'string') throw new Error('Question fixture requires text')
    return [first.text]
  })
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: ordinary question experiment context', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const captured = Promise.withResolvers<Record<string, unknown>>()
  const release = Promise.withResolvers<undefined>()

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
    await page.route('**/api/session/prompt', async (route) => {
      const envelope: unknown = route.request().postDataJSON()
      const request = object(object(object(envelope).payload).args).request
      const input = object(request)
      if (!Array.isArray(input.contexts) || input.contexts.length === 0) { await route.continue(); return }
      captured.resolve(input)
      await release.promise
      const response = await route.fetch()
      try {
        // A committed question can be observed through its Inbox receipt even if the HTTP response is lost.
        const envelope: unknown = await response.json()
        expect(object(object(envelope).result).ok).toBe(true)
        await route.abort('failed')
      } finally { await response.dispose() }
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  })

  afterAll(async () => {
    release.resolve(undefined)
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally { delete process.env.AGENTRANS_TEST_CUSTOM_KEY }
    }
  })

  it('attaches the six-step state to one normal question while the visible run continues', async () => {
    const questions = ordinaryQuestions(await readFile(FIXTURE, 'utf8'))
    expect(questions).toHaveLength(2)
    const input = page.locator('[data-composer-input]').first()
    const first = scaffold.whenTurnSettled()
    await input.fill(questions[0]!)
    await input.press('Enter')
    const sessionId = await first
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Question Session is not live')
    const card = () => page.getByRole('complementary', { name: `Artifact: ${TITLE}`, exact: true })
    const processControls = page.locator('[data-turn-process], [data-process-activity]')
    for (let index = 0; index < await processControls.count(); index++) {
      const control = processControls.nth(index)
      if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
    }
    await card().locator('canvas[aria-label="Interactive particle simulation"]').waitFor({ state: 'visible' })
    for (let step = 0; step < 6; step++) await card().getByRole('button', { name: 'Step', exact: true }).click()
    await card().getByRole('button', { name: 'Use for next question', exact: true }).click()
    const chip = () => page.locator('[data-artifact-prompt-context="current-particle"]:visible')
    await chip().waitFor({ state: 'visible' })
    await chip().getByRole('button', { name: 'Remove question context', exact: true }).click()
    expect(await chip().count()).toBe(0)
    await card().locator('[data-particle-step="6"]').waitFor({ state: 'visible' })
    await card().getByRole('button', { name: 'Use for next question', exact: true }).click()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)

    const second = scaffold.whenTurnSettled()
    await input.fill(questions[1]!)
    await input.press('Enter')
    const request = await captured.promise
    expect(request.contexts).toEqual([{ kind: 'artifact', value: {
      kind: 'current-particle', artifactId: 'projectile-runtime', revision: 1, checkpoint: { runtimeVersion: 1, stepCount: 6 },
    } }])
    await card().getByRole('button', { name: 'Step', exact: true }).click()
    await card().locator('[data-particle-step="7"]').waitFor({ state: 'visible' })
    release.resolve(undefined)
    expect(await second).toBe(sessionId)
    await page.getByText('Your question refers to revision 1 at step 6. Continuing the simulation afterwards does not change the attached conditions.', { exact: true })
      .waitFor({ state: 'visible' })
    expect(await page.locator('[data-prompt-context-retry]:visible').count()).toBe(0)
    const messages = agent.session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'user' ? [event.data] : [])
    expect(messages).toHaveLength(2)
    const question = messages[1]!
    expect(question.source.kind).toBe('user')
    expect(question.content).toHaveLength(2)
    expect(question.content[0]).toEqual({ type: 'text', text: questions[1] })
    const context = question.content[1]
    if (context?.type !== 'text') throw new Error('Question lost its attached experiment')
    const facts = object(object(JSON.parse(context.text.slice(context.text.indexOf('\n') + 1))).facts)
    expect(facts.kind).toBe('current-particle')
    expect(facts.checkpoint).toEqual({ runtimeVersion: 1, stepCount: 6 })
    expect(object(facts.artifact).revision).toBe(1)
    expect(object(facts.values).time).toBeCloseTo(0.2, 12)
    const displayed = page.locator('details[data-artifact-question-context]:visible').last()
    await displayed.waitFor({ state: 'visible' })
    expect(await displayed.getAttribute('open')).toBeNull()
    expect(await displayed.locator('[data-artifact-question-context-raw]').isVisible()).toBe(false)
    await displayed.locator('summary').click()
    expect(await displayed.locator('[data-artifact-question-context-raw]').textContent()).toBe(context.text)
    await displayed.locator('summary').click()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action')).toEqual([])

    await page.unroute('**/api/session/prompt')
    // Source replacement after browser capture must reject the old selection, preserving the question draft.
    await page.route('**/api/session/prompt', async (route) => {
      const source = scaffold.ctx.artifacts.resolveSceneSource(agent, {
        kind: 'current', artifactId: brandString<ArtifactId>('projectile-runtime'), revision: 1,
        checkpoint: { runtimeVersion: 1, stepCount: 7 },
      })
      scaffold.ctx.artifacts.commit(agent, scaffold.ctx.artifacts.prepare(agent, {
        action: 'update', artifactId: source.artifact.artifactId, baseRevision: 1, format: 'scene',
        title: source.artifact.title, presentation: source.artifact.presentation, spec: source.artifact.spec,
      }))
      await route.continue()
    })
    await input.fill(questions[1]!)
    await input.press('Enter')
    await page.getByText('The selected context could not be attached. Select it again or remove it before sending.', { exact: true })
      .waitFor({ state: 'visible' })
    expect(await input.innerText()).toBe(questions[1])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)
    await expect.poll(() => card().getAttribute('data-artifact-revision')).toBe('2')
    await page.unroute('**/api/session/prompt')
    const warningStart = tripwire.warnings.length
    await page.reload()
    await card().waitFor({ state: 'visible' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(await chip().count()).toBe(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(2)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  })
})
