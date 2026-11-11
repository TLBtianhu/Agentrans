// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, fixtureUserPrompts, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
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
    for (const label of ['A', 'B']) await evidenceAction().getByLabel(`Observed values: ${label}`, { exact: true }).waitFor({ state: 'visible' })
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
    expect(returned?.data.source).toEqual({ kind: 'branch-result', branchSessionId: childId,
      resultSeq: result.seq, resultMessageId: result.data.message.id, form: 'notice' })
    expect(returned?.data.content).toHaveLength(2)
    expect(returned?.data.content[0]).toEqual({ type: 'text', text: CONCLUSION })
    const evidenceBlock = returned?.data.content[1]
    if (evidenceBlock?.type !== 'text' || !evidenceBlock.text.startsWith(PREFIX)) throw new Error('Host evidence block is missing')
    const evidence: unknown = JSON.parse(evidenceBlock.text.slice(PREFIX.length))
    const saved = child.session.snapshotEvents().flatMap(event => event.type === 'artifact/observations' ? event.data.observations : [])
    const control = saved.find(fact => fact.observationId === controlId)
    const variant = saved.find(fact => fact.observationId === variantId)
    if (control === undefined || variant === undefined) throw new Error('Child evidence facts are missing')
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
