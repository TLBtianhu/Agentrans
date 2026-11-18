/** Opt-in browser acceptance of the default Agent's experiment selection with a real provider. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FiberState } from '@agentrans/cordis'
import type { ArtifactSnapshot } from '@agentrans/artifact/types'
import type {} from '@agentrans/artifact-followup/types'
import type { SessionId } from '@agentrans/session'
import { chromium, type Browser, type FrameLocator, type Locator, type Page, type Request } from 'playwright'
import { describe, expect, it, type TestContext } from 'vitest'
import { verifySentBfsDownload } from './artifact-bfs-download-support.ts'
import { exerciseCsvComparisonChanges } from './artifact-csv-changes-support.ts'
import { exerciseCsvReturnDraftSend } from './artifact-csv-return-draft-live-support.ts'
import {
  exerciseImportedCsvReturnDraftChain, exercisePortableCsvReturns, exerciseReusedImportedCsvReturns,
} from './artifact-csv-return-portable-support.ts'
import { exercisePortableCsvComparison } from './artifact-csv-portable-support.ts'
import {
  exerciseAttachedCsvInquiryReturns, exerciseContinuedCsvJourney, exerciseCsvInquiryResult, exerciseCsvInquiryResultChoice,
  exerciseCsvJourney,
} from './artifact-csv-support.ts'
import { exerciseCsvComparisonExplanation } from './artifact-csv-explanation-support.ts'
import { exercisePortableCsvExplanation, exerciseReusedImportedCsvExplanation } from './artifact-csv-explanation-portable-support.ts'
import { exerciseDoubleSlit } from './artifact-double-slit-support.ts'
import { exerciseHalfAdderJourney } from './artifact-half-adder-support.ts'
import { verifyParticleDownload } from './artifact-sent-particle-download-support.ts'
import { verifySentPlotDownload } from './artifact-sent-plot-download-support.ts'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, rawSessionLog, readPersistedEvents, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, expandOwningTurnProcess, expandTurnProcesses, scrollIntoView } from './support.ts'

const LIVE = process.env.AGENTRANS_ARTIFACT_LIVE === '1'
const HAS_KEY = (process.env.DEEPSEEK_API_KEY?.length ?? 0) > 0
const MODE = webSnapshotMode()
const MODEL = 'deepseek-flash'
const PROVIDER = 'deepseek-official'
const RETAINED_SIDEBAR = fileURLToPath(new URL('./fixtures/plugins/fixture-retained-sidebar', import.meta.url))

const EXPERIMENTS = {
  'function-plot': {
    first: 'I want to check what changing a in f(x) = a*x^2 does to the slope. '
      + 'Let me try values of a from 1 to 3 myself. Start with a = 1 and let me check the slope at x = 1.',
    followup: 'Using the readings I attached, tell me the slope I measured. Then add 1 to the function so I can repeat the same check. '
      + 'Keep the starting value and range of a and the point x = 1 unchanged.',
    canvas: 'Interactive function plot',
    historyCanvas: 'Function plot preview',
    review: 'Review function readings',
    context: 'current-function-plot',
  },
  'particle-system': {
    first: 'I predict that a particle moving right at 1 m/s on a frictionless surface with zero gravity travels the same distance '
      + 'in every tenth of a second. I want to verify that myself. Start at x = 0 and let me advance in tenths of a second '
      + 'and inspect position and velocity after each step.',
    followup: 'Using the readings I attached, tell me how far the particle moved. Then double its initial launch speed to 2 m/s '
      + 'so I can repeat the same experiment. Keep the other initial conditions.',
    canvas: 'Interactive particle simulation',
    historyCanvas: 'Interactive particle simulation',
    review: 'Review particle readings',
    context: 'current-particle',
  },
} as const

interface LiveBrowser {
  readonly browser: Browser
  readonly page: Page
  readonly world: WebScaffold
  readonly evidence: string
  readonly requests: readonly { origin: string; status: number; ok: boolean }[]
  readonly ask: (prompt: string, sessionId?: SessionId, useExistingDraft?: boolean) => Promise<SessionId>
  readonly providerSaw: (question: string, evidence: string) => boolean
  readonly providerUserText: (question: string) => readonly string[]
  readonly providerToolDescription: (name: string) => string | undefined
  readonly setDiagnosticPage: (page: Page) => void
  readonly stage: (name: string) => void
  readonly console: ReturnType<typeof watchConsole>
}

function userMessageText(payload: string | undefined, question: string): readonly string[] {
  if (payload === undefined) return []
  const body: unknown = JSON.parse(payload)
  if (typeof body !== 'object' || body === null || !('messages' in body) || !Array.isArray(body.messages)) return []
  const messages: readonly unknown[] = body.messages
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || !('role' in message) || message.role !== 'user'
      || !('content' in message) || !Array.isArray(message.content)) continue
    const content: readonly unknown[] = message.content
    const text = content.flatMap(block => typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string' ? [block.text] : [])
    if (text.includes(question)) return text
  }
  return []
}

function toolDescription(payload: string | undefined, name: string): string | undefined {
  if (payload === undefined) return undefined
  const body: unknown = JSON.parse(payload)
  if (typeof body !== 'object' || body === null || !('tools' in body) || !Array.isArray(body.tools)) return undefined
  const tools: readonly unknown[] = body.tools
  for (const tool of tools) {
    if (typeof tool === 'object' && tool !== null && 'name' in tool && tool.name === name
      && 'description' in tool && typeof tool.description === 'string') return tool.description
  }
  return undefined
}

async function runLiveCase(
  test: TestContext,
  scenario: string,
  exercise: (browser: LiveBrowser) => Promise<void>,
  turnTimeoutMs?: number,
): Promise<void> {
  const outputRoot = process.env.AGENTRANS_ARTIFACT_LIVE_OUTPUT_DIR
  if (outputRoot === undefined || outputRoot.length === 0) throw new Error('Set AGENTRANS_ARTIFACT_LIVE_OUTPUT_DIR for live acceptance evidence')
  await mkdir(outputRoot, { recursive: true })
  const evidence = await mkdtemp(join(outputRoot, `artifact-live-${scenario}-`))
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let sessionId: SessionId | undefined
  let bodyPassed = false
  let evidenceWritten = false
  let stage = 'boot'
  let latestModelPayload: string | undefined
  const requests: LiveBrowser['requests'][number][] = []
  const originalFetch = globalThis.fetch
  // Keep only the latest model body in memory to check the selected evidence. The saved trace has statuses only.
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const response = await originalFetch(input, init)
    if (method === 'POST' && url.pathname.endsWith('/messages')
      && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      requests.push({ origin: url.origin, status: response.status, ok: response.ok })
      latestModelPayload = typeof init?.body === 'string' ? init.body : undefined
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
      stage, scenario, mode: MODE, provider: PROVIDER, model: MODEL, requests,
    }, null, 2) + '\n', 'utf8')
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Live Artifact cleanup failed')
  })

  try {
    const world = await launchWebScaffold(scenario === 'filtered-csv' ? {
      restartable: true,
      extraInstallAnchors: [join(RETAINED_SIDEBAR, 'package.json')],
      extraOverlayPath: join(RETAINED_SIDEBAR, 'cordis.patch.yml'),
    } : {})
    scaffold = world
    expect(world.mode).toBe('record')
    const entries = [...world.ctx.loader.entries()]
    expect(entries.some(entry => entry.options.id === 'llm-deepseek'
      && entry.options.name === '@agentrans/llm-deepseek-api-key'
      && entry.fiber?.state === FiberState.ACTIVE)).toBe(true)
    expect(entries.some(entry => entry.options.name === '@agentrans/llm-replay')).toBe(false)
    expect([...world.ctx.registry.values()].some(runtime => runtime.name === 'llm-replay')).toBe(false)
    const executablePath = process.env.AGENTRANS_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    const browserContext = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    const view = await browserContext.newPage()
    page = view
    const console = watchConsole(view)
    await view.goto(world.authenticatedUrl, { waitUntil: 'load' })
    await view.waitForSelector('[class*="frame"]')
    await connectFreshWorkspace(view, world.workspaceCwd)
    const captureSession = world.ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/start') sessionId ??= session.id
    }, { global: true })
    test.onTestFinished(() => { captureSession() })
    const ask = async (prompt: string, target = sessionId, useExistingDraft = false): Promise<SessionId> => {
      const input = target === undefined ? view.locator('[data-composer-input]').first()
        : view.locator(`[data-conversation-session="${target}"] [data-composer-input][contenteditable="true"]`)
      if (useExistingDraft) await expect.poll(() => input.textContent()).toBe(prompt)
      else await input.fill(prompt)
      const settled = world.whenTurnSettled(turnTimeoutMs)
      await input.press('Enter')
      const id = await settled
      if (target !== undefined) expect(id).toBe(target)
      sessionId ??= id
      return id
    }
    const providerSaw = (question: string, attachment: string): boolean =>
      latestModelPayload?.includes(JSON.stringify(question)) === true && latestModelPayload.includes(JSON.stringify(attachment))
    await exercise({ browser, page: view, world, evidence, requests, ask, providerSaw,
      providerUserText: question => userMessageText(latestModelPayload, question),
      providerToolDescription: name => toolDescription(latestModelPayload, name),
      stage: (name) => { stage = name }, console, setDiagnosticPage: (activePage) => { page = activePage } })
    if (sessionId === undefined) throw new Error('No live model turn completed')
    const stored = await readPersistedEvents(world, sessionId)
    const headers = stored.flatMap(event => event.type === 'request/header' ? [event.data.header] : [])
    expect(headers.length).toBeGreaterThan(0)
    for (const header of headers) expect(header.config).toMatchObject({ provider: PROVIDER, model: MODEL })
    const initialSystem = stored.find(event => event.type === 'system/message')
    const guidance = initialSystem?.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (['no-shell-csv', 'continued-csv', 'filtered-csv', 'csv-inquiry-result', 'csv-inquiry-result-choice', 'csv-inquiry-comparison-send',
      'csv-inquiry-return-draft-send', 'portable-csv', 'portable-csv-returns', 'csv-comparison-changes', 'imported-csv-return-draft-chain',
      'csv-comparison-explanation', 'portable-csv-explanation', 'reuse-imported-csv-explanation', 'reuse-imported-csv-returns',
      'returned-bfs-checkpoint'].includes(scenario)) {
      expect(guidance).toContain('You are a conversation and teaching assistant. Answer directly when text is enough.')
      expect(guidance).toContain('use attachment_csv with its exact session attachment ID.')
      expect(guidance).toContain('create_chart')
      expect(guidance).toContain('update_chart')
    } else {
      expect(guidance).toContain('For explanations, answer directly in text when that is sufficient.')
      expect(guidance).toContain('A derivative at one point is a text answer.')
      expect(guidance).toContain('use the native scene tool directly.')
    }
    const scene = headers.flatMap(header => header.tools ?? []).find(tool => tool.name === 'scene')
    expect(scene?.description).toContain('sceneId with the current revision as baseRevision.')
    expect(stored.filter(event => event.type === 'assistant/attempt')).toEqual([])
    // These cases include completed recorded turns that never call the provider.
    if (!['csv-comparison-explanation', 'reuse-imported-csv-explanation', 'csv-inquiry-return-draft-send', 'reuse-imported-csv-returns',
      'imported-csv-return-draft-chain'].includes(scenario)) {
      expect(requests.length).toBeGreaterThanOrEqual(stored.filter(event => event.type === 'turn/start').length)
    }
    expect(requests.every(request => request.ok)).toBe(true)
    expect(console.pageErrors).toEqual([])
    bodyPassed = true
    stage = 'complete'
  } finally {
    const agents = scaffold?.ctx.get('agents')
    if (agents !== undefined && sessionId !== undefined) {
      const agent = agents.get(sessionId)
      if (agent !== undefined) await writeFile(join(evidence, 'session.jsonl'), rawSessionLog(agent.session), 'utf8')
      const branches = agents.roots().filter(candidate => candidate.session.header.parentSession === sessionId)
      await Promise.all(branches.map((branch, index) => writeFile(join(evidence, `branch-${index + 1}.jsonl`), rawSessionLog(branch.session), 'utf8')))
    }
    if (!bodyPassed && page !== undefined && !page.isClosed()) {
      await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true })
    }
    evidenceWritten = true
  }
}

async function visibleNumber(locator: Locator): Promise<number> {
  const text = await locator.textContent()
  if (text === null || text.trim() === '') throw new Error('A reviewed number is missing')
  const value = Number(text)
  expect(Number.isFinite(value)).toBe(true)
  return value
}

async function functionReading(review: Locator, expression: 'quadratic' | 'linear' = 'quadratic') {
  const reading = (name: string) => visibleNumber(review.locator(`[data-function-question-value="${name}"]`))
  const a = await visibleNumber(review.locator('[data-function-question-parameter="a"]'))
  const x = await reading('x')
  const value = await reading('value')
  const derivative = await reading('derivative')
  const integral = await reading('integral')
  expect(a).toBeGreaterThan(1)
  expect(x).toBe(1)
  expect(value).toBeCloseTo(a, 10)
  expect(derivative).toBeCloseTo(expression === 'quadratic' ? 2 * a : a, 6)
  expect(integral).toBeCloseTo(expression === 'quadratic' ? a / 3 : a / 2, 4)
  return { x, parameters: { a }, values: { value, derivative, integral } }
}

async function particleReading(review: Locator) {
  const particle = review.locator('[data-particle-question-particle]')
  const id = await particle.getAttribute('data-particle-question-particle')
  if (id === null) throw new Error('The reviewed particle is missing its identity')
  const coordinate = (name: string) => visibleNumber(particle.locator(`[data-particle-question-coordinate="${name}"]`))
  const stepCount = Number(await review.getAttribute('data-particle-question-step'))
  const time = await visibleNumber(review.locator('[data-particle-question-time]'))
  const x = await coordinate('x')
  const y = await coordinate('y')
  const vx = await coordinate('vx')
  const vy = await coordinate('vy')
  return { checkpoint: { runtimeVersion: 1 as const, stepCount }, values: { time, particles: [{ id, x, y, vx, vy }] } }
}

async function exerciseExperiment(
  kind: keyof typeof EXPERIMENTS, { page, world, evidence, requests, ask, stage, console }: LiveBrowser,
): Promise<void> {
  const scenario = EXPERIMENTS[kind]
  const card = (title: string) => page.getByRole('complementary', { name: `Artifact: ${title}`, exact: true })
  const turn = (artifact: Locator) => artifact.evaluate(element => element.closest('[data-chat-turn]')?.getAttribute('data-chat-turn'))
  const choice = page.locator(`[data-artifact-prompt-context="${scenario.context}"]:visible`)
  stage('first-experiment')
  const sessionId = await ask(scenario.first)
  let stored = await readPersistedEvents(world, sessionId)
  expect(stored.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])).toEqual(['completed'])
  const firstUpserts = stored.flatMap(event => event.type === 'artifact/upsert' ? [event.data] : [])
  expect(firstUpserts).toHaveLength(1)
  const original = firstUpserts[0]!
  expect(original).toMatchObject({ revision: 1, format: 'scene', spec: { kind } })
  const initial = card(original.title)
  await initial.getByRole('img', { name: scenario.canvas, exact: true }).waitFor({ state: 'visible' })
  expect(await initial.getAttribute('data-placement')).toBe('inline')
  expect(await turn(initial)).toBe('1')
  const requestsBeforeInteraction = requests.length

  stage('review')
  const step = initial.getByRole('button', { name: 'Step', exact: true })
  for (let index = 0; index < (kind === 'particle-system' ? 3 : 1); index++) await step.click()
  if (kind === 'particle-system') {
    const live = initial.locator('[data-particle-live-readings]')
    await expect.poll(() => visibleNumber(live.locator('[data-particle-live-coordinate="x"]'))).toBeCloseTo(0.3, 10)
    await expect.poll(() => visibleNumber(live.locator('[data-particle-live-coordinate="vx"]'))).toBe(1)
  }
  await initial.getByRole('button', { name: 'Use for next question', exact: true }).click()
  const review = initial.getByRole('region', { name: scenario.review, exact: true })
  await review.waitFor({ state: 'visible' })
  const read = () => kind === 'function-plot' ? functionReading(review) : particleReading(review)
  const confirmed = await read()
  if ('checkpoint' in confirmed) {
    if (original.format !== 'scene' || original.spec.kind !== 'particle-system' || original.spec.particles.length !== 1) {
      throw new Error('Expected one native particle to review')
    }
    expect(confirmed.checkpoint.stepCount).toBe(3)
    expect(confirmed.values.time).toBeCloseTo(0.3, 10)
    const particle = confirmed.values.particles[0]!
    expect(particle.x).toBeCloseTo(0.3, 10)
    expect([particle.y, particle.vx, particle.vy]).toEqual([original.spec.particles[0]?.y, 1, 0])
  }
  expect(await choice.count()).toBe(0)
  await step.click()
  expect(await read()).toEqual(confirmed)
  await page.screenshot({ path: join(evidence, 'review.png'), fullPage: true })
  await review.getByRole('button', { name: 'Attach readings', exact: true }).click()
  await choice.waitFor({ state: 'visible' })
  expect((await readPersistedEvents(world, sessionId)).filter(event => event.type === 'turn/start')).toHaveLength(1)
  expect(requests).toHaveLength(requestsBeforeInteraction)

  stage('followup')
  expect(await ask(scenario.followup)).toBe(sessionId)
  stored = await readPersistedEvents(world, sessionId)
  expect(stored.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])).toEqual(['completed', 'completed'])
  const questions = stored.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user' ? [event.data] : [])
  expect(questions).toHaveLength(2)
  const attached = questions[1]?.content[1]
  if (attached?.type !== 'text') throw new Error('The ordinary follow-up lost its confirmed readings')
  const context: unknown = JSON.parse(attached.text.slice(attached.text.indexOf('\n') + 1))
  expect(context).toMatchObject({ kind: 'artifact-question-context', sessionId,
    facts: { kind: scenario.context, artifact: original, ...confirmed } })
  expect(stored.filter(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action')).toEqual([])
  const toolNames = stored.flatMap(event => event.type === 'tool/call' ? [event.data.name] : [])
  expect(toolNames.filter(name => !['scene', 'artifact_runtime', 'skill'].includes(name))).toEqual([])
  const upserts = stored.flatMap(event => event.type === 'artifact/upsert' ? [event.data] : [])
  expect(upserts.map(artifact => [artifact.artifactId, artifact.revision])).toEqual([[original.artifactId, 1], [original.artifactId, 2]])
  const revised = upserts[1]!
  expect(revised).toMatchObject({ format: 'scene', spec: { kind } })
  if ('checkpoint' in confirmed) expect(revised).toMatchObject({ spec: {
    particles: [{ x: 0, y: confirmed.values.particles[0]?.y, vx: 2, vy: 0 }], gravity: { x: 0, y: 0 }, timeStep: 0.1,
  } })
  const current = card(revised.title)
  await expect.poll(() => current.getAttribute('data-artifact-revision')).toBe('2')
  expect(await turn(current)).toBe('2')
  await current.getByRole('img', { name: scenario.canvas, exact: true }).waitFor({ state: 'visible' })
  if (kind === 'function-plot') {
    await current.getByText('f(x)', { exact: true }).locator('..').getByText('2.000', { exact: true }).waitFor({ state: 'visible' })
    await current.getByText('f′(x)', { exact: true }).locator('..').getByText('2.000', { exact: true }).waitFor({ state: 'visible' })
    await current.getByText('∫', { exact: true }).locator('..').getByText('1.333', { exact: true }).waitFor({ state: 'visible' })
  } else {
    await current.getByRole('button', { name: 'Step', exact: true }).click()
    await current.locator('[data-particle-step="1"]').waitFor({ state: 'visible' })
    const live = current.locator('[data-particle-live-readings]')
    await expect.poll(() => visibleNumber(live.locator('[data-particle-live-coordinate="x"]'))).toBeCloseTo(0.2, 10)
    await expect.poll(() => visibleNumber(live.locator('[data-particle-live-coordinate="vx"]'))).toBe(2)
  }
  await page.screenshot({ path: join(evidence, 'revised.png'), fullPage: true })

  stage('reload')
  const warningStart = console.warnings.length
  await page.reload()
  await current.getByRole('img', { name: scenario.canvas, exact: true }).waitFor({ state: 'visible' })
  acknowledgeReloadConnectionLoss(console, warningStart)
  await page.getByText('Revision history', { exact: true }).click()
  await page.getByRole('button', { name: 'View revision 1', exact: true }).click()
  const previous = page.getByRole('region', { name: `Artifact revision 1: ${original.title}`, exact: true })
  await previous.getByRole('img', { name: scenario.historyCanvas, exact: true }).waitFor({ state: 'visible' })
  expect(await previous.getByRole('button', { name: 'Use for next question', exact: true }).count()).toBe(0)
  if (kind === 'function-plot') {
    expect(await previous.locator('[data-function-source-parameter="a"]').textContent()).toBe('1')
  }
  const displayed = page.locator('details[data-artifact-question-context]:visible').last()
  await displayed.locator('summary').click()
  expect(await displayed.locator('[data-artifact-question-context-raw]').textContent()).toBe(attached.text)
  expect(await current.getAttribute('data-artifact-revision')).toBe('2')
}

async function expectReturnedPlot(scope: Locator, original: ArtifactSnapshot, confirmed: Awaited<ReturnType<typeof functionReading>>) {
  const plot = scope.locator('[data-artifact-question-replay-revision="1"]')
  await plot.getByRole('img', { name: 'Function plot preview', exact: true }).waitFor({ state: 'visible' })
  expect(await plot.getAttribute('data-artifact-question-replay-id')).toBe(original.artifactId)
  expect(await visibleNumber(plot.locator('[data-function-source-parameter="a"]'))).toBe(confirmed.parameters.a)
  for (const [field, value] of Object.entries({ x: confirmed.x, ...confirmed.values })) {
    expect(await visibleNumber(plot.locator(`[data-function-source-value="${field}"]`))).toBe(value)
  }
  expect(await plot.getByRole('slider').count()).toBe(0)
}

async function selectAnswerPhrase(page: Page, source: Locator, phrase: string): Promise<void> {
  await source.evaluate((element) => { element.scrollIntoView({ block: 'center' }) })
  const points = await source.evaluate((element, text) => {
    const doc = element.ownerDocument
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!(node instanceof Text)) continue
      const index = node.data.indexOf(text)
      if (index < 0) continue
      const range = doc.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + text.length)
      const rects = [...range.getClientRects()]
      const first = rects[0]
      const last = rects.at(-1)
      if (first === undefined || last === undefined) continue
      return {
        start: { x: first.left + 0.5, y: first.top + first.height / 2 }, end: { x: last.right - 0.5, y: last.top + last.height / 2 },
      }
    }
    throw new Error('The exact answer phrase is missing from visible Markdown text')
  }, phrase)
  await page.mouse.move(points.start.x, points.start.y)
  await page.mouse.down()
  await page.mouse.move(points.end.x, points.end.y, { steps: 12 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe(phrase)
}

async function storedInquiryDraft(page: Page, sessionId: SessionId): Promise<unknown> {
  return page.evaluate((id) => {
    const raw = localStorage.getItem(`dsh.conversation.${id}`)
    const saved: unknown = raw === null ? null : JSON.parse(raw)
    return typeof saved === 'object' && saved !== null && 'draft' in saved ? saved.draft : null
  }, sessionId)
}

function isEmptyInquiryDraft(value: unknown): boolean {
  return value === '' || value === null || (typeof value === 'object' && value !== null && 'text' in value && value.text === ''
    && (!('quotes' in value) || Array.isArray(value.quotes) && value.quotes.length === 0))
}

async function editorQuestion(input: Locator): Promise<string> {
  return input.evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement
    for (const quote of copy.querySelectorAll('[data-composer-quote]')) quote.remove()
    return copy.textContent?.trim() ?? ''
  })
}

async function exerciseSelectedAnswerInquiry({ browser, page, world, evidence, requests, ask, providerSaw, providerUserText, stage,
  console }: LiveBrowser, requestedNativePlot = false): Promise<void> {
  const first = '我刚学导数。对于 f(x) = a*x^2，为什么在 x = 1 处 a 越大切线越陡？'
    + '我想自己从 a = 1 开始调大一点，看看切线斜率怎么变。'
    + (requestedNativePlot ? '请用内置函数图，通过参数 a 的滑块来试。' : '')
  const question = '根据我附上的锁定读数，说明在图上选定的点切线斜率是多少（保留两位小数），并用这个函数说明如何求出。请用中文简短回答。'
  const conversation = (id: SessionId) => page.locator(`[data-conversation-session="${id}"]`)
  const inputFor = (scope: Locator) => scope.locator('[data-composer-input][contenteditable="true"]')
  const quoteFor = (scope: Locator) => scope.locator('[data-composer-quote]')
  const expectNoQuote = async (scope: Locator, id: SessionId): Promise<void> => {
    await inputFor(scope).waitFor({ state: 'visible' })
    await expect.poll(async () => isEmptyInquiryDraft(await storedInquiryDraft(page, id))).toBe(true)
    await expect.poll(() => quoteFor(scope).count()).toBe(0)
    await expect.poll(() => editorQuestion(inputFor(scope))).toBe('')
  }
  const reload = async (ready: () => Promise<void>): Promise<void> => {
    const warningStart = console.warnings.length
    await page.reload()
    await ready()
    acknowledgeReloadConnectionLoss(console, warningStart)
  }
  const userAgent = await page.evaluate(() => navigator.userAgent)
  expect(userAgent).toMatch(/\bEdg\//u)
  await page.setViewportSize({ width: 1440, height: 1280 })

  stage('inquiry-generate-chinese-function-plot-answer')
  const parentId = await ask(first)
  const parent = conversation(parentId)
  const parentHistory = await readPersistedEvents(world, parentId)
  const original = parentHistory.find(event => event.type === 'artifact/upsert')
  const response = parentHistory.findLast(event => event.type === 'assistant/message'
    && event.data.message.content.some(block => block.type === 'text'))
  const end = parentHistory.findLast(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')
  if (original?.type !== 'artifact/upsert' || response?.type !== 'assistant/message' || end?.type !== 'turn/end') {
    throw new Error('The learning question did not get a completed answer with a native function plot')
  }
  const source = original.data
  if (source.format !== 'scene' || source.spec.kind !== 'function-plot') throw new Error('The learning question requires a native function plot')
  expect(source).toMatchObject({ revision: 1, format: 'scene', spec: { kind: 'function-plot', parameters: { a: { value: 1 } },
    trace: { x: 1 } } })
  const plot = (scope: Locator) => scope.getByRole('complementary', { name: `Artifact: ${source.title}`, exact: true })
  await plot(parent).getByRole('img', { name: 'Interactive function plot', exact: true }).waitFor({ state: 'visible' })
  const answer = parent.locator(`[data-chat-message-seq="${response.seq}"][data-chat-message-id="${response.data.message.id}"]`)
  const textSource = answer.locator('[data-text-interaction-source] span[data-markdown-source-start][data-markdown-source-end]:visible')
    .filter({ hasText: /切线斜率|斜率|导数/u }).first()
  const rawAnswer = response.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  const spanStart = await textSource.getAttribute('data-markdown-source-start')
  const displayed = await textSource.textContent()
  const phrase = displayed?.match(/切线斜率|斜率|导数/u)?.[0]
  if (spanStart === null || displayed === null || phrase === undefined) throw new Error('The visible Chinese wording is missing its Markdown range')
  const quotedQuestion = `> ${phrase}\n\n${question}`
  const expectQuote = async (scope: Locator): Promise<void> => {
    await expect.poll(() => quoteFor(scope).count()).toBe(1)
    await expect.poll(() => quoteFor(scope).locator('[data-quote-preview-text]').textContent()).toBe(phrase)
  }
  const offset = Number(spanStart) + displayed.indexOf(phrase)
  expect(rawAnswer.slice(offset, offset + phrase.length)).toBe(phrase)
  const selected = { messageSeq: response.seq, messageId: response.data.message.id,
    start: offset, end: offset + phrase.length, excerpt: phrase }
  const beforeFork = requests.length
  const dispatched: Request[] = []
  let forkRequests = 0
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path === '/api/session/prompt') dispatched.push(request)
    if (path === '/api/session/fork') forkRequests++
  })
  const children = () => world.ctx.agents.roots().filter(agent => agent.session.header.parentSession === parentId)
  const forkSelected = async (capture: boolean) => {
    const existing = new Set(children().map(agent => agent.id))
    await selectAnswerPhrase(page, textSource, phrase)
    const create = page.locator('[data-chat-inquiry-create]')
      .and(page.getByRole('button', { name: 'Start inquiry branch from selection', exact: true }))
    await create.waitFor({ state: 'visible' })
    if (capture) await page.screenshot({ path: join(evidence, 'inquiry-selected-phrase.png') })
    const [forked] = await Promise.all([page.waitForResponse(result => new URL(result.url()).pathname === '/api/session/fork'), create.click()])
    expect(forked.ok()).toBe(true)
    expect(forked.request().postDataJSON()).toMatchObject({
      payload: { args: { request: { sessionId: parentId, atSeq: end.seq, inquiry: selected } } },
    })
    await expect.poll(() => children().some(agent => !existing.has(agent.id))).toBe(true)
    const branch = children().find(agent => !existing.has(agent.id))
    if (branch === undefined) throw new Error('The selected answer inquiry did not open a child Session')
    expect(branch.session.header).toMatchObject({ parentSession: parentId, inquiry: selected })
    return branch
  }

  stage('inquiry-discover-selection-guide')
  const guide = answer.getByRole('button', { name: 'Explore a sentence', exact: true })
  const instruction = answer.getByText('Select a sentence in this answer, then choose “Start inquiry branch from selection”.', { exact: true })
  await guide.waitFor({ state: 'visible' })
  expect(await guide.getAttribute('aria-expanded')).toBe('false')
  await instruction.waitFor({ state: 'hidden' })
  await guide.press('Enter')
  await instruction.waitFor({ state: 'visible' })
  expect(await guide.getAttribute('aria-expanded')).toBe('true')
  await answer.screenshot({ path: join(evidence, 'inquiry-selection-guide-open.png') })
  expect(dispatched).toHaveLength(0)
  expect(forkRequests).toBe(0)
  expect(children()).toHaveLength(0)
  expect(requests).toHaveLength(beforeFork)

  stage('inquiry-native-edge-selection-and-fork')
  const child = await forkSelected(true)
  const childConversation = conversation(child.id)
  await childConversation.waitFor({ state: 'visible' })
  const childInput = inputFor(childConversation)
  await expectQuote(childConversation)
  await expect.poll(() => editorQuestion(childInput)).toBe('')
  await expect.poll(() => storedInquiryDraft(page, child.id)).toMatchObject({ quotes: [{ offset: 0, text: phrase }] })
  expect(dispatched).toHaveLength(0)
  expect(requests).toHaveLength(beforeFork)
  await childInput.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
  await page.keyboard.insertText(question)
  await expect.poll(() => editorQuestion(childInput)).toBe(question)
  await expectQuote(childConversation)

  stage('inquiry-operate-and-lock-inherited-graph')
  await expandTurnProcesses(page)
  const inherited = plot(childConversation)
  await inherited.getByRole('img', { name: 'Interactive function plot', exact: true }).waitFor({ state: 'visible' })
  const step = inherited.getByRole('button', { name: 'Step', exact: true })
  await step.click()
  await inherited.getByRole('button', { name: 'Use for next question', exact: true }).click()
  const review = inherited.getByRole('region', { name: 'Review function readings', exact: true })
  const reading = await functionReading(review)
  const expectedSlope = (2 * reading.parameters.a).toFixed(2)
  await review.screenshot({ path: join(evidence, 'inquiry-locked-reading.png') })
  await review.getByRole('button', { name: 'Attach readings', exact: true }).click()
  const chip = childConversation.locator('[data-artifact-prompt-context="current-function-plot"]')
  await chip.waitFor({ state: 'visible' })
  const storedPlot = () => page.evaluate(id => sessionStorage.getItem(`dsh.artifact.function-plot-draft.v1.${id}`), child.id)
  const savedPlot = await storedPlot()
  if (savedPlot === null) throw new Error('The locked function plot inputs were not persisted')
  expect(JSON.parse(savedPlot)).toMatchObject({ request: { kind: 'current-function-plot', artifactId: source.artifactId,
    revision: source.revision, x: reading.x, parameters: reading.parameters } })
  expect(requests).toHaveLength(beforeFork)
  const unsent = await storedInquiryDraft(page, child.id)
  const savedChild = await readPersistedEvents(world, child.id)

  stage('inquiry-reload-quote-question-and-locked-reading')
  await reload(async () => {
    await expectQuote(childConversation)
    await expect.poll(() => editorQuestion(childInput)).toBe(question)
    expect(await storedInquiryDraft(page, child.id)).toEqual(unsent)
    await chip.waitFor({ state: 'visible' })
    await expect.poll(() => chip.textContent()).toContain('Revision 1 · x = 1')
    expect(await storedPlot()).toBe(savedPlot)
  })
  expect(await readPersistedEvents(world, child.id)).toEqual(savedChild)
  expect(dispatched).toHaveLength(0)
  expect(requests).toHaveLength(beforeFork)
  await childConversation.locator('[data-composer-seat]').screenshot({ path: join(evidence, 'inquiry-draft-after-refresh.png') })

  stage('inquiry-send-confirmed-draft-once')
  const send = childConversation.getByRole('button', { name: 'Send message', exact: true })
  await expect.poll(() => send.isEnabled()).toBe(true)
  const settled = world.whenTurnSettled()
  await send.click()
  expect(await settled).toBe(child.id)
  expect(dispatched).toHaveLength(1)
  expect(dispatched[0]?.postDataJSON()).toMatchObject({ payload: { args: { request: {
    sessionId: child.id, content: [{ type: 'text', text: quotedQuestion }],
  } } } })
  expect(requests).toHaveLength(beforeFork + 1)
  await expectNoQuote(childConversation, child.id)
  await chip.waitFor({ state: 'hidden' })
  await expect.poll(storedPlot).toBeNull()
  const childEvents = await readPersistedEvents(world, child.id)
  const recordedQuestion = childEvents.findLast(event => event.type === 'user/message' && event.data.content.some(block =>
    block.type === 'text' && block.text === quotedQuestion))
  const conclusion = childEvents.findLast(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text'))
  if (recordedQuestion?.type !== 'user/message' || conclusion?.type !== 'assistant/message') throw new Error('The inquiry did not record an answer')
  const [sentQuestion, attached] = recordedQuestion.data.content
  expect(sentQuestion).toEqual({ type: 'text', text: quotedQuestion })
  if (attached?.type !== 'text') throw new Error('The selected question lost the locked function plot')
  expect(JSON.parse(attached.text.slice(attached.text.indexOf('\n') + 1))).toMatchObject({ kind: 'artifact-question-context', sessionId: child.id,
    facts: { kind: 'current-function-plot', artifact: source, ...reading } })
  expect(providerSaw(quotedQuestion, attached.text)).toBe(true)
  const providerText = providerUserText(quotedQuestion)
  expect(providerText.filter(text => text === quotedQuestion)).toHaveLength(1)
  expect(providerText.slice(providerText.indexOf(quotedQuestion), providerText.indexOf(quotedQuestion) + 2))
    .toEqual([quotedQuestion, attached.text])
  const conclusionText = conclusion.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  expect(conclusionText).toContain(expectedSlope)
  const callsBeforeReturn = requests.length
  const parentRow = page.locator(`[data-row-key="session:${parentId}"]`)
  const branchPath = answer.locator(`[data-inquiry-branch="${child.id}"]`)
  const resultButtons = answer.getByRole('button', { name: 'View returned result', exact: true })
  const resultFor = (id: SessionId) => resultButtons.and(answer.locator(`[data-inquiry-result="${id}"]`))
  await parentRow.click()
  await branchPath.waitFor({ state: 'visible' })
  expect(await resultButtons.count()).toBe(0)
  await branchPath.click()

  stage('inquiry-return-selected-conclusion-and-reading')
  const returnAction = childConversation.locator(`[data-branch-result-seq="${conclusion.seq}"]:visible`)
  await returnAction.getByRole('button', { name: 'Return with evidence', exact: true }).click()
  expect(await returnAction.getByRole('radio', { name: 'Question readings', exact: true }).isChecked()).toBe(true)
  await expectReturnedPlot(returnAction.locator('[data-branch-question-preview]'), source, reading)
  await returnAction.getByRole('button', { name: 'Confirm return with evidence', exact: true }).click()
  const returnedItem = parent.locator('[data-artifact-branch-evidence-item="question"]')
  await returnedItem.waitFor({ state: 'visible' })
  const returned = (await readPersistedEvents(world, parentId)).findLast(event =>
    event.type === 'user/message' && event.data.source.kind === 'branch-result')
  if (returned?.type !== 'user/message') throw new Error('The parent did not record the returned conclusion and reading')
  expect(returned.data.source).toMatchObject({ branchSessionId: child.id, resultSeq: conclusion.seq })
  expect(returned.data.content.some(block => block.type === 'text' && block.text.includes(expectedSlope))).toBe(true)
  const exactResult = parent.locator(`[data-artifact-branch-evidence][data-chat-message-id="${returned.data.id}"]`
    + `[data-chat-message-seq="${returned.seq}"]`)
  const exactReading = exactResult.locator('[data-artifact-branch-evidence-item="question"]')
  const viewReturned = async (shot: string): Promise<void> => {
    await resultFor(child.id).click()
    const replay = exactReading.getByRole('button', { name: 'Replay experiment', exact: true })
      .and(exactReading.locator('[data-chat-message-control="artifact-branch-result"]'))
    await expect.poll(() => replay.evaluate(element => document.activeElement === element)).toBe(true)
    await expect.poll(() => replay.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return element.contains(element.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
    })).toBe(true)
    await expectReturnedPlot(exactReading, source, reading)
    expect(await exactResult.textContent()).toContain(expectedSlope)
    await exactResult.screenshot({ path: join(evidence, shot) })
    expect(dispatched).toHaveLength(1)
    expect(requests).toHaveLength(callsBeforeReturn)
  }

  stage('inquiry-view-exact-returned-result-from-answer')
  await resultFor(child.id).waitFor({ state: 'visible' })
  await answer.screenshot({ path: join(evidence, 'inquiry-returned-result-entry.png') })
  await viewReturned('inquiry-returned-result-before-refresh.png')

  stage('inquiry-refresh-and-follow-original-phrase-path')
  await reload(async () => { await resultFor(child.id).waitFor({ state: 'visible' }) })
  await viewReturned('inquiry-returned-reading-after-refresh.png')

  stage('inquiry-download-directly-from-returned-plot')
  const returnAddress = { eventSeq: returned.seq, messageId: returned.data.id }
  const returnedPlotRequest = { sessionId: parentId, ...returnAddress }
  const functionId = source.spec.functions[0]?.id
  if (functionId === undefined) throw new Error('The original native plot has no function to export')
  const returnedBaseline = { functionId, ...reading }
  const beforeDirectExport = await Promise.all([readPersistedEvents(world, parentId), readPersistedEvents(world, child.id)])
  const childrenBeforeDirectExport = children().map(agent => agent.id)
  const forksBeforeDirectExport = forkRequests
  const restrictedPlotRequests: string[] = []
  const restrictedPaths = ['/api/artifactBranchResults/continuePlot', '/api/artifactExports/create', '/api/artifactExports/read']
  const watchDirectExport = (request: Request): void => {
    const path = new URL(request.url()).pathname
    if (restrictedPaths.includes(path)) restrictedPlotRequests.push(path)
  }
  page.on('request', watchDirectExport)
  const directDownload = exactReading.getByRole('button', { name: 'Download experiment HTML', exact: true })
    .and(exactReading.locator('[data-artifact-branch-download]'))
  const [downloadFromReturn, returnedExport] = await Promise.all([
    page.waitForEvent('download'),
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/artifactBranchResults/exportReturnedPlot'),
    directDownload.click(),
  ])
  expect(returnedExport.ok()).toBe(true)
  expect(returnedExport.request().postDataJSON()).toHaveProperty('payload.args.request', returnedPlotRequest)
  const returnedFilename = 'inquiry-returned-locked-plot.html'
  const returnedExportFile = join(evidence, returnedFilename)
  await downloadFromReturn.saveAs(returnedExportFile)
  const returnedOffline = await browser.newContext({ offline: true })
  try {
    const exported = await returnedOffline.newPage()
    const onlineRequests: string[] = []
    exported.on('request', (request) => { if (/^https?:/u.test(request.url())) onlineRequests.push(request.url()) })
    await exported.goto(pathToFileURL(returnedExportFile).href)
    await exported.locator('canvas#plot').waitFor({ state: 'visible' })
    const origin: unknown = JSON.parse(await exported.locator('#artifact-export-origin-data').textContent() ?? 'null')
    expect(origin).toMatchObject({ exporterVersion: 2, sessionId: parentId, artifactId: source.artifactId, revision: source.revision })
    expect(origin).toHaveProperty('functionPlotBaseline', returnedBaseline)
    expect(origin).toHaveProperty('returnedEvidence', returnAddress)
    const readout = (label: string) => exported.locator('#readout > div').filter({ has: exported.getByText(label, { exact: true }) }).locator('strong')
    const expectReturnedReadout = async (): Promise<void> => {
      for (const [label, value] of Object.entries({ x: reading.x.toFixed(2), a: String(reading.parameters.a),
        'f′(x)': reading.values.derivative.toFixed(3) })) {
        await readout(label).waitFor({ state: 'visible' })
        expect(await readout(label).textContent()).toBe(value)
      }
    }
    await expectReturnedReadout()
    const seek = source.spec.viewport.x[1].toFixed(2) === reading.x.toFixed(2) ? 'Home' : 'End'
    await exported.getByRole('slider', { name: 'Timeline', exact: true }).press(seek)
    expect(await readout('x').textContent()).not.toBe(reading.x.toFixed(2))
    await exported.getByRole('button', { name: 'Reset', exact: true }).click()
    await expectReturnedReadout()
    expect(onlineRequests).toEqual([])
    await exported.screenshot({ path: join(evidence, 'inquiry-returned-locked-plot-offline.png') })
  } finally {
    await returnedOffline.close()
    page.off('request', watchDirectExport)
  }
  expect(restrictedPlotRequests).toEqual([])
  expect(children().map(agent => agent.id)).toEqual(childrenBeforeDirectExport)
  expect(forkRequests).toBe(forksBeforeDirectExport)
  expect(await Promise.all([readPersistedEvents(world, parentId), readPersistedEvents(world, child.id)])).toEqual(beforeDirectExport)
  expect(await parentRow.getAttribute('aria-selected')).toBe('true')
  expect(dispatched).toHaveLength(1)
  expect(requests).toHaveLength(callsBeforeReturn)

  stage('inquiry-follow-phrase-path-after-direct-export')
  await parent.locator('[data-inquiry-source]').click()
  const anchor = answer.locator('[data-inquiry-anchor]')
  await expect.poll(() => anchor.textContent()).toContain(phrase)
  await expect.poll(() => anchor.evaluate(element => document.activeElement === element)).toBe(true)
  await expect.poll(() => page.evaluate(() => Array.from(CSS.highlights.get('agentrans-inquiry') ?? [],
    range => range instanceof Range ? range.toString() : null))).toEqual([phrase])
  await expect.poll(() => anchor.evaluate((element) => {
    const [range] = CSS.highlights.get('agentrans-inquiry') ?? []
    if (!(range instanceof Range)) return false
    const rects = [...range.getClientRects()]
    const doc = element.ownerDocument
    const fill = doc.defaultView?.getComputedStyle(element, '::highlight(agentrans-inquiry)').backgroundColor
    return fill !== undefined && fill !== '' && fill !== 'transparent' && fill !== 'rgba(0, 0, 0, 0)'
      && rects.length > 0 && rects.every(rect => element.contains(doc.elementFromPoint(
      rect.left + rect.width / 2, rect.top + rect.height / 2,
    )))
  })).toBe(true)
  await answer.screenshot({ path: join(evidence, 'inquiry-exact-quote-after-refresh.png') })
  await branchPath.click()
  await childConversation.waitFor({ state: 'visible' })
  const sentAddress = { eventSeq: recordedQuestion.seq, messageId: recordedQuestion.data.id }
  const sentRow = childConversation.locator(`[data-chat-message-id="${sentAddress.messageId}"][data-chat-message-seq="${sentAddress.eventSeq}"]`)
  await sentRow.getByText(question, { exact: true }).waitFor({ state: 'visible' })
  await expect.poll(() => sentRow.locator('[data-quote-preview-text]').textContent()).toBe(phrase)
  await expectNoQuote(childConversation, child.id)
  expect(children().map(agent => agent.id)).toEqual([child.id])
  expect(requests).toHaveLength(callsBeforeReturn)
  expect(dispatched).toHaveLength(1)

  if (requestedNativePlot) {
    stage('inquiry-download-directly-from-sent-plot-question-after-refresh')
    const readDownloadLogs = () => Promise.all([readPersistedEvents(world, parentId), readPersistedEvents(world, child.id)])
    const beforeSentExport = await readDownloadLogs()
    const rootsBeforeSentExport = world.ctx.agents.roots().map(agent => agent.id)
    const forksBeforeSentExport = forkRequests
    await reload(async () => { await sentRow.getByText(question, { exact: true }).waitFor({ state: 'visible' }) })
    const sentPlotExport = await verifySentPlotDownload({
      browser, page, card: sentRow, directory: evidence, sessionId: child.id, question: sentAddress,
      source: { ...source, spec: source.spec }, baseline: returnedBaseline,
      returned: { sessionId: parentId, ...returnAddress, file: returnedExportFile }, capture: true,
    })
    expect(await readDownloadLogs()).toEqual(beforeSentExport)
    expect(world.ctx.agents.roots().map(agent => agent.id)).toEqual(rootsBeforeSentExport)
    expect(forkRequests).toBe(forksBeforeSentExport)
    expect(requests).toHaveLength(callsBeforeReturn)
    expect(dispatched).toHaveLength(1)
    await writeFile(join(evidence, 'sent-plot-question-export-acceptance.json'), JSON.stringify({ userAgent, ...sentPlotExport,
      returned: { ...returnedPlotRequest, filename: returnedFilename }, providerRequests: 0, branchesUnchanged: true,
      sessionLogsUnchanged: true }, null, 2), 'utf8')
  }

  stage('inquiry-export-reopened-function-plot-revision')
  await expandTurnProcesses(page)
  const reopenedPlot = plot(childConversation)
  expect(await reopenedPlot.getAttribute('data-artifact-revision')).toBe(String(source.revision))
  const [download, exportResponse] = await Promise.all([
    page.waitForEvent('download'),
    page.waitForResponse(result => new URL(result.url()).pathname === '/api/artifactExports/create'),
    reopenedPlot.getByRole('button', { name: 'Export animation', exact: true }).click(),
  ])
  expect(exportResponse.ok()).toBe(true)
  const exportSource = { kind: 'current', artifactId: source.artifactId, revision: source.revision }
  expect(exportResponse.request().postDataJSON()).toMatchObject({
    payload: { args: { agentId: child.id, input: { format: 'html', source: exportSource } } },
  })
  const exportReady = (await readPersistedEvents(world, child.id)).findLast(event =>
    event.type === 'artifact/export' && event.data.status === 'ready')
  if (exportReady?.type !== 'artifact/export') throw new Error('The reopened branch did not save its export')
  expect(exportReady.data).toMatchObject({ request: { source: exportSource }, frozen: { artifact: source } })
  const exportedFile = join(evidence, 'inquiry-saved-plot-revision.html')
  await download.saveAs(exportedFile)
  const offline = await browser.newContext({ offline: true })
  try {
    const exported = await offline.newPage()
    const onlineRequests: string[] = []
    exported.on('request', (request) => { if (/^https?:/u.test(request.url())) onlineRequests.push(request.url()) })
    await exported.goto(pathToFileURL(exportedFile).href)
    await exported.locator('canvas#plot').waitFor({ state: 'visible' })
    expect(await exported.locator('h1').textContent()).toBe(source.title)
    expect(await exported.evaluate('spec')).toEqual(source.spec)
    const origin: unknown = JSON.parse(await exported.locator('#artifact-export-origin-data').textContent() ?? 'null')
    expect(origin).toMatchObject({ exportId: exportReady.data.request.exportId, sessionId: child.id,
      artifactId: source.artifactId, revision: source.revision })
    expect(onlineRequests).toEqual([])
  } finally { await offline.close() }
  expect(requests).toHaveLength(callsBeforeReturn)
  expect(dispatched).toHaveLength(1)

  stage('inquiry-export-continued-locked-plot')
  const beforeContinuation = await readPersistedEvents(world, parentId)
  const sourceBranchUpserts = (await readPersistedEvents(world, child.id)).filter(event => event.type === 'artifact/upsert')
  const existingChildren = new Set(children().map(agent => agent.id))
  await parentRow.click()
  await viewReturned('inquiry-returned-reading-before-continuation.png')
  const [continuedResponse] = await Promise.all([
    page.waitForResponse(result => new URL(result.url()).pathname === '/api/artifactBranchResults/continuePlot'),
    exactReading.getByRole('button', { name: 'Continue experiment', exact: true }).click(),
  ])
  expect(continuedResponse.ok()).toBe(true)
  const returnRef = { sessionId: parentId, eventSeq: returned.seq, messageId: returned.data.id }
  expect(continuedResponse.request().postDataJSON()).toMatchObject({ payload: { args: { request: returnRef } } })
  await expect.poll(() => children().filter(agent => !existingChildren.has(agent.id))).toHaveLength(1)
  const continued = children().find(agent => !existingChildren.has(agent.id))
  if (continued === undefined) throw new Error('The returned reading did not create a continuation branch')
  const continuedOwnEvents = () => continued.session.snapshotEvents().slice(continued.session.inheritedEventCount)
  const seeded = continuedOwnEvents().find(event => event.type === 'artifact/upsert')
  if (seeded?.type !== 'artifact/upsert' || seeded.data.format !== 'scene' || seeded.data.continuation === undefined) {
    throw new Error('The continued plot has no saved baseline')
  }
  const { continuation, ...continuedPlot } = seeded.data
  const baseline = continuation.baseline
  expect(seeded.data).toMatchObject({ revision: 1, spec: source.spec,
    continuation: { source: { ...returnRef, artifactId: source.artifactId, revision: source.revision }, baseline: reading } })
  expect(continuedPlot.artifactId).not.toBe(source.artifactId)
  const continueReceipt: unknown = await continuedResponse.json()
  expect(continueReceipt).toMatchObject({ result: { ok: true, value: { sessionId: continued.id, artifactId: continuedPlot.artifactId } } })
  const selectedFunction = source.spec.functions.find(item => item.id === baseline.functionId)
  if (selectedFunction === undefined) throw new Error('The locked baseline references an unknown function')
  await page.locator(`[data-row-key="session:${continued.id}"][aria-selected="true"]`).waitFor({ state: 'visible' })
  const card = conversation(continued.id).locator('section[data-artifact-revision="1"]').filter({
    has: page.locator('[data-function-baseline-comparison]:visible'),
  })
  const parameter = card.locator('label').filter({ hasText: /^Parameter a\b/u }).locator('output')
  await parameter.waitFor({ state: 'visible' })
  expect(await parameter.textContent()).toBe(reading.parameters.a.toFixed(2))
  await card.screenshot({ path: join(evidence, 'inquiry-continued-locked-plot.png') })

  const [lockedDownload, lockedExportResponse] = await Promise.all([
    page.waitForEvent('download'),
    page.waitForResponse(result => new URL(result.url()).pathname === '/api/artifactExports/create'),
    card.getByRole('button', { name: 'Export animation', exact: true }).click(),
  ])
  expect(lockedExportResponse.ok()).toBe(true)
  const lockedExportSource = { kind: 'current', artifactId: continuedPlot.artifactId, revision: 1 }
  expect(lockedExportResponse.request().postDataJSON()).toMatchObject({
    payload: { args: { agentId: continued.id, input: { format: 'html', source: lockedExportSource } } },
  })
  const lockedExport = (await readPersistedEvents(world, continued.id)).findLast(event =>
    event.type === 'artifact/export' && event.data.status === 'ready')
  if (lockedExport?.type !== 'artifact/export') throw new Error('The continued plot did not save its export')
  expect(lockedExport.data).toMatchObject({
    request: { source: lockedExportSource }, frozen: { artifact: continuedPlot, exporterVersion: 2, functionPlotBaseline: baseline },
  })
  const lockedFilename = 'inquiry-locked-plot.html'
  const lockedFile = join(evidence, lockedFilename)
  await lockedDownload.saveAs(lockedFile)
  const lockedOffline = await browser.newContext({ offline: true })
  try {
    const exported = await lockedOffline.newPage()
    const onlineRequests: string[] = []
    const pageErrors: string[] = []
    exported.on('request', (request) => { if (/^https?:/u.test(request.url())) onlineRequests.push(request.url()) })
    exported.on('pageerror', (error) => { pageErrors.push(error.message) })
    await exported.goto(pathToFileURL(lockedFile).href)
    await exported.locator('canvas#plot').waitFor({ state: 'visible' })
    const origin: unknown = JSON.parse(await exported.locator('#artifact-export-origin-data').textContent() ?? 'null')
    expect(origin).toMatchObject({ exporterVersion: 2, exportId: lockedExport.data.request.exportId, sessionId: continued.id,
      artifactId: continuedPlot.artifactId, revision: 1 })
    expect(origin).toHaveProperty('functionPlotBaseline', baseline)
    const readout = (label: string) => exported.locator('#readout > div').filter({
      has: exported.locator('span').and(exported.getByText(label, { exact: true })),
    }).locator('strong')
    const expectLockedReadout = async (): Promise<void> => {
      for (const [label, value] of Object.entries({ x: reading.x.toFixed(2), 'f′(x)': reading.values.derivative.toFixed(3),
        a: String(reading.parameters.a), Function: selectedFunction.label })) {
        await readout(label).waitFor({ state: 'visible' })
        expect(await readout(label).textContent()).toBe(value)
      }
    }
    await expectLockedReadout()
    const scrub = exported.getByRole('slider', { name: 'Timeline', exact: true })
    const seek = source.spec.viewport.x[1].toFixed(2) === reading.x.toFixed(2) ? 'Home' : 'End'
    await scrub.press(seek)
    expect(await readout('x').textContent()).not.toBe(reading.x.toFixed(2))
    await exported.getByRole('button', { name: 'Reset', exact: true }).click()
    await expectLockedReadout()
    expect(pageErrors).toEqual([])
    expect(onlineRequests).toEqual([])
    await exported.screenshot({ path: join(evidence, 'inquiry-locked-plot-offline.png') })
  } finally { await lockedOffline.close() }
  expect(continuedOwnEvents().filter(event => event.type === 'artifact/upsert')).toEqual([seeded])
  expect(continuedOwnEvents().filter(event => event.type === 'turn/start')).toEqual([])
  expect(await readPersistedEvents(world, parentId)).toEqual(beforeContinuation)
  expect((await readPersistedEvents(world, child.id)).filter(event => event.type === 'artifact/upsert')).toEqual(sourceBranchUpserts)
  expect(dispatched).toHaveLength(1)
  expect(requests).toHaveLength(callsBeforeReturn)

  stage('inquiry-delete-seeded-quote-without-sending')
  await parentRow.click()
  await parent.waitFor({ state: 'visible' })
  const deleted = await forkSelected(false)
  const deletedConversation = conversation(deleted.id)
  await expectQuote(deletedConversation)
  expect(deleted.id).not.toBe(child.id)
  expect(await storedInquiryDraft(page, deleted.id)).toMatchObject({ quotes: [{ text: phrase, offset: 0 }] })
  const unsentBranch = await readPersistedEvents(world, deleted.id)
  await quoteFor(deletedConversation).getByRole('button', { name: 'Remove quote', exact: true }).click()
  await expectNoQuote(deletedConversation, deleted.id)
  await reload(async () => { await expectNoQuote(deletedConversation, deleted.id) })
  await parentRow.click()
  await answer.locator(`[data-inquiry-branch="${deleted.id}"]`).click()
  await expectNoQuote(deletedConversation, deleted.id)
  expect(await readPersistedEvents(world, deleted.id)).toEqual(unsentBranch)
  await deletedConversation.locator('[data-composer-seat]').screenshot({ path: join(evidence, 'inquiry-deleted-quote-after-reopen.png') })
  await parentRow.click()
  await answer.locator(`[data-inquiry-branch="${deleted.id}"]`).waitFor({ state: 'visible' })
  await resultFor(child.id).waitFor({ state: 'visible' })
  expect(await resultButtons.count()).toBe(1)
  expect(await resultFor(deleted.id).count()).toBe(0)
  await answer.screenshot({ path: join(evidence, 'inquiry-returned-vs-unreturned-branches.png') })
  expect(dispatched).toHaveLength(1)
  expect(requests).toHaveLength(callsBeforeReturn)
  expect(console.warnings).toEqual([])
  await writeFile(join(evidence, 'selected-answer-inquiry-acceptance.json'), JSON.stringify({ userAgent, parentId, childId: child.id,
    selected, lockedReading: reading, conclusionText, returned: { eventSeq: returned.seq, messageId: returned.data.id },
    savedRevisionExport: { exportId: exportReady.data.request.exportId, artifactId: source.artifactId, revision: source.revision,
      nativeDownloadOpenedOffline: true },
    returnedPlotExport: { filename: returnedFilename, ...returnedPlotRequest, artifactId: source.artifactId, revision: source.revision,
      exporterVersion: 2, baseline: returnedBaseline, nativeDownloadOpenedOffline: true, restoredAfterReset: true,
      sessionLogsUnchanged: true },
    lockedPlotExport: { filename: lockedFilename, exportId: lockedExport.data.request.exportId, sessionId: continued.id,
      artifactId: continuedPlot.artifactId, revision: 1, exporterVersion: 2, baseline, restoredAfterReset: true },
    exactPhraseFocusAfterRefresh: true, highlightedPhraseInViewport: true, reopenedSameChild: true, providerRequests: requests.length,
    quoteAndQuestionAndReadingRestoredBeforeSend: true, inquiryPromptRequests: dispatched.length,
    inquiryProviderRequests: requests.length - beforeFork,
    sentQuoteAndQuestion: quotedQuestion, consumedQuoteAbsentOnReopen: true, deletedBranchId: deleted.id,
    deletedQuoteAbsentAfterRefreshAndReopen: true, sameResultFocusedBeforeAndAfterRefresh: true,
    noResultForUnreturnedSameQuoteBranch: true, extraProviderRequestsForSelectionReturnAndReplay: 0 }, null, 2) + '\n')
}

async function exerciseBranchQuestion({ page, world, evidence, requests, ask, providerSaw, stage, console }: LiveBrowser): Promise<void> {
  const first = 'I want to test how a changes the area under f(x) = a*x. Let me adjust a from 1 to 3 in increments of exactly 0.25, '
    + 'starting at a = 1. Start the trace at x = 1. Show the function value, slope, and signed integral from 0 to x.'
  const revision = 'Use the readings I attached and report the original slope and integral. Then update the same graph to '
    + 'f(x) = a*x + 1 with starting a = 2 and x = 1. Keep the range and increment of a unchanged.'
  const question = 'For the attached experiment readings, state the recorded a and x, then show how to compute the integral '
    + 'from zero to that x. Give the decimal result. Answer in text without changing the experiment.'
  const conversation = (id: SessionId) => page.locator(`[data-conversation-session="${id}"]`)
  const reply = (scope: Locator, turn: number) => scope.locator(`[data-chat-turn="${turn}"][data-chat-group-part="response"]:visible`).last()
  const card = (scope: Locator, title: string) => scope.getByRole('complementary', { name: `Artifact: ${title}`, exact: true })

  stage('parent-experiment')
  const parentId = await ask(first)
  const parentConversation = conversation(parentId)
  const original = (await readPersistedEvents(world, parentId)).find(event => event.type === 'artifact/upsert')
  if (original?.type !== 'artifact/upsert') throw new Error('The live model did not create the first plot')
  const source = original.data
  expect(source).toMatchObject({ revision: 1, format: 'scene', spec: { kind: 'function-plot',
    parameters: { a: { value: 1, step: 0.25 } }, trace: { x: 1 } } })
  await reply(parentConversation, 1).waitFor({ state: 'visible' })
  await parentConversation.getByRole('button', { name: 'Branch into a new conversation', exact: true }).last().click()
  await expect.poll(() => world.ctx.agents.roots().some(agent => agent.session.header.parentSession === parentId)).toBe(true)
  const child = world.ctx.agents.roots().find(agent => agent.session.header.parentSession === parentId)
  if (child === undefined) throw new Error('The experiment branch did not open')
  const childConversation = conversation(child.id)
  await page.locator(`[data-row-key="session:${child.id}"][aria-selected="true"]`).waitFor({ state: 'visible' })
  await reply(childConversation, 1).waitFor({ state: 'visible' })
  await expandTurnProcesses(page)

  stage('branch-revision')
  const branchPlot = card(childConversation, source.title)
  await branchPlot.getByRole('img', { name: 'Interactive function plot', exact: true }).waitFor({ state: 'visible' })
  await branchPlot.getByRole('button', { name: 'Step', exact: true }).click()
  await branchPlot.getByRole('button', { name: 'Use for next question', exact: true }).click()
  const review = branchPlot.getByRole('region', { name: 'Review function readings', exact: true })
  const confirmed = await functionReading(review, 'linear')
  expect(confirmed.parameters.a).toBe(1.25)
  expect(confirmed.values.integral).toBeCloseTo(0.625, 10)
  await review.getByRole('button', { name: 'Attach readings', exact: true }).click()
  await childConversation.locator('[data-artifact-prompt-context="current-function-plot"]').waitFor({ state: 'visible' })
  await ask(revision, child.id)
  await reply(childConversation, 2).waitFor({ state: 'visible' })
  const childEvents = await readPersistedEvents(world, child.id)
  const revised = childEvents.findLast(event => event.type === 'artifact/upsert' && event.data.revision === 2)
  expect(revised).toMatchObject({ data: { artifactId: source.artifactId, revision: 2, spec: {
    kind: 'function-plot', parameters: { a: { value: 2 } },
  } } })
  const branchQuestion = childEvents.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
  const conclusion = childEvents.findLast(event => event.type === 'assistant/message'
    && event.data.message.content.some(block => block.type === 'text'))
  if (branchQuestion === undefined || conclusion === undefined) throw new Error('The branch question or conclusion is missing')

  stage('return-evidence')
  const action = childConversation.locator(`[data-branch-result-seq="${conclusion.seq}"]:visible`)
  await action.getByRole('button', { name: 'Return with evidence', exact: true }).click()
  expect(await action.getByRole('radio', { name: 'Question readings', exact: true }).isChecked()).toBe(true)
  await expectReturnedPlot(action.locator('[data-branch-question-preview]'), source, confirmed)
  const callsBeforeReturn = requests.length
  await action.getByRole('button', { name: 'Confirm return with evidence', exact: true }).click()
  await page.locator(`[data-row-key="session:${parentId}"][aria-selected="true"]`).waitFor({ state: 'visible' })
  const returnedItem = parentConversation.locator('[data-artifact-branch-evidence-item="question"]:visible')
  await returnedItem.waitFor({ state: 'visible' })
  const parentBefore = await readPersistedEvents(world, parentId)
  const returned = parentBefore.find(event => event.type === 'user/message' && event.data.source.kind === 'branch-result')
  if (returned?.type !== 'user/message' || returned.data.source.kind !== 'branch-result') throw new Error('The returned evidence is not durable')
  expect(returned.data.source).toMatchObject({ branchSessionId: child.id, resultSeq: conclusion.seq })
  expect(parentBefore.filter(event => event.type === 'turn/end')).toHaveLength(1)
  expect(requests).toHaveLength(callsBeforeReturn)

  stage('parent-evidence-review')
  await returnedItem.getByRole('button', { name: 'Use this evidence for next question', exact: true }).click()
  const chip = parentConversation.locator('[data-artifact-prompt-context="branch-evidence"]')
  await chip.waitFor({ state: 'visible' })
  await chip.getByRole('button', { name: 'Replay experiment', exact: true }).click()
  await expectReturnedPlot(chip, source, confirmed)
  expect(requests).toHaveLength(callsBeforeReturn)
  await chip.screenshot({ path: join(evidence, 'evidence-in-composer.png') })

  stage('parent-model-answer')
  await ask(question, parentId)
  const parentAfter = await readPersistedEvents(world, parentId)
  expect(parentAfter.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])).toEqual(['completed', 'completed'])
  expect(parentAfter.filter(event => event.type === 'artifact/upsert')).toHaveLength(1)
  const newestQuestion = parentAfter.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (newestQuestion?.type !== 'user/message') throw new Error('The parent follow-up was not recorded')
  const attachment = newestQuestion.data.content[1]
  if (attachment?.type !== 'text') throw new Error('The parent follow-up lost its selected evidence')
  expect(newestQuestion.data.content[0]).toEqual({ type: 'text', text: question })
  const attached: unknown = JSON.parse(attachment.text.slice(attachment.text.indexOf('\n') + 1))
  expect(attached).toMatchObject({ kind: 'artifact-question-context', sessionId: parentId, facts: {
    kind: 'branch-evidence', branchResult: { eventSeq: returned.seq, messageId: returned.data.id,
      branchSessionId: child.id, resultSeq: conclusion.seq, questionSeq: branchQuestion.seq },
    readings: { kind: 'current-function-plot', artifact: source, ...confirmed },
  } })
  expect(providerSaw(question, attachment.text)).toBe(true)
  const answer = await reply(parentConversation, 2).innerText()
  expect(answer).toMatch(/\b1\.25\b/u)
  expect(answer).toMatch(/\b0\.625\b/u)
  await reply(parentConversation, 2).screenshot({ path: join(evidence, 'model-answer.png') })

  stage('reload-parent-question')
  const warningStart = console.warnings.length
  await page.reload()
  const displayed = parentConversation.locator('[data-chat-flow-kind="user"]:visible').filter({ hasText: question })
  await displayed.locator('[data-artifact-question-context-origin="branch-evidence"]').waitFor({ state: 'visible' })
  acknowledgeReloadConnectionLoss(console, warningStart)
  await displayed.getByRole('button', { name: 'Replay experiment', exact: true }).click()
  await expectReturnedPlot(displayed, source, confirmed)
  await displayed.screenshot({ path: join(evidence, 'question-replay-after-refresh.png') })
  expect((await readPersistedEvents(world, parentId)).find(event => event.seq === newestQuestion.seq)).toEqual(newestQuestion)
  expect(console.warnings).toEqual([])
}

async function expectReturnedParticle(
  scope: Locator, source: ArtifactSnapshot, reading: Awaited<ReturnType<typeof particleReading>>,
) {
  const replay = scope.locator(`[data-artifact-question-replay-revision="${source.revision}"]`)
  await replay.getByRole('img', { name: 'Interactive particle simulation', exact: true }).waitFor({ state: 'visible' })
  expect(await replay.getAttribute('data-artifact-question-replay-id')).toBe(source.artifactId)
  const checkpoint = replay.locator(`[data-particle-step="${reading.checkpoint.stepCount}"]`)
  expect(await checkpoint.getAttribute('data-read-only')).toBe('')
  expect(await visibleNumber(checkpoint.locator('[data-particle-source-time]'))).toBe(reading.values.time)
  const selected = reading.values.particles[0]!
  const particle = checkpoint.locator('[data-particle-live-id]')
  expect(await particle.getAttribute('data-particle-live-id')).toBe(selected.id)
  for (const coordinate of ['x', 'y', 'vx', 'vy'] as const) {
    expect(await visibleNumber(particle.locator(`[data-particle-live-coordinate="${coordinate}"]`))).toBe(selected[coordinate])
  }
  expect(await replay.getByRole('spinbutton', { name: 'Vertical gravity', exact: true }).count()).toBe(0)
  expect(await replay.getByRole('button', { name: /^(Play|Pause|Step|Reset)$/u }).count()).toBe(0)
}

async function exerciseContinuedParticle({
  browser, page, world, evidence, requests, ask, providerSaw, stage, console,
}: LiveBrowser): Promise<void> {
  const phrase = 'particle height'
  const first = 'I want to measure a projectile’s height myself at fixed time intervals. Give me an interactive experiment with '
    + 'exactly one particle starting at x=0, y=1, vx=1, vy=4, horizontal gravity 0 and vertical gravity -10. '
    + 'Use a fixed timestep of 0.1 seconds so I can advance it two steps and check its height. Include the words “particle height” in your answer.'
  const revise = 'Report the height in my attached readings. Then update the same experiment to vertical gravity -8, '
    + 'leaving the particle and timestep unchanged. I still want to keep my attached original reading.'
  const followup = 'Use the exact attached checkpoint and readings. State the sample step, the vertical gravity, and the '
    + 'resulting height in decimal notation. Answer in text and leave the experiment unchanged.'
  const conversation = (id: SessionId) => page.locator(`[data-conversation-session="${id}"]`)
  const selected = (id: SessionId) => page.locator(`[data-row-key="session:${id}"][aria-selected="true"]`)
  const items = (id: SessionId) => conversation(id).locator('[data-artifact-branch-evidence-item="question"]:visible')
  const userAgent = await page.evaluate(() => navigator.userAgent)
  expect(userAgent).toMatch(/\bEdg\//u)
  await page.setViewportSize({ width: 1440, height: 1280 })
  const openBranch = async (parentId: SessionId, trigger: Locator): Promise<SessionId> => {
    const existing = new Set(world.ctx.agents.roots().map(agent => agent.id))
    const next = () => world.ctx.agents.roots().find(agent => !existing.has(agent.id) && agent.session.header.parentSession === parentId)
    await trigger.click()
    await expect.poll(() => next()?.id).toBeDefined()
    const id = next()!.id
    await selected(id).waitFor({ state: 'visible' })
    return id
  }
  const reviewReadings = async (card: Locator, gravityY?: number) => {
    await card.getByRole('button', { name: 'Use for next question', exact: true }).click()
    const review = card.getByRole('region', { name: 'Review particle readings', exact: true })
    const reading = await particleReading(review)
    expect(reading.checkpoint.stepCount).toBe(2)
    expect(reading.values.time).toBeCloseTo(0.2, 12)
    if (gravityY !== undefined) {
      expect(await visibleNumber(review.locator('[data-particle-question-gravity-y]'))).toBe(gravityY)
      await review.screenshot({ path: join(evidence, 'comparison-readings-review.png') })
    }
    await review.getByRole('button', { name: 'Attach readings', exact: true }).click()
    return reading
  }
  const returnReading = async (parentId: SessionId, childId: SessionId, source: ArtifactSnapshot,
    reading: Awaited<ReturnType<typeof particleReading>>) => {
    const childEvents = await readPersistedEvents(world, childId)
    const result = childEvents.findLast(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text'))
    if (result === undefined) throw new Error('The branch has no text conclusion')
    const action = conversation(childId).locator(`[data-branch-result-seq="${result.seq}"]:visible`)
    await action.getByRole('button', { name: 'Return with evidence', exact: true }).click()
    expect(await action.getByRole('radio', { name: 'Question readings', exact: true }).isChecked()).toBe(true)
    await expectReturnedParticle(action.locator('[data-branch-question-preview]'), source, reading)
    const calls = requests.length
    await action.getByRole('button', { name: 'Confirm return with evidence', exact: true }).click()
    await selected(parentId).waitFor({ state: 'visible' })
    const returned = (await readPersistedEvents(world, parentId)).findLast(event =>
      event.type === 'user/message' && event.data.source.kind === 'branch-result')
    if (returned?.type !== 'user/message') throw new Error('The parent did not store the returned conclusion')
    expect(returned.data.source).toMatchObject({ branchSessionId: childId, resultSeq: result.seq })
    expect(requests).toHaveLength(calls)
    return returned
  }

  stage('particle-parent')
  const parentId = await ask(first)
  const parent = conversation(parentId)
  const parentHistory = await readPersistedEvents(world, parentId)
  const original = parentHistory.find(event => event.type === 'artifact/upsert')
  const closingAnswer = parentHistory.findLast(event => event.type === 'assistant/message'
    && event.data.message.content.some(block => block.type === 'text' && block.text.includes(phrase)))
  const end = parentHistory.findLast(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')
  if (original?.type !== 'artifact/upsert' || closingAnswer?.type !== 'assistant/message' || end?.type !== 'turn/end') {
    throw new Error('The model did not create a completed particle experiment answer with the requested phrase')
  }
  const source = original.data
  expect(source).toMatchObject({ revision: 1, format: 'scene', spec: { kind: 'particle-system',
    particles: [{ x: 0, y: 1, vx: 1, vy: 4 }], gravity: { x: 0, y: -10 }, timeStep: 0.1 } })

  stage('particle-branch-revision')
  const messageId = closingAnswer.data.message.id
  const sourceAnswer = parent.locator(`[data-chat-message-seq="${closingAnswer.seq}"][data-chat-message-id="${messageId}"]`)
  const phraseSpan = sourceAnswer.locator('span[data-markdown-source-start][data-markdown-source-end]:visible')
    .filter({ hasText: /particle height/u }).first()
  const spanStart = await phraseSpan.getAttribute('data-markdown-source-start')
  const displayed = await phraseSpan.textContent()
  if (spanStart === null || displayed === null) throw new Error('The particle phrase has no rendered source range')
  const start = Number(spanStart) + displayed.indexOf(phrase)
  const excerpt = { messageSeq: closingAnswer.seq, messageId, start, end: start + phrase.length, excerpt: phrase }
  const callsBeforeInquiry = requests.length
  await selectAnswerPhrase(page, phraseSpan, phrase)
  const selectionAction = page.locator('[data-chat-inquiry-create]')
  await selectionAction.waitFor({ state: 'visible' })
  await page.screenshot({ path: join(evidence, 'particle-inquiry-selected-phrase.png') })
  const [forked, branch] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/fork'), openBranch(parentId, selectionAction),
  ])
  expect(forked.request().postDataJSON()).toMatchObject({ payload: { args: { request: {
    sessionId: parentId, atSeq: end.seq, inquiry: excerpt,
  } } } })
  expect(world.ctx.agents.get(branch)?.session.header).toMatchObject({ parentSession: parentId, inquiry: excerpt })
  await expandTurnProcesses(page)
  const branchConversation = conversation(branch)
  const inherited = branchConversation.getByRole('complementary', { name: `Artifact: ${source.title}`, exact: true })
  for (let index = 0; index < 2; index++) await inherited.getByRole('button', { name: 'Step', exact: true }).click()
  const baseline = await reviewReadings(inherited)
  expect(baseline.values.particles[0]?.y).toBeCloseTo(1.7, 12)
  await expect.poll(() => branchConversation.locator('[data-composer-quote] [data-quote-preview-text]').textContent()).toBe(phrase)
  const branchInput = branchConversation.locator('[data-composer-input][contenteditable="true"]')
  await branchInput.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
  await page.keyboard.insertText(revise)
  await expect.poll(() => editorQuestion(branchInput)).toBe(revise)
  expect(requests).toHaveLength(callsBeforeInquiry)
  const settled = world.whenTurnSettled()
  await branchConversation.getByRole('button', { name: 'Send message', exact: true }).click()
  expect(await settled).toBe(branch)
  const branchEvents = await readPersistedEvents(world, branch)
  const quoted = `> ${phrase}\n\n${revise}`
  const question = branchEvents.findLast(event => event.type === 'user/message' && event.data.content.some(block =>
    block.type === 'text' && block.text === quoted))
  const locked = question?.type === 'user/message' ? question.data.content[1] : undefined
  if (locked?.type !== 'text') throw new Error('The inquiry question did not carry its locked particle reading')
  expect(JSON.parse(locked.text.slice(locked.text.indexOf('\n') + 1))).toMatchObject({ kind: 'artifact-question-context', sessionId: branch,
    facts: { kind: 'current-particle', artifact: source, ...baseline } })
  expect(providerSaw(quoted, locked.text)).toBe(true)
  expect(branchEvents.findLast(event => event.type === 'artifact/upsert')).toMatchObject({
    data: { artifactId: source.artifactId, revision: 2, spec: { gravity: { x: 0, y: -8 } } },
  })
  const originalNotice = await returnReading(parentId, branch, source, baseline)
  const parentBefore = await readPersistedEvents(world, parentId)
  const callsBeforeContinue = requests.length

  stage('particle-inquiry-view-frozen-returned-result')
  const result = sourceAnswer.getByRole('button', { name: 'View returned result', exact: true })
    .and(sourceAnswer.locator(`[data-inquiry-result="${branch}"]`))
  const returnedOriginal = parent.locator(`[data-artifact-branch-evidence][data-chat-message-id="${originalNotice.data.id}"]`
    + `[data-chat-message-seq="${originalNotice.seq}"]`)
  const openOriginal = async (shot: string): Promise<void> => {
    await result.waitFor({ state: 'visible' })
    await result.click()
    const control = returnedOriginal.locator('[data-chat-message-control="artifact-branch-result"]')
    await expect.poll(() => control.evaluate(element => document.activeElement === element)).toBe(true)
    await expectReturnedParticle(returnedOriginal, source, baseline)
    await returnedOriginal.screenshot({ path: join(evidence, shot) })
    expect(requests).toHaveLength(callsBeforeContinue)
  }
  await openOriginal('particle-inquiry-result-before-refresh.png')
  const inquiryWarnings = console.warnings.length
  await page.reload()
  await openOriginal('particle-inquiry-result-after-refresh.png')
  acknowledgeReloadConnectionLoss(console, inquiryWarnings)
  await sourceAnswer.locator(`[data-inquiry-branch="${branch}"]`).click()
  await selected(branch).waitFor({ state: 'visible' })
  await branchConversation.getByText(revise, { exact: true }).waitFor({ state: 'visible' })
  await page.locator(`[data-row-key="session:${parentId}"]`).click()
  await selected(parentId).waitFor({ state: 'visible' })
  expect(await readPersistedEvents(world, parentId)).toEqual(parentBefore)
  expect(requests).toHaveLength(callsBeforeContinue)
  await writeFile(join(evidence, 'particle-inquiry-result-acceptance.json'), JSON.stringify({ userAgent, parentId, childId: branch,
    excerpt, lockedReading: baseline, returned: { eventSeq: originalNotice.seq, messageId: originalNotice.data.id },
    focusedExactResultBeforeAndAfterRefresh: true, returnedReplayPaused: true, reopenedSameChild: true,
    extraProviderRequestsDuringInquiryNavigation: 0 }, null, 2) + '\n')

  stage('particle-continue-and-compare')
  const continued = await openBranch(parentId, items(parentId).getByRole('button', { name: 'Continue experiment', exact: true }))
  const continuedSession = world.ctx.agents.get(continued)
  if (continuedSession === undefined) throw new Error('The continuation session is missing')
  const ownEvents = () => continuedSession.session.snapshotEvents().slice(continuedSession.session.inheritedEventCount)
  const seeded = ownEvents().find(event => event.type === 'artifact/upsert')
  if (seeded?.type !== 'artifact/upsert' || seeded.data.format !== 'scene' || seeded.data.spec.kind !== 'particle-system'
    || source.format !== 'scene' || source.spec.kind !== 'particle-system') {
    throw new Error('The continuation did not create a native particle experiment')
  }
  expect(seeded.data.spec).toEqual(source.spec)
  expect(seeded.data).toMatchObject({ revision: 1,
    particleContinuation: { source: { sessionId: parentId, eventSeq: originalNotice.seq, messageId: originalNotice.data.id,
      artifactId: source.artifactId, revision: 1 }, baseline: { checkpoint: baseline.checkpoint } } })
  expect(seeded.data.artifactId).not.toBe(source.artifactId)
  expect((await readPersistedEvents(world, continued)).find(event => event.seq === seeded.seq)).toEqual(seeded)
  const card = conversation(continued).locator('section[data-artifact-revision]').filter({
    has: page.locator('[data-particle-baseline-comparison]'),
  })
  const gravity = card.getByRole('spinbutton', { name: 'Vertical gravity', exact: true })
  const height = (name: 'baseline' | 'current' | 'delta') => card.locator(`[data-particle-height="${name}"]`)
  const expectBaseline = async () => {
    await gravity.waitFor({ state: 'visible' })
    expect(await gravity.inputValue()).toBe('-10')
    expect(await height('baseline').innerText()).toBe('1.700')
    expect(await height('current').innerText()).toBe('1.700')
    expect(await height('delta').innerText()).toBe('0.000')
    expect(await card.getByRole('button', { name: 'Step', exact: true }).count()).toBe(0)
  }
  await expectBaseline()
  await gravity.fill('-5')
  await expect.poll(() => height('current').innerText()).toBe('1.750')
  expect(await height('baseline').innerText()).toBe('1.700')
  expect(await height('delta').innerText()).toBe('+0.050')
  await card.screenshot({ path: join(evidence, 'gravity-comparison.png') })
  await card.getByRole('button', { name: 'Reset', exact: true }).click()
  await expectBaseline()
  await gravity.fill('-5')
  const branchWarnings = console.warnings.length
  await page.reload()
  await expectBaseline()
  acknowledgeReloadConnectionLoss(console, branchWarnings)
  await gravity.fill('-5')
  expect(await readPersistedEvents(world, parentId)).toEqual(parentBefore)
  expect(requests).toHaveLength(callsBeforeContinue)

  stage('particle-continued-model-answer')
  const changed = await reviewReadings(card, -5)
  expect(changed.values.particles[0]?.y).toBeCloseTo(1.75, 12)
  expect(changed.values.particles[0]?.x).toBeCloseTo(0.2, 12)
  expect(changed.values.particles[0]?.vy).toBeCloseTo(3, 12)
  await ask(followup, continued)
  const latest = ownEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (latest?.type !== 'user/message') throw new Error('The continued question was not recorded')
  const attachment = latest.data.content[1]
  if (attachment?.type !== 'text') throw new Error('The continued question lost its confirmed comparison reading')
  expect(attachment.text).toContain('This question uses the adjusted particle experiment.')
  const attached: unknown = JSON.parse(attachment.text.slice(attachment.text.indexOf('\n') + 1))
  expect(attached).toMatchObject({ kind: 'artifact-question-context', sessionId: continued,
    facts: { kind: 'current-particle', artifact: seeded.data, gravityY: -5, ...changed } })
  expect(providerSaw(followup, attachment.text)).toBe(true)
  expect(ownEvents().filter(event => event.type === 'artifact/upsert')).toEqual([seeded])
  const final = ownEvents().findLast(event => event.type === 'assistant/message')
  if (final?.type !== 'assistant/message') throw new Error('The continuation has no model answer')
  const answerText = final.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ')
  const answer = conversation(continued).locator(`[data-chat-turn="${final.data.turn}"][data-chat-group-part="response"]:visible`).last()
  await answer.screenshot({ path: join(evidence, 'model-answer.png') })

  stage('particle-return-and-reload')
  const returned = await returnReading(parentId, continued, seeded.data, changed)
  const returnedAttachment = returned.data.content[1]
  if (returnedAttachment?.type !== 'text') throw new Error('The returned conclusion lost its comparison reading')
  const returnedEvidence: unknown = JSON.parse(returnedAttachment.text.slice(returnedAttachment.text.indexOf('\n') + 1))
  expect(returnedEvidence).toMatchObject({ kind: 'branch-result-artifact-evidence', branchSessionId: continued,
    evidence: { kind: 'question', questionSeq: latest.seq,
      facts: { kind: 'current-particle', artifact: seeded.data, gravityY: -5, ...changed } } })
  const checkParent = async () => {
    await expect.poll(() => items(parentId).count()).toBe(2)
    const originalToggle = items(parentId).first().getByRole('button', { name: 'Replay experiment', exact: true })
    if (await originalToggle.getAttribute('aria-expanded') !== 'true') await originalToggle.click()
    await expectReturnedParticle(items(parentId).first(), source, baseline)
    await items(parentId).last().getByRole('button', { name: 'Replay experiment', exact: true }).click()
    await expectReturnedParticle(items(parentId).last(), seeded.data, changed)
  }
  await checkParent()
  const parentWarnings = console.warnings.length
  await page.reload()
  await checkParent()
  acknowledgeReloadConnectionLoss(console, parentWarnings)
  await items(parentId).first().screenshot({ path: join(evidence, 'original-particle-after-refresh.png') })
  await items(parentId).last().screenshot({ path: join(evidence, 'returned-particle-after-refresh.png') })
  const parentAfter = await readPersistedEvents(world, parentId)
  expect(parentAfter.slice(0, parentBefore.length)).toEqual(parentBefore)
  expect(parentAfter.slice(parentBefore.length)).toEqual([returned])

  stage('particle-download-directly-from-returned-result')
  const returnAddress = { eventSeq: returned.seq, messageId: returned.data.id }
  const resultItem = parent.locator(`[data-artifact-branch-evidence][data-chat-message-id="${returned.data.id}"]`
    + `[data-chat-message-seq="${returned.seq}"]`).locator('[data-artifact-branch-evidence-item="question"]')
  const rootsBeforeDownload = world.ctx.agents.roots().map(agent => agent.id)
  const downloadLogs = () => Promise.all([readPersistedEvents(world, branch), readPersistedEvents(world, continued)])
  const logsBeforeDownload = await downloadLogs()
  const callsBeforeDownload = requests.length
  const originalDownload = await verifyParticleDownload({ browser, page,
    card: returnedOriginal.locator('[data-artifact-branch-evidence-item="question"]'), directory: evidence,
    sessionId: parentId, address: { eventSeq: originalNotice.seq, messageId: originalNotice.data.id },
    scene: { ...source, spec: source.spec }, reading: baseline, kind: 'returnedEvidence',
    fileName: 'inquiry-original-locked-particle.html', screenshot: 'inquiry-original-locked-particle-offline.png' })
  const continuedDownload = await verifyParticleDownload({ browser, page, card: resultItem, directory: evidence,
    sessionId: parentId, address: returnAddress, scene: { ...seeded.data, spec: seeded.data.spec }, reading: changed,
    gravityY: -5, kind: 'returnedEvidence', fileName: 'inquiry-returned-locked-particle.html',
    screenshot: 'inquiry-returned-locked-particle-offline.png' })
  await selected(parentId).waitFor({ state: 'visible' })

  stage('particle-download-from-sent-question-after-refresh')
  const sentAddress = { eventSeq: latest.seq, messageId: latest.data.id }
  const sentRow = conversation(continued)
    .locator(`[data-chat-message-seq="${sentAddress.eventSeq}"][data-chat-message-id="${sentAddress.messageId}"]`)
  await page.locator(`[data-row-key="session:${continued}"]`).click()
  await selected(continued).waitFor({ state: 'visible' })
  const sentWarnings = console.warnings.length
  await page.reload()
  await sentRow.getByText(followup, { exact: true }).waitFor({ state: 'visible' })
  acknowledgeReloadConnectionLoss(console, sentWarnings)
  const sentDownload = await verifyParticleDownload({ browser, page, card: sentRow, directory: evidence,
    sessionId: continued, address: sentAddress, scene: { ...seeded.data, spec: seeded.data.spec }, reading: changed,
    gravityY: -5, kind: 'sentQuestion', screenshot: 'sent-question-locked-particle-offline.png' })
  expect(requests).toHaveLength(callsBeforeDownload)
  expect(world.ctx.agents.roots().map(agent => agent.id)).toEqual(rootsBeforeDownload)
  expect(await readPersistedEvents(world, parentId)).toEqual(parentAfter)
  expect(await downloadLogs()).toEqual(logsBeforeDownload)
  const readOnly = { sessionLogsUnchanged: true, branchesUnchanged: true, additionalModelRequests: requests.length - callsBeforeDownload }
  await writeFile(join(evidence, 'particle-returned-html-acceptance.json'), JSON.stringify({ userAgent, ...continuedDownload,
    ...readOnly }, null, 2) + '\n')
  await writeFile(join(evidence, 'particle-sent-html-acceptance.json'), JSON.stringify({ userAgent, sentQuestion: sentDownload,
    originalReturn: originalDownload, ...readOnly }, null, 2) + '\n')
  expect(console.warnings).toEqual([])
  expect(answerText).toMatch(/\b1\.750*\b/u)
  expect(answerText).toMatch(/[-−]\s*5(?:\.0+)?\b(?!\.\d)/u)
}

const BFS_INITIAL = { kind: 'bfs-checkpoint', current: null, queue: ['A'], visited: [] } as const
const BFS_FIRST = { kind: 'bfs-checkpoint', current: 'A', queue: ['B', 'C'], visited: ['A'] } as const
const BFS_SELECTED = { kind: 'bfs-checkpoint', current: 'B', queue: ['C', 'D', 'E'], visited: ['A', 'B'] } as const
const BFS_NEXT = { kind: 'bfs-checkpoint', current: 'C', queue: ['D', 'E', 'F'], visited: ['A', 'B', 'C'] } as const
const BFS_AFTER_NEXT = { kind: 'bfs-checkpoint', current: 'D', queue: ['E', 'F'], visited: ['A', 'B', 'C', 'D'] } as const
type BfsTestState = typeof BFS_INITIAL | typeof BFS_FIRST | typeof BFS_SELECTED | typeof BFS_NEXT | typeof BFS_AFTER_NEXT

function bfsNodes(text: string | null): string[] {
  return text?.match(/\b[A-F]\b/gu) ?? []
}

async function expectBfsFrameState(frame: FrameLocator, state: BfsTestState): Promise<void> {
  const field = (name: string) => frame.getByLabel(name, { exact: true }).textContent({ timeout: 5_000 })
  await expect.poll(async () => bfsNodes(await field('Current node'))).toEqual(state.current === null ? [] : [state.current])
  expect(bfsNodes(await field('Queue'))).toEqual(state.queue)
  expect(bfsNodes(await field('Visited'))).toEqual(state.visited)
}

async function expectBfsFields(scope: Locator, state: BfsTestState): Promise<void> {
  const field = (name: string) => scope.locator(`[data-artifact-bfs-${name}]`).textContent()
  expect(bfsNodes(await field('current'))).toEqual(state.current === null ? [] : [state.current])
  expect(bfsNodes(await field('queue'))).toEqual(state.queue)
  expect(bfsNodes(await field('visited'))).toEqual(state.visited)
}

async function exerciseGeneratedBfs({
  browser, page, world, evidence, requests, ask, providerSaw, providerUserText, providerToolDescription, stage, console,
}: LiveBrowser): Promise<void> {
  const phrase = 'BFS queue'
  const initial = 'I want to explore why breadth-first search visits nodes in a particular order. Build a small interactive '
    + 'BFS stepper for this directed graph: A points to B and C in that order, B points to D and E in that order, '
    + 'C points to F, and D, E, and F have no outgoing edges. Start with only A queued and no visits. A Step button should '
    + 'visit the first waiting node and add its undiscovered neighbors to the back in order. Give the three readouts the accessible names '
    + 'Current node, Queue, and Visited. Keep the stepper compact and right in the answer. '
    + 'Let me lock the displayed readings, attach them to a question, and resume that exact step after reloading.'
  const followup = 'From the BFS state I attached, which node is current, what is in the queue in order, and which nodes '
    + 'have been visited? Explain in text why the front of that queue is visited next.'
  const parentFollowup = 'For the new BFS checkpoint attached to this question, list the current node, queue, and visited nodes '
    + 'in order. Explain in text why the next node is already ahead of the newest neighbor.'
  const conversationFor = (id: SessionId) => page.locator(`[data-conversation-session="${id}"]`)
  const selected = (id: SessionId) => page.locator(`[data-row-key="session:${id}"][aria-selected="true"]`)
  const userAgent = await page.evaluate(() => navigator.userAgent)
  expect(userAgent).toMatch(/\bEdg\//u)
  await page.setViewportSize({ width: 1440, height: 1280 })

  stage('bfs-open-branch')
  await page.getByRole('button', { name: 'Standard mode', exact: true }).click()
  await page.getByRole('menuitem', { name: /^Chat\b/u }).click()
  await page.getByRole('button', { name: 'Chat', exact: true }).waitFor({ state: 'visible' })
  const parentId = await ask('In one sentence, explain why breadth-first search uses a first-in, first-out queue. Include the exact words “BFS queue”.')
  const parentSession = world.ctx.agents.get(parentId)?.session
  if (parentSession === undefined) throw new Error('The BFS Chat session did not open')
  expect(world.ctx.agentPresets.presetForSession(parentSession)).toBe('chat')
  const parent = conversationFor(parentId)
  const firstEvents = await readPersistedEvents(world, parentId)
  const closingAnswer = firstEvents.findLast(event => event.type === 'assistant/message'
    && event.data.message.content.some(block => block.type === 'text' && block.text.includes(phrase)))
  const end = firstEvents.findLast(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')
  if (closingAnswer?.type !== 'assistant/message' || end?.type !== 'turn/end') {
    throw new Error('The BFS answer lacks the requested inquiry phrase')
  }
  const messageId = closingAnswer.data.message.id
  const sourceAnswer = parent.locator(`[data-chat-message-seq="${closingAnswer.seq}"][data-chat-message-id="${messageId}"]`)
  const phraseSpan = sourceAnswer.locator('span[data-markdown-source-start][data-markdown-source-end]:visible').filter({ hasText: phrase }).first()
  const spanStart = await phraseSpan.getAttribute('data-markdown-source-start')
  const displayed = await phraseSpan.textContent()
  if (spanStart === null || displayed === null) throw new Error('The BFS phrase has no rendered source range')
  const start = Number(spanStart) + displayed.indexOf(phrase)
  const inquiry = { messageSeq: closingAnswer.seq, messageId, start, end: start + phrase.length, excerpt: phrase }
  const callsBeforeInquiry = requests.length
  await selectAnswerPhrase(page, phraseSpan, phrase)
  const startInquiry = page.locator('[data-chat-inquiry-create]')
  await startInquiry.waitFor({ state: 'visible' })
  await page.screenshot({ path: join(evidence, 'bfs-inquiry-selected-phrase.png') })
  const [forked] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/fork'), startInquiry.click(),
  ])
  expect(forked.request().postDataJSON()).toMatchObject({ payload: { args: { request: {
    sessionId: parentId, atSeq: end.seq, inquiry,
  } } } })
  const child = () => world.ctx.agents.roots().find(agent => agent.session.header.parentSession === parentId)
  await expect.poll(() => child()?.id).toBeDefined()
  const id = child()!.id
  expect(child()?.session.header).toMatchObject({ parentSession: parentId, inquiry, agentPreset: 'chat' })
  await selected(id).waitFor({ state: 'visible' })

  stage('bfs-generate')
  const conversation = conversationFor(id)
  const input = conversation.locator('[data-composer-input][contenteditable="true"]')
  await expect.poll(() => conversation.locator('[data-composer-quote] [data-quote-preview-text]').textContent()).toBe(phrase)
  await input.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
  await page.keyboard.insertText(initial)
  await expect.poll(() => editorQuestion(input)).toBe(initial)
  expect(requests).toHaveLength(callsBeforeInquiry)
  const settled = world.whenTurnSettled()
  await conversation.getByRole('button', { name: 'Send message', exact: true }).click()
  expect(await settled).toBe(id)
  const initialEvents = await readPersistedEvents(world, id)
  const quotedPrompt = `> ${phrase}\n\n${initial}`
  expect(initialEvents.some(event => event.type === 'user/message' && event.data.content.some(block =>
    block.type === 'text' && block.text === quotedPrompt))).toBe(true)
  expect(providerUserText(quotedPrompt)).toEqual([quotedPrompt])
  const description = providerToolDescription('artifact')
  expect(description).toContain('returns {kind:"bfs-checkpoint",current,queue,visited}')
  expect(description).toContain('Use the complete four-field object for the initial state and every step.')
  expect(description).toContain('ready({state:readCheckpoint,restore:{kind:"bfs-checkpoint",apply:restoreCheckpoint}})')
  expect(description).toContain('After every BFS step, redraw the current node, queue, and visited nodes,')
  expect(description).toContain('then call window.artifactRuntime.reportState(readCheckpoint()).')
  const upserts = initialEvents.flatMap(event => event.type === 'artifact/upsert' ? [event.data] : [])
  const source = upserts.at(-1)
  if (source?.format !== 'html') throw new Error('The model did not generate a custom HTML BFS stepper')
  expect(new Set(upserts.map(snapshot => snapshot.artifactId))).toEqual(new Set([source.artifactId]))
  const card = page.locator(`section[data-artifact-revision="${source.revision}"]`).filter({
    has: page.locator(`iframe[data-artifact-frame][data-artifact-id="${source.artifactId}"]`),
  })
  const live = card.frameLocator('[data-artifact-frame]')
  const step = live.getByRole('button', { name: 'Step', exact: true })
  if (await conversation.count() === 0) {
    const warningStart = console.warnings.length
    await page.reload()
    await conversation.waitFor({ state: 'visible' })
    acknowledgeReloadConnectionLoss(console, warningStart)
  }
  await expandOwningTurnProcess(page, card)
  const openReview = card.locator('[data-artifact-prompt-attach="html-runtime"]')
  const review = card.locator('[data-artifact-bfs-review]')
  const checkLiveStep = async (state: BfsTestState): Promise<void> => {
    await expectBfsFrameState(live, state)
    await openReview.click()
    await expectBfsFields(review, state)
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
  }
  const calls = requests.length
  await checkLiveStep(BFS_INITIAL)
  await step.click()
  await checkLiveStep(BFS_FIRST)
  await step.click()
  await expectBfsFrameState(live, BFS_SELECTED)

  stage('bfs-review')
  await openReview.click()
  await expectBfsFields(review, BFS_SELECTED)
  await review.getByRole('button', { name: 'Attach readings', exact: true }).click()
  const branchChip = conversation.locator('[data-artifact-prompt-context="html-bfs"]')
  await expectBfsFields(branchChip, BFS_SELECTED)
  await step.click()
  await checkLiveStep(BFS_NEXT)
  await step.click()
  await checkLiveStep(BFS_AFTER_NEXT)
  await expectBfsFields(branchChip, BFS_SELECTED)
  expect(requests).toHaveLength(calls)

  stage('bfs-provider-followup')
  await ask(followup, id)
  const events = await readPersistedEvents(world, id)
  expect(events.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : []))
    .toEqual(['completed', 'completed', 'completed'])
  expect(events.flatMap(event => event.type === 'artifact/upsert' ? [event.data] : [])).toEqual(upserts)
  const question = events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (question?.type !== 'user/message') throw new Error('The branch follow-up is missing')
  const attachment = question.data.content[1]
  if (attachment?.type !== 'text') throw new Error('The confirmed BFS state did not reach the ordinary question')
  expect(attachment.text).toContain('Use facts.capture.state for the selected current node, queue and visited nodes.')
  const attached: unknown = JSON.parse(attachment.text.slice(attachment.text.indexOf('\n') + 1))
  expect(attached).toMatchObject({ kind: 'artifact-question-context', sessionId: id,
    facts: { kind: 'html-runtime', attribution: 'program-reported', artifact: {
      artifactId: source.artifactId, revision: source.revision, format: 'html', source: source.source,
    }, capture: { status: 'ready', restore: 'bfs-checkpoint', state: BFS_SELECTED } } })
  if (typeof attached !== 'object' || attached === null || !('facts' in attached)) throw new Error('The confirmed BFS facts are missing')
  expect(providerSaw(followup, attachment.text)).toBe(true)
  const reply = events.findLast(event => event.type === 'assistant/message')
  if (reply?.type !== 'assistant/message') throw new Error('The model did not answer the BFS follow-up')
  const conclusion = reply.data.message.content.filter(block => block.type === 'text')
  const answer = conclusion.map(block => block.text).join(' ')
  await conversation.locator(`[data-chat-turn="${reply.data.turn}"][data-chat-group-part="response"]:visible`).last()
    .screenshot({ path: join(evidence, 'bfs-model-answer.png') })

  stage('bfs-return-review')
  const parentBefore = await readPersistedEvents(world, parentId)
  expect(parentBefore.filter(event => event.type === 'artifact/upsert')).toEqual([])
  expect(parentBefore.filter(event => event.type === 'turn/start')).toHaveLength(1)
  const action = conversation.locator(`[data-branch-result-seq="${reply.seq}"]:visible`)
  await action.getByRole('button', { name: 'Return with evidence', exact: true }).click()
  const candidate = action.locator('[data-branch-question-preview]')
  expect(await action.getByRole('radio', { name: 'Question readings', exact: true }).isChecked()).toBe(true)
  expect(await candidate.textContent()).toContain(`revision ${source.revision}`)
  await expectBfsFields(candidate, BFS_SELECTED)
  expect(await candidate.locator('iframe').count()).toBe(0)
  await scrollIntoView(candidate)
  await candidate.screenshot({ path: join(evidence, 'bfs-return-review.png') })
  expect(await readPersistedEvents(world, parentId)).toEqual(parentBefore)
  const callsBeforeReturn = requests.length
  await action.getByRole('button', { name: 'Confirm return with evidence', exact: true }).click()
  await selected(parentId).waitFor({ state: 'visible' })
  const returnedItem = parent.locator('[data-artifact-branch-evidence-item="question"]:visible')
  await returnedItem.waitFor({ state: 'visible' })
  await expect.poll(async () => (await readPersistedEvents(world, parentId)).length).toBe(parentBefore.length + 1)
  const parentAfter = await readPersistedEvents(world, parentId)
  expect(parentAfter.slice(0, -1)).toEqual(parentBefore)
  const returned = parentAfter.at(-1)
  if (returned?.type !== 'user/message' || returned.data.source.kind !== 'branch-result') throw new Error('Expected returned BFS evidence')
  expect(returned.data.source).toMatchObject({ branchSessionId: id, resultSeq: reply.seq,
    resultMessageId: reply.data.message.id, artifactEvidence: 'bfs-checkpoint' })
  expect(returned.data.content.slice(0, -1)).toEqual(conclusion)
  const evidenceBlock = returned.data.content.at(-1)
  if (evidenceBlock?.type !== 'text') throw new Error('The adopted BFS conclusion is missing its locked state')
  expect(JSON.parse(evidenceBlock.text.slice(evidenceBlock.text.indexOf('\n') + 1))).toEqual({
    kind: 'branch-result-artifact-evidence', branchSessionId: id, evidence: {
      kind: 'question', questionSeq: question.seq, facts: attached.facts,
    },
  })
  await expectBfsFields(returnedItem, BFS_SELECTED)
  expect(requests).toHaveLength(callsBeforeReturn)

  const result = sourceAnswer.getByRole('button', { name: 'View returned result', exact: true })
    .and(sourceAnswer.locator(`[data-inquiry-result="${id}"]`))
  const exactReturn = parent.locator(`[data-artifact-branch-evidence][data-chat-message-id="${returned.data.id}"]`
    + `[data-chat-message-seq="${returned.seq}"]`)
  const toggle = exactReturn.locator('[data-artifact-bfs-replay-toggle]')
  const panel = exactReturn.locator('[data-artifact-bfs-replay]')
  const restored = panel.locator('[data-artifact-restoration="restored"]')
  const restoredIframe = restored.locator('iframe[data-artifact-replay-frame]')
  const replay = restoredIframe.contentFrame()
  const openResult = async (): Promise<void> => {
    const requestsBeforeOpen = requests.length
    await result.click()
    const control = toggle.and(exactReturn.locator('[data-chat-message-control="artifact-branch-result"]'))
    await expect.poll(() => control.evaluate(element => document.activeElement === element)).toBe(true)
    await restored.waitFor({ state: 'visible' })
    await expectBfsFrameState(replay, BFS_SELECTED)
    await expectBfsFields(returnedItem, BFS_SELECTED)
    expect(requests).toHaveLength(requestsBeforeOpen)
  }

  stage('bfs-open-inquiry-result-from-original-answer')
  await openResult()
  await panel.screenshot({ path: join(evidence, 'bfs-inquiry-result-before-refresh.png') })
  const stepColor = async (frame: FrameLocator): Promise<string> => {
    await frame.getByLabel('Queue', { exact: true }).hover()
    return await frame.getByRole('button', { name: 'Step', exact: true })
      .evaluate(button => getComputedStyle(button).backgroundColor)
  }
  const lockedStepColor = await stepColor(replay)
  const editedStepColor = 'rgb(173, 39, 154)'
  expect(lockedStepColor).not.toBe(editedStepColor)

  stage('bfs-update-original-branch-style-after-return')
  await sourceAnswer.locator(`[data-inquiry-branch="${id}"]`).click()
  await selected(id).waitFor({ state: 'visible' })
  const stylePrompt = `Update the existing BFS stepper (${source.artifactId}) in place. `
    + 'Change the Step button background to solid #ad279a. Keep the graph, controls, traversal order, and ability to lock and restore steps.'
  expect(await ask(stylePrompt, id)).toBe(id)
  expect(providerUserText(stylePrompt)).toEqual([stylePrompt])
  const eventsAfterStyle = await readPersistedEvents(world, id)
  expect(eventsAfterStyle.slice(0, events.length)).toEqual(events)
  const styleUpdates = eventsAfterStyle.slice(events.length).flatMap(event => event.type === 'artifact/upsert' ? [event.data] : [])
  const updated = styleUpdates.at(-1)
  if (updated?.format !== 'html') throw new Error('The model did not update the BFS HTML Artifact after the return')
  expect(styleUpdates.every(snapshot => snapshot.artifactId === source.artifactId && snapshot.revision > source.revision)).toBe(true)
  expect(updated.source).not.toBe(source.source)
  const updatedCard = conversation.locator(`section[data-artifact-revision="${updated.revision}"]`).filter({
    has: page.locator(`iframe[data-artifact-frame][data-artifact-id="${source.artifactId}"]`),
  })
  await expandOwningTurnProcess(page, updatedCard)
  const updatedFrame = updatedCard.frameLocator('[data-artifact-frame]')
  const updatedStep = updatedFrame.getByRole('button', { name: 'Step', exact: true })
  await expectBfsFrameState(updatedFrame, BFS_INITIAL)
  await updatedStep.click()
  await expectBfsFrameState(updatedFrame, BFS_FIRST)
  await updatedStep.click()
  await expectBfsFrameState(updatedFrame, BFS_SELECTED)
  await expect.poll(() => stepColor(updatedFrame)).toBe(editedStepColor)
  await updatedCard.screenshot({ path: join(evidence, 'bfs-branch-style-updated.png') })
  expect(await readPersistedEvents(world, parentId)).toEqual(parentAfter)
  const callsAfterStyle = requests.length
  expect(callsAfterStyle).toBeGreaterThan(callsBeforeReturn)
  await page.locator(`[data-row-key="session:${parentId}"]`).click()
  await selected(parentId).waitFor({ state: 'visible' })

  stage('bfs-parent-reload-and-restore')
  const warningStart = console.warnings.length
  await page.reload()
  await selected(parentId).waitFor({ state: 'visible' })
  await result.waitFor({ state: 'visible' })
  await expectBfsFields(returnedItem, BFS_SELECTED)
  expect(await exactReturn.locator('iframe').count()).toBe(0)
  acknowledgeReloadConnectionLoss(console, warningStart)
  expect(requests).toHaveLength(callsAfterStyle)

  stage('bfs-download-directly-from-returned-result')
  const returnAddress = { eventSeq: returned.seq, messageId: returned.data.id }
  const exportRequest = { sessionId: parentId, ...returnAddress }
  const rootsBeforeExport = world.ctx.agents.roots().map(agent => agent.id)
  const forbiddenRequests: string[] = []
  const forbiddenPaths = ['/api/session/prompt', '/api/session/fork', '/api/artifactExports/create', '/api/artifactExports/read']
  const watchExport = (request: Request): void => {
    const path = new URL(request.url()).pathname
    if (forbiddenPaths.includes(path)) forbiddenRequests.push(path)
  }
  page.on('request', watchExport)
  const [download, response] = await Promise.all([
    page.waitForEvent('download'),
    page.waitForResponse(result => new URL(result.url()).pathname === '/api/artifactBranchResults/exportReturnedBfs'),
    exactReturn.getByRole('button', { name: 'Download experiment HTML', exact: true })
      .and(exactReturn.locator('[data-artifact-branch-download]')).click(),
  ])
  expect(response.ok()).toBe(true)
  expect(response.request().postDataJSON()).toHaveProperty('payload.args.request', exportRequest)
  const exportFilename = 'inquiry-returned-locked-bfs.html'
  const exportFile = join(evidence, exportFilename)
  await download.saveAs(exportFile)
  const offlineContext = await browser.newContext({ offline: true })
  try {
    const offline = await offlineContext.newPage()
    const network: string[] = []
    const errors: string[] = []
    offline.on('request', (request) => { if (/^https?:/u.test(request.url())) network.push(request.url()) })
    offline.on('websocket', (socket) => { network.push(socket.url()) })
    offline.on('pageerror', (error) => { errors.push(error.message) })
    await offline.goto(pathToFileURL(exportFile).href)
    const exportedFrame = offline.locator('iframe[data-exported-bfs-frame]')
    const exported = exportedFrame.contentFrame()
    const restoredStatus = offline.locator('[data-bfs-export-status="restored"]')
    await restoredStatus.waitFor({ state: 'visible' })
    expect(await exportedFrame.getAttribute('sandbox')).toBe('allow-scripts')
    const origin: unknown = JSON.parse(await offline.locator('#artifact-export-origin-data').textContent() ?? 'null')
    expect(origin).toMatchObject({ exporterVersion: 1, sessionId: parentId, artifactId: source.artifactId, revision: source.revision })
    expect(origin).toHaveProperty('returnedEvidence', returnAddress)
    expect(origin).toHaveProperty('checkpoint', BFS_SELECTED)
    await expectBfsFrameState(exported, BFS_SELECTED)
    expect(await stepColor(exported)).toBe(lockedStepColor)
    const step = exported.getByRole('button', { name: 'Step', exact: true })
    await step.click()
    await expectBfsFrameState(exported, BFS_NEXT)
    await step.press('Enter')
    await expectBfsFrameState(exported, BFS_AFTER_NEXT)
    await offline.screenshot({ path: join(evidence, 'inquiry-returned-bfs-step-d-offline.png') })
    await offline.getByRole('button', { name: 'Reset to locked step', exact: true }).click()
    await restoredStatus.waitFor({ state: 'visible' })
    await expectBfsFrameState(exported, BFS_SELECTED)
    expect(await stepColor(exported)).toBe(lockedStepColor)
    expect(network).toEqual([])
    expect(errors).toEqual([])
    await offline.screenshot({ path: join(evidence, 'inquiry-returned-locked-bfs-offline.png') })
  } finally {
    await offlineContext.close()
    page.off('request', watchExport)
  }
  expect(forbiddenRequests).toEqual([])
  expect(requests).toHaveLength(callsAfterStyle)
  expect(world.ctx.agents.roots().map(agent => agent.id)).toEqual(rootsBeforeExport)
  expect(await readPersistedEvents(world, id)).toEqual(eventsAfterStyle)
  expect(await readPersistedEvents(world, parentId)).toEqual(parentAfter)
  expect(await exactReturn.locator('iframe').count()).toBe(0)
  await expectBfsFields(returnedItem, BFS_SELECTED)

  stage('bfs-continue-online-after-offline-export')
  await openResult()
  expect(await restoredIframe.getAttribute('sandbox')).toBe('allow-scripts')
  expect(await restoredIframe.getAttribute('data-artifact-id')).toBe(source.artifactId)
  expect(await restoredIframe.getAttribute('data-artifact-revision')).toBe(String(source.revision))
  expect(await stepColor(replay)).toBe(lockedStepColor)
  const originalReplayRuntime = await restoredIframe.getAttribute('data-artifact-runtime-id')
  await panel.screenshot({ path: join(evidence, 'bfs-parent-restored-after-reload.png') })
  await replay.getByRole('button', { name: 'Step', exact: true }).click()
  await expectBfsFrameState(replay, BFS_NEXT)
  await panel.screenshot({ path: join(evidence, 'bfs-parent-restored-next-step.png') })
  await expectBfsFields(returnedItem, BFS_SELECTED)
  await toggle.click()
  await restoredIframe.waitFor({ state: 'detached' })
  await toggle.click()
  await expectBfsFrameState(replay, BFS_SELECTED)
  expect(await restoredIframe.getAttribute('data-artifact-runtime-id')).not.toBe(originalReplayRuntime)
  expect(await parent.locator('[data-artifact-frame]').count()).toBe(0)
  await sourceAnswer.locator(`[data-inquiry-branch="${id}"]`).click()
  await selected(id).waitFor({ state: 'visible' })
  await conversation.locator(`[data-chat-message-id="${question.data.id}"]`).getByText(followup, { exact: true }).waitFor({ state: 'visible' })
  await page.locator(`[data-row-key="session:${parentId}"]`).click()
  await selected(parentId).waitFor({ state: 'visible' })
  await openResult()
  expect(await readPersistedEvents(world, id)).toEqual(eventsAfterStyle)
  expect(await readPersistedEvents(world, parentId)).toEqual(parentAfter)
  await writeFile(join(evidence, 'bfs-inquiry-result-acceptance.json'), JSON.stringify({ userAgent, parentId, childId: id, inquiry,
    generationPrompt: initial, defaultCheckpointGuidanceSent: true,
    generatedRevisions: upserts.map(snapshot => snapshot.revision),
    postReturnStyleUpdate: { artifactId: updated.artifactId, lockedRevision: source.revision, updatedRevision: updated.revision,
      lockedStepColor, updatedStepColor: editedStepColor, providerRequests: callsAfterStyle - callsBeforeReturn },
    liveReportedCheckpoints: [BFS_INITIAL, BFS_FIRST, BFS_SELECTED, BFS_NEXT, BFS_AFTER_NEXT],
    returned: { eventSeq: returned.seq, messageId: returned.data.id }, revision: source.revision, locked: BFS_SELECTED, executed: BFS_NEXT,
    returnedBfsExport: { filename: exportFilename, ...exportRequest, artifactId: source.artifactId, revision: source.revision,
      exporterVersion: 1, offlineSteps: [BFS_SELECTED, BFS_NEXT, BFS_AFTER_NEXT, BFS_SELECTED],
      stepColor: lockedStepColor, restoredAfterReset: true, sessionLogsUnchanged: true, branchesUnchanged: true,
      providerRequests: 0, offlineRequests: 0, forbiddenRequests },
    focusedExactResultBeforeAndAfterRefresh: true, reopenedSameChild: true, extraProviderRequestsDuringInquiryNavigation: 0 }, null, 2) + '\n')

  stage('bfs-parent-review-and-followup')
  await replay.getByRole('button', { name: 'Step', exact: true }).click()
  await expectBfsFrameState(replay, BFS_NEXT)
  await panel.locator('[data-artifact-bfs-followup]').click()
  const parentReview = panel.locator('[data-artifact-bfs-review]')
  await expectBfsFields(parentReview, BFS_NEXT)
  await parentReview.getByRole('button', { name: 'Attach readings', exact: true }).click()
  const chip = parent.locator('[data-artifact-prompt-context="branch-bfs-checkpoint"]')
  await expectBfsFields(chip, BFS_NEXT)
  expect(await chip.locator('[data-artifact-question-download]').count()).toBe(0)
  await scrollIntoView(chip)
  await chip.screenshot({ path: join(evidence, 'bfs-parent-confirmed-followup.png') })
  await replay.getByRole('button', { name: 'Step', exact: true }).click()
  await expectBfsFrameState(replay, BFS_AFTER_NEXT)
  await expectBfsFields(chip, BFS_NEXT)
  await expectBfsFields(returnedItem, BFS_SELECTED)
  expect(await readPersistedEvents(world, parentId)).toEqual(parentAfter)
  expect(requests).toHaveLength(callsAfterStyle)
  await ask(parentFollowup, parentId)
  const parentWithQuestion = await readPersistedEvents(world, parentId)
  expect(parentWithQuestion.slice(0, parentAfter.length)).toEqual(parentAfter)
  expect(parentWithQuestion.filter(event => event.type === 'artifact/upsert')).toEqual([])
  expect(parentWithQuestion.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])).toEqual(['completed', 'completed'])
  const newQuestion = parentWithQuestion.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (newQuestion?.type !== 'user/message') throw new Error('The sent parent BFS question is missing')
  const continuedAttachment = newQuestion.data.content[1]
  if (continuedAttachment?.type !== 'text') throw new Error('The ordinary parent question lost its new BFS checkpoint')
  expect(continuedAttachment.text).toContain('Use facts.state for the selected current node, queue and visited nodes.')
  expect(JSON.parse(continuedAttachment.text.slice(continuedAttachment.text.indexOf('\n') + 1))).toEqual({
    kind: 'artifact-question-context', sessionId: parentId, facts: {
      kind: 'branch-bfs-checkpoint', branchResult: { eventSeq: returned.seq, messageId: returned.data.id,
        branchSessionId: id, resultSeq: reply.seq, questionSeq: question.seq }, artifact: source,
      attribution: 'program-reported', state: BFS_NEXT,
    },
  })
  expect(providerSaw(parentFollowup, continuedAttachment.text)).toBe(true)
  const parentReply = parentWithQuestion.findLast(event => event.type === 'assistant/message')
  if (parentReply?.type !== 'assistant/message') throw new Error('The model did not answer the parent BFS follow-up')
  const parentAnswer = parentReply.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ')
  await parent.locator(`[data-chat-turn="${parentReply.data.turn}"][data-chat-group-part="response"]:visible`).last()
    .screenshot({ path: join(evidence, 'bfs-parent-followup-answer.png') })

  stage('bfs-parent-reload-both-checkpoints')
  const callsBeforeSentExport = requests.length
  const afterFollowupWarnings = console.warnings.length
  await page.reload()
  const historical = parent.locator(`[data-chat-flow-kind="user"][data-chat-message-id="${newQuestion.data.id}"]`
    + `[data-chat-message-seq="${newQuestion.seq}"]:visible`)
  await historical.locator('[data-artifact-program-context-origin="branch-bfs-checkpoint"]').waitFor({ state: 'visible' })
  acknowledgeReloadConnectionLoss(console, afterFollowupWarnings)
  expect(await parent.locator('iframe[data-artifact-replay-frame]').count()).toBe(0)

  stage('bfs-download-locked-sent-question-offline')
  const rootsBeforeSentExport = world.ctx.agents.roots().map(agent => agent.id)
  const sentExport = await verifySentBfsDownload({ browser, page, card: historical, directory: evidence, sessionId: parentId,
    question: { eventSeq: newQuestion.seq, messageId: newQuestion.data.id }, returned: { ...returnAddress, file: exportFile },
    artifactId: source.artifactId, revision: source.revision, expectReadouts: expectBfsFrameState,
    expectStyle: async (frame) => { expect(await stepColor(frame)).toBe(lockedStepColor) }, capture: true })
  expect(requests).toHaveLength(callsBeforeSentExport)
  expect(world.ctx.agents.roots().map(agent => agent.id)).toEqual(rootsBeforeSentExport)
  expect(await readPersistedEvents(world, parentId)).toEqual(parentWithQuestion)
  expect(await readPersistedEvents(world, id)).toEqual(eventsAfterStyle)
  expect(await parent.locator('iframe[data-artifact-replay-frame]').count()).toBe(0)
  await writeFile(join(evidence, 'bfs-sent-question-export-acceptance.json'), JSON.stringify({ userAgent, agentPreset: 'chat',
    sentBfsExport: { ...sentExport, stepColor: lockedStepColor, providerRequests: 0, branchesUnchanged: true, sessionLogsUnchanged: true },
    returnedBfsExport: { filename: exportFilename, ...returnAddress, checkpoint: BFS_SELECTED } }, null, 2) + '\n')

  stage('bfs-continue-sent-question-and-return-independently')
  await toggle.click()
  await expectBfsFrameState(replay, BFS_SELECTED)
  await historical.locator('[data-artifact-bfs-replay-toggle]').click()
  const questionPanel = historical.locator('[data-artifact-bfs-replay]')
  const questionIframe = questionPanel.locator('[data-artifact-restoration="restored"] iframe[data-artifact-replay-frame]')
  await questionIframe.waitFor({ state: 'visible' })
  expect(await questionIframe.getAttribute('sandbox')).toBe('allow-scripts')
  expect(await questionIframe.getAttribute('data-artifact-id')).toBe(source.artifactId)
  expect(await questionIframe.getAttribute('data-artifact-revision')).toBe(String(source.revision))
  expect(await questionIframe.getAttribute('data-artifact-runtime-id')).not.toBe(await restoredIframe.getAttribute('data-artifact-runtime-id'))
  const questionReplay = questionIframe.contentFrame()
  await expectBfsFrameState(questionReplay, BFS_NEXT)
  await questionPanel.screenshot({ path: join(evidence, 'bfs-new-question-restored-after-reload.png') })
  await replay.getByRole('button', { name: 'Step', exact: true }).click()
  await expectBfsFrameState(replay, BFS_NEXT)
  const questionStep = questionReplay.getByRole('button', { name: 'Step', exact: true })
  await questionStep.focus()
  await expect.poll(() => questionStep.evaluate(element => element.ownerDocument.activeElement === element)).toBe(true)
  await questionStep.press('Enter')
  await expectBfsFrameState(questionReplay, BFS_AFTER_NEXT)
  await expectBfsFrameState(replay, BFS_NEXT)
  await questionPanel.screenshot({ path: join(evidence, 'bfs-new-question-next-step.png') })
  expect(await readPersistedEvents(world, id)).toEqual(eventsAfterStyle)
  expect(await readPersistedEvents(world, parentId)).toEqual(parentWithQuestion)
  expect(console.warnings).toEqual([])
  expect(answer).toMatch(/\bB\b/u)
  expect(answer).toMatch(/\bC\b[^\n]*\bD\b[^\n]*\bE\b/u)
  expect(answer).toMatch(/\bA\b[^\n]*\bB\b/u)
  expect(parentAnswer).toMatch(/\bC\b/u)
  expect(parentAnswer).toMatch(/\bD\b[^\n]*\bE\b[^\n]*\bF\b/u)
  expect(parentAnswer).toMatch(/\bA\b[^\n]*\bB\b[^\n]*\bC\b/u)
}

describe.skipIf(!LIVE)('web live: default Agent experiment selection', () => {
  it('requires the explicit real-provider mode and a credential', () => {
    expect(MODE, 'Live Artifact acceptance requires AGENTRANS_SNAPSHOT=record').toBe('record')
    expect(HAS_KEY, 'Live Artifact acceptance requires DEEPSEEK_API_KEY').toBe(true)
  })

  for (const kind of ['function-plot', 'particle-system'] as const) {
    it.skipIf(!HAS_KEY || MODE !== 'record')(`offers and revises a ${kind} without tool directions`, async test =>
      runLiveCase(test, kind, live => exerciseExperiment(kind, live)), 360_000)
  }

  it.skipIf(!HAS_KEY || MODE !== 'record')('answers a sufficient text question directly', async test =>
    runLiveCase(test, 'text', async ({ page, world, evidence, ask, stage }) => {
      stage('direct-answer')
      const sessionId = await ask('What is the derivative of x^3 at x = 2, and why?')
      const stored = await readPersistedEvents(world, sessionId)
      expect(stored.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])).toEqual(['completed'])
      expect(stored.filter(event => event.type === 'tool/call' || event.type === 'artifact/upsert')).toEqual([])
      const answer = stored.flatMap(event => event.type === 'assistant/message' ? event.data.message.content : [])
        .flatMap(block => block.type === 'text' ? [block.text] : []).join(' ')
      expect(answer).toMatch(/\b12\b/)
      const reply = page.locator('[data-chat-turn="1"][data-chat-group-part="response"]:visible').last()
      await expect.poll(() => reply.innerText({ timeout: 2_500 })).toMatch(/\b12\b/)
      expect(await page.getByRole('complementary', { name: /^Artifact:/ }).count()).toBe(0)
      await page.screenshot({ path: join(evidence, 'answer.png'), fullPage: true })
    }), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('answers a parent question from selected returned branch evidence', async test =>
    runLiveCase(test, 'branch-evidence-question', exerciseBranchQuestion), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('opens an inquiry from selected answer text and returns exact experiment evidence', async test =>
    runLiveCase(test, 'selected-answer-inquiry', exerciseSelectedAnswerInquiry), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('exports the locked function plot from a continued inquiry', async test =>
    runLiveCase(test, 'locked-plot-export', live => exerciseSelectedAnswerInquiry(live, true)), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('continues a returned particle experiment with one gravity change', async test =>
    runLiveCase(test, 'continued-particle', exerciseContinuedParticle), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('returns and continues a generated BFS stepper in the parent conversation', async test =>
    runLiveCase(test, 'returned-bfs-checkpoint', exerciseGeneratedBfs), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('returns and continues a generated half-adder in the parent conversation', async test =>
    runLiveCase(test, 'returned-half-adder-checkpoint', live => exerciseHalfAdderJourney({ ...live,
      requestCount: () => live.requests.length,
      inquiry: {
        evidence: live.evidence,
        selectPhrase: (source, phrase) => selectAnswerPhrase(live.page, source, phrase),
        verifyCreationRequest: (prompt) => {
          expect(live.providerUserText(prompt)).toEqual([prompt])
          const description = live.providerToolDescription('artifact')
          expect(description).toContain('returns {kind:"half-adder-checkpoint",a,b,sum:a^b,carry:a&b}')
          expect(description).toContain('state:readCheckpoint')
          expect(description).toContain('After every A or B change, update the displayed outputs and call window.artifactRuntime.reportState(readCheckpoint()).')
        },
      },
      capture: async (target, name) => { await target.screenshot({ path: join(live.evidence, `${name}.png`) }) },
    })), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('uses the bundled design skill to generate a double-slit experiment', async test =>
    runLiveCase(test, 'double-slit-design-skill', exerciseDoubleSlit, 300_000), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('groups a CSV in Chat mode and exports the exact returned chart revision', async test =>
    runLiveCase(test, 'no-shell-csv', live => exerciseCsvJourney({ ...live, requestCount: () => live.requests.length }), 180_000), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('opens returned CSV readings from the original inquiry answer', async test =>
    runLiveCase(test, 'csv-inquiry-result', live => exerciseCsvInquiryResult({ ...live, requestCount: () => live.requests.length },
      (source, phrase) => selectAnswerPhrase(live.page, source, phrase)), 180_000), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('chooses between two CSV results returned by the same inquiry', async test =>
    runLiveCase(test, 'csv-inquiry-result-choice', live => exerciseCsvInquiryResultChoice({ ...live, requestCount: () => live.requests.length },
      (source, phrase) => selectAnswerPhrase(live.page, source, phrase)), 180_000), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('sends the locked CSV return comparison after browsing another pair', async test =>
    runLiveCase(test, 'csv-inquiry-comparison-send', live => exerciseAttachedCsvInquiryReturns({ ...live, requestCount: () => live.requests.length },
      (source, phrase) => selectAnswerPhrase(live.page, source, phrase)), 180_000), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('sends the same unsent CSV return comparison after visiting both sources', async test =>
    runLiveCase(test, 'csv-inquiry-return-draft-send', exerciseCsvReturnDraftSend, 180_000), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('continues returned CSV analysis in the parent conversation', async test =>
    runLiveCase(test, 'continued-csv', live => exerciseContinuedCsvJourney({ ...live, requestCount: () => live.requests.length }), 180_000), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('checks participating rows and locks a filtered CSV reading', async test =>
    runLiveCase(test, 'filtered-csv', live => exerciseContinuedCsvJourney({ ...live, requestCount: () => live.requests.length }, true), 180_000), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('transfers a saved CSV comparison through JSON into a new Chat', async test =>
    runLiveCase(test, 'portable-csv', exercisePortableCsvComparison, 180_000), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('transfers a saved CSV return comparison with both originals through JSON', async test =>
    runLiveCase(test, 'portable-csv-returns', exercisePortableCsvReturns, 180_000), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('reuses a whole imported CSV return comparison in a new question', async test =>
    runLiveCase(test, 'reuse-imported-csv-returns', exerciseReusedImportedCsvReturns, 180_000), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('sends an imported CSV return comparison after tracing and restoring its draft sources', async test =>
    runLiveCase(test, 'imported-csv-return-draft-chain', exerciseImportedCsvReturnDraftChain, 180_000), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('explains changed CSV calculation methods and contributing records', async test =>
    runLiveCase(test, 'csv-comparison-changes', exerciseCsvComparisonChanges, 180_000), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('explains two native CSV comparisons in calculation order', async test =>
    runLiveCase(test, 'csv-comparison-explanation', exerciseCsvComparisonExplanation, 180_000), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('transfers a saved two-step CSV explanation through JSON into a new Chat', async test =>
    runLiveCase(test, 'portable-csv-explanation', exercisePortableCsvExplanation, 180_000), 360_000)

  it.skipIf(!HAS_KEY || MODE !== 'record')('reuses a whole imported CSV explanation in a new question', async test =>
    runLiveCase(test, 'reuse-imported-csv-explanation', exerciseReusedImportedCsvExplanation, 180_000), 360_000)
})
