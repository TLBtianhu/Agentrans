// @vitest-environment node
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { observeParticleState, restoreParticleCheckpoint } from '@agentrans/artifact/particle-runtime'
import { deriveReplayScript, parseSessionLog, type ReplayOverrideDoc } from '@agentrans/llm-replay'
import type { SessionId } from '@agentrans/session/types'
import { verifyParticleDownload } from './artifact-sent-particle-download-support.ts'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, fixtureUserPrompts, launchWebScaffold,
  readPersistedEvents, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, expandTurnProcesses } from './support.ts'

// Authored parent/child model output; navigation, evidence, admission, and retry use the shipped Web profile.
const DIR = fileURLToPath(new URL('./fixtures/replay/branch-evidence', import.meta.url))
const PARENT_FIXTURE = join(DIR, 'session.v4.jsonl')
const CHILD_FIXTURE = join(DIR, 'session.1.v4.jsonl')
const GROUP = 'branch-gravity-study'
const CONCLUSION = 'Child evidence conclusion: the saved variant is higher after the same six steps.'
const PREFIX = 'The user selected the following saved Artifact evidence to accompany this conclusion. This does not state that the assistant used it when producing the conclusion.\n'
type Role = 'control' | 'variant'

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a Remote JSON object')
  return value as Record<string, unknown>
}

async function visibleParticles(preview: Locator) {
  const rows = await preview.locator('[data-particle-live-id]').all()
  return Promise.all(rows.map(async (row) => {
    const coordinates = await Promise.all(['x', 'y', 'vx', 'vy'].map(async name => [
      name, Number(await row.locator(`[data-particle-live-coordinate="${name}"]`).innerText()),
    ] as const))
    return { id: await row.getAttribute('data-particle-live-id'), ...Object.fromEntries(coordinates) }
  }))
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: branch conclusion with saved evidence', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const requests: unknown[] = []
  const receipts: unknown[] = []
  let loseFirstSuccess = true

  beforeAll(async () => {
    process.env.AGENTRANS_TEST_CUSTOM_KEY = 'local-test-key'
    scaffold = await launchWebScaffold({
      replayFixture: PARENT_FIXTURE, replayChildFixtures: [CHILD_FIXTURE], compareReplaySession: false, paceMs: 10,
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
    await page.route('**/api/artifactBranchResults/returnResult', async (route) => {
      const envelope: unknown = route.request().postDataJSON()
      requests.push(object(object(object(envelope).payload).args).request)
      const response = await route.fetch()
      try {
        const envelope: unknown = await response.json()
        const result = object(object(envelope).result)
        if (result.ok === true) {
          receipts.push(result.value)
          if (loseFirstSuccess) {
            loseFirstSuccess = false
            await route.abort('failed')
            return
          }
        }
        await route.fulfill({ response })
      } finally {
        await response.dispose()
      }
    })
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

  it('returns one selected conclusion and immutable evidence through unknown retry and explicit conflicts', async () => {
    const parentPrompts = fixtureUserPrompts(await readFile(PARENT_FIXTURE, 'utf8'))
    const childPrompts = fixtureUserPrompts(await readFile(CHILD_FIXTURE, 'utf8'))
    expect(parentPrompts).toHaveLength(2)
    expect(childPrompts).toHaveLength(3)
    const input = page.locator('[data-composer-input]').first()
    const parentTurn = scaffold.whenTurnSettled()
    await input.fill(parentPrompts[0]!)
    await input.press('Enter')
    const parentId = await parentTurn
    const parent = scaffold.ctx.agents.get(parentId)
    if (parent === undefined) throw new Error('Parent evidence Session is not live')
    const parentResults = () => parent.session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'branch-result' ? [event] : [])
    const parentTurns = () => parent.session.snapshotEvents().filter(event => event.type === 'turn/start').length

    await page.getByRole('button', { name: 'Branch into a new conversation', exact: true }).last().click()
    await expect.poll(() => scaffold.ctx.agents.roots().some(agent => agent.session.header.parentSession === parentId)).toBe(true)
    const firstChildTurn = scaffold.whenTurnSettled()
    await input.fill(childPrompts[1]!)
    await input.press('Enter')
    const childId = await firstChildTurn
    expect(childId).not.toBe(parentId)
    const child = scaffold.ctx.agents.get(childId)
    if (child === undefined) throw new Error('Child evidence Session is not live')
    await expandTurnProcesses(page)
    const group = () => page.locator(`section[data-comparison-group="${GROUP}"]:visible`).last()
    const card = (role: Role) => group().locator(`[data-comparison-role="${role}"] section[data-artifact-revision]`)
    const savedIds: Partial<Record<Role, string>> = {}
    for (const role of ['control', 'variant'] as const) {
      await card(role).locator('canvas[aria-label="Interactive particle simulation"]').waitFor({ state: 'visible' })
      for (let step = 0; step < 6; step++) await card(role).getByRole('button', { name: 'Step', exact: true }).click()
      const label = role === 'control' ? 'A' : 'B'
      await card(role).getByRole('textbox', { name: 'Observation name', exact: true }).fill(label)
      await card(role).getByRole('button', { name: 'Save observation', exact: true }).click()
      const row = card(role).locator('section[aria-label="Saved observations"] li').filter({ has: page.getByText(label, { exact: true }) })
      await row.waitFor({ state: 'visible' })
      const observationId = await row.getAttribute('data-observation-id')
      if (observationId === null) throw new Error('Saved branch observation has no identity')
      savedIds[role] = observationId
    }
    const controlId = savedIds.control
    const variantId = savedIds.variant
    if (controlId === undefined || variantId === undefined) throw new Error('Both branch observations are required')
    const secondChildTurn = scaffold.whenTurnSettled()
    await input.fill(childPrompts[2]!)
    await input.press('Enter')
    expect(await secondChildTurn).toBe(childId)
    await page.getByText(CONCLUSION, { exact: true }).waitFor({ state: 'visible' })
    for (const role of ['control', 'variant'] as const) await expect.poll(() => card(role).getAttribute('data-artifact-revision')).toBe('2')
    const result = child.session.snapshotEvents().findLast(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text === CONCLUSION))
    if (result === undefined || result.type !== 'assistant/message') throw new Error('Child-owned conclusion is missing')
    const evidenceAction = () => page.locator(`[data-branch-result-seq="${result.seq}"]:visible`)
    const openEvidence = () => evidenceAction().getByRole('button', { name: 'Return with evidence', exact: true }).click()
    const selectPair = async (): Promise<void> => {
      await evidenceAction().getByRole('radio', { name: 'Saved comparison', exact: true }).check()
      await evidenceAction().getByRole('combobox', { name: 'Control observation', exact: true })
        .selectOption(JSON.stringify(['gravity-control', controlId]))
      await evidenceAction().getByRole('combobox', { name: 'Variant observation', exact: true })
        .selectOption(JSON.stringify(['gravity-variant', variantId]))
    }
    const openSession = async (sessionId: string): Promise<void> => {
      await page.locator(`[data-row-key="session:${sessionId}"]`).click()
      await page.locator(`[data-conversation-session="${sessionId}"]`).waitFor({ state: 'visible' })
    }

    await openSession(parentId)
    const independentParentTurn = scaffold.whenTurnSettled()
    await input.fill(parentPrompts[1]!)
    await input.press('Enter')
    expect(await independentParentTurn).toBe(parentId)
    await page.getByText('Parent independent experiment starts at x=100.', { exact: true }).waitFor({ state: 'visible' })
    await openSession(childId)
    await page.getByText(CONCLUSION, { exact: true }).waitFor({ state: 'visible' })
    const parentBefore = parent.session.snapshotEvents()
    const childBefore = child.session.snapshotEvents()
    const saved = childBefore.flatMap(event => event.type === 'artifact/observations' ? event.data.observations : [])
    const control = saved.find(fact => fact.observationId === controlId)
    const variant = saved.find(fact => fact.observationId === variantId)
    if (control === undefined || variant === undefined) throw new Error('Child evidence facts are missing')
    expect(parentResults()).toEqual([])
    expect(parentTurns()).toBe(2)

    await openEvidence()
    await evidenceAction().getByRole('combobox', { name: 'Saved observation', exact: true })
      .selectOption(JSON.stringify(['gravity-control', controlId]))
    await evidenceAction().getByLabel('Observed values: A', { exact: true }).waitFor({ state: 'visible' })
    expect(await evidenceAction().textContent()).toContain('Gravity control · A · Revision 1 · step 6')
    expect(await evidenceAction().textContent()).not.toContain('Child private reasoning')
    await evidenceAction().getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(requests).toEqual([])
    expect(parentResults()).toEqual([])
    expect(child.session.snapshotEvents()).toEqual(childBefore)

    const reloadChild = async (): Promise<void> => {
      const warningStart = tripwire.warnings.length
      await page.reload()
      await page.getByText(CONCLUSION, { exact: true }).waitFor({ state: 'visible' })
      acknowledgeReloadConnectionLoss(tripwire, warningStart)
      await openSession(parentId)
      await openSession(childId)
      await page.getByText(CONCLUSION, { exact: true }).waitFor({ state: 'visible' })
    }
    await reloadChild()
    await openEvidence()
    await selectPair()
    expect(await evidenceAction().getByText(CONCLUSION, { exact: true }).isVisible()).toBe(true)
    for (const observation of [control, variant]) {
      const readout = evidenceAction().getByLabel(`Observed values: ${observation.label}`, { exact: true })
      await readout.waitFor({ state: 'visible' })
      expect(JSON.parse(await readout.innerText())).toEqual(observation.values)
    }
    expect(await evidenceAction().textContent()).toContain('Gravity variant · B · Revision 1 · step 6')
    expect(parentResults()).toEqual([])
    expect(child.session.snapshotEvents()).toEqual(childBefore)
    await evidenceAction().getByRole('button', { name: 'Confirm return with evidence', exact: true }).click()
    await evidenceAction().getByText('The return could not be confirmed. Retry the same conclusion and evidence, or check the parent conversation before cancelling.', { exact: true })
      .waitFor({ state: 'visible' })
    expect(parentResults()).toHaveLength(1)
    expect(await evidenceAction().getByRole('combobox', { name: 'Control observation', exact: true }).isDisabled()).toBe(true)
    expect(await evidenceAction().getByRole('combobox', { name: 'Variant observation', exact: true }).isDisabled()).toBe(true)
    expect(await evidenceAction().getByRole('radio', { name: 'Single observation', exact: true }).isDisabled()).toBe(true)
    await evidenceAction().getByRole('button', { name: 'Retry return with evidence', exact: true }).click()
    await page.getByText('Parent independent experiment starts at x=100.', { exact: true }).waitFor({ state: 'visible' })
    expect(requests).toHaveLength(2)
    expect(requests[0]).toEqual({
      sessionId: parentId, branchSessionId: childId, resultSeq: result.seq,
      evidence: { kind: 'comparison', group: GROUP,
        control: { artifactId: 'gravity-control', observationId: controlId },
        variant: { artifactId: 'gravity-variant', observationId: variantId } },
    })
    expect(requests[1]).toEqual(requests[0])
    expect(receipts).toHaveLength(2)
    expect(receipts[1]).toEqual(receipts[0])

    const returned = parentResults()[0]
    if (returned === undefined) throw new Error('The parent has no returned conclusion')
    expect(returned.data.source).toEqual({ kind: 'branch-result', branchSessionId: childId,
      resultSeq: result.seq, resultMessageId: result.data.message.id, form: 'notice' })
    expect(returned.data.content).toHaveLength(2)
    expect(returned.data.content[0]).toEqual({ type: 'text', text: CONCLUSION })
    const evidenceBlock = returned.data.content[1]
    if (evidenceBlock?.type !== 'text' || !evidenceBlock.text.startsWith(PREFIX)) throw new Error('Host evidence block is missing')
    const evidence: unknown = JSON.parse(evidenceBlock.text.slice(PREFIX.length))
    expect(evidence).toEqual({ kind: 'branch-result-artifact-evidence', branchSessionId: childId, evidence: {
      kind: 'comparison', group: GROUP, conditions: { runtimeVersion: 1, stepCount: 6, timeStep: 1 / 30, time: 0.2 }, control, variant,
    } })
    for (const fact of [control, variant]) {
      expect(fact.artifact.revision).toBe(1)
      expect(fact.artifact.spec.kind).toBe('particle-system')
      if (fact.artifact.spec.kind !== 'particle-system') throw new Error('Saved evidence source is not a particle system')
      expect(fact.artifact.spec.particles[0]?.x).toBe(1)
      expect(fact.checkpoint).toEqual({ runtimeVersion: 1, stepCount: 6 })
      expect(fact.values.particles[0]?.x).toBeCloseTo(1.6, 12)
    }
    expect(control.values.particles[0]?.y).toBeCloseTo(1 + 8 * 0.2 - 9.8 * (1 / 30) ** 2 * 6 * 5 / 2, 12)
    expect(variant.values.particles[0]?.y).toBeCloseTo(1 + 8 * 0.2 - 4 * (1 / 30) ** 2 * 6 * 5 / 2, 12)
    expect(JSON.stringify(returned)).not.toContain('Child private reasoning')
    const parentArtifact = parent.session.snapshotEvents().findLast(event => event.type === 'artifact/upsert' && event.data.artifactId === 'gravity-control')
    expect(parentArtifact).toMatchObject({ type: 'artifact/upsert', data: { title: 'Parent gravity control', revision: 1,
      spec: { kind: 'particle-system', particles: [{ id: 'alpha', x: 100 }] } } })

    const returnedEvidence = page.locator('[data-artifact-branch-evidence]:visible')
    const parentCard = page.getByRole('complementary', { name: 'Artifact: Parent gravity control', exact: true })
    const verifyReplays = async (): Promise<void> => {
      await returnedEvidence.getByText(CONCLUSION, { exact: true }).waitFor({ state: 'visible' })
      for (const [role, observation] of [['control', control], ['variant', variant]] as const) {
        const item = returnedEvidence.locator(`[data-artifact-branch-evidence-item="${role}"]`)
        const toggle = item.getByRole('button', { name: 'Replay experiment', exact: true })
        expect(await toggle.getAttribute('aria-expanded')).toBe('false')
        await toggle.click()
        const replay = item.locator('[data-artifact-question-replay-revision="1"]')
        await replay.getByRole('img').waitFor({ state: 'visible' })
        expect(await toggle.getAttribute('aria-expanded')).toBe('true')
        expect(await replay.getAttribute('data-artifact-question-replay-id')).toBe(observation.artifact.artifactId)
        const checkpoint = replay.locator('[data-particle-step="6"]')
        expect(await checkpoint.locator('[data-particle-source-time]').innerText()).toBe(String(observation.values.time))
        expect(await visibleParticles(checkpoint)).toEqual(observation.values.particles)
        expect(await replay.getByRole('button', { name: 'Step', exact: true }).count()).toBe(0)
        expect(await replay.getByRole('button', { name: 'Use for next question', exact: true }).count()).toBe(0)
      }
      const parentX = parentCard.locator('[data-particle-live-coordinate="x"]')
      expect(await parentX.innerText()).toBe('100')
    }
    await verifyReplays()
    const warningStart = tripwire.warnings.length
    await page.reload()
    await page.getByText('Parent independent experiment starts at x=100.', { exact: true }).waitFor({ state: 'visible' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await verifyReplays()
    expect(parentResults()).toHaveLength(1)
    expect(parentTurns()).toBe(2)
    const persistedReturn = (await readPersistedEvents(scaffold, parentId)).find(event => event.seq === returned.seq)
    expect(persistedReturn).toEqual(returned)

    await openSession(childId)
    await page.getByRole('button', { name: 'Return to parent branch', exact: true }).last().click()
    await page.getByRole('button', { name: 'Confirm return', exact: true }).click()
    await page.getByText('This conclusion was already returned with different evidence. Open the parent conversation to review it.', { exact: true })
      .waitFor({ state: 'visible' })
    expect(await page.getByRole('button', { name: 'Retry return', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Open parent conversation', exact: true }).click()
    expect(parentResults()).toHaveLength(1)

    await openSession(childId)
    await openEvidence()
    await evidenceAction().getByRole('combobox', { name: 'Saved observation', exact: true })
      .selectOption(JSON.stringify(['gravity-control', controlId]))
    await evidenceAction().getByRole('button', { name: 'Confirm return with evidence', exact: true }).click()
    await evidenceAction().getByText('This conclusion was already returned with different evidence, or without evidence. Open the parent conversation to review it.', { exact: true })
      .waitFor({ state: 'visible' })
    expect(await evidenceAction().getByRole('button', { name: 'Retry return with evidence', exact: true }).count()).toBe(0)
    await evidenceAction().getByRole('button', { name: 'Open parent conversation', exact: true }).click()
    expect(parentResults()).toHaveLength(1)

    await openSession(childId)
    await reloadChild()
    await openEvidence()
    await selectPair()
    await evidenceAction().getByRole('button', { name: 'Confirm return with evidence', exact: true }).click()
    await page.getByText('Parent independent experiment starts at x=100.', { exact: true }).waitFor({ state: 'visible' })
    expect(requests).toHaveLength(4)
    expect(requests[3]).toEqual(requests[0])
    expect(receipts).toHaveLength(3)
    expect(receipts[2]).toEqual(receipts[0])
    expect(parentResults()).toHaveLength(1)
    expect(parentTurns()).toBe(2)
    expect(parent.session.snapshotEvents()).toHaveLength(parentBefore.length + 1)
    expect(parent.session.snapshotEvents().slice(0, parentBefore.length)).toEqual(parentBefore)
    expect(child.session.snapshotEvents()).toEqual(childBefore)
    expect(child.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'artifact-action')).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl', 'session.1.v4.jsonl'])
  })
})

const QUESTION_SCENARIOS = [
  { kind: 'function-plot', recording: 'scene-function-question', title: 'Slope and area lab',
    artifactId: 'function-question-line', steps: 1, review: 'Review function readings', context: 'current-function-plot' },
  { kind: 'particle-system', recording: 'artifact-question-context', title: 'Projectile runtime',
    artifactId: 'projectile-runtime', steps: 6, review: 'Review particle readings', context: 'current-particle' },
] as const
const PARENT_EVIDENCE_QUESTION = 'What was the integral from zero to the recorded x in the readings I selected?'
const REPLAY_INTEGRAL_ANSWER = 'The selected readings record an integral of {{fromRequest:"kind":"branch-evidence"[^\\r\\n]*"integral":([0-9.]+)}}.'
const CONTINUED_EXPERIMENT_QUESTION = 'What is the integral at the new parameter value in this experiment?'
const CONTINUED_EXPERIMENT_REPLY = 'The changed experiment records an integral of '
const CONTINUED_EXPERIMENT_ANSWER = CONTINUED_EXPERIMENT_REPLY
  + '{{fromRequest:"kind":"current-function-plot"[^\\r\\n]*"integral":([0-9.]+)}}.'
const CONTINUED_PARTICLE_QUESTION = 'What is alpha’s height at the attached gravity and checkpoint?'
const CONTINUED_PARTICLE_REPLY = 'The changed experiment records a height of '
const CONTINUED_PARTICLE_ANSWER = CONTINUED_PARTICLE_REPLY
  + '{{fromRequest:"gravityY":-5[^\\r\\n]*?"id":"alpha","x":[0-9.]+,"y":([0-9.]+)}}.'

function continuationFixture(header: Record<string, unknown>, inherited: readonly string[], seedBoundary: string,
  question: string, answer: string): string {
  if (typeof header.createdAt !== 'number') throw new Error('The original recording needs a creation time')
  const turn = 2
  const step = 1
  const text = { type: 'text', text: answer } as const
  const model = { provider: 'custom-provider', model: 'user-model' }
  const stream = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: text.text },
    { type: 'block-end', index: 0, block: text },
    { type: 'finish', reason: { kind: 'stop' } },
  ].map((chunk, index) => ({ type: 'chunk', time: 1_793_654_003_000 + index, chunk }))
  const ownEvents = [
    { type: 'turn/start', data: { turn } },
    { type: 'step/start', data: { turn, step } },
    { type: 'user/message', surfaceOp: 'append', data: {
      role: 'user', id: '{{message:continued-experiment-question}}', source: { kind: 'user' },
      content: [{ type: 'text', text: question }],
    } },
    { type: 'request/header', data: { header: { config: model }, reason: 'series' } },
    { type: 'assistant/message', surfaceOp: 'append', data: {
      turn, step, stream, message: {
        role: 'assistant', id: '{{message:continued-experiment-answer}}', source: { kind: 'model', ...model }, content: [text],
      },
    } },
    { type: 'step/end', data: { turn, step } },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ]
  return [
    JSON.stringify({ ...header, id: '{{session:3}}', isSeeded: true, parentSession: '{{session:1}}', createdAt: header.createdAt + 1 }),
    ...inherited, seedBoundary, ...ownEvents.map(event => JSON.stringify(event)),
  ].join('\n') + '\n'
}

async function forkedQuestionFixtures(recording: string) {
  const file = fileURLToPath(new URL(`./fixtures/replay/${recording}/session.v4.jsonl`, import.meta.url))
  const recorded = await readFile(file, 'utf8')
  const lines = recorded.trimEnd().split(/\r?\n/u)
  const cut = lines.findIndex(line => object(JSON.parse(line)).type === 'turn/end') + 1
  if (cut === 0 || cut >= lines.length) throw new Error('The question recording needs two complete turns')
  const dir = await mkdtemp(join(tmpdir(), 'agentrans-branch-question-'))
  const parentFile = join(dir, 'session.v4.jsonl')
  const childFile = join(dir, 'session.1.v4.jsonl')
  const parentText = lines.slice(0, cut).join('\n') + '\n'
  const replayOverride = recording === 'scene-function-question' ? join(dir, 'replay.override.json') : undefined
  const continuedChild = join(dir, 'session.2.v4.jsonl')
  const childFiles = [childFile, continuedChild]
  const ownedFiles = [parentFile, ...childFiles]
  onTestFinished(async () => {
    await Promise.all(ownedFiles.map(path => unlink(path)))
    await rmdir(dir)
  })
  const header = object(JSON.parse(lines[0]!))
  const childHeader = JSON.stringify({ ...header, id: '{{session:2}}', isSeeded: true, parentSession: '{{session:1}}' })
  const seedBoundary = JSON.stringify({ type: 'session/end-seed', data: { inherited: true } })
  // Reuse the two existing recordings with a branch cut. The browser creates the actual evidence and return events.
  await Promise.all([
    writeFile(parentFile, parentText),
    writeFile(childFile, [childHeader, ...lines.slice(1, cut), seedBoundary, ...lines.slice(cut)].join('\n') + '\n'),
  ])
  const [question, answer] = replayOverride === undefined
    ? [CONTINUED_PARTICLE_QUESTION, CONTINUED_PARTICLE_ANSWER] : [CONTINUED_EXPERIMENT_QUESTION, CONTINUED_EXPERIMENT_ANSWER]
  await writeFile(continuedChild, continuationFixture(header, lines.slice(1, cut), seedBoundary, question, answer))
  if (replayOverride !== undefined) {
    const at = deriveReplayScript(parseSessionLog(parentText)).length
    // Read the integral from the new attached block. Replaying the older notice alone cannot resolve the placeholder.
    const override: ReplayOverrideDoc = { patches: [{ at, entry: { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: REPLAY_INTEGRAL_ANSWER },
      { type: 'block-end', index: 0, block: { type: 'text', text: REPLAY_INTEGRAL_ANSWER } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] } }] }
    await writeFile(replayOverride, JSON.stringify(override))
    ownedFiles.push(replayOverride)
  }
  return { parentFile, childFiles, recorded, replayOverride }
}

async function expectQuestionReplay(replay: Locator, experiment: typeof QUESTION_SCENARIOS[number], facts: Record<string, unknown>,
  artifactId: string = experiment.artifactId) {
  const source = replay.locator('[data-artifact-question-replay-revision="1"]')
  await source.getByRole('img').waitFor({ state: 'visible' })
  expect(await source.getAttribute('data-artifact-question-replay-id')).toBe(artifactId)
  expect(await source.getByRole('button', { name: 'Step', exact: true }).count()).toBe(0)
  expect(await source.getByRole('button', { name: 'Use for next question', exact: true }).count()).toBe(0)
  const values = object(facts.values)
  if (experiment.kind === 'particle-system') {
    const checkpoint = source.locator('[data-particle-step="6"]')
    expect(Number(await checkpoint.getAttribute('data-particle-time'))).toBe(0.2)
    expect(await visibleParticles(checkpoint)).toEqual(values.particles)
  } else {
    expect(await source.locator('[data-function-id="linear"][data-current]').innerText()).toBe('Linear')
    expect(await source.locator('[data-function-source-parameter="a"]').innerText()).toBe('1.25')
    expect(await source.getByRole('slider').count()).toBe(0)
    for (const [name, value] of Object.entries({ x: facts.x, ...values })) {
      expect(await source.locator(`[data-function-source-value="${name}"]`).innerText()).toBe(String(value))
    }
  }
}

async function expectOfflineLockedLinearPlot(page: Page, exportFile: string, originFields: Readonly<Record<string, unknown>>,
  baseline: unknown): Promise<void> {
  const offline = await page.context().browser()?.newContext({ offline: true })
  if (offline === undefined) throw new Error('The saved plot requires an independent offline browser context')
  try {
    const exported = await offline.newPage()
    const network: string[] = []
    exported.on('request', (request) => { if (/^https?:/u.test(request.url())) network.push(request.url()) })
    await exported.goto(pathToFileURL(exportFile).href)
    await exported.locator('canvas#plot').waitFor({ state: 'visible' })
    const origin: unknown = JSON.parse(await exported.locator('#artifact-export-origin-data').textContent() ?? 'null')
    expect(origin).toMatchObject({ exporterVersion: 2, revision: 1, ...originFields })
    expect(origin).toHaveProperty('functionPlotBaseline', baseline)
    for (const [label, value] of Object.entries({ a: '1.25', x: '1.00', 'f′(x)': '1.250' })) {
      const reading = exported.locator('#readout > div').filter({
        has: exported.locator('span').and(exported.getByText(label, { exact: true })),
      }).locator('strong')
      await reading.waitFor({ state: 'visible' })
      expect(await reading.textContent()).toBe(value)
    }
    expect(network).toEqual([])
  } finally { await offline.close() }
}

async function exerciseContinuedExperiment(page: Page, scaffold: WebScaffold, parentId: SessionId, parentEvidence: Locator,
  tripwire: ReturnType<typeof watchConsole>) {
  const parentBefore = await readPersistedEvents(scaffold, parentId)
  const existingSessions = new Set(scaffold.ctx.agents.roots().map(agent => agent.id))
  const response = page.waitForResponse(receipt => new URL(receipt.url()).pathname === '/api/artifactBranchResults/continuePlot')
  await parentEvidence.getByRole('button', { name: 'Continue experiment', exact: true }).click()
  const accepted = object(object(await (await response).json()).result)
  expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true)
  const { sessionId: childId, artifactId } = object(accepted.value)
  if (typeof childId !== 'string') throw new Error('The continuation response needs a child Session id')
  await page.locator(`[data-row-key="session:${childId}"][aria-selected="true"]`).waitFor({ state: 'visible' })
  const child = scaffold.ctx.agents.roots().find(agent => agent.id === childId)
  if (child === undefined) throw new Error('The continuation branch did not open')
  expect(child.session.header.parentSession).toBe(parentId)
  expect(existingSessions.has(child.id)).toBe(false)
  const conversation = page.locator(`[data-conversation-session="${child.id}"]`)
  const comparison = conversation.locator('[data-function-baseline-comparison]:visible')
  const card = conversation.locator('section[data-artifact-revision]').filter({ has: page.locator('[data-function-baseline-comparison]') })
  const parameter = card.locator('label').filter({ hasText: /^Parameter a\b/u }).locator('output')
  const integral = (name: 'baseline' | 'current' | 'delta') => comparison.locator(`[data-function-integral="${name}"]`)
  const ownEvents = () => child.session.snapshotEvents().slice(child.session.inheritedEventCount)
  const editable = ownEvents().findLast(event => event.type === 'artifact/upsert')
  if (editable?.type !== 'artifact/upsert' || editable.data.format !== 'scene' || editable.data.spec.kind !== 'function-plot') {
    throw new Error('The continuation did not commit an editable function plot')
  }
  expect(editable.data.artifactId).toBe(artifactId)
  expect(editable.data.revision).toBe(1)
  expect(parentBefore.some(event => event.type === 'artifact/upsert' && event.data.artifactId === editable.data.artifactId)).toBe(false)
  expect(editable.data.spec).toMatchObject({ functions: [{ id: 'linear', expression: 'a*x' }],
    parameters: { a: { value: 1 } }, trace: { x: 1 } })
  expect(editable.data).toMatchObject({ continuation: {
    baseline: { functionId: 'linear', x: 1, parameters: { a: 1.25 } },
  } })
  expect((await readPersistedEvents(scaffold, child.id)).find(event => event.seq === editable.seq)).toEqual(editable)
  expect(ownEvents().filter(event => event.type === 'turn/start')).toEqual([])
  expect(await readPersistedEvents(scaffold, parentId)).toEqual(parentBefore)

  const expectInitialReadings = async () => {
    await comparison.waitFor({ state: 'visible' })
    expect(await card.getByRole('slider').count()).toBe(1)
    expect(await parameter.innerText()).toBe('1.25')
    expect(await integral('baseline').innerText()).toBe('0.625')
    expect(await integral('current').innerText()).toBe('0.625')
    expect(await integral('delta').innerText()).toBe('0.000')
  }
  const changeParameter = async () => {
    for (let index = 0; index < 3; index++) await card.getByRole('button', { name: 'Step', exact: true }).click()
    await expect.poll(() => parameter.innerText()).toBe('2.00')
    expect(await integral('baseline').innerText()).toBe('0.625')
    expect(await integral('current').innerText()).toBe('1.000')
    expect(await integral('delta').innerText()).toBe('+0.375')
  }
  await expectInitialReadings()
  await changeParameter()
  const warningStart = tripwire.warnings.length
  await page.reload()
  await expectInitialReadings()
  acknowledgeReloadConnectionLoss(tripwire, warningStart)
  await changeParameter()

  const download = page.waitForEvent('download')
  await card.getByRole('button', { name: 'Export animation', exact: true }).click()
  const exportFile = join(scaffold.workspaceCwd, 'locked-continued-plot.html')
  await (await download).saveAs(exportFile)
  await expectOfflineLockedLinearPlot(page, exportFile, { sessionId: child.id, artifactId }, editable.data.continuation?.baseline)
  expect(await parameter.innerText()).toBe('2.00')
  expect(ownEvents().filter(event => event.type === 'artifact/upsert')).toEqual([editable])
  expect(ownEvents().filter(event => event.type === 'turn/start')).toEqual([])
  expect(await readPersistedEvents(scaffold, parentId)).toEqual(parentBefore)

  await card.getByRole('button', { name: 'Use for next question', exact: true }).click()
  const review = card.getByRole('region', { name: 'Review function readings', exact: true })
  expect(await review.locator('[data-function-question-parameter="a"]').innerText()).toBe('2')
  expect(await review.locator('[data-function-question-value="x"]').innerText()).toBe('1')
  await review.getByRole('button', { name: 'Attach readings', exact: true }).click()
  await conversation.locator('[data-artifact-prompt-context="current-function-plot"]').waitFor({ state: 'visible' })
  const input = conversation.locator('[data-composer-input][contenteditable="true"]')
  await input.fill(CONTINUED_EXPERIMENT_QUESTION)
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  expect(await settled).toBe(child.id)

  const question = ownEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
  const attachment = question?.type === 'user/message' ? question.data.content[1] : undefined
  if (attachment?.type !== 'text') throw new Error('The new question did not store its changed readings')
  const selected = object(object(JSON.parse(attachment.text.slice(attachment.text.indexOf('\n') + 1))).facts)
  expect(selected).toMatchObject({ kind: 'current-function-plot', x: 1, parameters: { a: 2 },
    artifact: { artifactId: editable.data.artifactId, revision: editable.data.revision, spec: editable.data.spec } })
  const value = object(selected.values).integral
  if (typeof value !== 'number') throw new Error('The new question did not store an integral')
  expect(value).toBeCloseTo(1, 12)
  const conclusion = `${CONTINUED_EXPERIMENT_REPLY}${value}.`
  await conversation.getByText(conclusion, { exact: true }).waitFor({ state: 'visible' })
  expect(ownEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)

  const reply = ownEvents().findLast(event => event.type === 'assistant/message')
  if (reply === undefined) throw new Error('The continuation did not produce a conclusion')
  const action = conversation.locator(`[data-branch-result-seq="${reply.seq}"]:visible`)
  await action.getByRole('button', { name: 'Return with evidence', exact: true }).click()
  await action.getByRole('button', { name: 'Confirm return with evidence', exact: true }).click()
  const returnedCard = page.locator(`[data-conversation-session="${parentId}"] [data-artifact-branch-evidence]:visible`)
    .filter({ hasText: conclusion })
  await returnedCard.getByRole('button', { name: 'Replay experiment', exact: true }).click()
  expect(await returnedCard.locator('[data-function-source-parameter="a"]').innerText()).toBe('2')
  expect(Number(await returnedCard.locator('[data-function-source-value="integral"]').innerText())).toBeCloseTo(1, 12)
  const parentAfter = await readPersistedEvents(scaffold, parentId)
  const returned = parentAfter.findLast(event => event.type === 'user/message' && event.data.source.kind === 'branch-result')
  expect(returned).toMatchObject({ type: 'user/message', data: { source: { branchSessionId: child.id, resultSeq: reply.seq } } })
  const returnedAttachment = returned?.type === 'user/message' ? returned.data.content[1] : undefined
  if (returnedAttachment?.type !== 'text') throw new Error('The continuation return did not store its changed readings')
  expect(object(JSON.parse(returnedAttachment.text.slice(returnedAttachment.text.indexOf('\n') + 1))).evidence)
    .toMatchObject({ kind: 'question', facts: selected })
  expect(parentAfter.slice(0, parentBefore.length)).toEqual(parentBefore)
  expect(parentAfter).toHaveLength(parentBefore.length + 1)
}

async function exerciseContinuedParticle(page: Page, scaffold: WebScaffold, parentId: SessionId, original: Locator,
  originalFacts: Record<string, unknown>, tripwire: ReturnType<typeof watchConsole>) {
  const parentBefore = await readPersistedEvents(scaffold, parentId)
  const openContinuation = async (item: Locator) => {
    const response = page.waitForResponse(receipt => new URL(receipt.url()).pathname === '/api/artifactBranchResults/continueParticle')
    await item.getByRole('button', { name: 'Continue experiment', exact: true }).click()
    const accepted = object(object(await (await response).json()).result)
    expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true)
    const { sessionId, artifactId } = object(accepted.value)
    if (typeof sessionId !== 'string' || typeof artifactId !== 'string') throw new Error('The continuation needs Session and Artifact ids')
    await page.locator(`[data-row-key="session:${sessionId}"][aria-selected="true"]`).waitFor({ state: 'visible' })
    const child = scaffold.ctx.agents.roots().find(agent => agent.id === sessionId)
    if (child === undefined) throw new Error('The particle continuation branch did not open')
    expect(child.session.header.parentSession).toBe(parentId)
    const conversation = page.locator(`[data-conversation-session="${sessionId}"]`)
    const card = conversation.locator('section[data-artifact-revision]').filter({ has: page.locator('[data-particle-baseline-comparison]') })
    return { child, artifactId, conversation, card }
  }
  const { child, artifactId, conversation, card } = await openContinuation(original)
  const events = () => child.session.snapshotEvents().slice(child.session.inheritedEventCount)
  const seeded = events().find(event => event.type === 'artifact/upsert')
  if (seeded?.type !== 'artifact/upsert' || seeded.data.format !== 'scene' || seeded.data.spec.kind !== 'particle-system') {
    throw new Error('The continuation did not seed a particle source')
  }
  expect(seeded.data).toMatchObject({ artifactId, revision: 1, spec: object(originalFacts.artifact).spec,
    particleContinuation: { baseline: { checkpoint: originalFacts.checkpoint } } })
  const gravity = card.getByRole('spinbutton', { name: 'Vertical gravity', exact: true })
  const height = (name: 'baseline' | 'current' | 'delta') => card.locator(`[data-particle-height="${name}"]`)
  expect(await gravity.inputValue()).toBe('-9.8')
  expect(await height('baseline').innerText()).toBe('2.437')
  await gravity.fill('-5')
  await expect.poll(() => height('current').innerText()).toBe('2.517')
  expect(await height('delta').innerText()).toBe('+0.080')
  await card.locator('[data-particle-step="6"]').waitFor({ state: 'visible' })
  expect(await readPersistedEvents(scaffold, parentId)).toEqual(parentBefore)

  await card.getByRole('button', { name: 'Use for next question', exact: true }).click()
  const review = card.getByRole('region', { name: 'Review particle readings', exact: true })
  await gravity.fill('-6')
  await expect.poll(() => height('current').innerText()).toBe('2.500')
  expect(await review.locator('[data-particle-question-gravity-y]').innerText()).toBe('-5')
  await review.getByRole('button', { name: 'Attach readings', exact: true }).click()
  await conversation.locator('[data-artifact-prompt-context="current-particle"]').waitFor({ state: 'visible' })
  const input = conversation.locator('[data-composer-input][contenteditable="true"]')
  await input.fill(CONTINUED_PARTICLE_QUESTION)
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  expect(await settled).toBe(child.id)
  const question = events().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (question?.type !== 'user/message') throw new Error('The continued question must be saved')
  const attached = question.data.content[1]
  if (attached?.type !== 'text') throw new Error('The continued question lost the changed readings')
  const facts = object(object(JSON.parse(attached.text.slice(attached.text.indexOf('\n') + 1))).facts)
  const gravityY = -5
  const checkpoint = { runtimeVersion: 1, stepCount: 6 } as const
  const scene = { ...seeded.data, spec: seeded.data.spec }
  const adjustedSpec = { ...scene.spec, gravity: { ...scene.spec.gravity, y: gravityY } }
  const values = observeParticleState(restoreParticleCheckpoint(adjustedSpec, checkpoint))
  const reading = { checkpoint, values }
  expect(checkpoint).toEqual(originalFacts.checkpoint)
  expect(facts).toMatchObject({ kind: 'current-particle', artifact: scene, gravityY, ...reading })
  const y = values.particles.find(particle => particle.id === 'alpha')?.y
  if (y === undefined) throw new Error('The changed particle has no height')
  expect(y).toBeCloseTo(2.6 - 5 / 60, 12)
  const conclusion = `${CONTINUED_PARTICLE_REPLY}${y}.`
  await conversation.getByText(conclusion, { exact: true }).waitFor({ state: 'visible' })
  const browser = page.context().browser()
  if (browser === null) throw new Error('The saved particle experiment requires an independent offline browser context')
  const sentAddress = { eventSeq: question.seq, messageId: question.data.id }
  const sentRow = conversation.locator(`[data-chat-message-id="${sentAddress.messageId}"][data-chat-message-seq="${sentAddress.eventSeq}"]`)
  const rootsBeforeSentDownload = scaffold.ctx.agents.roots().map(root => root.id)
  const childBeforeSentDownload = await readPersistedEvents(scaffold, child.id)
  const warningsBeforeSentReload = tripwire.warnings.length
  await page.reload()
  await sentRow.getByText(CONTINUED_PARTICLE_QUESTION, { exact: true }).waitFor({ state: 'visible' })
  acknowledgeReloadConnectionLoss(tripwire, warningsBeforeSentReload)
  await verifyParticleDownload({ browser, page, card: sentRow, directory: scaffold.workspaceCwd, sessionId: child.id,
    address: sentAddress, scene, reading, gravityY, kind: 'sentQuestion' })
  expect(scaffold.ctx.agents.roots().map(root => root.id)).toEqual(rootsBeforeSentDownload)
  expect(await readPersistedEvents(scaffold, child.id)).toEqual(childBeforeSentDownload)
  expect(await readPersistedEvents(scaffold, parentId)).toEqual(parentBefore)
  const reply = events().findLast(event => event.type === 'assistant/message')
  if (reply === undefined) throw new Error('The continuation did not produce a particle conclusion')
  const action = conversation.locator(`[data-branch-result-seq="${reply.seq}"]:visible`)
  await action.getByRole('button', { name: 'Return with evidence', exact: true }).click()
  await action.getByRole('button', { name: 'Confirm return with evidence', exact: true }).click()

  const returnedCard = page.locator(`[data-conversation-session="${parentId}"] [data-artifact-branch-evidence]:visible`)
    .filter({ hasText: conclusion })
  const warningsBeforeReload = tripwire.warnings.length
  await returnedCard.waitFor({ state: 'visible' })
  await page.reload()
  await returnedCard.getByRole('button', { name: 'Replay experiment', exact: true }).click()
  await expectQuestionReplay(returnedCard, QUESTION_SCENARIOS[1], facts, artifactId)
  acknowledgeReloadConnectionLoss(tripwire, warningsBeforeReload)
  const parentAfter = await readPersistedEvents(scaffold, parentId)
  expect(parentAfter.slice(0, parentBefore.length)).toEqual(parentBefore)
  expect(parentAfter).toHaveLength(parentBefore.length + 1)

  const notice = parentAfter.at(-1)
  if (notice?.type !== 'user/message' || notice.data.source.kind !== 'branch-result') {
    throw new Error('The adjusted particle return is missing from the saved Session')
  }
  expect(notice.data.source.branchSessionId).toBe(child.id)
  const returnAddress = { eventSeq: notice.seq, messageId: notice.data.id }
  const exactReturn = returnedCard.and(page.locator(`[data-chat-message-id="${notice.data.id}"][data-chat-message-seq="${notice.seq}"]`))
  const rootsBeforeDownload = scaffold.ctx.agents.roots().map(agent => agent.id)
  const childBeforeDownload = await readPersistedEvents(scaffold, child.id)
  await verifyParticleDownload({ browser, page, card: exactReturn, directory: scaffold.workspaceCwd, sessionId: parentId,
    address: returnAddress, scene, reading, gravityY, kind: 'returnedEvidence' })
  expect(scaffold.ctx.agents.roots().map(agent => agent.id)).toEqual(rootsBeforeDownload)
  expect(await readPersistedEvents(scaffold, parentId)).toEqual(parentAfter)
  expect(await readPersistedEvents(scaffold, child.id)).toEqual(childBeforeDownload)

  const next = await openContinuation(returnedCard)
  expect(await next.card.getByRole('spinbutton', { name: 'Vertical gravity', exact: true }).inputValue()).toBe('-5')
  expect(await next.card.locator('[data-particle-height="baseline"]').innerText()).toBe('2.517')
  expect(await next.card.locator('[data-particle-height="delta"]').innerText()).toBe('0.000')
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: branch conclusion with confirmed question readings', () => {
  it.each(QUESTION_SCENARIOS)('adopts and replays the original $kind readings after refresh', async (experiment) => {
    const { parentFile, childFiles, recorded, replayOverride } = await forkedQuestionFixtures(experiment.recording)
    const recordedEvents = parseSessionLog(recorded)
    const prompts = recordedEvents.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user'
      && event.data.content[0]?.type === 'text' ? [event.data.content[0].text] : [])
    expect(prompts).toHaveLength(2)
    const recordedConclusion = recordedEvents.findLast(event => event.type === 'assistant/message')
    const conclusionBlock = recordedConclusion?.type === 'assistant/message' ? recordedConclusion.data.message.content[0] : undefined
    if (conclusionBlock?.type !== 'text') throw new Error('The branch needs a text conclusion')
    const conclusion = conclusionBlock.text
    const parentReply = recordedEvents.findLast(event => event.type === 'assistant/message' && event.data.turn === 1)
    const parentReplyBlock = parentReply?.type === 'assistant/message' ? parentReply.data.message.content[0] : undefined
    if (parentReplyBlock?.type !== 'text') throw new Error('The parent needs a text reply to fork')

    process.env.AGENTRANS_TEST_CUSTOM_KEY = 'local-test-key'
    onTestFinished(() => { delete process.env.AGENTRANS_TEST_CUSTOM_KEY })
    const scaffold = await launchWebScaffold({
      replayFixture: parentFile, replayChildFixtures: childFiles, compareReplaySession: false, paceMs: 10,
      ...replayOverride === undefined ? {} : { replayOverride },
      extraOverlayPath: fileURLToPath(new URL('./teaching-custom-provider.overlay.yml', import.meta.url)),
      replayProviders: [{ id: 'custom-provider', name: 'Custom Lab',
        models: [{ id: 'user-model', name: 'Custom Lab Model', contextWindow: 8192 }] }],
    })
    onTestFinished(() => scaffold.close())
    const executablePath = process.env.AGENTRANS_PLAYWRIGHT_EXECUTABLE_PATH
    const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const input = page.locator('[data-composer-input]').first()
    const parentTurn = scaffold.whenTurnSettled()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const parentId = await parentTurn
    const parent = scaffold.ctx.agents.get(parentId)
    if (parent === undefined) throw new Error('Parent Session is not live')
    const results = () => parent.session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'branch-result' ? [event.data] : [])

    const card = page.getByRole('complementary', { name: `Artifact: ${experiment.title}`, exact: true })
    await page.getByText(parentReplyBlock.text, { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'Branch into a new conversation', exact: true }).last().click()
    await expect.poll(() => scaffold.ctx.agents.roots().some(agent => agent.session.header.parentSession === parentId)).toBe(true)
    const childAgent = scaffold.ctx.agents.roots().find(agent => agent.session.header.parentSession === parentId)
    if (childAgent === undefined) throw new Error('Child Session is not live')
    const inherited = childAgent.session.snapshotEvents().find(event =>
      event.type === 'artifact/upsert' && event.data.artifactId === experiment.artifactId)
    expect(inherited).toMatchObject({ type: 'artifact/upsert', data: { artifactId: experiment.artifactId, revision: 1 } })
    await page.locator(`[data-row-key="session:${childAgent.id}"][aria-selected="true"]`).waitFor({ state: 'visible' })
    const childConversation = page.locator(`[data-conversation-session="${childAgent.id}"]`)
    await childConversation.getByText(parentReplyBlock.text, { exact: true }).waitFor({ state: 'visible' })
    await expandTurnProcesses(page)
    await card.getByRole('img').waitFor({ state: 'visible' })
    for (let step = 0; step < experiment.steps; step++) await card.getByRole('button', { name: 'Step', exact: true }).click()
    await card.getByRole('button', { name: 'Use for next question', exact: true }).click()
    await card.getByRole('region', { name: experiment.review, exact: true })
      .getByRole('button', { name: 'Attach readings', exact: true }).click()
    await page.locator(`[data-artifact-prompt-context="${experiment.context}"]:visible`).waitFor({ state: 'visible' })
    await card.getByRole('button', { name: 'Step', exact: true }).click()
    const childTurn = scaffold.whenTurnSettled()
    const childInput = childConversation.locator('[data-composer-input][contenteditable="true"]')
    await childInput.fill(prompts[1]!)
    await childInput.press('Enter')
    expect(await childTurn).toBe(childAgent.id)
    await page.getByText(conclusion, { exact: true }).waitFor({ state: 'visible' })
    if (experiment.kind === 'function-plot') await expect.poll(() => card.getAttribute('data-artifact-revision')).toBe('2')
    const events = childAgent.session.snapshotEvents()
    const question = events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
    const result = events.findLast(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text === conclusion))
    if (question?.type !== 'user/message' || result?.type !== 'assistant/message') throw new Error('Branch question or conclusion is missing')
    const attachment = question.data.content[1]
    if (attachment?.type !== 'text') throw new Error('The branch question has no confirmed readings')
    const attached = object(JSON.parse(attachment.text.slice(attachment.text.indexOf('\n') + 1)))
    expect(attached.sessionId).toBe(childAgent.id)
    const facts = object(attached.facts)
    expect(facts.kind).toBe(experiment.context)
    expect(object(facts.artifact).revision).toBe(1)
    if (experiment.kind === 'particle-system') expect(facts.checkpoint).toEqual({ runtimeVersion: 1, stepCount: 6 })
    expect(events.some(event => event.type === 'artifact/observations')).toBe(false)

    const action = page.locator(`[data-branch-result-seq="${result.seq}"]:visible`)
    await action.getByRole('button', { name: 'Return with evidence', exact: true }).click()
    expect(await action.getByText(conclusion, { exact: true }).isVisible()).toBe(true)
    expect(await action.getByRole('radio', { name: 'Question readings', exact: true }).isChecked()).toBe(true)
    await expectQuestionReplay(action.locator('[data-branch-question-preview]'), experiment, facts)
    expect(results()).toEqual([])
    await action.getByRole('button', { name: 'Confirm return with evidence', exact: true }).click()
    const parentEvidence = page.locator('[data-artifact-branch-evidence-item="question"]:visible')
    const verifyParent = async (): Promise<void> => {
      await page.locator('[data-artifact-branch-evidence]:visible').getByText(conclusion, { exact: true }).waitFor({ state: 'visible' })
      await parentEvidence.getByRole('button', { name: 'Replay experiment', exact: true }).click()
      await expectQuestionReplay(parentEvidence, experiment, facts)
      const live = experiment.kind === 'particle-system'
        ? card.locator('[data-particle-step="0"]')
        : card.locator('label').filter({ hasText: /^Parameter a\b/u }).locator('output')
      await live.waitFor({ state: 'visible' })
      expect(await card.getAttribute('data-artifact-revision')).toBe('1')
      if (experiment.kind === 'function-plot') expect(await live.innerText()).toBe('1.00')
    }
    await verifyParent()
    expect(results()).toHaveLength(1)
    const returned = results()[0]
    expect(returned?.source).toMatchObject({ kind: 'branch-result', branchSessionId: childAgent.id, resultSeq: result.seq })
    expect(returned?.content[0]).toEqual({ type: 'text', text: conclusion })
    const evidenceBlock = returned?.content[1]
    if (evidenceBlock?.type !== 'text') throw new Error('The parent notice has no evidence')
    expect(JSON.parse(evidenceBlock.text.slice(evidenceBlock.text.indexOf('\n') + 1))).toEqual({
      kind: 'branch-result-artifact-evidence', branchSessionId: childAgent.id, evidence: { kind: 'question', questionSeq: question.seq, facts },
    })
    const parentConversation = page.locator(`[data-conversation-session="${parentId}"]`)
    const followupRow = parentConversation.locator('[data-chat-flow-kind="user"]:visible').filter({ hasText: PARENT_EVIDENCE_QUESTION })
    if (experiment.kind === 'function-plot') {
      const followup = parentEvidence.getByRole('button', { name: 'Use this evidence for next question', exact: true })
      const chip = parentConversation.locator('[data-artifact-prompt-context="branch-evidence"]')
      await followup.click()
      await chip.getByRole('button', { name: 'Replay experiment', exact: true }).click()
      await expectQuestionReplay(chip, experiment, facts)
      await chip.getByRole('button', { name: 'Remove question context', exact: true }).click()
      await chip.waitFor({ state: 'detached' })
      await followup.click()
      await chip.waitFor({ state: 'visible' })
      expect(parent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)

      const parentInput = parentConversation.locator('[data-composer-input][contenteditable="true"]')
      await parentInput.fill(PARENT_EVIDENCE_QUESTION)
      const settled = scaffold.whenTurnSettled()
      await parentInput.press('Enter')
      expect(await settled).toBe(parentId)
      const integral = object(facts.values).integral
      if (typeof integral !== 'number') throw new Error('The returned integral is missing')
      await parentConversation.getByText(`The selected readings record an integral of ${integral}.`, { exact: true }).waitFor({ state: 'visible' })
      await followupRow.locator('[data-artifact-question-context-origin="branch-evidence"]').waitFor({ state: 'visible' })
    }
    const warningStart = tripwire.warnings.length
    await page.reload()
    await parentEvidence.waitFor({ state: 'visible' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await verifyParent()
    if (experiment.kind === 'function-plot') {
      await followupRow.getByRole('button', { name: 'Replay experiment', exact: true }).click()
      await expectQuestionReplay(followupRow, experiment, facts)
    }
    expect(results()).toHaveLength(1)
    expect(parent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(experiment.kind === 'function-plot' ? 2 : 1)
    const persistedParent = await readPersistedEvents(scaffold, parentId)
    const persistedResults = persistedParent.filter(event => event.type === 'user/message' && event.data.source.kind === 'branch-result')
    expect(persistedResults.map(event => event.data)).toEqual(results())
    if (experiment.kind === 'function-plot') {
      const notice = persistedResults[0]
      if (notice?.type !== 'user/message') throw new Error('The returned function plot is missing from the saved Session')
      const returnAddress = { eventSeq: notice.seq, messageId: notice.data.id }
      const exactReturn = parentConversation.locator(`[data-artifact-branch-evidence][data-chat-message-seq="${notice.seq}"]`
        + `[data-chat-message-id="${notice.data.id}"]`).locator('[data-artifact-branch-evidence-item="question"]')
      const rootsBeforeExport = scaffold.ctx.agents.roots().map(agent => agent.id)
      const branchBeforeExport = await readPersistedEvents(scaffold, childAgent.id)
      const [download, response] = await Promise.all([
        page.waitForEvent('download'),
        page.waitForResponse(receipt => new URL(receipt.url()).pathname === '/api/artifactBranchResults/exportReturnedPlot'),
        exactReturn.getByRole('button', { name: 'Download experiment HTML', exact: true })
          .and(exactReturn.locator('[data-artifact-branch-download]')).click(),
      ])
      expect(response.ok()).toBe(true)
      expect(response.request().postDataJSON()).toHaveProperty('payload.args.request', { sessionId: parentId, ...returnAddress })
      const exportFile = join(scaffold.workspaceCwd, 'locked-returned-plot.html')
      await download.saveAs(exportFile)
      await expectOfflineLockedLinearPlot(page, exportFile,
        { sessionId: parentId, artifactId: experiment.artifactId, returnedEvidence: returnAddress },
        { functionId: facts.functionId, x: facts.x, parameters: facts.parameters, values: facts.values })
      expect(scaffold.ctx.agents.roots().map(agent => agent.id)).toEqual(rootsBeforeExport)
      expect(await readPersistedEvents(scaffold, parentId)).toEqual(persistedParent)
      expect(await readPersistedEvents(scaffold, childAgent.id)).toEqual(branchBeforeExport)
      await exerciseContinuedExperiment(page, scaffold, parentId, parentEvidence, tripwire)
    } else {
      await exerciseContinuedParticle(page, scaffold, parentId, parentEvidence, facts, tripwire)
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
