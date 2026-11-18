/** Live browser acceptance for sending a saved CSV return comparison after both draft source visits. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CSV_COMPARISON_QUESTION_PREFIX, csvComparisonChangesText } from '@agentrans/artifact/runtime-values'
import type { Locator, Request } from 'playwright'
import { expect, vi } from 'vitest'
import type { CsvExplanationBrowser } from './artifact-csv-explanation-support.ts'
import {
  csvReturnLink, expectFocused, expectWarmReturnComparison, frozenCsvReturnCards, visitCsvReturnDraftSources,
} from './artifact-csv-return-source-support.ts'
import { expectWarmComparisonAnswer } from './artifact-csv-support.ts'
import { csvFixtureChatHead, expectComparisonProviderText, seedWitnessedCsvReturnComparisonDraft } from './csv-comparison-browser-fixture.ts'
import { acknowledgeReloadConnectionLoss, readPersistedEvents } from './scaffold.ts'

const PROMPT = '/api/session/prompt'
const RECALCULATE = '/api/artifactBranchResults/recalculateCsv'
const LOOKUPS = new Set(['compareCsvReturns', 'compareCsvQuestionToReturn', 'csvFilterOptions', 'csvParticipatingRows',
  'csvQuestionParticipatingRows', 'csvReturnedParticipatingRows', 'lockCsv', 'recalculateCsv'].map(endpoint => `/api/artifactBranchResults/${endpoint}`))
const QUESTION = 'Using my attached comparison, explain how both readings were calculated and what happened to the contributing records. '
  + 'List their original CSV record numbers and recorded values.'

/** Restore both sources and the same unsent draft, and send it to the real provider once. */
export async function exerciseCsvReturnDraftSend({ page, world, evidence, requests, ask, providerUserText, stage, console }:
CsvExplanationBrowser): Promise<void> {
  const userAgent = await page.evaluate(() => navigator.userAgent)
  expect(userAgent).toMatch(/\bEdg\//u)
  await page.setViewportSize({ width: 1440, height: 1280 })
  const observed: string[] = []
  const watch = (request: Request): void => { observed.push(new URL(request.url()).pathname) }
  const reads = vi.spyOn(world.ctx.attachments, 'readFileStream').mockImplementation(() => {
    throw new Error('A saved return comparison must never open the original attachment in this test')
  })
  const metrics = () => ({ providerRequests: requests.length, promptRequests: observed.filter(path => path === PROMPT).length,
    csvReads: reads.mock.calls.length, csvRecomputes: observed.filter(path => path === RECALCULATE).length })
  const expectReadOnly = (intentionalSends: number): void => {
    expect(metrics()).toEqual({ providerRequests: intentionalSends, promptRequests: intentionalSends, csvReads: 0, csvRecomputes: 0 })
    expect(observed.filter(path => LOOKUPS.has(path))).toEqual([])
  }
  const reload = async (ready: () => Promise<void>): Promise<void> => {
    const before = console.warnings.length
    await page.reload()
    await ready()
    acknowledgeReloadConnectionLoss(console, before)
  }
  const screenshot = async (target: Locator, file: string): Promise<void> => {
    await target.screenshot({ path: join(evidence, file), animations: 'disabled' })
  }
  page.on('request', watch)
  try {
    stage('csv-return-draft-seed-without-provider')
    const systemHead = await csvFixtureChatHead(world)
    const { sessionId, draft, returns } = await seedWitnessedCsvReturnComparisonDraft(world, 'csv-live-return-draft', systemHead)
    const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
    await workspace.attachSession(sessionId)
    const workspaceRow = page.locator(`[data-row-key="workspace:${workspace.id}"]`)
    await reload(async () => { await workspaceRow.waitFor({ state: 'visible' }) })
    if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
    await page.locator(`[data-row-key="session:${sessionId}"]`).click()
    await expect.poll(() => world.ctx.agents.get(sessionId)?.session.snapshotEvents().some(event => event.type === 'approval/policy')).toBe(true)
    const agent = world.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('The recorded CSV inquiry Session did not activate')
    await agent.whenIdle()
    expect(await world.ctx.sessions.flush(agent.session)).toBe(true)
    const initial = await readPersistedEvents(world, sessionId)
    const conversation = page.locator(`[data-conversation-session="${sessionId}"]`)
    const chip = conversation.locator('[data-artifact-prompt-context="csv-question-comparison"]')
    const input = conversation.locator('[data-composer-input][contenteditable="true"]')
    await chip.waitFor({ state: 'visible' })
    expectReadOnly(0)

    stage('csv-return-draft-visit-and-restore-both-sources')
    const selections = await visitCsvReturnDraftSources({ page, world, sessionId, conversation, returns, draft,
      text: QUESTION, reload, screenshot, reloadAfterFinalReturn: false })
    expectReadOnly(0)
    expect(await readPersistedEvents(world, sessionId)).toEqual(initial)
    expect(await world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toEqual(draft)
    const beforeSend = { ...metrics(), sameDraftReceiptAndFacts: true, historyUnchanged: true, exactRestoredSelections: selections }

    stage('csv-return-draft-send-one-real-question')
    expect(await ask(QUESTION, sessionId, true)).toBe(sessionId)
    expectReadOnly(1)
    await expect.poll(() => world.ctx.artifactBranchResults.readCsvComparisonDraft({ sessionId })).toBeNull()
    await chip.waitFor({ state: 'hidden' })
    await expect.poll(() => input.textContent()).toBe('')
    const history = await readPersistedEvents(world, sessionId)
    expect(history.slice(0, initial.length)).toEqual(initial)
    const added = history.slice(initial.length)
    expect(added.filter(event => event.type === 'turn/start')).toHaveLength(1)
    const sent = added.find(event => event.type === 'user/message' && event.data.source.kind === 'user'
      && event.data.content.some(block => block.type === 'text' && block.text === QUESTION))
    if (sent?.type !== 'user/message') throw new Error('The restored draft did not become the recorded question')
    const context = sent.data.content[1]
    if (context?.type !== 'text' || !context.text.startsWith(CSV_COMPARISON_QUESTION_PREFIX)) throw new Error('Missing confirmed comparison')
    expect(JSON.parse(context.text.slice(CSV_COMPARISON_QUESTION_PREFIX.length))).toEqual({ kind: 'artifact-question-context', sessionId,
      facts: draft.facts })
    const changes = csvComparisonChangesText(draft.facts.comparison)
    expect(sent.data.content).toEqual([QUESTION, context.text, changes].map(text => ({ type: 'text', text })))
    const modelBlocks = providerUserText(QUESTION)
    expect(modelBlocks.filter(text => text === QUESTION)).toHaveLength(1)
    const questionIndex = modelBlocks.indexOf(QUESTION)
    const returnHistory = initial.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'branch-result'
      ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
    expect(modelBlocks.slice(0, questionIndex)).toEqual(returnHistory)
    expectComparisonProviderText(modelBlocks.slice(questionIndex), QUESTION, context.text, changes)
    expect(modelBlocks.every(text => !text.includes('"proof"') && !text.includes('"receiptId"') && !text.includes(draft.receiptId))).toBe(true)
    expect(added.filter(event => event.type === 'tool/call')).toEqual([])
    const final = added.findLast(event => event.type === 'assistant/message')
    if (final?.type !== 'assistant/message') throw new Error('The real provider did not answer the restored CSV comparison')
    const answer = final.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expectWarmComparisonAnswer(answer)

    stage('csv-return-draft-replay-sent-and-both-saved-cards')
    const comparison = conversation.locator(`[data-chat-message-id="${sent.data.id}"][data-chat-message-seq="${sent.seq}"] [data-csv-compare-attached]`)
    const open = comparison.getByRole('button', { name: 'Replay attached comparison', exact: true })
    const sources = frozenCsvReturnCards(conversation, returns, 'comparison')
    for (const { side, source, back, checkSource } of sources) {
      await reload(async () => { await open.waitFor({ state: 'visible' }) })
      await open.click()
      await expectWarmReturnComparison(comparison)
      if (side === 'first') await screenshot(comparison, 'csv-inquiry-draft-sent-after-refresh.png')
      await csvReturnLink(comparison, side).click()
      await checkSource()
      await screenshot(source, `csv-inquiry-draft-sent-source-${side}.png`)
      await back.click()
      await expectFocused(csvReturnLink(comparison, side))
    }
    expectReadOnly(1)
    expect(await readPersistedEvents(world, sessionId)).toEqual(history)
    expect(console.warnings).toEqual([])
    expect(console.pageErrors).toEqual([])
    await writeFile(join(evidence, 'csv-inquiry-draft-send-acceptance.json'), JSON.stringify({ userAgent, returns,
      lockedComparison: draft.facts.comparison, sent: { eventSeq: sent.seq, messageId: sent.data.id }, answer, beforeSend, ...metrics(),
      extraProviderCallsForSourceVisitsAndReplay: 0, bothExactSentSourcesReopened: true, persistedCanonicalMatchesSavedDraft: true,
    }, null, 2) + '\n')
  } finally {
    page.off('request', watch)
    reads.mockRestore()
  }
}
