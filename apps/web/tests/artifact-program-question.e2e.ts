// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, fixtureUserPrompts, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

const DIR = fileURLToPath(new URL('./fixtures/replay/artifact-program-question', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}

function programSelection(request: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(request.contexts)) return undefined
  for (const context of request.contexts) {
    const contribution = object(context)
    if (contribution.kind !== 'artifact') continue
    const value = object(contribution.value)
    if (value.kind === 'html-runtime') return value
  }
  return undefined
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: program-reported ordinary question context', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const captured = Promise.withResolvers<{
    readonly envelope: Record<string, unknown>
    readonly request: Record<string, unknown>
    readonly headers: Record<string, string>
    readonly url: string
  }>()
  const release = Promise.withResolvers<undefined>()
  let intercepted = false

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
      const envelope = object(route.request().postDataJSON())
      const request = object(object(object(envelope.payload).args).request)
      const selection = programSelection(request)
      if (intercepted || selection === undefined || object(selection.capture).status !== 'ready') { await route.continue(); return }
      intercepted = true
      captured.resolve({ envelope, request, headers: await route.request().allHeaders(), url: route.request().url() })
      await release.promise
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
    release.resolve(undefined)
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally { delete process.env.AGENTRANS_TEST_CUSTOM_KEY }
    }
  })

  it('freezes the received report, preserves unknown-result retry, and repairs the same program from an attached error', async () => {
    const questions = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(questions).toHaveLength(3)
    const input = page.locator('[data-composer-input]').first()
    const first = scaffold.whenTurnSettled()
    await input.fill(questions[0]!)
    await input.press('Enter')
    const sessionId = await first
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Program question Session is not live')
    const artifactId = brandString<ArtifactId>('reported-counter')
    const card = () => page.getByRole('complementary', { name: 'Artifact: Reported counter', exact: true })
    const frame = () => card().frameLocator('[data-artifact-frame]')
    const attach = () => card().locator('[data-artifact-prompt-attach="html-runtime"]')
    const chip = () => page.locator('[data-artifact-prompt-context="html-runtime"]')
    const processes = page.locator('[data-turn-process], [data-process-activity]')
    for (let index = 0; index < await processes.count(); index++) {
      const control = processes.nth(index)
      if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
    }
    await expect.poll(() => attach().isEnabled()).toBe(true)
    await frame().locator('#advance').click()
    await expect.poll(() => frame().locator('#count').textContent()).toBe('1')
    await attach().click()
    await chip().waitFor({ state: 'visible' })
    await chip().getByRole('button', { name: 'Remove question context', exact: true }).click()
    expect(await chip().count()).toBe(0)
    await attach().click()
    const receivedTwo = page.evaluate(() => new Promise<void>((resolve) => {
      const receive = (event: MessageEvent<unknown>): void => {
        const data = event.data
        if (typeof data !== 'object' || data === null || !('kind' in data) || data.kind !== 'artifact-runtime-state' || !('state' in data)) return
        const state = data.state
        if (typeof state !== 'object' || state === null || !('count' in state) || state.count !== 2) return
        window.removeEventListener('message', receive)
        resolve()
      }
      window.addEventListener('message', receive)
    }))
    await frame().locator('#advance').click()
    await receivedTwo
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    const second = scaffold.whenTurnSettled()
    await input.fill(questions[1]!)
    await input.press('Enter')
    const original = await captured.promise
    const selected = programSelection(original.request)
    expect(selected).toMatchObject({ kind: 'html-runtime', capturedSessionId: sessionId, artifactId, revision: 1,
      capture: { status: 'ready', state: { count: 2 } } })
    await frame().locator('#advance').click()
    await expect.poll(() => frame().locator('#count').textContent()).toBe('3')
    await card().getByRole('button', { name: 'View source', exact: true }).click()
    await expect.poll(() => scaffold.ctx.artifactRuntime.inspect(agent, artifactId, 1).runs.length).toBe(0)
    release.resolve(undefined)
    expect(await second).toBe(sessionId)
    await page.unroute('**/api/session/prompt')

    const ordinary = () => agent.session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'user' ? [event.data] : [])
    const stateQuestion = ordinary()[1]!
    expect(stateQuestion.content).toHaveLength(2)
    const stateBlock = stateQuestion.content[1]
    if (stateBlock?.type !== 'text') throw new Error('Expected program context text')
    expect(stateBlock.text).not.toContain('Particle values are recomputed')
    const stateFacts = object(object(JSON.parse(stateBlock.text.split('\n')[1]!)).facts)
    expect(stateFacts).toMatchObject({ kind: 'html-runtime', attribution: 'program-reported', runtimeId: selected?.runtimeId,
      artifact: { artifactId, revision: 1, format: 'html' }, capture: { status: 'ready', state: { count: 2 } } })
    const disclosure = page.locator('[data-artifact-program-context]').first()
    expect(await disclosure.getAttribute('open')).toBeNull()
    await disclosure.locator('summary').click()
    expect(await disclosure.locator('pre').textContent()).toBe(stateBlock.text)
    await card().getByRole('button', { name: 'Show preview', exact: true }).click()
    await expect.poll(() => attach().isEnabled()).toBe(true)
    await chip().getByRole('alert').waitFor({ state: 'visible' })
    await chip().getByRole('button', { name: 'Remove question context', exact: true }).click()
    await frame().locator('#fail').click()
    await card().locator('[data-artifact-runtime-status="error"]').waitFor({ state: 'visible' })
    await expect.poll(() => attach().isEnabled()).toBe(true)
    await attach().click()
    const third = scaffold.whenTurnSettled()
    await input.fill(questions[2]!)
    await input.press('Enter')
    expect(await third).toBe(sessionId)
    const errorQuestion = ordinary()[2]!
    const errorBlock = errorQuestion.content[1]
    if (errorBlock?.type !== 'text') throw new Error('Expected program error context')
    const errorFacts = object(object(JSON.parse(errorBlock.text.split('\n')[1]!)).facts)
    expect(errorFacts).toMatchObject({ kind: 'html-runtime', attribution: 'program-reported', artifact: { revision: 1 },
      capture: { status: 'error', error: { code: 'PROGRAM_ERROR', message: 'Counter failed on purpose' } } })
    expect(Object.hasOwn(object(errorFacts.capture), 'state')).toBe(false)
    await expect.poll(() => card().getAttribute('data-artifact-revision')).toBe('2')
    await expect.poll(() => attach().isEnabled()).toBe(true)
    const headers = { ...original.headers }
    delete headers['content-length']
    const retry = await page.request.post(original.url, { headers, data: original.envelope })
    try { expect(object(object(await retry.json()).result).ok).toBe(true) } finally { await retry.dispose() }
    expect(ordinary()).toHaveLength(3)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(3)

    await chip().getByRole('button', { name: 'Remove question context', exact: true }).click()
    await attach().click()
    await page.route('**/api/session/prompt', async (route) => {
      const request = object(object(object(object(route.request().postDataJSON()).payload).args).request)
      if (programSelection(request) === undefined) { await route.continue(); return }
      const source = scaffold.ctx.artifacts.currentSnapshot(agent, artifactId)
      if (source?.format !== 'html' || source.revision !== 2) throw new Error('Expected current HTML revision 2')
      scaffold.ctx.artifacts.commit(agent, scaffold.ctx.artifacts.prepare(agent, {
        action: 'update', artifactId, baseRevision: 2, title: source.title, presentation: source.presentation, source: source.source,
      }))
      await route.continue()
    })
    await input.fill(questions[1]!)
    await input.press('Enter')
    await page.getByText('The selected context could not be attached. Select it again or remove it before sending.', { exact: true }).waitFor({ state: 'visible' })
    expect(await input.innerText()).toBe(questions[1])
    expect(ordinary()).toHaveLength(3)
    await page.unroute('**/api/session/prompt')
    const warningStart = tripwire.warnings.length
    await page.reload()
    await card().waitFor({ state: 'visible' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(await chip().count()).toBe(0)
    expect(ordinary()[1]?.content).toEqual(stateQuestion.content)
    expect(ordinary()[2]?.content).toEqual(errorQuestion.content)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action')).toHaveLength(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  }, 120_000)
})
