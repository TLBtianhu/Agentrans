/** Opt-in real-provider acceptance of one particle Artifact across two ordinary questions. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-artifact/types'
import type {} from '@deepseek-ai/dsh-artifact-followup/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { chromium, type Browser, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import {
  launchWebScaffold, rawSessionLog, readPersistedEvents, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

const LIVE = process.env.DSH_ARTIFACT_LIVE === '1'
const HAS_KEY = (process.env.DEEPSEEK_API_KEY?.length ?? 0) > 0
const MODE = webSnapshotMode()
const ID = 'live-particle-lab'
const TITLE = 'Live particle lab'
const MODEL = 'deepseek-flash'
const INITIAL = {
  kind: 'particle-system', particles: [{ id: 'alpha', x: 0, y: 0, vx: 1, vy: 0, mass: 1 }],
  gravity: { x: 0, y: 0 }, timeStep: 0.1, trails: false,
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}

describe.skipIf(!LIVE)('web live: real DeepSeek particle Artifact', () => {
  it('requires the explicit real-provider mode', () => {
    expect(MODE, 'Live Artifact acceptance requires DSH_SNAPSHOT=record').toBe('record')
  })

  it.skipIf(!HAS_KEY || MODE !== 'record')('creates, observes and revises the same experiment through real model calls', async (test) => {
    const outputRoot = process.env.DSH_ARTIFACT_LIVE_OUTPUT_DIR
    if (outputRoot === undefined || outputRoot.length === 0) throw new Error('Set DSH_ARTIFACT_LIVE_OUTPUT_DIR for live acceptance evidence')
    await mkdir(outputRoot, { recursive: true })
    const evidence = await mkdtemp(join(outputRoot, 'artifact-live-'))
    let scaffold: WebScaffold | undefined
    let browser: Browser | undefined
    let page: Page | undefined
    let sessionId: SessionId | undefined
    let bodyPassed = false
    let evidenceWritten = false
    let stage = 'boot'
    const requests: { origin: string; status: number; ok: boolean }[] = []
    const originalFetch = globalThis.fetch
    // Observe status only; the real adapter owns request/response bodies and credentials.
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      const response = await originalFetch(input, init)
      if (method === 'POST' && url.pathname.endsWith('/messages')
        && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        requests.push({ origin: url.origin, status: response.status, ok: response.ok })
      }
      return response
    }
    test.onTestFinished(async () => {
      const cleanupErrors: unknown[] = []
      try { await browser?.close() } catch (error) { cleanupErrors.push(error) }
      try { await scaffold?.close() } catch (error) { cleanupErrors.push(error) }
      globalThis.fetch = originalFetch
      await writeFile(join(evidence, 'summary.json'), JSON.stringify({
        passed: bodyPassed && evidenceWritten && cleanupErrors.length === 0,
        bodyPassed, evidenceWritten, cleanupCompleted: cleanupErrors.length === 0,
        stage, mode: MODE, provider: 'deepseek-official', model: MODEL, requests,
      }, null, 2) + '\n', 'utf8')
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Live Artifact cleanup failed')
    })

    try {
      // Record mode without a replayFixture retains the native adapter and writes no fixture.
      const world = await launchWebScaffold()
      scaffold = world
      expect(world.mode).toBe('record')
      const entries = [...world.ctx.loader.entries()]
      expect(entries.some(entry => entry.options.id === 'llm-deepseek'
        && entry.options.name === '@deepseek-ai/dsh-llm-deepseek-api-key'
        && entry.fiber?.state === FiberState.ACTIVE)).toBe(true)
      expect(entries.filter(entry => entry.options.name === '@deepseek-ai/dsh-llm-replay')).toEqual([])
      expect([...world.ctx.registry.values()].some(runtime => runtime.name === 'llm-replay')).toBe(false)
      const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
      browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
      const view = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
      page = view
      const console = watchConsole(view)
      await view.goto(world.authenticatedUrl, { waitUntil: 'load' })
      await view.waitForSelector('[class*="frame"]')
      await connectFreshWorkspace(view, world.workspaceCwd)
      const input = view.locator('[data-composer-input]').first()
      const card = () => view.getByRole('complementary', { name: `Artifact: ${TITLE}`, exact: true })
      const expand = async (): Promise<void> => {
        const controls = view.locator('[data-turn-process], [data-process-activity]')
        for (let index = 0; index < await controls.count(); index++) {
          const control = controls.nth(index)
          if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
        }
      }

      stage = 'create'
      const first = world.whenTurnSettled()
      await input.fill(`请直接调用 scene 工具创建一个粒子实验，不要创建工作区文件。sceneId 必须是 ${ID}，title 必须是 ${TITLE}，presentation 必须是 inline，action=create，kind=particle-system。完整 spec 严格为 ${JSON.stringify(INITIAL)}。创建成功后简短确认。`)
      await input.press('Enter')
      sessionId = await first
      const id = sessionId
      const events = () => readPersistedEvents(world, id)
      let stored = await events()
      expect(stored.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])).toEqual(['completed'])
      const firstUpserts = stored.flatMap(event => event.type === 'artifact/upsert' ? [event.data] : [])
      expect(firstUpserts).toHaveLength(1)
      const original = firstUpserts[0]
      expect(original).toMatchObject({ artifactId: ID, title: TITLE, revision: 1, format: 'scene', spec: INITIAL })
      await expand()
      await card().locator('canvas[aria-label="Interactive particle simulation"]').waitFor({ state: 'visible' })

      stage = 'local-step'
      const requestCount = requests.length
      for (let step = 0; step < 3; step++) await card().getByRole('button', { name: 'Step', exact: true }).click()
      await card().locator('[data-particle-step="3"]').waitFor({ state: 'visible' })
      expect(Number(await card().locator('[data-particle-step]').getAttribute('data-particle-time'))).toBeCloseTo(0.3, 10)
      expect((await events()).filter(event => event.type === 'turn/start')).toHaveLength(1)
      expect(requests).toHaveLength(requestCount)
      await view.screenshot({ path: join(evidence, 'original-step-3.png'), fullPage: true })

      stage = 'ordinary-followup'
      await card().getByRole('button', { name: 'Use for next question', exact: true }).click()
      await view.locator('[data-artifact-prompt-context="current-particle"]:visible').waitFor({ state: 'visible' })
      const second = world.whenTurnSettled()
      await input.fill(`这是一个普通追问。请先根据我附带的当前实验观测说明 alpha 三步后的位置，再调用 scene 工具修改同一个 ${ID}，action=update、baseRevision=1，保持 title 为 ${TITLE} 和 presentation=inline。只把初始 vx 从1改为2，其余初始条件、零重力、timeStep=0.1、trails=false保持不变。不要新建第二个对象，也不要把观测到的当前位置当成初始位置。完成后简短确认。`)
      await input.press('Enter')
      expect(await second).toBe(id)
      stored = await events()
      expect(stored.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])).toEqual(['completed', 'completed'])
      const questions = stored.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user' ? [event.data] : [])
      expect(questions).toHaveLength(2)
      const contextBlock = questions[1]?.content[1]
      if (contextBlock?.type !== 'text') throw new Error('Ordinary follow-up lost its Artifact context')
      const context = object(JSON.parse(contextBlock.text.slice(contextBlock.text.indexOf('\n') + 1)))
      expect(context).toMatchObject({ kind: 'artifact-question-context', sessionId: id })
      const facts = object(context.facts)
      expect(facts).toMatchObject({ kind: 'current-particle', artifact: original, checkpoint: { runtimeVersion: 1, stepCount: 3 } })
      const values = object(facts.values)
      expect(values.time).toBeCloseTo(0.3, 10)
      if (!Array.isArray(values.particles) || values.particles.length !== 1) throw new Error('Expected the Host-computed alpha observation')
      expect(object(values.particles[0])).toMatchObject({ id: 'alpha', y: 0, vx: 1, vy: 0 })
      expect(object(values.particles[0]).x).toBeCloseTo(0.3, 10)
      const upserts = stored.flatMap(event => event.type === 'artifact/upsert' ? [event.data] : [])
      expect(upserts.map(artifact => [artifact.artifactId, artifact.revision])).toEqual([[ID, 1], [ID, 2]])
      expect(upserts[1]).toMatchObject({ format: 'scene', title: TITLE,
        spec: { ...INITIAL, particles: [{ ...INITIAL.particles[0], vx: 2 }] } })
      const sceneCalls = stored.flatMap(event => event.type === 'tool/call' && event.data.name === 'scene' ? [event.data] : [])
      expect(sceneCalls).toHaveLength(2)
      expect(JSON.parse(sceneCalls[0]!.arguments)).toMatchObject({ action: 'create', sceneId: ID })
      expect(JSON.parse(sceneCalls[1]!.arguments)).toMatchObject({ action: 'update', sceneId: ID, baseRevision: 1 })
      for (const call of sceneCalls) {
        const result = stored.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.callId)
        expect(result?.type === 'tool/result' && result.data.message.isError !== true).toBe(true)
      }
      expect(stored.filter(event => event.type === 'assistant/attempt')).toEqual([])
      expect(stored.flatMap(event => event.type === 'assistant/message' ? event.data.stream : [])
        .filter(record => record.type === 'chunk' && record.chunk.type === 'finish' && record.chunk.reason.kind === 'error')).toEqual([])
      const headers = stored.flatMap(event => event.type === 'request/header' ? [event.data.header.config] : [])
      expect(headers.length).toBeGreaterThan(0)
      for (const header of headers) expect(header).toMatchObject({ provider: 'deepseek-official', model: MODEL })

      stage = 'revised-runtime'
      await expand()
      await expect.poll(() => card().getAttribute('data-artifact-revision')).toBe('2')
      await card().locator('[data-particle-step="0"]').waitFor({ state: 'visible' })
      await card().getByRole('button', { name: 'Step', exact: true }).click()
      await card().locator('[data-particle-step="1"]').waitFor({ state: 'visible' })
      await card().getByRole('textbox', { name: 'Observation name', exact: true }).fill('Live revised step 1')
      await card().getByRole('button', { name: 'Save observation', exact: true }).click()
      await card().locator('section[aria-label="Saved observations"] li')
        .filter({ has: view.getByText('Live revised step 1', { exact: true }) }).waitFor({ state: 'visible' })
      const active = world.ctx.agents.get(id)
      if (active === undefined) throw new Error('Live Artifact Session was released before observation flush')
      await world.ctx.sessions.flush(active.session)
      stored = await events()
      const revised = stored.flatMap(event => event.type === 'artifact/observations' ? event.data.observations : [])
        .find(observation => observation.label === 'Live revised step 1')
      expect(revised).toMatchObject({ artifact: upserts[1], checkpoint: { runtimeVersion: 1, stepCount: 1 } })
      expect(revised?.values.time).toBeCloseTo(0.1, 10)
      expect(revised?.values.particles[0]).toMatchObject({ id: 'alpha', vx: 2, y: 0, vy: 0 })
      expect(revised?.values.particles[0]?.x).toBeCloseTo(0.2, 10)
      expect(stored.filter(event => event.type === 'turn/start')).toHaveLength(2)
      expect(stored.filter(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action')).toEqual([])
      expect(requests.length).toBeGreaterThanOrEqual(2)
      expect(requests.every(request => request.ok)).toBe(true)
      expect(console.pageErrors).toEqual([])
      await view.screenshot({ path: join(evidence, 'revised-step-1.png'), fullPage: true })
      bodyPassed = true
      stage = 'complete'
    } finally {
      if (scaffold !== undefined && sessionId !== undefined) {
        const agent = scaffold.ctx.agents.get(sessionId)
        if (agent !== undefined) await writeFile(join(evidence, 'session.jsonl'), rawSessionLog(agent.session), 'utf8')
      }
      if (!bodyPassed && page !== undefined && !page.isClosed()) await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true })
      evidenceWritten = true
    }
  }, 360_000)
})
