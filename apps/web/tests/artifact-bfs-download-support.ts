import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Browser, FrameLocator, Locator, Page, Request } from 'playwright'
import { expect } from 'vitest'

const states = {
  B: { kind: 'bfs-checkpoint', current: 'B', queue: ['C', 'D', 'E'], visited: ['A', 'B'] },
  C: { kind: 'bfs-checkpoint', current: 'C', queue: ['D', 'E', 'F'], visited: ['A', 'B', 'C'] },
  D: { kind: 'bfs-checkpoint', current: 'D', queue: ['E', 'F'], visited: ['A', 'B', 'C', 'D'] },
} as const

interface MessageAddress {
  readonly eventSeq: number
  readonly messageId: string
}

interface SentBfsDownload {
  readonly browser: Browser
  readonly page: Page
  readonly card: Locator
  readonly directory: string
  readonly sessionId: string
  readonly question: MessageAddress
  readonly returned: MessageAddress & { readonly file: string }
  readonly artifactId: string
  readonly revision: number
  readonly expectReadouts: (frame: FrameLocator, checkpoint: typeof states[keyof typeof states]) => Promise<void>
  readonly expectStyle: (frame: FrameLocator) => Promise<void>
  readonly capture?: boolean
}

/** Verify separate offline files for a sent C checkpoint and its original B return. */
export async function verifySentBfsDownload({
  browser, page, card, directory, sessionId, question, returned, artifactId, revision, expectReadouts, expectStyle, capture,
}: SentBfsDownload) {
  const endpoint = '/api/artifactBranchResults/exportSentBfs'
  const forbiddenPaths = ['/api/session/prompt', '/api/session/fork', '/api/artifactExports/create', '/api/artifactExports/read',
    '/api/artifactBranchResults/exportReturnedBfs']
  const forbiddenRequests: string[] = []
  const watchExport = (request: Request): void => {
    const path = new URL(request.url()).pathname
    if (forbiddenPaths.includes(path)) forbiddenRequests.push(path)
  }
  const filename = 'sent-question-locked-bfs.html'
  const file = join(directory, filename)
  const offlineContext = await browser.newContext({ offline: true })
  const network: string[] = []
  const errors: string[] = []
  const watchOffline = (offline: Page): void => {
    offline.on('request', (request) => { if (/^https?:/u.test(request.url())) network.push(request.url()) })
    offline.on('websocket', (socket) => { network.push(socket.url()) })
    offline.on('pageerror', (error) => { errors.push(error.message) })
  }
  const loadFile = async (path: string) => {
    const offline = await offlineContext.newPage()
    watchOffline(offline)
    await offline.goto(pathToFileURL(path).href)
    const frame = offline.locator('iframe[data-exported-bfs-frame]')
    const restored = offline.locator('[data-bfs-export-status="restored"]')
    await restored.waitFor({ state: 'visible' })
    expect(await frame.getAttribute('sandbox')).toBe('allow-scripts')
    const origin: unknown = JSON.parse(await offline.locator('#artifact-export-origin-data').textContent() ?? 'null')
    expect(origin).toMatchObject({ exporterVersion: 1, sessionId, artifactId, revision })
    return { offline, frame: frame.contentFrame(), restored, origin }
  }

  page.on('request', watchExport)
  try {
    const [download, response] = await Promise.all([
      page.waitForEvent('download'),
      page.waitForResponse(receipt => new URL(receipt.url()).pathname === endpoint),
      card.getByRole('button', { name: 'Download experiment HTML', exact: true })
        .and(card.locator('[data-artifact-question-download]')).click(),
    ])
    expect(response.ok()).toBe(true)
    expect(response.request().postDataJSON()).toHaveProperty('payload.args.request', { sessionId, ...question })
    expect(download.suggestedFilename()).toBe(`sent-bfs-${question.eventSeq}.html`)
    await download.saveAs(file)

    const sent = await loadFile(file)
    expect(sent.origin).toHaveProperty('sentQuestion', question)
    expect(sent.origin).toHaveProperty('checkpoint', states.C)
    await expectReadouts(sent.frame, states.C)
    await expectStyle(sent.frame)
    const original = await loadFile(returned.file)
    expect(original.origin).toHaveProperty('returnedEvidence', { eventSeq: returned.eventSeq, messageId: returned.messageId })
    expect(original.origin).toHaveProperty('checkpoint', states.B)
    await expectReadouts(original.frame, states.B)
    await expectStyle(original.frame)
    await sent.offline.bringToFront()
    await sent.frame.getByRole('button', { name: 'Step', exact: true }).click()
    await expectReadouts(sent.frame, states.D)
    if (capture === true) await sent.offline.screenshot({ path: join(directory, 'sent-question-bfs-step-d-offline.png') })
    await sent.offline.getByRole('button', { name: 'Reset to locked step', exact: true }).click()
    await sent.restored.waitFor({ state: 'visible' })
    await expectReadouts(sent.frame, states.C)
    await expectStyle(sent.frame)
    await expectReadouts(original.frame, states.B)
    if (capture === true) await sent.offline.screenshot({ path: join(directory, 'sent-question-locked-bfs-offline.png') })
    expect(network).toEqual([])
    expect(errors).toEqual([])
  } finally {
    page.off('request', watchExport)
    await offlineContext.close()
  }
  expect(forbiddenRequests).toEqual([])
  return { filename, sessionId, ...question, artifactId, revision, exporterVersion: 1,
    offlineSteps: [states.C, states.D, states.C], independentReturnCheckpoint: states.B,
    restoredAfterReset: true, offlineRequests: 0, forbiddenRequests }
}
