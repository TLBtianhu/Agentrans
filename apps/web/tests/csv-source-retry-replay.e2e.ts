// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionId } from '@agentrans/session'
import { chromium, type Locator, type Request } from 'playwright'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { runRetainedCsvRetryScenarios } from './csv-source-retry-browser.ts'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, launchWebScaffold, readPersistedEvents,
  seedSession, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/replay/csv-source-retry-replay', import.meta.url))
const RETAINED_SIDEBAR = fileURLToPath(new URL('./fixtures/plugins/fixture-retained-sidebar', import.meta.url))
const CSV_SOURCE_ENDPOINTS = new Set([
  'compareCsvQuestionToReturn', 'csvFilterOptions', 'csvParticipatingRows', 'csvQuestionParticipatingRows',
  'csvReturnedParticipatingRows', 'lockCsv', 'recalculateCsv',
])

function questionAddress(history: Awaited<ReturnType<typeof readPersistedEvents>>, title: string) {
  const question = history.find(event => event.type === 'user/message' && event.data.content.some(block =>
    block.type === 'text' && block.text === title))
  if (question?.type !== 'user/message') throw new Error(`Missing fixture question: ${title}`)
  return { eventSeq: question.seq, messageId: question.data.id }
}

async function expectPath(comparison: Locator, stops: readonly ReturnType<typeof questionAddress>[]): Promise<void> {
  const trail = comparison.locator('[data-csv-source-trail]')
  await trail.waitFor({ state: 'visible' })
  expect(await trail.locator('[data-csv-source-trail-stop]').evaluateAll(items => items.map(item => ({
    eventSeq: Number(item.getAttribute('data-csv-source-event-seq')),
    messageId: item.getAttribute('data-csv-source-message-id'),
  })))).toEqual(stops)
  const original = comparison.locator('[data-csv-compare-reading="original"] [data-csv-reading="value"]')
  const locked = comparison.locator('[data-csv-compare-reading="locked"] [data-csv-reading="value"]')
  expect(await original.textContent()).toBe('30')
  expect(await locked.textContent()).toBe('35')
}

it.skipIf(webSnapshotMode() === 'record')('recovers retained CSV source paths across two session round trips', async () => {
  const sessionFile = 'session.v4.jsonl'
  const primaryFixture = join(FIXTURE, 'a')
  const otherFixture = join(FIXTURE, 'b')
  await Promise.all([assertFixtureInventory(primaryFixture, [sessionFile]), assertFixtureInventory(otherFixture, [sessionFile])])
  const world = await launchWebScaffold({
    compareReplaySession: false,
    extraInstallAnchors: [join(RETAINED_SIDEBAR, 'package.json')],
    extraOverlayPath: join(RETAINED_SIDEBAR, 'cordis.patch.yml'),
  })
  onTestFinished(() => world.close())
  const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
  const primary = await seedSession(world, await readFile(join(primaryFixture, sessionFile), 'utf8'), 'csv-source-retry-a', 'chat')
  const other = await seedSession(world, await readFile(join(otherFixture, sessionFile), 'utf8'), 'csv-source-retry-b', 'chat')
  await workspace.attachSession(primary)
  await workspace.attachSession(other)

  const executablePath = process.env.AGENTRANS_PLAYWRIGHT_EXECUTABLE_PATH
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'csv-source-retry-replay'))
  const console = watchConsole(page)
  // With no model replay fixture the scaffold also fails loud on any model stream.
  const newActivity: string[] = []
  const stopActivity = world.ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/start' || event.type === 'request/header' || event.type === 'assistant/attempt') {
      newActivity.push(event.type)
    }
  }, { global: true })
  const reads = vi.spyOn(world.ctx.attachments, 'readFileStream').mockImplementation(() => {
    throw new Error('Historical source navigation attempted to read an attachment')
  })
  const unexpectedRequests: string[] = []
  const recordRequest = (request: Request): void => {
    const { pathname } = new URL(request.url())
    const csvEndpoint = pathname.split('/').at(-1)
    if (pathname === '/api/session/prompt' || (pathname.startsWith('/api/artifactBranchResults/')
      && csvEndpoint !== undefined && CSV_SOURCE_ENDPOINTS.has(csvEndpoint))) unexpectedRequests.push(pathname)
  }
  page.on('request', recordRequest)
  try {
    await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
    const openedHistory = async (sessionId: SessionId) => {
      await page.locator(`[data-row-key="session:${sessionId}"]`).click()
      // Cold history is visible before the Host has finished pinning initial permissions.
      await expect.poll(() => world.ctx.agents.get(sessionId)?.session.snapshotEvents().some(event =>
        event.type === 'approval/policy')).toBe(true)
      const agent = world.ctx.agents.get(sessionId)
      if (agent === undefined) throw new Error(`The fixture Session did not activate: ${sessionId}`)
      await agent.whenIdle()
      expect(await world.ctx.sessions.flush(agent.session)).toBe(true)
      return await readPersistedEvents(world, sessionId)
    }
    const primaryHistory = await openedHistory(primary)
    const otherHistory = await openedHistory(other)
    const origin = questionAddress(primaryHistory, 'A comparison origin')
    const fallback = questionAddress(primaryHistory, 'A comparison fallback')
    const retainedTarget = questionAddress(primaryHistory, 'A original CSV comparison')
    const otherOrigin = questionAddress(otherHistory, 'B comparison origin')
    const otherTarget = questionAddress(otherHistory, 'B original CSV comparison')

    const comparison = (session: SessionId, message: ReturnType<typeof questionAddress>) => page
      .locator(`[data-conversation-session="${session}"]`)
      .locator(`[data-chat-message-seq="${message.eventSeq}"][data-chat-message-id="${message.messageId}"]`)
      .locator('[data-csv-compare-attached]')
    const openRetainedSource = async (): Promise<void> => {
      const departure = comparison(primary, origin)
      const disclosure = departure.locator('[data-chat-message-control="artifact-csv-comparison"]')
      await disclosure.waitFor({ state: 'visible' })
      if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click()
      await departure.getByRole('button', { name: 'View full source chain', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Source chain', exact: true })
      await dialog.locator(`[data-csv-source-chain-stop][data-csv-source-event-seq="${retainedTarget.eventSeq}"]`
        + `[data-csv-source-message-id="${retainedTarget.messageId}"]`).getByRole('button').click()
      await dialog.waitFor({ state: 'hidden' })
      await expectPath(comparison(primary, retainedTarget), [origin, fallback, retainedTarget])
    }

    const { retainedRetryScenarios } = await runRetainedCsvRetryScenarios({
      page, retainedSessionId: primary, otherSessionId: other, fallback, retainedTarget, otherOrigin, otherTarget,
      roundTrips: 2,
      openRetainedSource,
      readTraffic: () => [unexpectedRequests.length, reads.mock.calls.length, newActivity.length],
      async reloadAndCheck(check) {
        const warnings = console.warnings.length
        await page.reload()
        await check()
        acknowledgeReloadConnectionLoss(console, warnings)
      },
      async assertPath(path) {
        switch (path) {
          case 'fallback':
            await expectPath(comparison(primary, fallback), [origin, fallback])
            break
          case 'retained':
            await expectPath(comparison(primary, retainedTarget), [origin, fallback, retainedTarget])
            break
          case 'other':
            await expectPath(comparison(other, otherTarget), [otherOrigin, otherTarget])
            break
        }
      },
      async assertUnchanged() {
        expect(await readPersistedEvents(world, primary)).toEqual(primaryHistory)
        expect(await readPersistedEvents(world, other)).toEqual(otherHistory)
      },
    })
    expect(retainedRetryScenarios.map(({ outcome, roundTrips }) => [outcome, roundTrips])).toEqual([
      ['retry-before-delivery', 2], ['stay-in-b', 2], ['retry-after-delivery', 2],
    ])
    expect(unexpectedRequests).toEqual([])
    expect(reads).not.toHaveBeenCalled()
    expect(newActivity).toEqual([])
    expect(console.warnings).toEqual([])
    expect(console.pageErrors).toEqual([])
  } finally {
    page.off('request', recordRequest)
    reads.mockRestore()
    stopActivity()
  }
})
