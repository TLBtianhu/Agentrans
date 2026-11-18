// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished, vi } from 'vitest'
import { fixtureUserPrompts, launchWebScaffold, readPersistedEvents, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const recording = new URL('./fixtures/replay/branch-result/session.v4.jsonl', import.meta.url)
const excerpt = 'conclusion'

it.skipIf(webSnapshotMode() === 'record').each(['workspace attachment fails', 'the successful response is lost'] as const)(
  'reopens the original inquiry and prefills the selected passage when %s', async (fault) => {
    const world = await launchWebScaffold({ replayFixture: fileURLToPath(recording), compareReplaySession: false, paceMs: 10 })
    onTestFinished(() => world.close())

    const executablePath = process.env.AGENTRANS_PLAYWRIGHT_EXECUTABLE_PATH
    const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    onTestFinished(() => browser.close())
    const page = await newEnglishPage(browser)
    page.setDefaultTimeout(15_000)
    await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, world.workspaceCwd)
    const [prompt] = fixtureUserPrompts(await readFile(recording, 'utf8'))
    if (prompt === undefined) throw new Error('Expected a recorded user question')
    const settled = world.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompt)
    await input.press('Enter')
    const parentId = await settled
    const workspace = world.ctx.workspaceRegistry.list().find(candidate => candidate.sessionIds.includes(parentId))
    if (workspace === undefined) throw new Error('Expected the source Session in its workspace')
    const attach = vi.spyOn(workspace, 'attachSession')
    if (fault === 'workspace attachment fails') attach.mockRejectedValueOnce(new Error('Workspace write failed'))
    onTestFinished(() => { attach.mockRestore() })

    const original = await readPersistedEvents(world, parentId)
    const answer = original.findLast(event => event.type === 'assistant/message')
    const end = original.at(-1)
    if (answer?.type !== 'assistant/message' || end?.type !== 'turn/end') throw new Error('Expected a complete recorded answer')
    const raw = answer.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    const start = raw.indexOf(excerpt)
    expect(start).toBeGreaterThanOrEqual(0)
    const inquiry = { messageSeq: answer.seq, messageId: answer.data.message.id, start, end: start + excerpt.length, excerpt }

    const requests: unknown[] = []
    const outcomes: unknown[] = []
    const modelPrompts: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/session/prompt') modelPrompts.push(request.url())
    })
    await page.route('**/api/session/fork', async (route) => {
      const envelope = route.request().postDataJSON() as { readonly payload: { readonly args: { readonly request: unknown } } }
      requests.push(envelope.payload.args.request)
      const upstream = await route.fetch({ maxRetries: 0 })
      try {
        outcomes.push(await upstream.json())
        if (fault === 'the successful response is lost' && requests.length === 1) await route.abort('failed')
        else await route.fulfill({ response: upstream })
      } finally { await upstream.dispose() }
    })
    const row = (id: string) => page.locator(`[data-row-key="session:${id}"]`)
    const parent = page.locator(`[data-conversation-session="${parentId}"]`)
    const source = parent.locator(`[data-chat-message-id="${answer.data.message.id}"] [data-markdown-source-start]:visible`)
      .filter({ hasText: excerpt }).first()
    await source.scrollIntoViewIfNeeded()
    const points = await source.evaluate((span, text) => {
      const node = span.firstChild
      if (!(node instanceof Text)) throw new Error('Expected recorded answer text')
      const offset = node.data.indexOf(text)
      if (offset < 0) throw new Error('Expected the passage in the rendered answer')
      const range = span.ownerDocument.createRange()
      range.setStart(node, offset)
      range.setEnd(node, offset + text.length)
      const rect = range.getBoundingClientRect()
      return { left: rect.left + 0.5, right: rect.right - 0.5, y: rect.top + rect.height / 2 }
    }, excerpt)
    await page.mouse.move(points.left, points.y)
    await page.mouse.down()
    await page.mouse.move(points.right, points.y, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe(excerpt)
    await page.locator('[data-chat-inquiry-create]').click()

    await expect.poll(() => outcomes.length).toBe(1)
    expect(requests).toHaveLength(1)
    const childId = attach.mock.calls[0]?.[0]
    expect(outcomes[0]).toMatchObject(fault === 'workspace attachment fails'
      ? { result: { ok: false, error: { code: 'session/workspace-attach-failed', details: { sessionId: childId } } } }
      : { result: { ok: true, value: { sessionId: childId } } })
    if (childId === undefined) throw new Error('The first attempt did not reach workspace attachment')
    const storedChild = await world.ctx.sessionPersistence.stat(childId)
    expect(storedChild?.header).toMatchObject({ parentSession: parentId, inquiry, isSeeded: true })
    expect(requests[0]).toMatchObject({ sessionId: parentId, atSeq: end.seq, inquiry })
    expect(requests[0]).toHaveProperty('requestId', expect.stringMatching(/^[\da-f-]{36}$/iu))
    const dialog = page.getByRole('dialog', { name: 'Couldn’t open the inquiry branch' })
    await dialog.waitFor({ state: 'visible' })
    expect(workspace.sessionIds.includes(childId)).toBe(fault === 'the successful response is lost')
    expect(await row(parentId).getAttribute('aria-selected')).toBe('true')
    expect(await page.locator(`[data-conversation-session="${childId}"]`).count()).toBe(0)

    // Retry must use the captured passage even after the browser selection is gone.
    await page.evaluate(() => document.getSelection()?.removeAllRanges())
    await dialog.locator('[data-chat-inquiry-retry]').click()
    await dialog.waitFor({ state: 'hidden' })
    await row(childId).and(page.locator('[aria-selected="true"]')).waitFor({ state: 'visible' })
    const child = page.locator(`[data-conversation-session="${childId}"]`)
    const quote = child.locator('[data-composer-quote] [data-quote-preview-text]')
    await expect.poll(() => quote.allTextContents()).toEqual([excerpt])
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    expect(outcomes[1]).toMatchObject({ result: { ok: true, value: { sessionId: childId } } })
    expect(workspace.sessionIds.filter(id => id !== parentId)).toEqual([childId])
    const children = (await world.ctx.sessionPersistence.list()).filter(session => session.header.parentSession === parentId)
    expect(children.map(session => session.header.id)).toEqual([childId])

    await child.getByRole('button', { name: 'Remove quote', exact: true }).click()
    await row(parentId).click()
    await row(childId).click()
    await child.locator('[data-composer-input]').waitFor({ state: 'visible' })
    expect(await quote.count()).toBe(0)
    expect(modelPrompts).toEqual([])
    expect(await readPersistedEvents(world, parentId)).toEqual(original)
    expect((await readPersistedEvents(world, childId)).slice(original.length).map(event => event.type)).toEqual(['session/end-seed'])
  },
)
