// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brandString } from '@agentrans/brand'
import { observeParticleState, restoreParticleCheckpoint } from '@agentrans/artifact/particle-runtime'
import type { ArtifactId } from '@agentrans/artifact/types'
import { verifyParticleDownload } from './artifact-sent-particle-download-support.ts'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, launchWebScaffold,
  readPersistedEvents, watchConsole, webSnapshotMode, type WebScaffold,
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
    const executablePath = process.env.AGENTRANS_PLAYWRIGHT_EXECUTABLE_PATH
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

  it('replays and downloads the six-step state from a saved question after the run and revision advance', async () => {
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
    const attachReadings = async (): Promise<void> => {
      await card().getByRole('button', { name: 'Use for next question', exact: true }).click()
      await card().getByRole('region', { name: 'Review particle readings', exact: true })
        .getByRole('button', { name: 'Attach readings', exact: true }).click()
    }
    const processControls = page.locator('[data-turn-process], [data-process-activity]')
    for (let index = 0; index < await processControls.count(); index++) {
      const control = processControls.nth(index)
      if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
    }
    await card().locator('canvas[aria-label="Interactive particle simulation"]').waitFor({ state: 'visible' })
    for (let step = 0; step < 6; step++) await card().getByRole('button', { name: 'Step', exact: true }).click()
    await attachReadings()
    const chip = () => page.locator('[data-artifact-prompt-context="current-particle"]:visible')
    await chip().waitFor({ state: 'visible' })
    await chip().getByRole('button', { name: 'Remove question context', exact: true }).click()
    expect(await chip().count()).toBe(0)
    await card().locator('[data-particle-step="6"]').waitFor({ state: 'visible' })
    await attachReadings()
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
    const events = agent.session.snapshotEvents()
    const messages = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(messages).toHaveLength(2)
    const savedQuestion = messages[1]
    const source = events.find(event => event.type === 'artifact/upsert')?.data
    if (savedQuestion?.type !== 'user/message' || source?.format !== 'scene' || source.spec.kind !== 'particle-system') {
      throw new Error('The saved question and original particle revision must be in history')
    }
    const question = savedQuestion.data
    const address = { eventSeq: savedQuestion.seq, messageId: question.id }
    expect(question.source.kind).toBe('user')
    expect(question.content).toHaveLength(2)
    expect(question.content[0]).toEqual({ type: 'text', text: questions[1] })
    const context = question.content[1]
    if (context?.type !== 'text') throw new Error('Question lost its attached experiment')
    const facts = object(object(JSON.parse(context.text.slice(context.text.indexOf('\n') + 1))).facts)
    expect(facts.kind).toBe('current-particle')
    const lockedCheckpoint = { runtimeVersion: 1, stepCount: 6 } as const
    expect(facts.checkpoint).toEqual(lockedCheckpoint)
    expect(facts.artifact).toEqual(source)
    const attachedValues = object(facts.values)
    expect(attachedValues.time).toBeCloseTo(0.2, 12)
    const historicalQuestion = page.locator(`[data-chat-message-id="${address.messageId}"][data-chat-message-seq="${address.eventSeq}"]:visible`)
      .filter({ hasText: questions[1]! })
    const displayed = historicalQuestion.locator('details[data-artifact-question-context]')
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
      const current = scaffold.ctx.artifacts.resolveSceneSource(agent, {
        kind: 'current', artifactId: brandString<ArtifactId>('projectile-runtime'), revision: 1,
        checkpoint: { runtimeVersion: 1, stepCount: 7 },
      })
      if (current.artifact.spec.kind !== 'particle-system') throw new Error('The current source must remain a particle experiment')
      scaffold.ctx.artifacts.commit(agent, scaffold.ctx.artifacts.prepare(agent, {
        action: 'update', artifactId: current.artifact.artifactId, baseRevision: 1, format: 'scene',
        title: current.artifact.title, presentation: current.artifact.presentation,
        spec: { ...current.artifact.spec, gravity: { ...current.artifact.spec.gravity, y: -12 } },
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
    expect(await card().getAttribute('data-artifact-revision')).toBe('2')
    const toggle = historicalQuestion.getByRole('button', { name: 'Replay experiment', exact: true })
    const replay = historicalQuestion.locator('[data-artifact-question-replay-panel]')
    await toggle.waitFor({ state: 'visible' })
    expect(await displayed.getAttribute('open')).toBeNull()
    const lockedValues = observeParticleState(restoreParticleCheckpoint(source.spec, lockedCheckpoint))
    expect(attachedValues).toEqual(lockedValues)
    const beforeDownload = await readPersistedEvents(scaffold, sessionId)
    const rootsBeforeDownload = scaffold.ctx.agents.roots().map(root => root.id)
    await verifyParticleDownload({ browser, page, card: historicalQuestion, directory: scaffold.workspaceCwd, sessionId, address,
      scene: { ...source, spec: source.spec }, reading: { checkpoint: lockedCheckpoint, values: lockedValues }, kind: 'sentQuestion' })
    expect(await readPersistedEvents(scaffold, sessionId)).toEqual(beforeDownload)
    expect(scaffold.ctx.agents.roots().map(root => root.id)).toEqual(rootsBeforeDownload)
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    await toggle.click()
    const replayCanvas = replay.getByRole('img')
    await replayCanvas.waitFor({ state: 'visible' })
    expect(await replayCanvas.getAttribute('width')).toBe('900')
    expect(await replayCanvas.getAttribute('height')).toBe('420')
    await replay.locator('[data-artifact-question-replay-id="projectile-runtime"][data-artifact-question-replay-revision="1"]')
      .waitFor({ state: 'visible' })
    const checkpoint = replay.locator('[data-particle-step="6"]')
    await checkpoint.waitFor({ state: 'visible' })
    expect(await checkpoint.locator('[data-particle-source-time]').innerText()).toBe(String(attachedValues.time))
    const particles = checkpoint.locator('[data-particle-live-id]')
    await particles.first().waitFor({ state: 'visible' })
    const restoredParticles = await Promise.all((await particles.all()).map(async (particle) => {
      const coordinates = await Promise.all(['x', 'y', 'vx', 'vy'].map(async name => [
        name, Number(await particle.locator(`[data-particle-live-coordinate="${name}"]`).innerText()),
      ] as const))
      return { id: await particle.getAttribute('data-particle-live-id'), ...Object.fromEntries(coordinates) }
    }))
    expect(restoredParticles).toEqual(attachedValues.particles)
    expect(await replay.getByRole('button', { name: 'Step', exact: true }).count()).toBe(0)
    expect(await replay.getByRole('button', { name: 'Use for next question', exact: true }).count()).toBe(0)
    expect(await card().getAttribute('data-artifact-revision')).toBe('2')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'artifact/observations')).toEqual([])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(2)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  })
})
