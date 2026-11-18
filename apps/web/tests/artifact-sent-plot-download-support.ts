import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FunctionPlotSpec } from '@agentrans/artifact/scene'
import type { ArtifactPlotContinuation, SceneArtifactSnapshot } from '@agentrans/artifact/types'
import type { Browser, Locator, Page, Request } from 'playwright'
import { expect } from 'vitest'

interface MessageAddress {
  readonly eventSeq: number
  readonly messageId: string
}

interface SentPlotDownload {
  readonly browser: Browser
  readonly page: Page
  readonly card: Locator
  readonly directory: string
  readonly sessionId: string
  readonly question: MessageAddress
  readonly source: Pick<SceneArtifactSnapshot, 'artifactId' | 'revision' | 'title'> & { readonly spec: FunctionPlotSpec }
  readonly baseline: ArtifactPlotContinuation['baseline']
  readonly returned?: MessageAddress & { readonly sessionId: string; readonly file: string }
  readonly capture?: boolean
}

/** Download and open the exact locked plot from a saved question. */
export async function verifySentPlotDownload({
  browser, page, card, directory, sessionId, question, source, baseline, returned, capture,
}: SentPlotDownload) {
  const endpoint = '/api/artifactBranchResults/exportSentPlot'
  const forbiddenPaths = ['/api/session/prompt', '/api/session/fork', '/api/artifactExports/create', '/api/artifactExports/read',
    '/api/artifactBranchResults/continuePlot', '/api/artifactBranchResults/exportReturnedPlot']
  const forbiddenRequests: string[] = []
  const watchExport = (request: Request): void => {
    const path = new URL(request.url()).pathname
    if (forbiddenPaths.includes(path)) forbiddenRequests.push(path)
  }
  const { artifactId, revision, spec, title } = source
  const filename = `sent-plot-${question.eventSeq}.html`
  const file = join(directory, filename)
  const selectedFunction = spec.functions.find(fn => fn.id === baseline.functionId)
  if (selectedFunction === undefined) throw new Error('The locked plot must select a source function')
  const displayNumber = (value: number | null): string => value === null ? '—' : value.toFixed(3)
  const readouts = {
    Function: selectedFunction.label,
    ...Object.fromEntries(Object.entries(baseline.parameters).map(([name, value]) => [name, String(value)])),
    x: baseline.x.toFixed(2), 'f(x)': displayNumber(baseline.values.value),
    'f′(x)': displayNumber(baseline.values.derivative), '∫': displayNumber(baseline.values.integral),
  }
  const readout = (offline: Page, label: string) => offline.locator('#readout > div')
    .filter({ has: offline.getByText(label, { exact: true }) }).locator('strong')
  const expectLockedReadouts = async (offline: Page): Promise<void> => {
    for (const [label, value] of Object.entries(readouts)) {
      await expect.poll(() => readout(offline, label).textContent()).toBe(value)
    }
  }
  const offlineContext = await browser.newContext({ offline: true })
  const network: string[] = []
  const errors: string[] = []
  const loadFile = async (path: string, owner: string) => {
    const offline = await offlineContext.newPage()
    offline.on('request', (request) => { if (/^https?:/u.test(request.url())) network.push(request.url()) })
    offline.on('websocket', (socket) => { network.push(socket.url()) })
    offline.on('pageerror', (error) => { errors.push(error.message) })
    await offline.goto(pathToFileURL(path).href)
    await offline.locator('canvas#plot').waitFor({ state: 'visible' })
    expect(await offline.title()).toBe(`${title} · animation`)
    expect(await offline.evaluate('spec')).toEqual(spec)
    const origin: unknown = JSON.parse(await offline.locator('#artifact-export-origin-data').textContent() ?? 'null')
    expect(origin).toMatchObject({ exporterVersion: 2, sessionId: owner, artifactId, revision, functionPlotBaseline: baseline })
    await expectLockedReadouts(offline)
    return { offline, origin }
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
    expect(download.suggestedFilename()).toBe(filename)
    await download.saveAs(file)

    const sent = await loadFile(file, sessionId)
    expect(sent.origin).toHaveProperty('sentQuestion', question)
    expect(sent.origin).not.toHaveProperty('returnedEvidence')
    let original: Page | undefined
    if (returned !== undefined) {
      const loaded = await loadFile(returned.file, returned.sessionId)
      const { eventSeq, messageId } = returned
      expect(loaded.origin).toHaveProperty('returnedEvidence', { eventSeq, messageId })
      expect(loaded.origin).not.toHaveProperty('sentQuestion')
      original = loaded.offline
    }
    await sent.offline.bringToFront()
    const seek = spec.viewport.x[1].toFixed(2) === readouts.x ? 'Home' : 'End'
    await sent.offline.getByRole('slider', { name: 'Timeline', exact: true }).press(seek)
    await expect.poll(() => readout(sent.offline, 'x').textContent()).not.toBe(readouts.x)
    if (original !== undefined) await expectLockedReadouts(original)
    await sent.offline.getByRole('button', { name: 'Reset', exact: true }).click()
    await expectLockedReadouts(sent.offline)
    if (capture === true) await sent.offline.screenshot({ path: join(directory, 'sent-question-locked-plot-offline.png') })
    expect(network).toEqual([])
    expect(errors).toEqual([])
  } finally {
    page.off('request', watchExport)
    await offlineContext.close()
  }
  expect(forbiddenRequests).toEqual([])
  return { filename, sessionId, ...question, artifactId, revision, exporterVersion: 2, baseline,
    probeMovedOffline: true, restoredAfterReset: true, independentReturnFile: returned !== undefined,
    offlineRequests: 0, forbiddenRequests }
}
