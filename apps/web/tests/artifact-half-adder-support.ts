/** Shared real-browser acceptance for a program-reported half-adder checkpoint. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HtmlArtifactSnapshot } from '@agentrans/artifact/types'
import type { ArtifactBranchExportReturnedHalfAdderRequest } from '@agentrans/artifact-branch/types'
import type { SessionId } from '@agentrans/session'
import type { Browser, FrameLocator, Locator, Page, Request } from 'playwright'
import { expect } from 'vitest'
import { acknowledgeReloadConnectionLoss, readPersistedEvents, type watchConsole, type WebScaffold } from './scaffold.ts'
import { expandOwningTurnProcess, scrollIntoView } from './support.ts'

/** Requests shared with the deterministic replay. */
export const HALF_ADDER_PROMPTS = {
  parent: 'What is an XOR gate? Answer in one sentence.',
  create: 'Build a compact, inline interactive half-adder. Start with A=0 and B=0. Make A and B independent checkboxes '
    + 'with the aria-labels Input A and Input B. Show the current sum and carry as individual 0/1 readouts with the aria-labels Sum and Carry. '
    + 'Let me attach the displayed state to a question and resume it after reload. Keep the visual design compact and readable.',
  branch: 'For the attached half-adder state, list A, B, sum and carry on separate labeled lines, then explain the outputs in text.',
  style: (artifactId: string) => `Update the existing half-adder (${artifactId}) in place. `
    + 'Give the numeric Sum readout a visible solid 3px purple outline (#ad279a) for either output value. '
    + 'Keep the controls, labels, truth table and ability to lock and restore readings.',
  followup: 'For the new half-adder state attached to this question, list A, B, sum and carry on separate labeled lines, '
    + 'then explain in text why those two output bits differ.',
} as const

const LIVE_CREATE = 'Build a compact interactive half-adder right in this answer. Start with both inputs off. '
  + 'Let me switch the inputs independently with checkboxes named Input A and Input B. '
  + 'Show two separate numeric readouts with the accessible names Sum and Carry. '
  + 'Let me lock the displayed readings, attach them to a follow-up, and reopen the same state after a refresh.'

const KIND = 'half-adder-checkpoint'
const FIELDS = ['a', 'b', 'sum', 'carry'] as const
const CHECKPOINTS = {
  '00': { kind: KIND, a: 0, b: 0, sum: 0, carry: 0 },
  '10': { kind: KIND, a: 1, b: 0, sum: 1, carry: 0 },
  '11': { kind: KIND, a: 1, b: 1, sum: 0, carry: 1 },
  '01': { kind: KIND, a: 0, b: 1, sum: 1, carry: 0 },
} as const
type Checkpoint = typeof CHECKPOINTS[keyof typeof CHECKPOINTS]
type Ask = (prompt: string, sessionId?: SessionId) => Promise<SessionId>

interface HalfAdderInquiry {
  readonly evidence: string
  readonly selectPhrase: (source: Locator, phrase: string) => Promise<void>
  readonly verifyCreationRequest: (quotedPrompt: string) => void
}

const INQUIRY_PHRASE = 'XOR gate'

async function expectHalfAdderFields(scope: Locator, state: Checkpoint): Promise<void> {
  for (const name of FIELDS) {
    await expect.poll(() => scope.locator(`[data-artifact-half-adder-${name}]`).textContent()).toBe(String(state[name]))
  }
}

function halfAdderControls(frame: FrameLocator) {
  const a = frame.getByRole('checkbox', { name: 'Input A', exact: true })
  const b = frame.getByRole('checkbox', { name: 'Input B', exact: true })
  return {
    a,
    b,
    async expectState(state: Checkpoint) {
      expect(await a.isChecked()).toBe(state.a === 1)
      expect(await b.isChecked()).toBe(state.b === 1)
      const output = (name: 'Sum' | 'Carry') => frame.getByLabel(name, { exact: true }).evaluate(node =>
        (node instanceof HTMLInputElement ? node.value : node.textContent ?? '').trim(), { timeout: 5_000 })
      await expect.poll(() => output('Sum')).toBe(String(state.sum))
      await expect.poll(() => output('Carry')).toBe(String(state.carry))
    },
  }
}

function sumOutline(frame: FrameLocator) {
  return frame.getByLabel('Sum', { exact: true }).evaluate((element) => {
    const style = getComputedStyle(element)
    return { color: style.outlineColor, style: style.outlineStyle, width: style.outlineWidth }
  })
}

type SumOutline = Awaited<ReturnType<typeof sumOutline>>

async function verifyHalfAdderExport(input: {
  readonly browser: Browser
  readonly card: Locator
  readonly page: Page
  readonly directory: string
  readonly request: ArtifactBranchExportReturnedHalfAdderRequest
  readonly source: HtmlArtifactSnapshot
  readonly lockedSumOutline: SumOutline
  readonly capture: boolean
  readonly returned?: Pick<ArtifactBranchExportReturnedHalfAdderRequest, 'eventSeq' | 'messageId'> & { readonly filename: string }
}) {
  const { browser, card, page, directory, request, source, lockedSumOutline, returned } = input
  const sent = returned !== undefined
  const endpoint = sent ? 'exportSentHalfAdder' : 'exportReturnedHalfAdder'
  const marker = sent ? '[data-artifact-question-download]' : '[data-artifact-branch-download]'
  const forbiddenRequests: string[] = []
  const watchedPaths = ['/api/session/prompt', '/api/session/fork', '/api/artifactExports/create', '/api/artifactExports/read']
  if (sent) watchedPaths.push('/api/artifactBranchResults/exportReturnedHalfAdder')
  const watchExport = (observed: Request): void => {
    const path = new URL(observed.url()).pathname
    if (watchedPaths.includes(path)) forbiddenRequests.push(path)
  }
  const filePrefix = sent ? 'sent-question' : 'inquiry-returned'
  const filename = `${filePrefix}-locked-half-adder.html`
  const offlineContext = await browser.newContext({ offline: true })
  const network: string[] = []
  const errors: string[] = []
  const { sessionId, eventSeq, messageId } = request
  const { artifactId, revision } = source
  const loadExport = async (
    name: string, key: 'sentQuestion' | 'returnedEvidence', address: { eventSeq: number; messageId: string }, checkpoint: Checkpoint,
  ) => {
    const offline = await offlineContext.newPage()
    offline.on('request', (observed) => { if (/^https?:/u.test(observed.url())) network.push(observed.url()) })
    offline.on('websocket', (socket) => { network.push(socket.url()) })
    offline.on('pageerror', (error) => { errors.push(error.message) })
    await offline.goto(pathToFileURL(join(directory, name)).href)
    const frame = offline.locator('iframe[data-exported-half-adder-frame]')
    const restored = offline.locator('[data-half-adder-export-status="restored"]')
    await restored.waitFor({ state: 'visible' })
    expect(await frame.getAttribute('sandbox')).toBe('allow-scripts')
    const origin: unknown = JSON.parse(await offline.locator('#artifact-export-origin-data').textContent() ?? 'null')
    expect(origin).toMatchObject({ exporterVersion: 1, sessionId, artifactId, revision, [key]: address, checkpoint })
    expect(origin).not.toHaveProperty(key === 'sentQuestion' ? 'returnedEvidence' : 'sentQuestion')
    const exported = frame.contentFrame()
    const controls = halfAdderControls(exported)
    const expectLocked = async (): Promise<void> => {
      await controls.expectState(checkpoint)
      expect(await sumOutline(exported)).toEqual(lockedSumOutline)
    }
    await expectLocked()
    const reset = async (): Promise<void> => {
      await offline.getByRole('button', { name: 'Reset to locked step', exact: true }).click()
      await restored.waitFor({ state: 'visible' })
      await expectLocked()
    }
    return { offline, controls, expectLocked, reset }
  }
  page.on('request', watchExport)
  try {
    const [download, response] = await Promise.all([
      page.waitForEvent('download'),
      page.waitForResponse(result => new URL(result.url()).pathname === `/api/artifactBranchResults/${endpoint}`),
      card.getByRole('button', { name: 'Download experiment HTML', exact: true })
        .and(card.locator(marker)).click(),
    ])
    expect(response.ok()).toBe(true)
    expect(response.request().postDataJSON()).toHaveProperty('payload.args.request', request)
    expect(download.suggestedFilename()).toBe(`${sent ? 'sent' : 'returned'}-half-adder-${eventSeq}.html`)
    await download.saveAs(join(directory, filename))
    const locked = sent ? CHECKPOINTS['10'] : CHECKPOINTS['11']
    const exported = await loadExport(filename, sent ? 'sentQuestion' : 'returnedEvidence', { eventSeq, messageId }, locked)
    const original = returned === undefined ? undefined
      : await loadExport(returned.filename, 'returnedEvidence', { eventSeq: returned.eventSeq, messageId: returned.messageId }, CHECKPOINTS['11'])
    await exported.offline.bringToFront()
    const tour = sent ? [['a', '00'], ['b', '01'], ['a', '11']] as const
      : [['b', '10'], ['a', '00'], ['b', '01']] as const
    for (const [index, [toggle, state]] of tour.entries()) {
      const control = exported.controls[toggle]
      if (index === tour.length - 1) await control.press('Space')
      else await control.click()
      await exported.controls.expectState(CHECKPOINTS[state])
    }
    if (input.capture) {
      await exported.offline.screenshot({ path: join(directory, `${filePrefix}-half-adder-at-${tour[2][1]}-offline.png`) })
    }
    await exported.reset()
    if (input.capture) await exported.offline.screenshot({ path: join(directory, `${filePrefix}-locked-half-adder-offline.png`) })
    if (original !== undefined) {
      await original.offline.bringToFront()
      await original.controls.b.click()
      await original.controls.expectState(CHECKPOINTS['10'])
      await original.reset()
      await exported.expectLocked()
    }
    expect(network).toEqual([])
    expect(errors).toEqual([])
    expect(forbiddenRequests).toEqual([])
    return { filename, ...request, artifactId, revision, exporterVersion: 1,
      offlineStates: [locked, ...tour.map(([, state]) => CHECKPOINTS[state]), locked],
      ...(original === undefined ? {} : { independentReturnCheckpoint: CHECKPOINTS['11'] }),
      sumOutline: lockedSumOutline, restoredAfterReset: true, offlineRequests: network.length, forbiddenRequests }
  } finally {
    page.off('request', watchExport)
    await offlineContext.close()
  }
}

function expectHalfAdderAnswer(text: string, state: Checkpoint): void {
  const lines = text.split(/\r?\n/u).map(line => line.replace(/[*`]/gu, ''))
  for (const [name, field] of [['A', 'a'], ['B', 'b'], ['sum', 'sum'], ['carry', 'carry']] as const) {
    expect(lines.some(line => new RegExp(`\\b${name}\\s*[:=]\\s*${state[field]}\\b`, 'iu').test(line)), text).toBe(true)
  }
}

function attachmentJson(text: string): unknown {
  return JSON.parse(text.slice(text.indexOf('\n') + 1))
}

/**
 * Verify the truth table, return and export a branch reading, and confirm an independently restorable parent reading.
 * @param input - Browser, application and model verification callbacks.
 * @returns When both immutable parent checkpoints can be operated independently after reload.
 */
export async function exerciseHalfAdderJourney(input: {
  readonly browser: Browser
  readonly page: Page
  readonly world: WebScaffold
  readonly ask: Ask
  readonly console: ReturnType<typeof watchConsole>
  readonly stage?: (name: string) => void
  readonly requestCount: () => number
  readonly providerSaw?: (prompt: string, attachment: string) => boolean
  readonly capture?: (target: Locator, name: string) => Promise<void>
  readonly inquiry?: HalfAdderInquiry
}): Promise<void> {
  const { browser, page, world, ask, console, stage, requestCount, providerSaw, capture, inquiry } = input
  const conversation = (id: SessionId) => page.locator(`[data-conversation-session="${id}"]`)
  const selected = (id: SessionId) => page.locator(`[data-row-key="session:${id}"][aria-selected="true"]`)
  stage?.('half-adder-open-branch')
  const parentPrompt = inquiry === undefined ? HALF_ADDER_PROMPTS.parent
    : 'What is an XOR gate? Answer in one sentence and include the exact words “XOR gate” in the sentence.'
  const parentId = await ask(parentPrompt)
  const parent = conversation(parentId)
  const beforeBranch = requestCount()
  const launchInquiry = async (options: HalfAdderInquiry) => {
    const userAgent = await page.evaluate(() => navigator.userAgent)
    expect(userAgent).toMatch(/\bEdg\//u)
    await page.setViewportSize({ width: 1440, height: 1280 })
    const history = await readPersistedEvents(world, parentId)
    const answer = history.findLast(event => event.type === 'assistant/message' && event.data.message.content.some(block =>
      block.type === 'text' && block.text.includes(INQUIRY_PHRASE)))
    const end = history.findLast(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')
    if (answer?.type !== 'assistant/message' || end?.type !== 'turn/end') throw new Error('The half-adder inquiry passage is missing')
    const messageId = answer.data.message.id
    const source = parent.locator(`[data-chat-message-seq="${answer.seq}"][data-chat-message-id="${messageId}"]`)
    const span = source.locator('span[data-markdown-source-start][data-markdown-source-end]:visible').filter({ hasText: INQUIRY_PHRASE }).first()
    const offset = await span.getAttribute('data-markdown-source-start')
    const visibleText = await span.textContent()
    if (offset === null || visibleText === null) throw new Error('Missing the source offsets for the selected half-adder answer')
    const start = Number(offset) + visibleText.indexOf(INQUIRY_PHRASE)
    const reference = { messageSeq: answer.seq, messageId, start, end: start + INQUIRY_PHRASE.length, excerpt: INQUIRY_PHRASE }
    await options.selectPhrase(span, INQUIRY_PHRASE)
    const trigger = page.locator('[data-chat-inquiry-create]')
    await trigger.waitFor({ state: 'visible' })
    await page.screenshot({ path: join(options.evidence, 'half-adder-inquiry-selected-phrase.png') })
    const [forked] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/fork'), trigger.click(),
    ])
    expect(forked.request().postDataJSON()).toMatchObject({ payload: { args: { request: {
      sessionId: parentId, atSeq: end.seq, inquiry: reference,
    } } } })
    return { source, reference, userAgent }
  }
  const launched = inquiry === undefined ? undefined : await launchInquiry(inquiry)
  if (launched === undefined) {
    await parent.locator('[data-turn-tail="1"]:visible').getByRole('button', { name: 'Branch into a new conversation', exact: true }).click()
  }
  const child = () => world.ctx.agents.roots().find(agent => agent.session.header.parentSession === parentId)
  await expect.poll(() => child()?.id).toBeDefined()
  const childId = child()!.id
  await selected(childId).waitFor({ state: 'visible' })
  if (launched !== undefined) expect(child()?.session.header).toMatchObject({ parentSession: parentId, inquiry: launched.reference })

  stage?.('half-adder-generate-and-truth-table')
  const childConversation = conversation(childId)
  if (launched === undefined) expect(await ask(HALF_ADDER_PROMPTS.create, childId)).toBe(childId)
  else {
    await expect.poll(() => childConversation.locator('[data-composer-quote] [data-quote-preview-text]').textContent()).toBe(INQUIRY_PHRASE)
    const editor = childConversation.locator('[data-composer-input][contenteditable="true"]')
    await editor.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
    await page.keyboard.insertText(LIVE_CREATE)
    expect(requestCount()).toBe(beforeBranch)
    const settled = world.whenTurnSettled()
    await childConversation.getByRole('button', { name: 'Send message', exact: true }).click()
    expect(await settled).toBe(childId)
  }
  const generated = await readPersistedEvents(world, childId)
  if (inquiry !== undefined) {
    const quotedPrompt = `> ${INQUIRY_PHRASE}\n\n${LIVE_CREATE}`
    expect(generated.some(event => event.type === 'user/message' && event.data.content.some(block =>
      block.type === 'text' && block.text === quotedPrompt))).toBe(true)
    inquiry.verifyCreationRequest(quotedPrompt)
  }
  const artifacts = generated.flatMap(event => event.type === 'artifact/upsert' ? [event.data] : [])
  const source = artifacts.at(-1)
  if (source?.format !== 'html') throw new Error('Expected an interactive HTML half-adder')
  expect(new Set(artifacts.map(snapshot => snapshot.artifactId))).toEqual(new Set([source.artifactId]))
  const card = page.locator(`section[data-artifact-revision="${source.revision}"]`).filter({
    has: page.locator(`iframe[data-artifact-frame][data-artifact-id="${source.artifactId}"]`),
  })
  if (await childConversation.count() === 0) {
    const warningStart = console.warnings.length
    await page.reload()
    await childConversation.waitFor({ state: 'visible' })
    acknowledgeReloadConnectionLoss(console, warningStart)
  }
  await expandOwningTurnProcess(page, card)
  const live = halfAdderControls(card.frameLocator('[data-artifact-frame]'))
  const openReview = card.locator('[data-artifact-prompt-attach="html-runtime"]')
  const review = card.locator('[data-artifact-half-adder-review]')
  const expectLiveCheckpoint = async (state: Checkpoint): Promise<void> => {
    await live.expectState(state)
    if (inquiry === undefined) return
    await openReview.click()
    await expectHalfAdderFields(review, state)
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
  }
  const afterCreation = requestCount()
  await expectLiveCheckpoint(CHECKPOINTS['00'])
  await live.a.click()
  await expectLiveCheckpoint(CHECKPOINTS['10'])
  await live.b.click()
  await expectLiveCheckpoint(CHECKPOINTS['11'])
  await live.a.click()
  await expectLiveCheckpoint(CHECKPOINTS['01'])
  await live.a.click()
  await live.expectState(CHECKPOINTS['11'])
  await capture?.(card, 'half-adder-live-at-11')

  stage?.('half-adder-confirm-branch')
  await openReview.click()
  await expectHalfAdderFields(review, CHECKPOINTS['11'])
  await review.getByRole('button', { name: 'Attach readings', exact: true }).click()
  const branchChip = childConversation.locator('[data-artifact-prompt-context="html-half-adder"]')
  await expectHalfAdderFields(branchChip, CHECKPOINTS['11'])
  await live.a.click()
  await live.expectState(CHECKPOINTS['01'])
  expect(requestCount()).toBe(afterCreation)
  expect(await ask(HALF_ADDER_PROMPTS.branch, childId)).toBe(childId)
  const branchEvents = await readPersistedEvents(world, childId)
  expect(branchEvents.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : []))
    .toEqual(['completed', 'completed', 'completed'])
  expect(branchEvents.flatMap(event => event.type === 'artifact/upsert' ? [event.data] : [])).toEqual(artifacts)
  const question = branchEvents.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (question?.type !== 'user/message') throw new Error('Expected an ordinary half-adder branch question')
  const questionBlock = question.data.content[1]
  if (questionBlock?.type !== 'text') throw new Error('The branch question lost its confirmed half-adder state')
  expect(questionBlock.text).toContain('Use facts.capture.state for the selected input bits a and b and output bits sum and carry.')
  const confirmed = attachmentJson(questionBlock.text)
  if (typeof confirmed !== 'object' || confirmed === null || !('facts' in confirmed)) throw new Error('Expected confirmed half-adder facts')
  expect(confirmed).toMatchObject({ kind: 'artifact-question-context', sessionId: childId, facts: {
    kind: 'html-runtime', artifact: source, attribution: 'program-reported', capture: { status: 'ready', restore: KIND, state: CHECKPOINTS['11'] },
  } })
  if (providerSaw !== undefined) expect(providerSaw(HALF_ADDER_PROMPTS.branch, questionBlock.text)).toBe(true)
  const result = branchEvents.findLast(event => event.type === 'assistant/message')
  if (result?.type !== 'assistant/message') throw new Error('Expected the half-adder branch conclusion')
  const conclusion = result.data.message.content.filter(block => block.type === 'text')
  const branchAnswer = conclusion.map(block => block.text).join('\n')

  stage?.('half-adder-return-confirmed-branch')
  const parentBefore = await readPersistedEvents(world, parentId)
  const afterBranchQuestion = requestCount()
  const action = childConversation.locator(`[data-branch-result-seq="${result.seq}"]:visible`)
  await action.getByRole('button', { name: 'Return with evidence', exact: true }).click()
  expect(await action.getByRole('radio', { name: 'Question readings', exact: true }).isChecked()).toBe(true)
  const returnReview = action.locator('[data-branch-question-preview]')
  expect(await returnReview.textContent()).toContain(`revision ${source.revision}`)
  await expectHalfAdderFields(returnReview, CHECKPOINTS['11'])
  expect(await returnReview.locator('iframe').count()).toBe(0)
  await scrollIntoView(returnReview)
  await capture?.(returnReview, 'half-adder-return-review')
  expect(await readPersistedEvents(world, parentId)).toEqual(parentBefore)
  await action.getByRole('button', { name: 'Confirm return with evidence', exact: true }).click()
  await selected(parentId).waitFor({ state: 'visible' })
  const returnedItem = parent.locator('[data-artifact-branch-evidence-item="question"]:visible')
  await expectHalfAdderFields(returnedItem, CHECKPOINTS['11'])
  await expect.poll(async () => (await readPersistedEvents(world, parentId)).length).toBe(parentBefore.length + 1)
  const parentWithReturn = await readPersistedEvents(world, parentId)
  expect(parentWithReturn.slice(0, -1)).toEqual(parentBefore)
  const returned = parentWithReturn.at(-1)
  if (returned?.type !== 'user/message' || returned.data.source.kind !== 'branch-result') throw new Error('Expected the returned half-adder result')
  expect(returned.data.source).toMatchObject({ branchSessionId: childId, resultSeq: result.seq,
    resultMessageId: result.data.message.id, artifactEvidence: KIND })
  expect(returned.data.content.slice(0, -1)).toEqual(conclusion)
  const returnedBlock = returned.data.content.at(-1)
  if (returnedBlock?.type !== 'text') throw new Error('The returned result lost its half-adder evidence')
  expect(attachmentJson(returnedBlock.text)).toEqual({ kind: 'branch-result-artifact-evidence', branchSessionId: childId,
    evidence: { kind: 'question', questionSeq: question.seq, facts: confirmed.facts } })
  expect(requestCount()).toBe(afterBranchQuestion)

  stage?.('half-adder-continue-and-confirm-parent')
  const toggle = returnedItem.locator('[data-artifact-half-adder-replay-toggle]')
  const panel = returnedItem.locator('[data-artifact-half-adder-replay]')
  const iframeSelector = '[data-artifact-restoration="restored"] iframe[data-artifact-replay-frame]'
  const parentIframe = panel.locator(iframeSelector)
  const replay = halfAdderControls(parentIframe.contentFrame())
  const returnAddress = { eventSeq: returned.seq, messageId: returned.data.id }
  const exactReturn = parent.locator(`[data-artifact-branch-evidence][data-chat-message-id="${returned.data.id}"]`
    + `[data-chat-message-seq="${returned.seq}"]`)
  const inquiryResult = launched?.source.getByRole('button', { name: 'View returned result', exact: true })
    .and(launched.source.locator(`[data-inquiry-result="${childId}"]`))
  const openExactResult = async (): Promise<void> => {
    const callsBeforeOpen = requestCount()
    if (inquiryResult === undefined) await toggle.click()
    else {
      await inquiryResult.click()
      const control = exactReturn.locator('[data-chat-message-control="artifact-branch-result"]')
      await expect.poll(() => control.evaluate(element => element.ownerDocument.activeElement === element)).toBe(true)
    }
    await parentIframe.waitFor({ state: 'visible' })
    expect(await parentIframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(await parentIframe.getAttribute('data-artifact-id')).toBe(source.artifactId)
    expect(await parentIframe.getAttribute('data-artifact-revision')).toBe(String(source.revision))
    await replay.expectState(CHECKPOINTS['11'])
    await expectHalfAdderFields(returnedItem, CHECKPOINTS['11'])
    expect(requestCount()).toBe(callsBeforeOpen)
  }
  stage?.('half-adder-view-exact-inquiry-result')
  expect(await returnedItem.locator('iframe').count()).toBe(0)
  await openExactResult()
  await capture?.(exactReturn, 'half-adder-inquiry-result-before-refresh')
  const lockedSumOutline = await sumOutline(parentIframe.contentFrame())

  stage?.('half-adder-update-original-branch-style-after-return')
  const reopenBranch = launched?.source.locator(`[data-inquiry-branch="${childId}"]`)
    ?? page.locator(`[data-row-key="session:${childId}"]`)
  await reopenBranch.click()
  await selected(childId).waitFor({ state: 'visible' })
  expect(requestCount()).toBe(afterBranchQuestion)
  const stylePrompt = HALF_ADDER_PROMPTS.style(source.artifactId)
  expect(await ask(stylePrompt, childId)).toBe(childId)
  const branchEventsAfterStyle = await readPersistedEvents(world, childId)
  expect(branchEventsAfterStyle.slice(0, branchEvents.length)).toEqual(branchEvents)
  const appended = branchEventsAfterStyle.slice(branchEvents.length)
  expect(appended.some(event => event.type === 'user/message'
    && event.data.content.some(block => block.type === 'text' && block.text === stylePrompt))).toBe(true)
  const updates = appended.flatMap(event => event.type === 'artifact/upsert' ? [event.data] : [])
  const updated = updates.at(-1)
  if (updated?.format !== 'html') throw new Error('The model did not update the half-adder HTML Artifact after the return')
  expect(updates.every(snapshot => snapshot.artifactId === source.artifactId && snapshot.revision > source.revision)).toBe(true)
  expect(updated.source).not.toBe(source.source)
  const updatedCard = childConversation.locator(`section[data-artifact-revision="${updated.revision}"]`).filter({
    has: page.locator(`iframe[data-artifact-frame][data-artifact-id="${source.artifactId}"]`),
  })
  await expandOwningTurnProcess(page, updatedCard)
  const updatedFrame = updatedCard.frameLocator('[data-artifact-frame]')
  const updatedControls = halfAdderControls(updatedFrame)
  await updatedControls.expectState(CHECKPOINTS['00'])
  await updatedControls.a.click()
  await updatedControls.b.click()
  await updatedControls.expectState(CHECKPOINTS['11'])
  await expect.poll(() => sumOutline(updatedFrame)).toEqual({ color: 'rgb(173, 39, 154)', style: 'solid', width: '3px' })
  const updatedSumOutline = await sumOutline(updatedFrame)
  expect(updatedSumOutline).not.toEqual(lockedSumOutline)
  await capture?.(updatedCard, 'half-adder-branch-style-updated')
  expect(await readPersistedEvents(world, parentId)).toEqual(parentWithReturn)
  const callsAfterStyle = requestCount()
  expect(callsAfterStyle).toBeGreaterThan(afterBranchQuestion)
  await page.locator(`[data-row-key="session:${parentId}"]`).click()
  await selected(parentId).waitFor({ state: 'visible' })
  const warnings = console.warnings.length
  await page.reload()
  await exactReturn.waitFor({ state: 'visible' })
  expect(await returnedItem.locator('iframe').count()).toBe(0)
  expect(requestCount()).toBe(callsAfterStyle)

  stage?.('half-adder-download-directly-from-returned-result')
  const rootsBeforeExport = world.ctx.agents.roots().map(agent => agent.id)
  const exportDirectory = inquiry?.evidence ?? world.workspaceCwd
  const exportEvidence = await verifyHalfAdderExport({ browser, page, card: exactReturn, directory: exportDirectory,
    request: { sessionId: parentId, ...returnAddress }, source, lockedSumOutline, capture: inquiry !== undefined })
  expect(await returnedItem.locator('iframe').count()).toBe(0)
  expect(requestCount()).toBe(callsAfterStyle)
  expect(world.ctx.agents.roots().map(agent => agent.id)).toEqual(rootsBeforeExport)
  expect(await readPersistedEvents(world, childId)).toEqual(branchEventsAfterStyle)
  expect(await readPersistedEvents(world, parentId)).toEqual(parentWithReturn)
  await openExactResult()
  expect(await sumOutline(parentIframe.contentFrame())).toEqual(lockedSumOutline)
  acknowledgeReloadConnectionLoss(console, warnings)
  await capture?.(exactReturn, 'half-adder-inquiry-result-after-refresh')

  if (launched !== undefined && inquiry !== undefined) {
    await replay.b.click()
    await replay.expectState(CHECKPOINTS['10'])
    await expectHalfAdderFields(returnedItem, CHECKPOINTS['11'])
    await capture?.(exactReturn, 'half-adder-inquiry-local-toggle')
    await launched.source.locator(`[data-inquiry-branch="${childId}"]`).click()
    await selected(childId).waitFor({ state: 'visible' })
    await childConversation.locator(`[data-chat-message-id="${question.data.id}"]`).waitFor({ state: 'visible' })
    await page.locator(`[data-row-key="session:${parentId}"]`).click()
    await selected(parentId).waitFor({ state: 'visible' })
    await openExactResult()
    expect(await readPersistedEvents(world, childId)).toEqual(branchEventsAfterStyle)
    expect(await readPersistedEvents(world, parentId)).toEqual(parentWithReturn)
    await writeFile(join(inquiry.evidence, 'half-adder-inquiry-result-acceptance.json'), JSON.stringify({
      userAgent: launched.userAgent, parentId, childId, inquiry: launched.reference,
      generationPrompt: LIVE_CREATE, defaultCheckpointGuidanceSent: true,
      returned: returnAddress, locked: CHECKPOINTS['11'], localToggle: CHECKPOINTS['10'],
      postReturnStyleUpdate: { artifactId: source.artifactId, lockedRevision: source.revision, updatedRevision: updated.revision,
        lockedSumOutline, updatedSumOutline, providerRequests: callsAfterStyle - afterBranchQuestion },
      returnedHalfAdderExport: { ...exportEvidence, sessionLogsUnchanged: true, branchesUnchanged: true, providerRequests: 0 },
      exactFocusBeforeAndAfterRefresh: true, reopenedSameChild: true, extraProviderRequestsDuringInquiryNavigation: 0,
    }, null, 2) + '\n')
  }
  await replay.expectState(CHECKPOINTS['11'])
  await replay.b.click()
  await replay.expectState(CHECKPOINTS['10'])
  await panel.locator('[data-artifact-half-adder-followup]').click()
  const parentReview = panel.locator('[data-artifact-half-adder-review]')
  await expectHalfAdderFields(parentReview, CHECKPOINTS['10'])
  await parentReview.getByRole('button', { name: 'Attach readings', exact: true }).click()
  const parentChip = parent.locator('[data-artifact-prompt-context="branch-half-adder-checkpoint"]')
  await expectHalfAdderFields(parentChip, CHECKPOINTS['10'])
  await scrollIntoView(parentChip)
  await capture?.(parentChip, 'half-adder-confirmed-parent-followup')
  await replay.a.click()
  await replay.expectState(CHECKPOINTS['00'])
  await expectHalfAdderFields(parentChip, CHECKPOINTS['10'])
  await expectHalfAdderFields(returnedItem, CHECKPOINTS['11'])
  expect(await readPersistedEvents(world, parentId)).toEqual(parentWithReturn)
  expect(requestCount()).toBe(callsAfterStyle)

  stage?.('half-adder-parent-model-followup')
  expect(await ask(HALF_ADDER_PROMPTS.followup, parentId)).toBe(parentId)
  const parentWithQuestion = await readPersistedEvents(world, parentId)
  expect(parentWithQuestion.slice(0, parentWithReturn.length)).toEqual(parentWithReturn)
  expect(parentWithQuestion.filter(event => event.type === 'artifact/upsert')).toEqual([])
  expect(parentWithQuestion.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : []))
    .toEqual(['completed', 'completed'])
  const newQuestion = parentWithQuestion.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (newQuestion?.type !== 'user/message') throw new Error('The sent half-adder follow-up is missing')
  const newBlock = newQuestion.data.content[1]
  if (newBlock?.type !== 'text') throw new Error('The parent question lost its locked half-adder state')
  expect(newBlock.text).toContain('Use facts.state for the selected input bits a and b and output bits sum and carry.')
  expect(attachmentJson(newBlock.text)).toEqual({ kind: 'artifact-question-context', sessionId: parentId, facts: {
    kind: 'branch-half-adder-checkpoint', branchResult: { eventSeq: returned.seq, messageId: returned.data.id,
      branchSessionId: childId, resultSeq: result.seq, questionSeq: question.seq }, artifact: source,
    attribution: 'program-reported', state: CHECKPOINTS['10'],
  } })
  if (providerSaw !== undefined) expect(providerSaw(HALF_ADDER_PROMPTS.followup, newBlock.text)).toBe(true)
  const reply = parentWithQuestion.findLast(event => event.type === 'assistant/message')
  if (reply?.type !== 'assistant/message') throw new Error('Expected a parent half-adder answer')
  const answer = reply.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  const replyRow = parent.locator(`[data-chat-turn="${reply.data.turn}"][data-chat-group-part="response"]:visible`).last()
  await capture?.(replyRow, 'half-adder-parent-model-answer')

  stage?.('half-adder-reload-both-checkpoints')
  const warningStart = console.warnings.length
  const callsBeforeSentExport = requestCount()
  await page.reload()
  const historical = parent.locator(`[data-chat-flow-kind="user"][data-chat-message-id="${newQuestion.data.id}"]`
    + `[data-chat-message-seq="${newQuestion.seq}"]:visible`)
  await historical.locator('[data-artifact-program-context-origin="branch-half-adder-checkpoint"]').waitFor({ state: 'visible' })
  acknowledgeReloadConnectionLoss(console, warningStart)
  expect(await parent.locator('iframe[data-artifact-replay-frame]').count()).toBe(0)

  stage?.('half-adder-download-locked-sent-question-offline')
  const rootsBeforeSentExport = world.ctx.agents.roots().map(agent => agent.id)
  const sentExport = await verifyHalfAdderExport({ browser, page, card: historical, directory: exportDirectory,
    request: { sessionId: parentId, eventSeq: newQuestion.seq, messageId: newQuestion.data.id },
    source, lockedSumOutline, capture: inquiry !== undefined, returned: { ...returnAddress, filename: exportEvidence.filename } })
  expect(requestCount()).toBe(callsBeforeSentExport)
  expect(world.ctx.agents.roots().map(agent => agent.id)).toEqual(rootsBeforeSentExport)
  expect(await readPersistedEvents(world, parentId)).toEqual(parentWithQuestion)
  expect(await readPersistedEvents(world, childId)).toEqual(branchEventsAfterStyle)
  expect(await parent.locator('iframe[data-artifact-replay-frame]').count()).toBe(0)
  if (inquiry !== undefined && launched !== undefined) {
    await writeFile(join(inquiry.evidence, 'half-adder-sent-question-export-acceptance.json'), JSON.stringify({ userAgent: launched.userAgent,
      sentHalfAdderExport: { ...sentExport, providerRequests: 0, branchesUnchanged: true, sessionLogsUnchanged: true },
      returnedHalfAdderExport: { filename: exportEvidence.filename, ...returnAddress, checkpoint: CHECKPOINTS['11'] } }, null, 2) + '\n')
  }

  stage?.('half-adder-continue-independent-checkpoints')
  await toggle.click()
  await parentIframe.waitFor({ state: 'visible' })
  await replay.expectState(CHECKPOINTS['11'])
  await capture?.(panel, 'half-adder-return-restored-after-reload')
  await historical.locator('[data-artifact-half-adder-replay-toggle]').click()
  const historicalPanel = historical.locator('[data-artifact-half-adder-replay]')
  const historicalIframe = historicalPanel.locator(iframeSelector)
  await historicalIframe.waitFor({ state: 'visible' })
  for (const frame of [parentIframe, historicalIframe]) {
    expect(await frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(await frame.getAttribute('data-artifact-id')).toBe(source.artifactId)
    expect(await frame.getAttribute('data-artifact-revision')).toBe(String(source.revision))
  }
  expect(await historicalIframe.getAttribute('data-artifact-runtime-id')).not.toBe(await parentIframe.getAttribute('data-artifact-runtime-id'))
  const continued = halfAdderControls(historicalIframe.contentFrame())
  await continued.expectState(CHECKPOINTS['10'])
  await capture?.(historicalPanel, 'half-adder-question-restored-after-reload')
  await replay.a.click()
  await replay.expectState(CHECKPOINTS['01'])
  await continued.a.focus()
  await expect.poll(() => continued.a.evaluate(element => element.ownerDocument.activeElement === element)).toBe(true)
  await continued.a.press('Space')
  await continued.expectState(CHECKPOINTS['00'])
  await replay.expectState(CHECKPOINTS['01'])
  expect(await readPersistedEvents(world, parentId)).toEqual(parentWithQuestion)
  expect(await readPersistedEvents(world, childId)).toEqual(branchEventsAfterStyle)
  expect(console.warnings).toEqual([])
  expect(console.pageErrors).toEqual([])
  expectHalfAdderAnswer(branchAnswer, CHECKPOINTS['11'])
  expectHalfAdderAnswer(answer, CHECKPOINTS['10'])
}
