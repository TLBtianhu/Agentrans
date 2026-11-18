// @vitest-environment node
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser, type FrameLocator, type Page, type Request } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest'
import { brandString } from '@agentrans/brand'
import type { ArtifactId } from '@agentrans/artifact/types'
import { ToolCallId } from '@agentrans/llm'
import type { ReplayEntry } from '@agentrans/llm-replay'
import { verifySentBfsDownload } from './artifact-bfs-download-support.ts'
import { exerciseHalfAdderJourney, HALF_ADDER_PROMPTS } from './artifact-half-adder-support.ts'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, fixtureUserPrompts, launchWebScaffold,
  readPersistedEvents, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, expandOwningTurnProcess, scrollIntoView } from './support.ts'

const DIR = fileURLToPath(new URL('./fixtures/replay/artifact-program-question', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const PARENT_SEED = fileURLToPath(new URL('./fixtures/replay/branch-result/session.v4.jsonl', import.meta.url))

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
    const executablePath = process.env.AGENTRANS_PLAYWRIGHT_EXECUTABLE_PATH
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
    const advanceAgain = frame().locator('#advance')
    await scrollIntoView(advanceAgain)
    await advanceAgain.click()
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

const BFS_STEPPER_SOURCE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>BFS stepper</title><style>#step { background-color: #1e40af; }</style></head>
<body>
  <button type="button" id="step">Step</button>
  <dl>
    <dt>Current node</dt><dd id="current"></dd>
    <dt>Queue</dt><dd id="queue"></dd>
    <dt>Visited</dt><dd id="visited"></dd>
  </dl>
  <script>
    const graph = { A: ['B', 'C'], B: ['D', 'E'], C: ['F'], D: [], E: [], F: [] };
    let state = { kind: 'bfs-checkpoint', current: null, queue: ['A'], visited: [] };
    function render() {
      document.getElementById('current').textContent = state.current ?? '';
      document.getElementById('queue').textContent = state.queue.join(', ');
      document.getElementById('visited').textContent = state.visited.join(', ');
    }
    document.getElementById('step').addEventListener('click', () => {
      const current = state.queue.shift();
      if (current === undefined) return;
      state.current = current;
      state.visited.push(current);
      for (const node of graph[current]) {
        if (!state.queue.includes(node) && !state.visited.includes(node)) state.queue.push(node);
      }
      render();
      window.artifactRuntime.reportState(state);
    });
    render();
    window.artifactRuntime.ready({ state: () => state, restore: {
      kind: 'bfs-checkpoint', apply: checkpoint => { state = checkpoint; render(); },
    } });
  </script>
</body>
</html>`

const BFS_CURRENT_SOURCE = BFS_STEPPER_SOURCE.replace("current: null, queue: ['A']", "current: null, queue: ['E']")
  .replace("C: ['F'], D: [], E: [], F: []", 'C: [], D: [], E: [], F: []')
const BFS_RESTYLED_SOURCE = BFS_CURRENT_SOURCE.replace('#1e40af', '#ad279a')
const BFS_ORIGINAL_STYLE = 'rgb(30, 64, 175)'
const BFS_RESTYLED_STYLE = 'rgb(173, 39, 154)'
const BFS_QUESTION = 'Which node is current in the checkpoint I attached?'
const BFS_REPLY = 'The confirmed checkpoint has current node '
const BFS_CONCLUSION = `${BFS_REPLY}B.`
const PARENT_BFS_QUESTION = 'Which node is current in the new BFS checkpoint I attached?'
const PARENT_BFS_REPLY = 'The new checkpoint has current node '
const INITIAL_PARENT_PROMPT = 'What does FIFO mean?'
const INITIAL_BFS_PROMPT = 'Create an interactive BFS stepper with a restorable checkpoint.'
const BFS_STYLE_PROMPT = 'Change the current BFS stepper so the Step button has a purple background.'

function textReplay(text: string): Extract<ReplayEntry, { kind: 'chunks' }> {
  return { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] }
}

function bfsReplay(): Extract<ReplayEntry, { kind: 'chunks' }>[] {
  return [createProgramReplay('bfs-stepper', 'BFS stepper', BFS_STEPPER_SOURCE), textReplay('The BFS stepper is ready.'),
    textReplay(BFS_REPLY + '{{fromRequest:"kind":"bfs-checkpoint","current":"([A-F])"}}.'),
    updateProgramReplay('bfs-stepper', 'BFS stepper', BFS_RESTYLED_SOURCE, 2), textReplay('The Step button now has a purple background.')]
}

function createProgramReplay(artifactId: string, title: string, source: string): Extract<ReplayEntry, { kind: 'chunks' }> {
  return programWriteReplay(artifactId, title, source, { action: 'create' })
}

function updateProgramReplay(artifactId: string, title: string, source: string, baseRevision: number): Extract<ReplayEntry, { kind: 'chunks' }> {
  return programWriteReplay(artifactId, title, source, { action: 'update', baseRevision })
}

function programWriteReplay(artifactId: string, title: string, source: string, write: { action: 'create' } | {
  action: 'update'
  baseRevision: number
}): Extract<ReplayEntry, { kind: 'chunks' }> {
  const argumentsText = JSON.stringify({ ...write, artifactId, title, presentation: 'inline', source })
  const tool = { type: 'tool-call', id: ToolCallId(`${write.action}-${artifactId}`), name: 'artifact', arguments: argumentsText } as const
  return { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: tool.id, name: tool.name, argumentsDelta: argumentsText },
    { type: 'block-end', index: 0, block: tool },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ] }
}

function childProgramReplay(parentLog: string, scripts: Extract<ReplayEntry, { kind: 'chunks' }>[],
  prompts: readonly string[]): string {
  const model = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const header = { type: 'session', version: 4, id: '{{session:2}}', createdAt: 1_793_653_000_001, cwd: '{{cwd}}',
    isSeeded: true, parentSession: '{{session:1}}', delegationDepth: 0, agentPreset: 'standard' }
  const boundary = { type: 'session/end-seed', data: { inherited: true } }
  let nextTurn = 2
  let nextStep = 1
  const events = scripts.flatMap(({ chunks }, index) => {
    const turn = nextTurn
    const step = nextStep
    const prompt = prompts[turn - 2]
    if (prompt === undefined) throw new Error(`Missing the replay prompt for turn ${turn}`)
    const moreSteps = chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'tool-calls')
    if (moreSteps) nextStep += 1
    else {
      nextTurn += 1
      nextStep = 1
    }
    const blocks = chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
    const toolEvents = blocks.flatMap(block => block.type !== 'tool-call' ? [] : [
      { type: 'tool/call', data: { turn, step, callId: block.id, name: block.name, arguments: block.arguments } },
      { type: 'tool/result', surfaceOp: 'append', data: { turn, step, message: { role: 'tool', id: `{{message:program-tool-result-${block.id}}}`,
        source: { kind: 'tool', callId: block.id }, toolCallId: block.id, isError: false, content: [{ type: 'text', text: 'HTML source saved' }] } } },
    ])
    return [
      ...step === 1 ? [{ type: 'user/message', surfaceOp: 'append', data: { role: 'user', id: `{{message:bfs-question-${turn}}}`,
        source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] } }, { type: 'turn/start', data: { turn } }] : [],
      { type: 'step/start', data: { turn, step } },
      { type: 'request/header', data: { header: { config: model }, reason: 'series' } },
      { type: 'assistant/message', surfaceOp: 'append', data: { turn, step,
        stream: chunks.map((chunk, part) => ({ type: 'chunk', time: 1_793_653_001_000 + index * 10 + part, chunk })),
        message: { role: 'assistant', id: `{{message:bfs-answer-${index}}}`, source: { kind: 'model', ...model }, content: blocks } } },
      ...toolEvents,
      { type: 'step/end', data: { turn, step } },
      ...moreSteps ? [] : [{ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }],
    ]
  })
  const inherited = parentLog.trimEnd().split(/\r?\n/u).slice(1)
  return [JSON.stringify(header), ...inherited, ...[boundary, ...events].map(event => JSON.stringify(event))].join('\n') + '\n'
}

async function launchProgramReplay(test: TestContext, parent: readonly ReplayEntry[],
  child: Extract<ReplayEntry, { kind: 'chunks' }>[], prompts: readonly string[]): Promise<WebScaffold> {
  const directory = await mkdtemp(join(tmpdir(), 'agentrans-program-replay-'))
  const replayOverride = join(directory, 'replay.override.json')
  const parentFixture = join(directory, 'session.v4.jsonl')
  const childFixture = join(directory, 'session.1.v4.jsonl')
  const parentLog = await readFile(PARENT_SEED, 'utf8')
  await Promise.all([writeFile(replayOverride, JSON.stringify(parent)), writeFile(parentFixture, parentLog),
    writeFile(childFixture, childProgramReplay(parentLog, child, prompts))])
  test.onTestFinished(async () => {
    await Promise.all([unlink(replayOverride), unlink(parentFixture), unlink(childFixture)])
    await rmdir(directory)
  })
  const scaffold = await launchWebScaffold({ replayFixture: parentFixture, replayOverride,
    replayChildFixtures: [childFixture], compareReplaySession: false })
  test.onTestFinished(() => scaffold.close())
  return scaffold
}

async function expectBfsReadouts(frame: FrameLocator, current: string, queue: string, visited: string): Promise<void> {
  await expect.poll(() => frame.locator('#current').textContent({ timeout: 5_000 })).toBe(current)
  expect(await frame.locator('#queue').textContent()).toBe(queue)
  expect(await frame.locator('#visited').textContent()).toBe(visited)
}

function bfsStepBackground(frame: FrameLocator): Promise<string> {
  return frame.locator('#step').evaluate(button => getComputedStyle(button).backgroundColor)
}

async function expectBfsExportBlocksNetwork(browser: Browser, file: string): Promise<void> {
  const connectedContext = await browser.newContext()
  try {
    const connected = await connectedContext.newPage()
    const sentinel = 'http://127.0.0.1:9/bfs-egress-probe'
    const attemptedNetwork: string[] = []
    await connectedContext.route(url => url.href.startsWith(sentinel), async (route) => {
      attemptedNetwork.push(route.request().url())
      await route.abort()
    })
    await connected.goto(pathToFileURL(file).href)
    await connected.locator('[data-bfs-export-status="restored"]').waitFor({ state: 'visible' })
    const sandboxBody = connected.frameLocator('iframe[data-exported-bfs-frame]').locator('body')
    const cspBlock = (directive: string) => connected.waitForEvent('console', {
      predicate: message => message.text().includes('127.0.0.1:9') && message.text().includes(directive), timeout: 5000,
    })
    const [, fetchRejected] = await Promise.all([
      cspBlock('connect-src'),
      sandboxBody.evaluate((_, url) => fetch(url).then(() => false, () => true), `${sentinel}/fetch`),
    ])
    expect(fetchRejected).toBe(true)
    await Promise.all([
      cspBlock('frame-src'),
      sandboxBody.evaluate((_, url) => { window.location.assign(url) }, `${sentinel}/navigate`),
    ])
    expect(attemptedNetwork).toEqual([])
  } finally { await connectedContext.close() }
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: confirmed BFS question checkpoint', () => {
  it('returns and continues a BFS step, then reopens both locked parent checkpoints', async (test) => {
    const parentReplay = [textReplay('FIFO means first in, first out.'),
      textReplay(PARENT_BFS_REPLY + '{{fromRequest:"kind":"branch-bfs-checkpoint"[^\\r\\n]*"current":"([A-F])"}}.')]
    const scaffold = await launchProgramReplay(test, parentReplay, bfsReplay(), [INITIAL_BFS_PROMPT, BFS_QUESTION, BFS_STYLE_PROMPT])
    const executablePath = process.env.AGENTRANS_PLAYWRIGHT_EXECUTABLE_PATH
    const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    test.onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    const tripwire = watchConsole(page)
    let modelMessages = 0
    const stopCounting = scaffold.ctx.on('session/event', (_session, event) => {
      if (event.type === 'assistant/message' && event.data.message.source.kind === 'model') modelMessages += 1
    }, { global: true })
    test.onTestFinished(() => { stopCounting() })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const send = async (question: string, input = page.locator('[data-composer-input]').first()) => {
      await input.fill(question)
      const settled = scaffold.whenTurnSettled()
      await input.press('Enter')
      return await settled
    }
    const parentId = await send(INITIAL_PARENT_PROMPT)
    const parent = page.locator(`[data-conversation-session="${parentId}"]`)
    await parent.locator('[data-turn-tail="1"]:visible').getByRole('button', {
      name: 'Branch into a new conversation', exact: true,
    }).click()
    const child = () => scaffold.ctx.agents.roots().find(agent => agent.session.header.parentSession === parentId)
    await expect.poll(() => child()?.id).toBeDefined()
    const id = child()!.id
    await page.locator(`[data-row-key="session:${id}"][aria-selected="true"]`).waitFor({ state: 'visible' })
    const conversation = page.locator(`[data-conversation-session="${id}"]`)
    const input = conversation.locator('[data-composer-input][contenteditable="true"]')
    expect(await send(INITIAL_BFS_PROMPT, input)).toBe(id)
    const card = conversation.getByRole('complementary', { name: 'Artifact: BFS stepper', exact: true })
    const live = card.frameLocator('[data-artifact-frame]')
    const step = live.getByRole('button', { name: 'Step', exact: true })
    await expandOwningTurnProcess(page, card)
    await step.click()
    await step.click()
    await expectBfsReadouts(live, 'B', 'C, D, E', 'A, B')
    await card.locator('[data-artifact-prompt-attach="html-runtime"]').click()
    const review = card.locator('[data-artifact-bfs-review]')
    await review.waitFor({ state: 'visible' })
    expect(await review.locator('[data-artifact-bfs-current]').textContent()).toContain('B')
    expect(await review.locator('[data-artifact-bfs-queue]').textContent()).toMatch(/C.*D.*E/u)
    expect(await review.locator('[data-artifact-bfs-visited]').textContent()).toMatch(/A.*B/u)
    await step.click()
    await expectBfsReadouts(live, 'C', 'D, E, F', 'A, B, C')
    await review.getByRole('button', { name: 'Attach readings', exact: true }).click()
    const chip = conversation.locator('[data-artifact-prompt-context="html-bfs"]')
    expect(await chip.locator('[data-artifact-bfs-current]').textContent()).toBe('B')
    const question = BFS_QUESTION
    expect(await send(question, input)).toBe(id)
    await conversation.getByText(BFS_CONCLUSION, { exact: true }).waitFor({ state: 'visible' })
    const events = await readPersistedEvents(scaffold, id)
    const user = events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
    const attached = user?.type === 'user/message' ? user.data.content[1] : undefined
    if (attached?.type !== 'text') throw new Error('The ordinary question lost its BFS checkpoint')
    expect(JSON.parse(attached.text.slice(attached.text.indexOf('\n') + 1))).toMatchObject({
      kind: 'artifact-question-context', sessionId: id, facts: { kind: 'html-runtime', attribution: 'program-reported',
        artifact: { artifactId: 'bfs-stepper', revision: 1 }, capture: { status: 'ready', restore: 'bfs-checkpoint',
          state: { kind: 'bfs-checkpoint', current: 'B', queue: ['C', 'D', 'E'], visited: ['A', 'B'] } } },
    })

    const agent = scaffold.ctx.agents.get(id)
    if (agent === undefined) throw new Error('The BFS session is missing')
    const artifactId = brandString<ArtifactId>('bfs-stepper')
    scaffold.ctx.artifacts.commit(agent, scaffold.ctx.artifacts.prepare(agent, {
      action: 'update', artifactId, baseRevision: 1, title: 'BFS stepper', presentation: 'inline',
      source: BFS_CURRENT_SOURCE,
    }))
    await expect.poll(() => card.getAttribute('data-artifact-revision')).toBe('2')
    await expect.poll(async () => (await readPersistedEvents(scaffold, id)).findLast(event => event.type === 'artifact/upsert')?.data.revision)
      .toBe(2)
    const updatedEvents = await readPersistedEvents(scaffold, id)

    const warningStart = tripwire.warnings.length
    await page.reload()
    const historical = conversation.locator('[data-chat-flow-kind="user"]:visible').filter({ hasText: question })
    const toggle = historical.locator('[data-artifact-bfs-replay-toggle]')
    await toggle.waitFor({ state: 'visible' })
    expect(await historical.locator('[data-artifact-replay-frame]').count()).toBe(0)
    await toggle.click()
    const iframe = historical.locator('[data-artifact-bfs-replay] [data-artifact-restoration="restored"] iframe[data-artifact-replay-frame]')
    await iframe.waitFor({ state: 'visible' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expandOwningTurnProcess(page, card)
    expect(await iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(await iframe.getAttribute('data-artifact-id')).toBe(artifactId)
    expect(await iframe.getAttribute('data-artifact-revision')).toBe('1')
    const restored = iframe.contentFrame()
    await expectBfsReadouts(restored, 'B', 'C, D, E', 'A, B')
    await restored.getByRole('button', { name: 'Step', exact: true }).click()
    await expectBfsReadouts(restored, 'C', 'D, E, F', 'A, B, C')
    await expectBfsReadouts(live, '', 'E', '')
    await toggle.click()
    await iframe.waitFor({ state: 'detached' })
    await toggle.click()
    await expectBfsReadouts(restored, 'B', 'C, D, E', 'A, B')
    expect(await readPersistedEvents(scaffold, id)).toEqual(updatedEvents)

    const parentBefore = await readPersistedEvents(scaffold, parentId)
    expect(parentBefore.filter(event => event.type === 'artifact/upsert')).toEqual([])
    const conclusion = updatedEvents.findLast(event => event.type === 'assistant/message')
    if (conclusion?.type !== 'assistant/message') throw new Error('The branch BFS conclusion is missing')
    const action = conversation.locator(`[data-branch-result-seq="${conclusion.seq}"]:visible`)
    await action.getByRole('button', { name: 'Return with evidence', exact: true }).click()
    const preview = action.locator('[data-branch-question-preview]')
    expect(await preview.textContent()).toContain('revision 1')
    expect(await preview.locator('[data-artifact-bfs-current]').textContent()).toBe('B')
    expect(await preview.locator('[data-artifact-bfs-queue]').textContent()).toBe('C, D, E')
    expect(await preview.locator('[data-artifact-bfs-visited]').textContent()).toBe('A, B')
    expect(await readPersistedEvents(scaffold, parentId)).toEqual(parentBefore)
    await action.getByRole('button', { name: 'Confirm return with evidence', exact: true }).click()
    const returned = parent.locator('[data-artifact-branch-evidence]:visible')
    await returned.getByText(BFS_CONCLUSION, { exact: true }).waitFor({ state: 'visible' })
    await expect.poll(async () => (await readPersistedEvents(scaffold, parentId)).length).toBe(parentBefore.length + 1)
    const parentAfter = await readPersistedEvents(scaffold, parentId)
    expect(parentAfter.slice(0, -1)).toEqual(parentBefore)
    const notice = parentAfter.at(-1)
    if (notice?.type !== 'user/message') throw new Error('The returned BFS checkpoint is missing from the saved Session')
    expect(notice).toMatchObject({ type: 'user/message', data: { source: { kind: 'branch-result', artifactEvidence: 'bfs-checkpoint',
      branchSessionId: id, resultSeq: conclusion.seq } } })
    const returnAddress = { eventSeq: notice.seq, messageId: notice.data.id }
    const exactReturn = returned.and(page.locator(`[data-chat-message-id="${notice.data.id}"][data-chat-message-seq="${notice.seq}"]`))

    const childRow = page.locator(`[data-row-key="session:${id}"]`)
    await childRow.click()
    await childRow.and(page.locator('[aria-selected="true"]')).waitFor({ state: 'visible' })
    expect(await send(BFS_STYLE_PROMPT, input)).toBe(id)
    const eventsAfterStyle = await readPersistedEvents(scaffold, id)
    expect(eventsAfterStyle.slice(0, updatedEvents.length)).toEqual(updatedEvents)
    expect(eventsAfterStyle.slice(updatedEvents.length).filter(event => event.type === 'artifact/upsert')).toMatchObject([
      { data: { artifactId, revision: 3, source: BFS_RESTYLED_SOURCE } },
    ])
    const styledCard = card.and(page.locator('[data-artifact-revision="3"]'))
    await expandOwningTurnProcess(page, styledCard)
    const styledFrame = styledCard.frameLocator('[data-artifact-frame]')
    await expectBfsReadouts(styledFrame, '', 'E', '')
    expect(await bfsStepBackground(styledFrame)).toBe(BFS_RESTYLED_STYLE)
    expect(await readPersistedEvents(scaffold, parentId)).toEqual(parentAfter)
    const parentRow = page.locator(`[data-row-key="session:${parentId}"]`)
    await parentRow.click()
    await parentRow.and(page.locator('[aria-selected="true"]')).waitFor({ state: 'visible' })

    const warningsBeforeReturnReload = tripwire.warnings.length
    await page.reload()
    await exactReturn.waitFor({ state: 'visible' })
    expect(await exactReturn.locator('[data-artifact-replay-frame]').count()).toBe(0)
    acknowledgeReloadConnectionLoss(tripwire, warningsBeforeReturnReload)

    const rootsBeforeExport = scaffold.ctx.agents.roots().map(agent => agent.id)
    const unrelatedRequests: string[] = []
    const watchedPaths = ['/api/session/prompt', '/api/session/fork', '/api/artifactExports/create', '/api/artifactExports/read']
    const watchExport = (request: Request): void => {
      const path = new URL(request.url()).pathname
      if (watchedPaths.includes(path)) unrelatedRequests.push(path)
    }
    page.on('request', watchExport)
    const [download, response] = await Promise.all([
      page.waitForEvent('download'),
      page.waitForResponse(receipt => new URL(receipt.url()).pathname === '/api/artifactBranchResults/exportReturnedBfs'),
      exactReturn.getByRole('button', { name: 'Download experiment HTML', exact: true })
        .and(exactReturn.locator('[data-artifact-branch-download]')).click(),
    ])
    expect(response.ok()).toBe(true)
    expect(response.request().postDataJSON()).toHaveProperty('payload.args.request', { sessionId: parentId, ...returnAddress })
    const exportFile = join(scaffold.workspaceCwd, 'locked-returned-bfs.html')
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
      const frame = offline.locator('iframe[data-exported-bfs-frame]')
      const exported = frame.contentFrame()
      const restored = offline.locator('[data-bfs-export-status="restored"]')
      await restored.waitFor({ state: 'visible' })
      expect(await frame.getAttribute('sandbox')).toBe('allow-scripts')
      const origin: unknown = JSON.parse(await offline.locator('#artifact-export-origin-data').textContent() ?? 'null')
      expect(origin).toMatchObject({ exporterVersion: 1, sessionId: parentId, artifactId, revision: 1 })
      expect(origin).toHaveProperty('returnedEvidence', returnAddress)
      expect(origin).toHaveProperty('checkpoint', { kind: 'bfs-checkpoint', current: 'B', queue: ['C', 'D', 'E'], visited: ['A', 'B'] })
      await expectBfsReadouts(exported, 'B', 'C, D, E', 'A, B')
      expect(await bfsStepBackground(exported)).toBe(BFS_ORIGINAL_STYLE)
      const exportedStep = exported.getByRole('button', { name: 'Step', exact: true })
      await exportedStep.click()
      await expectBfsReadouts(exported, 'C', 'D, E, F', 'A, B, C')
      await exportedStep.press('Enter')
      await expectBfsReadouts(exported, 'D', 'E, F', 'A, B, C, D')
      await offline.getByRole('button', { name: 'Reset to locked step', exact: true }).click()
      await restored.waitFor({ state: 'visible' })
      await expectBfsReadouts(exported, 'B', 'C, D, E', 'A, B')
      expect(await bfsStepBackground(exported)).toBe(BFS_ORIGINAL_STYLE)
      expect(network).toEqual([])
      expect(errors).toEqual([])
    } finally {
      await offlineContext.close()
      page.off('request', watchExport)
    }
    expect(unrelatedRequests).toEqual([])
    expect(scaffold.ctx.agents.roots().map(agent => agent.id)).toEqual(rootsBeforeExport)
    expect(await readPersistedEvents(scaffold, parentId)).toEqual(parentAfter)
    expect(await readPersistedEvents(scaffold, id)).toEqual(eventsAfterStyle)
    expect(await exactReturn.locator('[data-artifact-replay-frame]').count()).toBe(0)
    await exactReturn.locator('[data-artifact-bfs-replay-toggle]').click()
    const parentIframe = exactReturn.locator('[data-artifact-restoration="restored"] iframe[data-artifact-replay-frame]')
    await parentIframe.waitFor({ state: 'visible' })
    expect(await parentIframe.getAttribute('data-artifact-revision')).toBe('1')
    const restoredInParent = parentIframe.contentFrame()
    await expectBfsReadouts(restoredInParent, 'B', 'C, D, E', 'A, B')
    expect(await bfsStepBackground(restoredInParent)).toBe(BFS_ORIGINAL_STYLE)
    await expectBfsExportBlocksNetwork(browser, exportFile)

    await restoredInParent.getByRole('button', { name: 'Step', exact: true }).click()
    await expectBfsReadouts(restoredInParent, 'C', 'D, E, F', 'A, B, C')
    await returned.locator('[data-artifact-bfs-followup]').click()
    const parentReview = returned.locator('[data-artifact-bfs-review]')
    expect(await parentReview.locator('[data-artifact-bfs-current]').textContent()).toBe('C')
    expect(await parentReview.locator('[data-artifact-bfs-queue]').textContent()).toBe('D, E, F')
    expect(await parentReview.locator('[data-artifact-bfs-visited]').textContent()).toBe('A, B, C')
    await restoredInParent.getByRole('button', { name: 'Step', exact: true }).click()
    await expectBfsReadouts(restoredInParent, 'D', 'E, F', 'A, B, C, D')
    await parentReview.getByRole('button', { name: 'Attach readings', exact: true }).click()
    const parentChip = parent.locator('[data-artifact-prompt-context="branch-bfs-checkpoint"]')
    expect(await parentChip.locator('[data-artifact-bfs-current]').textContent()).toBe('C')
    expect(await parentChip.locator('[data-artifact-bfs-queue]').textContent()).toBe('D, E, F')
    expect(await parentChip.locator('[data-artifact-bfs-visited]').textContent()).toBe('A, B, C')
    expect(await parentChip.locator('[data-artifact-question-download]').count()).toBe(0)
    expect(await readPersistedEvents(scaffold, parentId)).toEqual(parentAfter)
    expect(await send(PARENT_BFS_QUESTION, parent.locator('[data-composer-input][contenteditable="true"]'))).toBe(parentId)
    await parent.getByText(`${PARENT_BFS_REPLY}C.`, { exact: true }).waitFor({ state: 'visible' })
    const parentWithQuestion = await readPersistedEvents(scaffold, parentId)
    expect(parentWithQuestion.slice(0, parentAfter.length)).toEqual(parentAfter)
    const parentQuestion = parentWithQuestion.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
    if (parentQuestion?.type !== 'user/message') throw new Error('The sent parent BFS question is missing')
    const parentAttachment = parentQuestion.data.content[1]
    if (parentAttachment?.type !== 'text') throw new Error('The parent question lost the BFS checkpoint')
    expect(JSON.parse(parentAttachment.text.slice(parentAttachment.text.indexOf('\n') + 1))).toMatchObject({
      kind: 'artifact-question-context', sessionId: parentId, facts: { kind: 'branch-bfs-checkpoint', attribution: 'program-reported',
        branchResult: { eventSeq: notice.seq, messageId: notice.data.id,
          branchSessionId: id, resultSeq: conclusion.seq, questionSeq: user?.seq },
        artifact: { artifactId, revision: 1, source: BFS_STEPPER_SOURCE },
        state: { kind: 'bfs-checkpoint', current: 'C', queue: ['D', 'E', 'F'], visited: ['A', 'B', 'C'] } },
    })
    const warningsBeforeNewReload = tripwire.warnings.length
    const modelMessagesBeforeSentExport = modelMessages
    await page.reload()
    const derived = parent.locator(`[data-chat-flow-kind="user"][data-chat-message-id="${parentQuestion.data.id}"]`
      + `[data-chat-message-seq="${parentQuestion.seq}"]:visible`)
    await derived.locator('[data-artifact-program-context-origin="branch-bfs-checkpoint"]').waitFor({ state: 'visible' })
    acknowledgeReloadConnectionLoss(tripwire, warningsBeforeNewReload)
    expect(await parent.locator('iframe[data-artifact-replay-frame]').count()).toBe(0)
    const rootsBeforeSentExport = scaffold.ctx.agents.roots().map(agent => agent.id)
    await verifySentBfsDownload({ browser, page, card: derived, directory: scaffold.workspaceCwd, sessionId: parentId,
      question: { eventSeq: parentQuestion.seq, messageId: parentQuestion.data.id }, returned: { ...returnAddress, file: exportFile },
      artifactId, revision: 1,
      expectReadouts: (frame, checkpoint) => expectBfsReadouts(frame, checkpoint.current, checkpoint.queue.join(', '), checkpoint.visited.join(', ')),
      expectStyle: async (frame) => { expect(await bfsStepBackground(frame)).toBe(BFS_ORIGINAL_STYLE) } })
    expect(modelMessages).toBe(modelMessagesBeforeSentExport)
    expect(scaffold.ctx.agents.roots().map(agent => agent.id)).toEqual(rootsBeforeSentExport)
    expect(await readPersistedEvents(scaffold, parentId)).toEqual(parentWithQuestion)
    expect(await readPersistedEvents(scaffold, id)).toEqual(eventsAfterStyle)
    expect(await parent.locator('iframe[data-artifact-replay-frame]').count()).toBe(0)
    await returned.locator('[data-artifact-bfs-replay-toggle]').click()
    await expectBfsReadouts(restoredInParent, 'B', 'C, D, E', 'A, B')
    await derived.locator('[data-artifact-bfs-replay-toggle]').click()
    const derivedIframe = derived.locator('[data-artifact-restoration="restored"] iframe[data-artifact-replay-frame]')
    expect(await derivedIframe.getAttribute('data-artifact-runtime-id')).not.toBe(await parentIframe.getAttribute('data-artifact-runtime-id'))
    const derivedReplay = derivedIframe.contentFrame()
    await expectBfsReadouts(derivedReplay, 'C', 'D, E, F', 'A, B, C')
    await derivedReplay.getByRole('button', { name: 'Step', exact: true }).click()
    await expectBfsReadouts(derivedReplay, 'D', 'E, F', 'A, B, C, D')
    await expectBfsReadouts(restoredInParent, 'B', 'C, D, E', 'A, B')
    expect(await readPersistedEvents(scaffold, parentId)).toEqual(parentWithQuestion)
    expect(await readPersistedEvents(scaffold, id)).toEqual(eventsAfterStyle)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})

const HALF_ADDER_SOURCE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Half-adder</title></head>
<body>
  <label>A <input id="a" type="checkbox" aria-label="Input A"></label>
  <label>B <input id="b" type="checkbox" aria-label="Input B"></label>
  <output id="sum" aria-label="Sum"></output>
  <output id="carry" aria-label="Carry"></output>
  <script>
    const a = document.getElementById('a');
    const b = document.getElementById('b');
    const sum = document.getElementById('sum');
    const carry = document.getElementById('carry');
    function snapshot() {
      const left = Number(a.checked);
      const right = Number(b.checked);
      return { kind: 'half-adder-checkpoint', a: left, b: right, sum: left ^ right, carry: left & right };
    }
    function render() {
      const state = snapshot();
      sum.value = String(state.sum);
      carry.value = String(state.carry);
      return state;
    }
    function report() { window.artifactRuntime.reportState(render()); }
    a.addEventListener('change', report);
    b.addEventListener('change', report);
    render();
    window.artifactRuntime.ready({ state: snapshot, restore: { kind: 'half-adder-checkpoint', apply: checkpoint => {
      a.checked = checkpoint.a === 1;
      b.checked = checkpoint.b === 1;
      render();
    } } });
  </script>
</body>
</html>`

const HALF_ADDER_STYLED_SOURCE = HALF_ADDER_SOURCE.replace('</head>', '<style>#sum { outline: 3px solid #ad279a; }</style></head>')

function halfAdderReply(origin: 'live' | 'returned'): Extract<ReplayEntry, { kind: 'chunks' }> {
  const start = origin === 'returned' ? '"kind":"branch-half-adder-checkpoint"[^\\r\\n]*?' : ''
  const checkpoint = start + '"kind":"half-adder-checkpoint"'
  const field = (name: string, pattern: string) => `${name}: {{fromRequest:${checkpoint}${pattern}}}`
  return textReplay([
    field('A', ',"a":([01])'), field('B', ',"a":[01],"b":([01])'),
    field('Sum', ',"a":[01],"b":[01],"sum":([01])'), field('Carry', ',"a":[01],"b":[01],"sum":[01],"carry":([01])'),
  ].join('\n'))
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: confirmed half-adder question checkpoint', () => {
  it('checks the four truth-table rows and reopens two independently confirmed readings', async (test) => {
    const world = await launchProgramReplay(test,
      [textReplay('XOR outputs one when exactly one input is one.'), halfAdderReply('returned')],
      [createProgramReplay('half-adder', 'Half-adder', HALF_ADDER_SOURCE), textReplay('The half-adder is ready.'), halfAdderReply('live'),
        updateProgramReplay('half-adder', 'Half-adder', HALF_ADDER_STYLED_SOURCE, 1), textReplay('The Sum readout now has a purple outline.')],
      [HALF_ADDER_PROMPTS.create, HALF_ADDER_PROMPTS.branch, HALF_ADDER_PROMPTS.style('half-adder')])
    const executablePath = process.env.AGENTRANS_PLAYWRIGHT_EXECUTABLE_PATH
    const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    test.onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    const console = watchConsole(page)
    await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    await connectFreshWorkspace(page, world.workspaceCwd)
    let modelMessages = 0
    const stopCounting = world.ctx.on('session/event', (_session, event) => {
      if (event.type === 'assistant/message' && event.data.message.source.kind === 'model') modelMessages += 1
    }, { global: true })
    test.onTestFinished(() => { stopCounting() })
    await exerciseHalfAdderJourney({ browser, page, world, console, requestCount: () => modelMessages, ask: async (prompt, sessionId) => {
      const input = sessionId === undefined ? page.locator('[data-composer-input]').first()
        : page.locator(`[data-conversation-session="${sessionId}"] [data-composer-input][contenteditable="true"]`)
      await input.fill(prompt)
      const settled = world.whenTurnSettled()
      await input.press('Enter')
      return await settled
    } })
  }, 120_000)
})
