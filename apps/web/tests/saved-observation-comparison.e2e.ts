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
import { connectFreshWorkspace } from './support.ts'

// Authored model output exercises saved comparison facts through the shipped Web profile.
const DIR = fileURLToPath(new URL('./fixtures/replay/saved-observation-comparison', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const GROUP = 'saved-gravity-study'
type Role = 'control' | 'variant'

describe.skipIf(webSnapshotMode() === 'record')('web e2e: saved observation comparison', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    process.env.AGENTRANS_TEST_CUSTOM_KEY = 'local-test-key'
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE, compareReplaySession: false, paceMs: 10,
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

  it('pins compatible saved revisions, reselects them after reload, and sends their ordered pair once', async () => {
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(2)
    const firstTurn = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await firstTurn
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Saved-comparison Session is not live')
    const actions = () => agent.session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'artifact-action' ? [event.data] : [])
    const turns = () => agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length
    const group = () => page.locator(`section[data-comparison-group="${GROUP}"]:visible`).last()
    const card = (role: Role) => group().locator(`[data-comparison-role="${role}"] section[data-artifact-revision]`)
    const savedRow = (role: Role, label: string) => card(role).locator('section[aria-label="Saved observations"] li')
      .filter({ has: page.getByText(label, { exact: true }) })
    const select = (role: Role, label: string) => savedRow(role, label).getByRole('button', { name: 'Use for comparison', exact: true }).click()
    const send = () => group().getByRole('button', { name: 'Send comparison', exact: true })
    const save = async (role: Role, label: string): Promise<string> => {
      await card(role).getByRole('textbox', { name: 'Observation name', exact: true }).fill(label)
      await card(role).getByRole('button', { name: 'Save observation', exact: true }).click()
      await savedRow(role, label).waitFor({ state: 'visible' })
      const id = await savedRow(role, label).getAttribute('data-observation-id')
      if (id === null || id.length === 0) throw new Error(`Saved observation ${label} has no identity`)
      return id
    }

    const processControls = page.locator('[data-turn-process], [data-process-activity]')
    for (let index = 0; index < await processControls.count(); index++) {
      const control = processControls.nth(index)
      if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
    }
    await group().waitFor({ state: 'visible', timeout: 15_000 })
    for (const role of ['control', 'variant'] as const) {
      await card(role).locator('canvas[aria-label="Interactive particle simulation"]').waitFor({ state: 'visible' })
      for (let step = 0; step < 6; step++) await card(role).getByRole('button', { name: 'Step', exact: true }).click()
    }
    const controlId = await save('control', 'A')
    const variantId = await save('variant', 'B')
    await card('control').getByRole('button', { name: 'Step', exact: true }).click()
    await save('control', 'A7')
    await select('control', 'A7')
    await select('variant', 'B')
    await group().getByText('Select observations with the same runtime version, time step, and step count.', { exact: true })
      .waitFor({ state: 'visible' })
    expect(await send().isEnabled()).toBe(false)
    await select('control', 'A')
    await expect.poll(() => send().isEnabled()).toBe(true)
    await card('control').getByRole('button', { name: 'Return to latest', exact: true }).click()
    await expect.poll(() => send().isEnabled()).toBe(false)
    await select('control', 'A')
    await expect.poll(() => send().isEnabled()).toBe(true)
    for (const role of ['control', 'variant'] as const) {
      await card(role).locator('[data-particle-step="6"][data-particle-time="0.2"]').waitFor({ state: 'visible' })
      expect(await card(role).getAttribute('data-artifact-revision')).toBe('1')
    }
    expect(actions()).toEqual([])
    expect(turns()).toBe(1)

    const sourceUpdate = scaffold.whenTurnSettled()
    await input.fill(prompts[1]!)
    await input.press('Enter')
    expect(await sourceUpdate).toBe(sessionId)
    await page.getByText('Both current sources are revision 2. The selected observations still describe revision 1.', { exact: true })
      .waitFor({ state: 'visible' })
    const updates = agent.session.snapshotEvents().flatMap(event => event.type === 'artifact/upsert' ? [event.data] : [])
    for (const role of ['control', 'variant'] as const) {
      expect(updates.findLast(snapshot => snapshot.artifactId === `gravity-${role}`)).toMatchObject({
        revision: 2, format: 'scene',
        spec: { kind: 'particle-system', particles: [{ id: 'alpha', x: role === 'control' ? 10 : 20 }] },
      })
      expect(await card(role).getAttribute('data-artifact-revision')).toBe('1')
      await card(role).locator('[data-particle-step="6"]').waitFor({ state: 'visible' })
    }
    expect(actions()).toEqual([])
    expect(turns()).toBe(2)

    const reloadAndReopen = async (): Promise<void> => {
      const warningStart = tripwire.warnings.length
      await page.reload()
      await savedRow('control', 'A').waitFor({ state: 'visible' })
      acknowledgeReloadConnectionLoss(tripwire, warningStart)
      await page.getByRole('button', { name: 'New session', exact: true }).last().click()
      const search = page.getByRole('button', { name: 'Search sessions', exact: true })
      if (await search.getAttribute('aria-expanded') !== 'true') await search.click()
      await page.getByRole('textbox', { name: 'Search session names', exact: true }).fill('Compare saved particle')
      const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
      await expect.poll(() => results.count()).toBe(1)
      await results.click()
      await savedRow('control', 'A').waitFor({ state: 'visible' })
      await savedRow('control', 'A7').waitFor({ state: 'visible' })
      await savedRow('variant', 'B').waitFor({ state: 'visible' })
      for (const role of ['control', 'variant'] as const) {
        await expect.poll(() => card(role).getAttribute('data-artifact-revision')).toBe('2')
        await card(role).locator('[data-particle-step="0"]').waitFor({ state: 'visible' })
      }
      expect(await send().isEnabled()).toBe(false)
      await select('control', 'A')
      await select('variant', 'B')
      await expect.poll(() => send().isEnabled()).toBe(true)
      for (const role of ['control', 'variant'] as const) {
        await expect.poll(() => card(role).getAttribute('data-artifact-revision')).toBe('1')
        await card(role).locator('[data-particle-step="6"][data-particle-time="0.2"]').waitFor({ state: 'visible' })
      }
    }
    await reloadAndReopen()
    expect(await savedRow('control', 'A').getAttribute('data-observation-id')).toBe(controlId)
    expect(await savedRow('variant', 'B').getAttribute('data-observation-id')).toBe(variantId)
    expect(actions()).toEqual([])
    expect(turns()).toBe(2)

    const comparisonTurn = scaffold.whenTurnSettled()
    await send().click()
    expect(await comparisonTurn).toBe(sessionId)
    await page.getByText('The saved variant is higher at the same six-step checkpoint; both observations came from revision 1.', { exact: true })
      .waitFor({ state: 'visible' })
    expect(actions()).toHaveLength(1)
    expect(actions()[0]?.source).toEqual({ kind: 'artifact-action', artifactId: 'gravity-control', revision: 1 })
    const facts = agent.session.snapshotEvents().flatMap(event => event.type === 'artifact/observations' ? event.data.observations : [])
    const control = facts.find(fact => fact.observationId === controlId)
    const variant = facts.find(fact => fact.observationId === variantId)
    if (control === undefined || variant === undefined) throw new Error('Comparison lost its saved observations')
    for (const fact of [control, variant]) {
      expect(fact.artifact.revision).toBe(1)
      expect(fact.artifact.spec.kind).toBe('particle-system')
      if (fact.artifact.spec.kind !== 'particle-system') throw new Error('Comparison source is not a particle system')
      expect(fact.artifact.spec.particles[0]?.x).toBe(1)
      expect(fact.checkpoint).toEqual({ runtimeVersion: 1, stepCount: 6 })
      expect(fact.values.time).toBeCloseTo(0.2, 12)
      expect(fact.values.particles).toHaveLength(1)
      expect(fact.values.particles[0]?.x).toBeCloseTo(1.6, 12)
    }
    expect(control.values.particles[0]?.y).toBeCloseTo(1 + 8 * 0.2 - 9.8 * (1 / 30) ** 2 * 6 * 5 / 2, 12)
    expect(variant.values.particles[0]?.y).toBeCloseTo(1 + 8 * 0.2 - 4 * (1 / 30) ** 2 * 6 * 5 / 2, 12)
    const block = actions()[0]?.content[0]
    if (block?.type !== 'text') throw new Error('Saved comparison did not enter one text block')
    const recorded: unknown = JSON.parse(block.text)
    expect(recorded).toEqual({
      kind: 'artifact_action', artifactId: 'gravity-control', revision: 1, action: 'comparison.completed',
      payload: {
        kind: 'saved-particle-observation-comparison', group: GROUP,
        conditions: { runtimeVersion: 1, timeStep: 1 / 30, stepCount: 6, time: 0.2 },
        control: { ref: { artifactId: 'gravity-control', observationId: controlId }, label: 'A', revision: 1, values: control.values },
        variant: { ref: { artifactId: 'gravity-variant', observationId: variantId }, label: 'B', revision: 1, values: variant.values },
      },
    })
    expect(turns()).toBe(3)

    await reloadAndReopen()
    await send().click()
    await group().getByText('Comparison sent to Agent.', { exact: true }).waitFor({ state: 'visible' })
    expect(actions()).toHaveLength(1)
    expect(turns()).toBe(3)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(DIR, ['session.v4.jsonl'])
  })
})
