// @vitest-environment node
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream, type WriteStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { symbols, type Context } from '@agentrans/cordis'
import { chromium, type Download, type Locator, type Page, type Request, type Route } from 'playwright'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import {
  compareReading, expectCsvComparisonRecords, seedImportedCsvSourceKinds, seedWitnessedCsvComparisons, seedWitnessedCsvExplanation,
  seedWitnessedCsvReturnComparison,
} from './csv-comparison-browser-fixture.ts'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, readPersistedEvents, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const EXPORT_PATH = '/api/artifactBranchResults/exportSentCsvComparison'
const FORBIDDEN_REQUESTS = new Set([
  '/api/session/prompt',
  ...['compareCsvQuestionToReturn', 'compareCsvReturns', 'csvFilterOptions', 'csvParticipatingRows', 'csvQuestionParticipatingRows',
    'csvReturnedParticipatingRows', 'lockCsv', 'recalculateCsv'].map(endpoint => `/api/artifactBranchResults/${endpoint}`),
])

type ExportLocale = 'en' | 'zh'

const offlineCopy = {
  en: {
    comparison: 'Locked CSV comparison', explanation: 'CSV comparison explanation', noFilter: 'No filter',
    mean: 'Mean of LatencyMs', sum: 'Sum of LatencyMs', range: 'Records 1–2 of 2',
    fields: ['Group', 'Aggregation', 'Filter', 'Value', 'Rows'], membership: 'Record membership', recordsTable: 'Reviewed records',
    record: 'Record', status: 'Status', kept: 'Kept', excluded: 'Excluded', added: 'Added',
    original: 'Original reading', locked: 'Locked reading', changeAggregation: 'Change aggregation', applyFilter: 'Apply filter',
    sameRows: 'The mean and sum use the same rows.', matchingRows: 'The sum uses the rows that match the filter.',
    aggregationSummary: 'View locked aggregation comparison', filteringSummary: 'View locked filtering comparison',
    unfilteredMean: 'Unfiltered mean', unfilteredSum: 'Unfiltered sum', filteredSum: 'Filtered sum',
    earlier: 'Earlier return', later: 'Later return', originals: 'Original returns',
    revision: 'Revision', conclusion: 'Returned conclusion', recorded: 'Recorded reading', groups: 'Saved chart groups',
    participating: 'Participating records in the saved comparison page',
  },
  zh: {
    comparison: '已锁定的 CSV 对照', explanation: 'CSV 对照两步解释', noFilter: '无筛选',
    mean: '均值（LatencyMs）', sum: '总和（LatencyMs）', range: '第 1–2 条，共 2 条',
    fields: ['分组', '聚合方式', '筛选条件', '读数', '行数'], membership: '记录参与情况', recordsTable: '已核对记录',
    record: '记录', status: '状态', kept: '保留', excluded: '排除', added: '新增',
    original: '原始读数', locked: '锁定读数', changeAggregation: '更改聚合方式', applyFilter: '应用筛选',
    sameRows: '均值和总和使用相同的记录。', matchingRows: '总和使用符合筛选条件的记录。',
    aggregationSummary: '查看锁定的聚合对照', filteringSummary: '查看锁定的筛选对照',
    unfilteredMean: '未筛选的均值', unfilteredSum: '未筛选的总和', filteredSum: '筛选后的总和',
    earlier: '较早的回流', later: '较晚的回流', originals: '原始回流',
    revision: '修订', conclusion: '回流结论', recorded: '记录的读数', groups: '已保存的图表分组',
    participating: '已保存对照页中的参与记录',
  },
} as const

const languageSettings = {
  en: { lang: 'en', settings: 'Settings', language: 'English' },
  zh: { lang: 'zh-CN', settings: '设置', language: '中文' },
} as const

const importedSourceCopy = {
  en: {
    'single-page': 'JSON comparison with one locked page',
    'two-step-explanation': 'JSON two-step explanation with two original locked pages',
    'return-comparison': 'JSON comparison with two original return cards',
  },
  zh: {
    'single-page': '含一页已锁定结果的 JSON 对照',
    'two-step-explanation': '含两份原始锁定页的 JSON 两步解释',
    'return-comparison': '含两张原始回流卡的 JSON 对照',
  },
} as const

const importedProvenance = { en: 'User-imported readings and records', zh: '用户导入的读数和记录' } as const

async function switchExportLocale(page: Page, current: ExportLocale, next: ExportLocale): Promise<void> {
  const before = languageSettings[current]
  const after = languageSettings[next]
  await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(before.lang)
  await page.getByRole('button', { name: before.settings, exact: true }).and(page.locator('[aria-haspopup="dialog"]')).click()
  await page.getByRole('dialog', { name: before.settings, exact: true }).getByRole('button', { name: before.language, exact: true }).click()
  await page.getByRole('menuitem', { name: after.language, exact: true }).click()
  const settings = page.getByRole('dialog', { name: after.settings, exact: true })
  await settings.waitFor({ state: 'visible' })
  await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(after.lang)
  await page.keyboard.press('Escape')
  await settings.waitFor({ state: 'hidden' })
}

async function checkOfflineComparison(page: Page, locale: ExportLocale = 'en'): Promise<void> {
  await checkDocumentTitle(page, offlineCopy[locale].comparison)
  await checkLockedPage(page.locator('body'), true, locale)
  expect(await page.locator('script, iframe, form, button, input, link[rel="stylesheet"]').count()).toBe(0)
}

async function checkDocumentTitle(page: Page, title: string): Promise<void> {
  expect(await page.title()).toBe(title)
  await page.getByRole('heading', { name: title, exact: true }).waitFor({ state: 'visible' })
}

async function checkReadingLabels(scope: Locator, headings: readonly [string, string], locale: ExportLocale): Promise<void> {
  for (const [side, heading] of [['original', headings[0]], ['locked', headings[1]]] as const) {
    const reading = scope.locator(`[data-csv-compare-reading="${side}"]`)
    await reading.getByRole('heading', { name: heading, exact: true }).waitFor({ state: 'visible' })
    expect(await reading.locator('dt').allTextContents()).toEqual(offlineCopy[locale].fields)
  }
}

async function checkLockedPage(scope: Locator, filtered: boolean, locale: ExportLocale = 'en', returned = false): Promise<void> {
  const copy = offlineCopy[locale]
  await checkReadingLabels(scope, returned ? [copy.earlier, copy.later] : [copy.original, copy.locked], locale)
  await compareReading(scope, 'original', { key: 'Warm', aggregate: copy.mean, filter: copy.noFilter, value: '30', count: '2' })
  await compareReading(scope, 'locked', { key: 'Warm', aggregate: copy.sum, filter: filtered ? 'Batch = B' : copy.noFilter,
    value: filtered ? '35' : '60', count: filtered ? '1' : '2' })
  await scope.getByRole('heading', { name: copy.membership, exact: true }).waitFor({ state: 'visible' })
  expect(await scope.locator('[data-csv-compare-range]').textContent()).toBe(copy.range)
  const counts = { kept: filtered ? '1' : '2', excluded: filtered ? '1' : '0', added: '0' }
  for (const status of ['kept', 'excluded', 'added'] as const) {
    const count = counts[status]
    expect(await scope.locator(`[data-csv-compare-count="${status}"]`).textContent()).toBe(count)
    expect(await scope.locator(`[data-csv-compare-count="${status}"]`).locator('xpath=preceding-sibling::dt[1]').textContent()).toBe(copy[status])
  }
  const records = scope.getByRole('table', { name: copy.recordsTable, exact: true })
  const headers = [copy.record, copy.status, ...(filtered ? ['Batch'] : []), 'LatencyMs']
  expect(await records.getByRole('columnheader').allTextContents()).toEqual(headers)
  expect(await records.locator('[data-csv-compare-cell="status"]').allTextContents()).toEqual([filtered ? copy.excluded : copy.kept, copy.kept])
  await expectCsvComparisonRecords(scope, filtered)
}

it.skipIf(webSnapshotMode() === 'record')('downloads the exact saved CSV comparison and reopens it offline after reload', async () => {
  const world = await launchWebScaffold({ compareReplaySession: false })
  onTestFinished(() => world.close())
  const { sessionId, filtered, alternate } = await seedWitnessedCsvComparisons(world, 'csv-sent-comparison-export')
  const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
  await workspace.attachSession(sessionId)
  const executablePath = process.env.AGENTRANS_PLAYWRIGHT_EXECUTABLE_PATH
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'csv-sent-comparison-export'))
  const console = watchConsole(page)
  const downloads = await mkdtemp(join(tmpdir(), 'csv-comparison-export-'))
  const filePaths = [join(downloads, 'first.html'), join(downloads, 'after-reload.html')] as const
  onTestFinished(async () => {
    await Promise.all(filePaths.map(file => rm(file, { force: true })))
    await rmdir(downloads)
  })
  const offline = await browser.newContext({ offline: true })
  onTestFinished(() => offline.close())
  const offlinePage = await offline.newPage()
  const externalRequests: string[] = []
  offlinePage.on('request', (request) => {
    if (new URL(request.url()).protocol !== 'file:') externalRequests.push(request.url())
  })
  const unrelatedRequests: string[] = []
  const activity: string[] = []
  const stopActivity = world.ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/start' || event.type === 'request/header' || event.type === 'assistant/attempt') activity.push(event.type)
  }, { global: true })
  const reads = vi.spyOn(world.ctx.attachments, 'readFileStream').mockImplementation(() => {
    throw new Error('Exporting a witnessed saved comparison must not open a CSV attachment')
  })
  const requests: unknown[] = []
  const watchRequest = (request: Request): void => {
    const { pathname } = new URL(request.url())
    if (FORBIDDEN_REQUESTS.has(pathname)) unrelatedRequests.push(pathname)
    if (pathname === EXPORT_PATH) requests.push(request.postDataJSON())
  }
  page.on('request', watchRequest)
  try {
    await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
    await page.locator(`[data-row-key="session:${sessionId}"]`).click()
    await expect.poll(() => world.ctx.agents.get(sessionId)?.session.snapshotEvents().some(event => event.type === 'approval/policy'))
      .toBe(true)
    const agent = world.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('The saved comparison Session did not activate')
    await agent.whenIdle()
    expect(await world.ctx.sessions.flush(agent.session)).toBe(true)
    const before = await readPersistedEvents(world, sessionId)

    const openComparison = async (address: typeof filtered): Promise<Locator> => {
      const row = page.locator(`[data-chat-message-id="${address.messageId}"][data-chat-message-seq="${address.eventSeq}"]:visible`)
      const comparison = row.locator('[data-csv-compare-attached]')
      await comparison.getByRole('button', { name: 'Replay attached comparison', exact: true }).click()
      return comparison
    }
    const exported: Buffer[] = []
    for (const file of filePaths) {
      const active = await openComparison(alternate)
      await compareReading(active, 'locked', { key: 'Warm', value: '60', filter: 'No filter', count: '2' })
      const selected = await openComparison(filtered)
      await compareReading(selected, 'locked', { key: 'Warm', value: '35', filter: 'Batch = B', count: '1' })
      const [download, response] = await Promise.all([
        page.waitForEvent('download'),
        page.waitForResponse(response => new URL(response.url()).pathname === EXPORT_PATH),
        selected.getByRole('button', { name: 'Download comparison as HTML', exact: true }).click(),
      ])
      expect(response.ok()).toBe(true)
      expect(download.suggestedFilename()).toBe(`csv-comparison-${filtered.eventSeq}.html`)
      await download.saveAs(file)
      exported.push(await readFile(file))
      await offlinePage.goto(pathToFileURL(file).href, { waitUntil: 'load' })
      await checkOfflineComparison(offlinePage)
      if (file === filePaths[0]) {
        const warnings = console.warnings.length
        await page.reload()
        await expect.poll(() => page.locator(`[data-row-key="session:${sessionId}"]`).getAttribute('aria-selected')).toBe('true')
        acknowledgeReloadConnectionLoss(console, warnings)
      }
    }
    expect(exported).toHaveLength(2)
    expect(exported[1]).toEqual(exported[0])
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      const expected = { ...filtered, locale: 'en' }
      expect(request).toMatchObject({ payload: { args: { request: expected } } })
      expect((request as { payload: { args: { request: unknown } } }).payload.args.request).toEqual(expected)
    }
    expect(await readPersistedEvents(world, sessionId)).toEqual(before)
    expect(externalRequests).toEqual([])
    expect(unrelatedRequests).toEqual([])
    expect(activity).toEqual([])
    expect(reads).not.toHaveBeenCalled()
    expect(console.warnings).toEqual([])
    expect(console.pageErrors).toEqual([])
    const evidence = process.env.AGENTRANS_CSV_EXPORT_EVIDENCE_DIR
    if (evidence !== undefined && evidence.length > 0) {
      await mkdir(evidence, { recursive: true })
      await copyFile(filePaths[0], join(evidence, `csv-comparison-${filtered.eventSeq}.html`))
      await offlinePage.screenshot({ path: join(evidence, 'csv-comparison-opened-offline.png'), fullPage: true })
      await writeFile(join(evidence, 'csv-comparison-export.json'), JSON.stringify({
        selected: filtered, alternate, downloads: requests.length, identicalBytesAfterReload: true,
        browser: browser.version(), externalRequests, unrelatedRequests, modelActivity: activity, attachmentReads: reads.mock.calls.length,
      }, null, 2) + '\n')
    }
  } finally {
    page.off('request', watchRequest)
    reads.mockRestore()
    stopActivity()
  }
})

type SentAddress = Awaited<ReturnType<typeof seedWitnessedCsvReturnComparison>>['sent']
type DownloadSelection = {
  readonly sent: SentAddress
  readonly kind: 'comparison' | 'explanation'
  readonly locale?: ExportLocale
  readonly evidenceFilename?: string
}

type HeldExportOrder =
  | 'first-then-second' | 'second-before-first' | 'second-saving-when-first-released'
  | 'retry-after-host-restart' | 'retry-after-host-restart-with-pending-response' | 'retry-after-host-restart-with-partial-body'
  | 'save-complete-response-during-host-restart' | 'save-triggered-download-during-host-restart'
  | 'responses-together' | 'responses-together-with-overlapping-saves' | 'responses-together-with-saves-resumed-in-reverse-order'
  | 'responses-together-with-overlapping-reverse-resumes'
  | 'responses-in-reverse-order' | 'responses-in-reverse-order-with-overlapping-saves'
  | { readonly singlePauseBytes: 0 | 1 | 2 | 21 }
  | {
    readonly resume: 'click' | 'reverse'
    readonly finish: 'click' | 'reverse'
    readonly stopHostBeforeFinishing?: true
  }

function exportRequestAddress(body: unknown): unknown {
  return (body as { payload: { args: { request: unknown } } }).payload.args.request
}

function holdHostExportResponse(world: WebScaffold, selection: { sent: SentAddress; locale: ExportLocale }) {
  const service = world.ctx.artifactBranchResults
  // The Gateway looks up methods on a Cordis service view bound to each invocation.
  const instance = Reflect.get(service, symbols.original) as typeof service
  // oxlint-disable-next-line typescript/unbound-method -- The spy supplies the real invocation receiver below.
  const render = instance.exportSentCsvComparison
  const rendered = Promise.withResolvers<number>()
  const release = Promise.withResolvers<undefined>()
  let disconnected = false
  let matchingInvocations = 0
  const spy = vi.spyOn(instance, 'exportSentCsvComparison').mockImplementation(async function (this: typeof service, request) {
    if (!isDeepStrictEqual(request, { ...selection.sent, locale: selection.locale })) return render.call(this, request)
    matchingInvocations++
    try {
      const signal = (Reflect.get(this, 'ctx') as Context).invocation?.signal
      if (signal === undefined) throw new Error('The held CSV export did not run in a Host RPC invocation')
      const bytes = await render.call(this, request)
      const onDisconnect = (): void => {
        disconnected = true
        release.resolve(undefined)
      }
      signal.addEventListener('abort', onDisconnect, { once: true })
      try {
        if (signal.aborted) onDisconnect()
        rendered.resolve(bytes.byteLength)
        await release.promise
        signal.throwIfAborted()
        return bytes
      } finally { signal.removeEventListener('abort', onDisconnect) }
    } catch (error) {
      rendered.reject(error)
      throw error
    }
  })
  onTestFinished(() => { release.resolve(undefined); spy.mockRestore() })
  return { rendered: rendered.promise, didDisconnect: () => disconnected, invocations: () => matchingInvocations,
    release: (): void => { release.resolve(undefined) } }
}

function holdPartialHostExportBody(world: WebScaffold) {
  const prefixBytes = 2048
  const sent = Promise.withResolvers<{ status: number; bytes: number; includesHtml: boolean }>()
  let interrupted = false
  const remove = world.ctx.on('connection/request', async (request, response, next) => {
    if (request.method !== 'POST' || request.url !== EXPORT_PATH) {
      await next()
      return
    }
    // Keep the prefix visible on the wire instead of buffering it in gzip.
    response.setHeader('cache-control', 'no-transform')
    const write = response.write.bind(response)
    const prefix: Buffer[] = []
    let remaining = prefixBytes
    response.once('close', () => { interrupted = !response.writableEnded })
    response.write = (chunk: Uint8Array): boolean => {
      if (remaining === 0) return false
      const bytes = Buffer.from(chunk.subarray(0, remaining))
      prefix.push(bytes)
      remaining -= bytes.byteLength
      const accepted = write(bytes)
      if (remaining > 0) return accepted
      sent.resolve({ status: response.statusCode, bytes: prefixBytes, includesHtml: Buffer.concat(prefix).includes('<!doctype html>') })
      // Keep the genuine HTTP bridge waiting for drain or the socket to close.
      return false
    }
    try { await next() }
    finally { response.write = write }
  }, { global: true })
  onTestFinished(() => { remove() })
  return { sent: sent.promise, didInterrupt: () => interrupted }
}

async function observeExportBody(page: Page) {
  const observed = { status: 0, mimeType: '', bodyBytes: 0, includesHtml: false, finished: false, error: '' }
  const binding = 'reportPartialCsvExportBody'
  await page.exposeFunction(binding, (state: typeof observed) => { Object.assign(observed, state) })
  await page.evaluate(({ path, binding }) => {
    const originalFetch = globalThis.fetch
    const fetch = originalFetch.bind(globalThis)
    const report = Reflect.get(globalThis, binding) as (state: typeof observed) => Promise<void>
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof globalThis.Request ? input.url : input, location.href)
      if (init?.method !== 'POST' || url.pathname !== path) {
        return await fetch(input, init)
      }
      globalThis.fetch = originalFetch
      const response = await fetch(input, init)
      const readCopy = async (): Promise<void> => {
        const state = { status: response.status, mimeType: response.headers.get('content-type')?.split(';')[0] ?? '',
          bodyBytes: 0, includesHtml: false, finished: false, error: '' }
        const reader = response.clone().body?.getReader()
        const decoder = new TextDecoder()
        let text = ''
        try {
          await report(state)
          if (reader === undefined) throw new Error('The export response has no body')
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            state.bodyBytes += value.byteLength
            text += decoder.decode(value, { stream: true })
            state.includesHtml = text.includes('<!doctype html>')
            await report(state)
          }
          state.finished = true
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error)
        } finally { reader?.releaseLock() }
        await report(state)
      }
      void readCopy().catch(() => { /* The page can close while reporting a failed test. */ })
      return response
    }
  }, { path: EXPORT_PATH, binding })
  return observed
}

type CompleteExportResponse = { status: number; bytes: number; sha256: string }

async function pauseDownloadAfterResponse(page: Page, selection: { sent: SentAddress; locale: ExportLocale }) {
  const binding = 'pauseCsvExportAfterResponse'
  const resume = Promise.withResolvers<undefined>()
  let completed: CompleteExportResponse | undefined
  await page.exposeFunction(binding, async (receipt: CompleteExportResponse) => {
    completed = receipt
    await resume.promise
  })
  await page.evaluate(({ path, binding, address }) => {
    const originalFetch = globalThis.fetch
    const fetch = originalFetch.bind(globalThis)
    const pause = Reflect.get(globalThis, binding) as (receipt: CompleteExportResponse) => Promise<void>
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof globalThis.Request ? input.url : input, location.href)
      if (init?.method !== 'POST' || url.pathname !== path || typeof init.body !== 'string') return await fetch(input, init)
      const envelope = JSON.parse(init.body) as { payload?: { args?: { request?: typeof address } } }
      const target = envelope.payload?.args?.request
      if (target?.sessionId !== address.sessionId || target.eventSeq !== address.eventSeq
        || target.messageId !== address.messageId || target.locale !== address.locale) return await fetch(input, init)
      globalThis.fetch = originalFetch
      const response = await fetch(input, init)
      const parse = response.formData.bind(response)
      response.formData = async () => {
        const body = await parse()
        const file = body.get('bytes-0')
        if (!(file instanceof Blob)) throw new Error('The completed export response has no HTML attachment')
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))
        const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
        await pause({ status: response.status, bytes: file.size, sha256 })
        return body
      }
      return response
    }
  }, { path: EXPORT_PATH, binding, address: { ...selection.sent, locale: selection.locale } })
  const release = (): void => { resume.resolve(undefined) }
  onTestFinished(release)
  return { completed: () => completed, release }
}

function observeSessionFollowSnapshots(page: Page): () => number {
  let snapshots = 0
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname !== '/api/remote.mux') return
    const follows = new Set<string>()
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return
      const frame = JSON.parse(payload) as { type: string; streamId: string; endpoint?: string }
      if (frame.type === 'open' && frame.endpoint === 'session/follow') follows.add(frame.streamId)
    })
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return
      const frame = JSON.parse(payload) as { type: string; streamId: string; value?: { type: string } }
      if (frame.type === 'item' && follows.has(frame.streamId) && frame.value?.type === 'snapshot') snapshots++
    })
  })
  return () => snapshots
}

async function holdHtmlExports(page: Page, selections: readonly { sent: SentAddress; locale: ExportLocale }[], releaseTogether: boolean) {
  const sharedRelease = releaseTogether ? Promise.withResolvers<undefined>() : undefined
  const holds = selections.map(({ sent, locale }) => {
    const ready = Promise.withResolvers<{ status: number; bytes: number }>()
    const release = sharedRelease ?? Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    return { request: { ...sent, locale }, ready, release }
  })
  // Keep interception installed until every paused reply has been delivered.
  await page.route(url => url.pathname === EXPORT_PATH, async (route) => {
    const request = exportRequestAddress(route.request().postDataJSON())
    const hold = holds.find(candidate => isDeepStrictEqual(candidate.request, request))
    if (hold === undefined) {
      await route.continue()
      return
    }
    let fulfilling = false
    try {
      expect(route.request().method()).toBe('POST')
      const upstream = await route.fetch({ maxRetries: 0, maxRedirects: 0 })
      expect(upstream.ok()).toBe(true)
      const bytes = (await upstream.body()).byteLength
      expect(bytes).toBeGreaterThan(0)
      hold.ready.resolve({ status: upstream.status(), bytes })
      await hold.release.promise
      fulfilling = true
      await route.fulfill({ response: upstream })
    } catch (error) {
      hold.ready.reject(error)
      if (!fulfilling && !page.isClosed()) await route.abort()
    }
  })
  return holds.map(hold => ({ ready: hold.ready.promise, release: (): void => { hold.release.resolve(undefined) } }))
}

async function saveWithBytePauses(
  download: Download, file: string, ...whilePaused: ((destination: WriteStream) => Promise<void>)[]
): Promise<void> {
  const pauses = whilePaused.map((wait, index) => ({ wait, bytes: index + 1, resume: Promise.withResolvers<undefined>() }))
  const stream = await download.createReadStream()
  const destination = createWriteStream(file)
  const saving = pipeline(stream, async function* (source: AsyncIterable<Buffer>) {
    let nextPause = 0
    for await (const chunk of source) {
      let offset = 0
      let pause = pauses[nextPause]
      while (pause !== undefined && offset < chunk.length) {
        yield chunk.subarray(offset, offset + 1)
        offset++
        await pause.resume.promise
        pause = pauses[++nextPause]
      }
      if (offset < chunk.length) yield chunk.subarray(offset)
    }
  }, destination)
  const checkPartialSaves = async (): Promise<void> => {
    try {
      for (const { wait, bytes, resume } of pauses) {
        await expect.poll(() => stat(file).then(info => info.size, () => 0)).toBe(bytes)
        await wait(destination)
        resume.resolve(undefined)
      }
    } finally {
      for (const { resume } of pauses) resume.resolve(undefined)
    }
  }
  await Promise.all([saving, checkPartialSaves()])
}

async function prepareOfflineExports<Fixture extends Pick<SentAddress, 'sessionId'>>(
  name: string, seed: (world: WebScaffold, id: string) => Promise<Fixture>, select: (fixture: Fixture) => readonly DownloadSelection[],
  heldExportOrder?: HeldExportOrder,
) {
  const holdResponseAtHost = heldExportOrder === 'retry-after-host-restart-with-pending-response'
  const holdPartialBody = heldExportOrder === 'retry-after-host-restart-with-partial-body'
  const singlePauseBytes = typeof heldExportOrder === 'object' && 'singlePauseBytes' in heldExportOrder
    ? heldExportOrder.singlePauseBytes : undefined
  const orderedSaves = typeof heldExportOrder === 'object' && 'resume' in heldExportOrder ? heldExportOrder : undefined
  const triggerSingleBeforeStop = heldExportOrder === 'save-triggered-download-during-host-restart' || singlePauseBytes !== undefined
  const holdCompleteBody = heldExportOrder === 'save-complete-response-during-host-restart' || triggerSingleBeforeStop
  const sendRequestBeforeStop = holdResponseAtHost || holdPartialBody || holdCompleteBody
  const retryAfterRestart = heldExportOrder === 'retry-after-host-restart' || holdResponseAtHost || holdPartialBody
  const restartDuringExport = retryAfterRestart || holdCompleteBody
  const world = await launchWebScaffold({ compareReplaySession: false, restartable: restartDuringExport })
  let closing: Promise<void> | undefined
  const closeHost = (): Promise<void> => closing ??= world.close()
  onTestFinished(closeHost)
  const recordStream = vi.fn(() => { throw new Error('Exporting a saved CSV page must not start a model stream') })
  const reads = vi.fn(() => {
    throw new Error('Exporting a saved CSV page must not open an attachment')
  })
  const guardAnalysis = (): void => {
    const stopStreams = world.ctx.on('llm/stream', recordStream, { global: true })
    const attachmentReads = vi.spyOn(world.ctx.attachments, 'readFileStream').mockImplementation(reads)
    onTestFinished(() => { attachmentReads.mockRestore(); stopStreams() })
  }
  guardAnalysis()
  const fixture = await seed(world, name)
  const { sessionId } = fixture
  const selections = select(fixture)
  const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
  await workspace.attachSession(sessionId)
  const executablePath = process.env.AGENTRANS_PLAYWRIGHT_EXECUTABLE_PATH
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const followSnapshots = holdCompleteBody ? observeSessionFollowSnapshots(page) : undefined
  let debugPage = page
  onTestFailed(() => saveFailureShot(debugPage, name))
  const console = watchConsole(page)
  const restricted: string[] = []
  const exports: unknown[] = []
  const downloadEvents: string[] = []
  page.on('download', (download) => { downloadEvents.push(download.suggestedFilename()) })
  page.on('request', (request) => {
    const { pathname } = new URL(request.url())
    if (FORBIDDEN_REQUESTS.has(pathname)) restricted.push(pathname)
    if (pathname === EXPORT_PATH) exports.push(request.postDataJSON())
  })
  const dir = await mkdtemp(join(tmpdir(), `${name}-`))
  const files = selections.map((selection) => {
    const locale = selection.locale ?? 'en'
    const filename = `csv-comparison-${selection.sent.eventSeq}.html`
    return { ...selection, locale, filename, file: join(dir, `${locale}-${filename}`) }
  })
  onTestFinished(async () => {
    await Promise.all(files.map(({ file }) => rm(file, { force: true })))
    await rmdir(dir)
  })
  const evidence = process.env.AGENTRANS_CSV_EXPORT_EVIDENCE_DIR
  if (evidence !== undefined && evidence.length > 0) await mkdir(evidence, { recursive: true })

  await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
  await page.locator(`[data-row-key="session:${sessionId}"]`).click()
  await expect.poll(() => world.ctx.agents.get(sessionId)?.session.snapshotEvents().some(event => event.type === 'approval/policy')).toBe(true)
  const agent = world.ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('The saved CSV comparison Session did not activate')
  await agent.whenIdle()
  expect(await world.ctx.sessions.flush(agent.session)).toBe(true)
  const before = await readPersistedEvents(world, sessionId)
  let sessionBeforeExport = before
  const expectSessionUnchanged = async (): Promise<void> => {
    expect(await readPersistedEvents(world, sessionId)).toEqual(sessionBeforeExport)
  }
  const hostUrl = new URL('/', world.authenticatedUrl)
  const expectHostUnavailable = async (): Promise<void> => {
    await expect(fetch(hostUrl, { signal: AbortSignal.timeout(3000) })).rejects.toMatchObject({ cause: { code: 'ECONNREFUSED' } })
  }
  let hostStopped = false
  const stopHostAndVerify = async (): Promise<void> => {
    await closeHost()
    await expectHostUnavailable()
    hostStopped = true
  }
  let currentLocale: ExportLocale = 'en'
  let heldResponse: { status: number; bytes: number; pageLanguageBefore: string; pageLanguageAfter: string } | undefined
  let downloadsBeforeHeldResponseReleased: number | undefined
  let secondHeldResponse: { status: number; bytes: number } | undefined
  let secondFileBytesBeforeHeldResponseReleased: number | undefined
  let responsesReleasedTogether: true | undefined
  const heldResponses: { status: number; bytes: number }[] = []
  type PartialFile = { filename: string; bytes: number }
  const serialReleases: { filename: string; savedBeforeRelease: string[]; partialFilesBeforeRelease: PartialFile[] | undefined }[] = []
  let partialFilesAfterLastReleasedDownloadSaved: PartialFile[] | undefined
  let partialFilesBeforeResume: PartialFile[] | undefined
  let completedSavesBeforeResume: number | undefined
  const serialSaveResumes: { filename: string; savedBeforeResume: string[]; partialFilesBeforeResume: PartialFile[] }[] = []
  let partialFilesBeforeFinishing: PartialFile[] | undefined
  let partialFilesAfterHostStop: PartialFile[] | undefined
  let completedSavesAtHostStop: number | undefined
  let warningsBeforeHostStop: number | undefined
  let failedSingleDownload: { error: string; notice: string } | undefined
  let singleExportBytesRenderedAtHost: number | undefined
  let singleExportDisconnectedAtHost: boolean | undefined
  let singleExportInvocationsBeforeRestart: number | undefined
  let singleResponsesBeforeRetry: number | undefined
  let singleResponseStatuses: number[] | undefined
  let partialSingleBodyBeforeShutdown: { status: number; hostBytes: number; browserBytes: number; includesHtml: boolean } | undefined
  let singleFileAbsentBeforeRetry: true | undefined
  let completeSingleResponseBeforeShutdown: CompleteExportResponse | undefined
  let singleDownloadBeforeShutdown: {
    filename: string
    protocol: string
    destinationExists: boolean
    destinationBytes?: number
  } | undefined
  let singleFileAbsentAfterHostStop: true | undefined
  let singleFileBytesAfterHostStop: number | undefined
  let singleFileSha256WhileStopped: string | undefined
  let exportRequestsAfterReconnect: number | undefined
  let sessionFollowSnapshotsAfterRestart: number | undefined
  let savedWhileHostStopped: string[] | undefined
  let exportRequestsBeforeRetry: number | undefined
  let sessionEventsAddedByReopen: string[] | undefined
  const serialSaveFinishes: { filename: string; bytes: number; savedAfterFinish: string[]; partialFilesAfterFinish: PartialFile[] }[] = []
  const savedDownloads: string[] = []
  type DownloadFile = typeof files[number]

  const showDownload = async ({ sent, kind, locale }: DownloadFile) => {
    if (locale !== currentLocale) {
      await switchExportLocale(page, currentLocale, locale)
      currentLocale = locale
    }
    const pair = page.locator(`[data-chat-message-id="${sent.messageId}"][data-chat-message-seq="${sent.eventSeq}"]:visible`)
      .locator('[data-csv-compare-attached]')
    const replay = locale === 'zh' ? '复现附加对照' : 'Replay attached comparison'
    const downloadLabel = locale === 'en' ? `Download ${kind} as HTML` : kind === 'comparison' ? '下载 HTML 对照' : '下载两步解释（HTML）'
    const jsonLabel = locale === 'en' ? `Download ${kind} as JSON` : kind === 'comparison' ? '下载 JSON 对照' : '下载两步解释（JSON）'
    const replayButton = pair.getByRole('button', { name: replay, exact: true })
    await replayButton.waitFor({ state: 'visible' })
    if (await replayButton.getAttribute('aria-expanded') === 'false') await replayButton.click()
    await pair.getByRole('button', { name: jsonLabel, exact: true }).waitFor({ state: 'visible' })
    const button = pair.getByRole('button', { name: downloadLabel, exact: true }).and(pair.locator('[data-csv-download-comparison]'))
    return { pair, button }
  }
  const waitForDownload = async ({ sent, locale, filename }: DownloadFile): Promise<Download> => {
    const [download, response] = await Promise.all([
      page.waitForEvent('download', item => item.suggestedFilename() === filename),
      page.waitForResponse(result => new URL(result.url()).pathname === EXPORT_PATH
        && isDeepStrictEqual(exportRequestAddress(result.request().postDataJSON()), { ...sent, locale })),
    ])
    expect(response.ok()).toBe(true)
    return download
  }
  const startDownload = async (file: DownloadFile, button: Locator): Promise<Download> => {
    const [download] = await Promise.all([waitForDownload(file), button.click()])
    return download
  }
  const saveDownload = async (file: DownloadFile, started: Promise<Download>): Promise<void> => {
    const download = await started
    await download.saveAs(file.file)
    savedDownloads.push(file.filename)
  }
  const downloadFromCard = async (file: DownloadFile): Promise<void> => {
    const { button } = await showDownload(file)
    await saveDownload(file, startDownload(file, button))
  }
  const waitingButton = (card: Locator) => card.locator('[data-csv-download-comparison][aria-busy="true"]')
  const expectWaiting = async (pending: Locator): Promise<void> => {
    await pending.waitFor({ state: 'visible' })
    expect(await pending.isDisabled()).toBe(true)
  }
  if (heldExportOrder === undefined) {
    for (const file of files) await downloadFromCard(file)
  } else if (restartDuringExport) {
    const [first, second, single] = files
    if (first === undefined || second === undefined || single === undefined || files.length !== 3) {
      throw new Error('Restarting during export requires three cards')
    }
    const completedResponses = [first, second]
    const firstTwoNames = completedResponses.map(file => file.filename)
    const allNames = [...firstTwoNames, single.filename]
    const advanceSaves = Promise.withResolvers<undefined>()
    const resumeSaves = Promise.withResolvers<undefined>()
    const allowSingleRequest = Promise.withResolvers<undefined>()
    const heldSingleRequest = Promise.withResolvers<Request>()
    const writes: Promise<void>[] = []
    const secondByteCheckpoints: Promise<undefined>[] = []
    const interceptExport = (url: URL): boolean => url.pathname === EXPORT_PATH
    const matchesSingle = (request: Request): boolean => interceptExport(new URL(request.url()))
      && isDeepStrictEqual(exportRequestAddress(request.postDataJSON()), { ...single.sent, locale: single.locale })
    const holdSingle = async (route: Route): Promise<void> => {
      const request = route.request()
      if (matchesSingle(request)) {
        heldSingleRequest.resolve(request)
        await allowSingleRequest.promise
      }
      await route.continue()
    }
    const checkPausedSaves = async (): Promise<PartialFile[]> => Promise.all(completedResponses.map(async (file) => {
      const bytes = (await stat(file.file)).size
      expect(bytes).toBe(2)
      return { filename: file.filename, bytes }
    }))
    const hostHold = holdResponseAtHost ? holdHostExportResponse(world, single) : undefined
    const responses: number[] = []
    const initialSingleResponses = holdPartialBody || holdCompleteBody ? [200] : []
    let completeBody: Awaited<ReturnType<typeof pauseDownloadAfterResponse>> | undefined
    singleResponseStatuses = responses
    page.on('response', (response) => { if (matchesSingle(response.request())) responses.push(response.status()) })
    if (!sendRequestBeforeStop) advanceSaves.resolve(undefined)
    try {
      for (const file of completedResponses) {
        const { button } = await showDownload(file)
        const atFirstByte = Promise.withResolvers<undefined>()
        const atSecondByte = Promise.withResolvers<undefined>()
        secondByteCheckpoints.push(atSecondByte.promise)
        const save = async (): Promise<void> => {
          const download = await startDownload(file, button)
          await saveWithBytePauses(download, file.file, async () => {
            atFirstByte.resolve(undefined)
            await advanceSaves.promise
          }, async () => {
            atSecondByte.resolve(undefined)
            await resumeSaves.promise
          })
          savedDownloads.push(file.filename)
        }
        const saved = save()
        writes.push(saved)
        await Promise.race([sendRequestBeforeStop ? atFirstByte.promise : atSecondByte.promise, saved])
      }
      if (!sendRequestBeforeStop) await page.route(interceptExport, holdSingle)
      const { pair, button } = await showDownload(single)
      const requested = pair.locator('[role="status"][data-csv-download-comparison-status="requested"]')
      const waitForSingleBlobDownload = async (): Promise<Download> => {
        const download = await page.waitForEvent('download', item => item.suggestedFilename() === single.filename)
        expect(download.url()).toMatch(/^blob:/u)
        return download
      }
      let singleDownload: Download | undefined
      let singleDestination: WriteStream | undefined
      const checkPausedSingleDestination = async (expectedBytes: number): Promise<number> => {
        expect(singleDestination?.destroyed).toBe(false)
        expect(singleDestination?.closed).toBe(false)
        expect(singleDestination?.bytesWritten).toBe(expectedBytes)
        const bytes = (await stat(single.file)).size
        expect(bytes).toBe(expectedBytes)
        return bytes
      }
      const partialBody = holdPartialBody ? holdPartialHostExportBody(world) : undefined
      const browserBody = holdPartialBody ? await observeExportBody(page) : undefined
      if (holdCompleteBody) completeBody = await pauseDownloadAfterResponse(page, single)
      const singleRequested = sendRequestBeforeStop ? page.waitForRequest(matchesSingle) : heldSingleRequest.promise
      await button.click()
      const pending = await singleRequested
      expect(pending.method()).toBe('POST')
      if (hostHold !== undefined) {
        singleExportBytesRenderedAtHost = await hostHold.rendered
        expect(singleExportBytesRenderedAtHost).toBeGreaterThan(0)
      }
      if (partialBody !== undefined && browserBody !== undefined) {
        const prefix = await partialBody.sent
        expect(prefix.status).toBe(200)
        expect(prefix.includesHtml).toBe(true)
        const response = await pending.response()
        if (response === null) throw new Error('Edge did not receive the held response headers')
        expect(await response.headerValue('content-encoding')).toBeNull()
        await expect.poll(() => ({ ...browserBody, responseStatuses: [...responses] }), { timeout: 5000 }).toEqual({
          status: 200, mimeType: 'multipart/form-data', bodyBytes: prefix.bytes, includesHtml: true,
          finished: false, error: '', responseStatuses: [200],
        })
        partialSingleBodyBeforeShutdown = { status: prefix.status, hostBytes: prefix.bytes,
          browserBytes: browserBody.bodyBytes, includesHtml: browserBody.includesHtml }
      }
      if (completeBody !== undefined) {
        await expect.poll(completeBody.completed, { timeout: 5000 }).toBeDefined()
        completeSingleResponseBeforeShutdown = completeBody.completed()
        expect(completeSingleResponseBeforeShutdown?.status).toBe(200)
        expect(completeSingleResponseBeforeShutdown?.bytes).toBeGreaterThan(0)
        const response = await pending.response()
        if (response === null) throw new Error('Edge did not receive the completed export response')
        expect(await response.finished()).toBeNull()
        if (triggerSingleBeforeStop) {
          const download = waitForSingleBlobDownload()
          completeBody.release()
          singleDownload = await download
          await requested.waitFor({ state: 'visible' })
          if (singlePauseBytes === 0) {
            const stream = await singleDownload.createReadStream()
            singleDestination = createWriteStream(single.file, { flags: 'wx' })
            const opened = once(singleDestination, 'open')
            const saving = pipeline(stream, async function* (source: AsyncIterable<Buffer>) {
              await resumeSaves.promise
              yield* source
            }, singleDestination).then(() => { savedDownloads.push(single.filename) })
            writes.push(saving)
            await Promise.race([opened, saving])
          } else if (singlePauseBytes !== undefined) {
            await expect(stat(single.file)).rejects.toMatchObject({ code: 'ENOENT' })
            const atCheckpoint = Promise.withResolvers<undefined>()
            const pauseAtCheckpoint = async (destination: WriteStream): Promise<void> => {
              await expect.poll(() => destination.bytesWritten).toBe(singlePauseBytes)
              singleDestination = destination
              atCheckpoint.resolve(undefined)
              await resumeSaves.promise
            }
            const continueWriting = (): Promise<void> => Promise.resolve()
            const earlierCheckpoints = Array.from({ length: singlePauseBytes - 1 }, () => continueWriting)
            const saving = saveWithBytePauses(singleDownload, single.file, ...earlierCheckpoints, pauseAtCheckpoint)
              .then(() => { savedDownloads.push(single.filename) })
            writes.push(saving)
            await Promise.race([atCheckpoint.promise, saving])
          }
        }
      }
      if (sendRequestBeforeStop) {
        advanceSaves.resolve(undefined)
      }
      await Promise.race([Promise.all(secondByteCheckpoints), Promise.all(writes)])
      partialFilesBeforeFinishing = await checkPausedSaves()
      expect(savedDownloads).toEqual([])
      if (singleDownload === undefined) await expectWaiting(waitingButton(pair))
      expect(responses).toEqual(initialSingleResponses)
      if (hostHold !== undefined) expect(hostHold.didDisconnect()).toBe(false)
      if (partialBody !== undefined) expect(partialBody.didInterrupt()).toBe(false)
      expect(downloadEvents).toEqual(triggerSingleBeforeStop ? allNames : firstTwoNames)
      const singleBytesBeforeShutdown = singlePauseBytes === undefined ? undefined : await checkPausedSingleDestination(singlePauseBytes)
      if (singleBytesBeforeShutdown === undefined) await expect(stat(single.file)).rejects.toMatchObject({ code: 'ENOENT' })
      if (singleDownload !== undefined) {
        singleDownloadBeforeShutdown = { filename: singleDownload.suggestedFilename(), protocol: new URL(singleDownload.url()).protocol,
          ...(singleBytesBeforeShutdown === undefined ? { destinationExists: false }
            : { destinationExists: true, destinationBytes: singleBytesBeforeShutdown }) }
      }
      expect(exports).toHaveLength(3)
      await expectSessionUnchanged()
      const previousHost = world.ctx
      const snapshotsBeforeRestart = followSnapshots?.() ?? 0
      warningsBeforeHostStop = console.warnings.length
      await world.restart(async () => {
        await expectHostUnavailable()
        partialFilesAfterHostStop = await checkPausedSaves()
        expect(savedDownloads).toEqual([])
        completedSavesAtHostStop = savedDownloads.length
        if (completeBody !== undefined) {
          if (singlePauseBytes !== undefined) {
            singleFileBytesAfterHostStop = await checkPausedSingleDestination(singlePauseBytes)
          } else {
            await expect(stat(single.file)).rejects.toMatchObject({ code: 'ENOENT' })
            singleFileAbsentAfterHostStop = true
            const download = singleDownload === undefined ? waitForSingleBlobDownload() : Promise.resolve(singleDownload)
            writes.push(saveDownload(single, download))
          }
          completeBody.release()
          resumeSaves.resolve(undefined)
          await Promise.all(writes)
          const bytes = await readFile(single.file)
          expect(bytes.byteLength).toBe(completeSingleResponseBeforeShutdown?.bytes)
          singleFileSha256WhileStopped = createHash('sha256').update(bytes).digest('hex')
          expect(singleFileSha256WhileStopped).toBe(completeSingleResponseBeforeShutdown?.sha256)
          expect(pending.failure()).toBeNull()
          await requested.waitFor({ state: 'visible' })
          expect(exports).toHaveLength(3)
          expect(responses).toEqual([200])
          expect(downloadEvents).toEqual(allNames)
          savedWhileHostStopped = [...savedDownloads]
          expect(savedWhileHostStopped.toSorted()).toEqual(allNames.toSorted())
          await expectHostUnavailable()
          return
        }
        allowSingleRequest.resolve(undefined)
        await expect.poll(() => pending.failure()?.errorText, { timeout: 10_000 }).toBeDefined()
        const error = pending.failure()?.errorText ?? ''
        if (partialBody !== undefined && browserBody !== undefined) {
          expect(partialBody.didInterrupt()).toBe(true)
          expect(browserBody.finished).toBe(false)
          await expect.poll(() => browserBody.error).not.toBe('')
          expect(error).toMatch(/^net::ERR_(INCOMPLETE_CHUNKED_ENCODING|CONTENT_LENGTH_MISMATCH|CONNECTION_RESET|CONNECTION_CLOSED)$/u)
        } else if (hostHold === undefined) expect(error).toBe('net::ERR_CONNECTION_REFUSED')
        else {
          singleExportDisconnectedAtHost = hostHold.didDisconnect()
          expect(singleExportDisconnectedAtHost).toBe(true)
          singleExportInvocationsBeforeRestart = hostHold.invocations()
          expect(singleExportInvocationsBeforeRestart).toBe(1)
          expect(error).toMatch(/^net::ERR_(EMPTY_RESPONSE|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED)$/u)
        }
        expect(responses).toEqual(initialSingleResponses)
        await expect(stat(single.file)).rejects.toMatchObject({ code: 'ENOENT' })
        const alert = pair.locator('[role="alert"][data-csv-download-comparison-status="failed"]')
        await alert.waitFor({ state: 'visible' })
        const notice = (await alert.textContent() ?? '').trim()
        expect(notice).toBe('无法下载对照，请重试')
        expect(await button.isEnabled()).toBe(true)
        failedSingleDownload = { error, notice }
        if (evidence !== undefined && evidence.length > 0) {
          await pair.screenshot({ path: join(evidence, 'csv-single-export-failed.png') })
        }
        if (!sendRequestBeforeStop) await page.unroute(interceptExport, holdSingle)
        resumeSaves.resolve(undefined)
        await Promise.all(writes)
        savedWhileHostStopped = [...savedDownloads]
        expect(savedWhileHostStopped.toSorted()).toEqual(firstTwoNames.toSorted())
        expect(downloadEvents).toEqual(firstTwoNames)
      })
      expect(world.ctx).not.toBe(previousHost)
      expect(new URL(world.baseUrl).origin).toBe(hostUrl.origin)
      guardAnalysis()
      if (followSnapshots === undefined) {
        await expectSessionUnchanged()
        await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
        await page.locator(`[data-row-key="session:${sessionId}"]`).click()
      } else {
        await expect.poll(followSnapshots, { timeout: 30_000 }).toBeGreaterThan(snapshotsBeforeRestart)
        sessionFollowSnapshotsAfterRestart = followSnapshots() - snapshotsBeforeRestart
      }
      const retry = await showDownload(single)
      const reopenedAgent = world.ctx.agents.get(sessionId)
      if (reopenedAgent === undefined) throw new Error('The restarted Host did not reopen the original Session')
      await reopenedAgent.whenIdle()
      expect(await world.ctx.sessions.flush(reopenedAgent.session)).toBe(true)
      sessionBeforeExport = await readPersistedEvents(world, sessionId)
      expect(sessionBeforeExport.slice(0, before.length)).toEqual(before)
      sessionEventsAddedByReopen = sessionBeforeExport.slice(before.length).map(event => event.type)
      expect(sessionEventsAddedByReopen).toEqual(['session/end-seed'])
      expect(await retry.button.isEnabled()).toBe(true)
      expect(exports).toHaveLength(3)
      if (retryAfterRestart) {
        expect(downloadEvents).toEqual(firstTwoNames)
        expect(responses).toEqual(initialSingleResponses)
        await expect(stat(single.file)).rejects.toMatchObject({ code: 'ENOENT' })
        singleFileAbsentBeforeRetry = true
        singleResponsesBeforeRetry = responses.length
        exportRequestsBeforeRetry = exports.length
        await saveDownload(single, startDownload(single, retry.button))
        expect(responses).toEqual([...initialSingleResponses, 200])
        expect(savedDownloads.at(-1)).toBe(single.filename)
      } else {
        exportRequestsAfterReconnect = exports.length
        expect(responses).toEqual([200])
      }
      expect(downloadEvents).toEqual(allNames)
    } finally {
      hostHold?.release()
      completeBody?.release()
      advanceSaves.resolve(undefined)
      allowSingleRequest.resolve(undefined)
      resumeSaves.resolve(undefined)
      await Promise.allSettled(writes)
    }
  } else if (orderedSaves !== undefined
    || heldExportOrder === 'responses-together' || heldExportOrder === 'responses-together-with-overlapping-saves'
    || heldExportOrder === 'responses-together-with-saves-resumed-in-reverse-order'
    || heldExportOrder === 'responses-together-with-overlapping-reverse-resumes'
    || heldExportOrder === 'responses-in-reverse-order'
    || heldExportOrder === 'responses-in-reverse-order-with-overlapping-saves') {
    const finishIndividually = orderedSaves !== undefined
    const resumeInClickOrder = orderedSaves?.resume === 'click'
    const finishInReverseOrder = orderedSaves?.finish === 'reverse'
    const overlapResumedSaves = heldExportOrder === 'responses-together-with-overlapping-reverse-resumes' || finishIndividually
    const resumeIndividually = heldExportOrder === 'responses-together-with-saves-resumed-in-reverse-order' || overlapResumedSaves
    const pauseAllSaves = heldExportOrder === 'responses-together-with-overlapping-saves' || resumeIndividually
    const releaseTogether = heldExportOrder === 'responses-together' || pauseAllSaves
    const overlapSaves = heldExportOrder === 'responses-in-reverse-order-with-overlapping-saves'
    const filenames = files.map(file => file.filename)
    const expectedFinishOrder = finishInReverseOrder ? filenames.toReversed() : filenames
    expect(new Set(filenames).size).toBe(files.length)
    expect(files.length).toBeGreaterThan(1)
    const holds = await holdHtmlExports(page, files, releaseTogether)
    const pendingExports = files.map((file, index) => {
      const hold = holds[index]
      if (hold === undefined) throw new Error('Missing held response for an export')
      return { file, hold, download: waitForDownload(file) }
    })
    const checkPartialFiles = (pending: readonly { file: DownloadFile }[], expectedBytes = 1): Promise<PartialFile[]> =>
      Promise.all(pending.map(async ({ file }) => {
        const bytes = (await stat(file.file)).size
        expect(bytes).toBe(expectedBytes)
        return { filename: file.filename, bytes }
      }))
    const saveWithPause = async (): Promise<void> => {
      const allPaused = Promise.withResolvers<undefined>()
      const sharedResume = Promise.withResolvers<undefined>()
      const sharedFinish = Promise.withResolvers<undefined>()
      const pausedFiles = new Set<string>()
      const pausedWrites = pendingExports.map(({ file, download }) => {
        const resume = resumeIndividually ? Promise.withResolvers<undefined>() : sharedResume
        const finish = finishIndividually ? Promise.withResolvers<undefined>() : sharedFinish
        const atSecondByte = Promise.withResolvers<undefined>()
        const save = async (): Promise<void> => {
          const firstPause = async (): Promise<void> => {
            pausedFiles.add(file.filename)
            if (pausedFiles.size === pendingExports.length) allPaused.resolve(undefined)
            await resume.promise
          }
          const pauses = [firstPause]
          if (overlapResumedSaves) {
            pauses.push(async () => {
              atSecondByte.resolve(undefined)
              await finish.promise
            })
          }
          await saveWithBytePauses(await download, file.file, ...pauses)
          savedDownloads.push(file.filename)
        }
        return { file, resume, atSecondByte: atSecondByte.promise, finish, saved: save() }
      })
      const writes = pausedWrites.map(({ saved }) => saved)
      const allSaved = Promise.all(writes)
      try {
        await Promise.race([allPaused.promise, allSaved])
        expect(pausedFiles.size).toBe(pausedWrites.length)
        expect(downloadEvents.toSorted()).toEqual(filenames.toSorted())
        partialFilesBeforeResume = await checkPartialFiles(pausedWrites)
        expect(savedDownloads).toEqual([])
        completedSavesBeforeResume = savedDownloads.length
        if (resumeIndividually) {
          const resumeOrder = resumeInClickOrder ? pausedWrites : pausedWrites.toReversed()
          for (const [index, { file, resume, atSecondByte, saved }] of resumeOrder.entries()) {
            const alreadyResumed = resumeOrder.slice(0, index)
            expect(savedDownloads).toEqual(overlapResumedSaves ? [] : alreadyResumed.map(({ file }) => file.filename))
            const partialFilesBeforeResume = await checkPartialFiles(resumeOrder.slice(index))
            if (overlapResumedSaves) partialFilesBeforeResume.unshift(...await checkPartialFiles(alreadyResumed, 2))
            serialSaveResumes.push({ filename: file.filename, savedBeforeResume: [...savedDownloads], partialFilesBeforeResume })
            resume.resolve(undefined)
            if (overlapResumedSaves) await Promise.race([atSecondByte, allSaved])
            else {
              await saved
              expect((await stat(file.file)).size).toBeGreaterThan(1)
            }
          }
          if (overlapResumedSaves) {
            partialFilesBeforeFinishing = await checkPartialFiles(resumeOrder, 2)
            expect(savedDownloads).toEqual([])
          }
        }
        if (finishIndividually) {
          if (orderedSaves.stopHostBeforeFinishing === true) {
            await expectSessionUnchanged()
            warningsBeforeHostStop = console.warnings.length
            await stopHostAndVerify()
            partialFilesAfterHostStop = await checkPartialFiles(pausedWrites, 2)
            expect(savedDownloads).toEqual([])
            completedSavesAtHostStop = savedDownloads.length
          }
          const finishOrder = finishInReverseOrder ? pausedWrites.toReversed() : pausedWrites
          for (const [index, { file, finish, saved }] of finishOrder.entries()) {
            finish.resolve(undefined)
            await Promise.race([saved, allSaved])
            expect(savedDownloads).toEqual(expectedFinishOrder.slice(0, index + 1))
            const bytes = (await stat(file.file)).size
            expect(bytes).toBeGreaterThan(2)
            const partialFilesAfterFinish = await checkPartialFiles(finishOrder.slice(index + 1), 2)
            serialSaveFinishes.push({ filename: file.filename, bytes, savedAfterFinish: [...savedDownloads], partialFilesAfterFinish })
          }
        }
      } finally {
        for (const { resume, finish } of pausedWrites) {
          resume.resolve(undefined)
          finish.resolve(undefined)
        }
        await Promise.allSettled(writes)
      }
      await allSaved
    }
    const clickAndRelease = async (): Promise<void> => {
      const pendingButtons: Locator[] = []
      try {
        for (const { file, hold } of pendingExports) {
          const { pair, button } = await showDownload(file)
          pendingButtons.push(waitingButton(pair))
          await button.click()
          heldResponses.push(await hold.ready)
          expect(exports).toHaveLength(pendingButtons.length)
          await Promise.all(pendingButtons.map(expectWaiting))
        }
        expect(downloadEvents).toEqual([])
        expect(savedDownloads).toEqual([])
        downloadsBeforeHeldResponseReleased = downloadEvents.length
        if (releaseTogether) {
          responsesReleasedTogether = true
          holds[0]?.release()
          if (pauseAllSaves) await saveWithPause()
          else await Promise.all(pendingExports.map(({ file, download }) => saveDownload(file, download)))
          return
        }
        const releaseOrder = pendingExports.toReversed()
        const releaseNext = async (index: number): Promise<void> => {
          const next = releaseOrder[index]
          if (next === undefined) return
          const { file, hold, download } = next
          const alreadyReleased = releaseOrder.slice(0, index)
          const expectedDownloads = alreadyReleased.map(earlier => earlier.file.filename)
          await Promise.all(pendingButtons.slice(0, pendingButtons.length - index).map(expectWaiting))
          expect(downloadEvents).toEqual(expectedDownloads)
          expect(savedDownloads).toEqual(overlapSaves ? [] : expectedDownloads)
          const partialFilesBeforeRelease = overlapSaves ? await checkPartialFiles(alreadyReleased) : undefined
          serialReleases.push({ filename: file.filename, savedBeforeRelease: [...savedDownloads], partialFilesBeforeRelease })
          hold.release()
          if (overlapSaves && index < releaseOrder.length - 1) {
            // Keep this destination at one byte while the remaining replies are released.
            await saveWithBytePauses(await download, file.file, () => releaseNext(index + 1))
            savedDownloads.push(file.filename)
            return
          }
          await saveDownload(file, download)
          if (overlapSaves) partialFilesAfterLastReleasedDownloadSaved = await checkPartialFiles(alreadyReleased)
          await releaseNext(index + 1)
        }
        await releaseNext(0)
      } finally {
        for (const hold of holds) hold.release()
      }
    }
    await Promise.all([...pendingExports.map(({ download }) => download), clickAndRelease()])
    if (releaseTogether) {
      expect(downloadEvents.toSorted()).toEqual(filenames.toSorted())
      if (finishIndividually) expect(savedDownloads).toEqual(expectedFinishOrder)
      else if (resumeIndividually && !overlapResumedSaves) expect(savedDownloads).toEqual(filenames.toReversed())
      else expect(savedDownloads.toSorted()).toEqual(filenames.toSorted())
    } else {
      expect(downloadEvents).toEqual(filenames.toReversed())
      expect(savedDownloads).toEqual(overlapSaves ? filenames : filenames.toReversed())
    }
  } else {
    const [first, second] = files
    if (first === undefined || second === undefined || files.length !== 2 || first.locale === second.locale) {
      throw new Error('Holding an HTML response requires two exports in different languages')
    }
    const { pair, button } = await showDownload(first)
    const [hold, holdSecond] = await holdHtmlExports(page, heldExportOrder === 'second-saving-when-first-released' ? files : [first], false)
    if (hold === undefined) throw new Error('Missing held response for the first export')
    const releaseFirstResponse = (): void => {
      downloadsBeforeHeldResponseReleased ??= downloadEvents.length
      hold.release()
    }
    const pending = waitingButton(pair)
    const firstSaved = saveDownload(first, startDownload(first, button))
    const switchAndRelease = async (): Promise<void> => {
      try {
        const upstream = await hold.ready
        expect(exports).toHaveLength(1)
        await expectWaiting(pending)
        expect(downloadEvents).toEqual([])
        await switchExportLocale(page, currentLocale, second.locale)
        currentLocale = second.locale
        await expectWaiting(pending)
        expect(downloadEvents).toEqual([])
        expect(exports).toHaveLength(1)
        heldResponse = { status: upstream.status, bytes: upstream.bytes, pageLanguageBefore: languageSettings[first.locale].lang,
          pageLanguageAfter: languageSettings[second.locale].lang }
        if (heldExportOrder !== 'first-then-second') {
          expect(second.sent.messageId).not.toBe(first.sent.messageId)
          expect(second.filename).not.toBe(first.filename)
        }
        if (heldExportOrder === 'second-before-first') {
          await downloadFromCard(second)
          await expectWaiting(pending)
          expect(downloadEvents).toEqual([second.filename])
          expect(savedDownloads).toEqual([second.filename])
          expect(exports).toHaveLength(2)
        } else if (heldExportOrder === 'second-saving-when-first-released') {
          if (holdSecond === undefined) throw new Error('Missing held response for the second export')
          const { pair: secondPair, button: secondButton } = await showDownload(second)
          const releaseSecondWhenBothWaiting = async (): Promise<void> => {
            try {
              const secondUpstream = await holdSecond.ready
              expect(exports).toHaveLength(2)
              await expectWaiting(pending)
              await expectWaiting(waitingButton(secondPair))
              expect(downloadEvents).toEqual([])
              expect(savedDownloads).toEqual([])
              secondHeldResponse = { status: secondUpstream.status, bytes: secondUpstream.bytes }
            } finally { holdSecond.release() }
          }
          const [download] = await Promise.all([startDownload(second, secondButton), releaseSecondWhenBothWaiting()])
          await saveWithBytePauses(download, second.file, async () => {
            expect(downloadEvents).toEqual([second.filename])
            expect(savedDownloads).toEqual([])
            secondFileBytesBeforeHeldResponseReleased = (await stat(second.file)).size
            expect(secondFileBytesBeforeHeldResponseReleased).toBe(1)
            releaseFirstResponse()
            await firstSaved
            expect(downloadEvents).toEqual([second.filename, first.filename])
            expect(savedDownloads).toEqual([first.filename])
            expect((await stat(second.file)).size).toBe(1)
          })
          savedDownloads.push(second.filename)
        }
      } finally { releaseFirstResponse() }
    }
    await Promise.all([firstSaved, switchAndRelease()])
    if (heldExportOrder === 'first-then-second') {
      expect(downloadEvents).toEqual([first.filename])
      await downloadFromCard(second)
    } else {
      expect(downloadEvents).toEqual([second.filename, first.filename])
      expect(savedDownloads).toEqual(heldExportOrder === 'second-before-first'
        ? [second.filename, first.filename] : [first.filename, second.filename])
    }
  }
  const addresses = exports.map(exportRequestAddress)
  const expectedAddresses = files.map(({ sent, locale }) => ({ ...sent, locale }))
  expect(addresses).toEqual(retryAfterRestart ? [...expectedAddresses, expectedAddresses.at(-1)] : expectedAddresses)
  if (!hostStopped) await expectSessionUnchanged()
  const hostStopWarnings = warningsBeforeHostStop === undefined ? undefined : console.warnings.slice(warningsBeforeHostStop)
  expect(console.warnings.slice(0, warningsBeforeHostStop)).toEqual([])
  for (const warning of hostStopWarnings ?? []) expect(warning).toMatch(/^\[connection\] connection lost, retry #\d+$/u)
  expect(console.pageErrors).toEqual([])

  await page.close()
  if (!hostStopped) await stopHostAndVerify()
  const offline = await browser.newContext({ offline: true, viewport: { width: 1220, height: 1100 } })
  onTestFinished(() => offline.close())
  const offlinePage = await offline.newPage()
  debugPage = offlinePage
  let expectedUrl: string | undefined
  const offlineRequests: string[] = []
  offlinePage.on('request', (request) => {
    if (request.url() !== expectedUrl) offlineRequests.push(request.url())
  })
  const open = async ({ file, locale }: { file: string; locale: ExportLocale }): Promise<void> => {
    expectedUrl = pathToFileURL(file).href
    await offlinePage.goto(expectedUrl, { waitUntil: 'load' })
    expect(await offlinePage.locator('html').getAttribute('lang')).toBe(languageSettings[locale].lang)
    expect(await offlinePage.locator('script, iframe, form, button, input, link[rel="stylesheet"], a[href]').count()).toBe(0)
  }
  const report = async (fields: Readonly<Record<string, unknown>>, screenshot?: string): Promise<void> => {
    expect(offlineRequests).toEqual([])
    expect(restricted).toEqual([])
    expect(recordStream).not.toHaveBeenCalled()
    expect(reads).not.toHaveBeenCalled()
    if (evidence !== undefined && evidence.length > 0) {
      await Promise.all(files.map(({ file, filename, evidenceFilename }) => copyFile(file, join(evidence, evidenceFilename ?? filename))))
      if (screenshot !== undefined) await offlinePage.screenshot({ path: join(evidence, screenshot), fullPage: true })
      await writeFile(join(evidence, `${name}.json`), JSON.stringify({ browser: await offlinePage.evaluate(() => navigator.userAgent),
        ...fields, heldResponse, secondHeldResponse, responsesReleasedTogether, downloadsBeforeHeldResponseReleased,
        heldResponses: heldResponses.length > 0 ? heldResponses : undefined,
        serialReleases: serialReleases.length > 0 ? serialReleases : undefined,
        secondFileBytesBeforeHeldResponseReleased, partialFilesAfterLastReleasedDownloadSaved,
        partialFilesBeforeResume, completedSavesBeforeResume, partialFilesBeforeFinishing,
        partialFilesAfterHostStop, completedSavesAtHostStop, hostStopWarnings,
        failedSingleDownload, savedWhileHostStopped, exportRequestsBeforeRetry, sessionEventsAddedByReopen,
        singleExportBytesRenderedAtHost, singleExportDisconnectedAtHost, singleExportInvocationsBeforeRestart,
        singleResponsesBeforeRetry, singleResponseStatuses,
        partialSingleBodyBeforeShutdown, singleFileAbsentBeforeRetry,
        completeSingleResponseBeforeShutdown, singleFileSha256WhileStopped, exportRequestsAfterReconnect,
        singleDownloadBeforeShutdown, singleFileAbsentAfterHostStop, singleFileBytesAfterHostStop,
        sessionFollowSnapshotsAfterRestart,
        serialSaveResumes: serialSaveResumes.length > 0 ? serialSaveResumes : undefined,
        serialSaveFinishes: serialSaveFinishes.length > 0 ? serialSaveFinishes : undefined,
        requestedExports: addresses, exportAttempts: exports.length, downloads: downloadEvents.length, downloadEvents, savedDownloads,
        hostStopped, offlineRequests, restricted,
        modelStreams: recordStream.mock.calls.length, attachmentReads: reads.mock.calls.length,
        csvRecomputes: restricted.filter(path => path.endsWith('/recalculateCsv')).length, sessionLogUnchanged: true,
      }, null, 2) + '\n')
    }
  }
  return { fixture, files, offlinePage, evidence, open, report }
}

async function openOfflineExport<Fixture extends Pick<SentAddress, 'sessionId'>>(
  name: string, kind: DownloadSelection['kind'], seed: (world: WebScaffold, id: string) => Promise<Fixture>,
  sentAddress: (fixture: Fixture) => SentAddress,
) {
  const { fixture, files, offlinePage, evidence, open, report } = await prepareOfflineExports(name, seed, current => [
    { sent: sentAddress(current), kind },
  ])
  const [download] = files
  if (download === undefined) throw new Error('The requested CSV comparison was not exported')
  await open(download)
  const reportDocument = (fields: Readonly<Record<string, unknown>>, screenshot: string): Promise<void> =>
    report({ ...fields, filename: download.filename }, screenshot)
  return { fixture, offlinePage, evidence, report: reportDocument }
}

type CaptureOfflineSection = (scope: Locator, suffix: string) => Promise<void>

async function checkOfflineExplanation(offlinePage: Page, capture: CaptureOfflineSection, locale: ExportLocale = 'en'): Promise<void> {
  const copy = offlineCopy[locale]
  await checkDocumentTitle(offlinePage, copy.explanation)
  const steps = offlinePage.locator('[data-csv-explanation-step]')
  expect(await steps.evaluateAll(items => items.map(element => element.getAttribute('data-csv-explanation-step')))).toEqual(['aggregation', 'filtering'])
  const aggregation = steps.nth(0)
  const filtering = steps.nth(1)
  await aggregation.getByRole('heading', { name: copy.changeAggregation, exact: true }).waitFor({ state: 'visible' })
  await filtering.getByRole('heading', { name: copy.applyFilter, exact: true }).waitFor({ state: 'visible' })
  await aggregation.getByText(copy.sameRows, { exact: true }).waitFor({ state: 'visible' })
  await filtering.getByText(copy.matchingRows, { exact: true }).waitFor({ state: 'visible' })
  const firstReadings = aggregation.locator('[data-csv-explanation-readings]')
  const secondReadings = filtering.locator('[data-csv-explanation-readings]')
  await checkReadingLabels(firstReadings, [copy.unfilteredMean, copy.unfilteredSum], locale)
  await checkReadingLabels(secondReadings, [copy.unfilteredSum, copy.filteredSum], locale)
  await compareReading(firstReadings, 'original', { key: 'Warm', aggregate: copy.mean, filter: copy.noFilter, value: '30', count: '2' })
  await compareReading(firstReadings, 'locked', { key: 'Warm', aggregate: copy.sum, filter: copy.noFilter, value: '60', count: '2' })
  await compareReading(secondReadings, 'original', { key: 'Warm', aggregate: copy.sum, filter: copy.noFilter, value: '60', count: '2' })
  await compareReading(secondReadings, 'locked', { key: 'Warm', aggregate: copy.sum, filter: 'Batch = B', value: '35', count: '1' })
  const lockedAggregation = aggregation.locator('details[data-csv-explanation-locked-page="aggregation"]')
  const lockedFiltering = filtering.locator('details[data-csv-explanation-locked-page="filtering"]')
  expect(await offlinePage.locator('details[open]').count()).toBe(0)
  const display = async (scope: Locator, filteredPage: boolean): Promise<void> => {
    const title = filteredPage ? copy.filteringSummary : copy.aggregationSummary
    const summary = scope.locator('summary')
    await expect.poll(() => summary.textContent()).toBe(title)
    await summary.click()
    await expect.poll(() => scope.evaluate(element => element.hasAttribute('open'))).toBe(true)
    expect(await offlinePage.locator('details[open]').count()).toBe(1)
    await checkLockedPage(scope, filteredPage, locale)
    await capture(scope, filteredPage ? 'filtering' : 'aggregation')
    await summary.click()
    await expect.poll(() => offlinePage.locator('details[open]').count()).toBe(0)
  }
  await display(lockedAggregation, false)
  await display(lockedFiltering, true)
}

it.skipIf(webSnapshotMode() === 'record')('opens both locked steps of an exported CSV explanation with the Host stopped', async () => {
  const { fixture: { alternate, filtered, explanation }, offlinePage, evidence, report } = await openOfflineExport(
    'csv-explanation-export', 'explanation', seedWitnessedCsvExplanation, fixture => fixture.explanation,
  )
  await checkOfflineExplanation(offlinePage, async (scope, suffix) => {
    if (evidence !== undefined && evidence.length > 0) await scope.screenshot({ path: join(evidence, `csv-explanation-offline-${suffix}.png`) })
  })
  await report({ explanation, aggregation: alternate, filtering: filtered, bothLockedPagesOpenedOffline: true },
    'csv-explanation-offline-overview.png')
})

async function checkOfflineReturns(offlinePage: Page, returns: { first: { revision: number }; second: { revision: number } },
  capture: CaptureOfflineSection, locale: ExportLocale = 'en'): Promise<void> {
  const copy = offlineCopy[locale]
  await checkDocumentTitle(offlinePage, copy.comparison)
  await checkLockedPage(offlinePage.locator('body'), false, locale, true)
  await offlinePage.getByRole('heading', { name: copy.originals, exact: true }).waitFor({ state: 'visible' })
  const details = offlinePage.locator('details[data-csv-return-source]')
  expect(await details.evaluateAll(items => items.map(item => item.getAttribute('data-csv-return-source')))).toEqual(['first', 'second'])
  const opened = offlinePage.locator('details[data-csv-return-source][open]')
  expect(await opened.count()).toBe(0)
  const sides = [
    { side: 'first', label: copy.earlier, title: 'Original sample latency', aggregate: copy.mean, warm: '30', cold: '50',
      conclusion: 'Warm had mean latency 30 ms across two measurements.' },
    { side: 'second', label: copy.later, title: 'Total sample latency', aggregate: copy.sum, warm: '60', cold: '100',
      conclusion: 'Warm had total latency 60 ms across the same two measurements.' },
  ] as const
  for (const { side, label, title, aggregate, warm, cold, conclusion } of sides) {
    const source = offlinePage.locator(`details[data-csv-return-source="${side}"]`)
    const summary = source.locator('summary')
    expect(await summary.textContent()).toBe(label)
    if (side === 'first') await summary.click()
    else await summary.press('Enter')
    await expect.poll(() => source.evaluate(element => element.hasAttribute('open'))).toBe(true)
    expect(await opened.count()).toBe(side === 'first' ? 1 : 2)
    expect(await source.locator('[data-csv-return-title]').textContent()).toBe(title)
    expect(await source.locator('[data-csv-return-revision]').textContent()).toBe(`${copy.revision} ${returns[side].revision}`)
    await source.getByRole('heading', { name: copy.conclusion, exact: true }).waitFor({ state: 'visible' })
    expect(await source.locator('[data-csv-return-conclusion]').allTextContents()).toEqual([conclusion])
    const selected = source.locator('[data-csv-return-reading]')
    await selected.getByRole('heading', { name: copy.recorded, exact: true }).waitFor({ state: 'visible' })
    expect(await selected.locator('dt').allTextContents()).toEqual(copy.fields)
    for (const [field, expected] of Object.entries({ key: 'Warm', aggregate, filter: copy.noFilter, value: warm, count: '2' })) {
      expect(await selected.locator(`[data-csv-reading="${field}"]`).textContent()).toBe(expected)
    }
    const groups = source.getByRole('table', { name: copy.groups, exact: true })
    expect(await groups.getByRole('columnheader').allTextContents()).toEqual(['Trial', copy.fields[3], copy.fields[4]])
    expect(await groups.locator('[data-csv-return-group]').evaluateAll(rows => rows.map(row => ['key', 'value', 'count']
      .map(field => row.querySelector(`[data-csv-return-group-cell="${field}"]`)?.textContent)))).toEqual([
      ['Warm', warm, '2'], ['Cold', cold, '2'],
    ])
    const records = source.getByRole('table', { name: copy.participating, exact: true })
    expect(await records.getByRole('columnheader').allTextContents()).toEqual([copy.record, 'LatencyMs'])
    expect(await records.locator('[data-csv-return-record]').evaluateAll(rows => rows.map(row => ({
      record: row.getAttribute('data-csv-return-record'), value: row.querySelector('[data-csv-return-cell="value"]')?.textContent,
    })))).toEqual([{ record: '4', value: '25' }, { record: '5', value: '35' }])
    await capture(source, side)
  }
  await details.first().locator('summary').click()
  expect(await opened.count()).toBe(1)
  expect(await opened.getAttribute('data-csv-return-source')).toBe('second')
  await details.last().locator('summary').click()
  await expect.poll(() => opened.count()).toBe(0)
  await checkLockedPage(offlinePage.locator('body'), false, locale, true)
}

it.skipIf(webSnapshotMode() === 'record')('opens both original CSV returns in an exported comparison with the Host stopped', async () => {
  const { fixture: { returns, sent }, offlinePage, evidence, report } = await openOfflineExport(
    'csv-inquiry-return-comparison-export', 'comparison', seedWitnessedCsvReturnComparison, fixture => fixture.sent,
  )
  await checkOfflineReturns(offlinePage, returns, async (scope, suffix) => {
    if (evidence !== undefined && evidence.length > 0) {
      await scope.screenshot({ path: join(evidence, `csv-inquiry-return-comparison-offline-${suffix}.png`) })
    }
  })
  await report({ sent, returns, bothOriginalReturnsOpenedOffline: true, originalsOpenIndependently: true },
    'csv-inquiry-return-comparison-offline-overview.png')
})

type ImportedCsvEntry = Awaited<ReturnType<typeof seedImportedCsvSourceKinds>>['entries'][number]

async function checkImportedOfflineExport(
  offlinePage: Page, { kind, facts }: ImportedCsvEntry, locale: ExportLocale, capture: CaptureOfflineSection,
): Promise<string> {
  const label = importedSourceCopy[locale][kind]
  const attribution = offlinePage.locator('[data-csv-import-source]')
  await attribution.waitFor({ state: 'visible' })
  expect(await attribution.count()).toBe(1)
  expect(await attribution.getAttribute('data-csv-import-source')).toBe(kind)
  expect(await attribution.textContent()).toBe(label)
  expect(await offlinePage.locator('[data-csv-compare-provenance]').textContent()).toBe(importedProvenance[locale])
  if (kind === 'single-page') await checkOfflineComparison(offlinePage, locale)
  else if (kind === 'two-step-explanation') await checkOfflineExplanation(offlinePage, capture, locale)
  else {
    if (facts.returnCards === undefined) throw new Error('The imported comparison is missing its original return cards')
    await checkOfflineReturns(offlinePage, facts.returnCards, capture, locale)
  }
  expect(await attribution.isVisible()).toBe(true)
  return label
}

it.skipIf(webSnapshotMode() === 'record')('exports each imported CSV type with Chinese attribution and original pages available offline', async () => {
  const { fixture, files, offlinePage, open, evidence, report } = await prepareOfflineExports(
    'csv-imported-zh-attribution-offline-export', seedImportedCsvSourceKinds,
    ({ entries }) => entries.map(({ kind, sent }) => ({ sent,
      kind: kind === 'two-step-explanation' ? 'explanation' : 'comparison', locale: 'zh', evidenceFilename: `csv-imported-zh-${kind}.html` })),
  )
  expect(fixture.entries.map(({ kind }) => kind)).toEqual(Object.keys(importedSourceCopy.zh))
  const verified = []
  for (const entry of fixture.entries) {
    const { kind, sent } = entry
    const download = files.find(file => file.sent.eventSeq === sent.eventSeq && file.sent.messageId === sent.messageId)
    if (download === undefined) throw new Error(`Missing the downloaded ${kind} export`)
    await open(download)
    const label = await checkImportedOfflineExport(offlinePage, entry, 'zh', async (scope, suffix) => {
      if (evidence !== undefined && evidence.length > 0) {
        await scope.screenshot({ path: join(evidence, `csv-imported-zh-${kind}-offline-${suffix}.png`), animations: 'disabled' })
      }
    })
    if (evidence !== undefined && evidence.length > 0) {
      await offlinePage.screenshot({ path: join(evidence, `csv-imported-zh-${kind}-offline-overview.png`), fullPage: true })
    }
    verified.push({ kind, sent, label, filename: download.evidenceFilename ?? download.filename })
  }
  await report({ verified, documentLanguage: 'zh-CN', allExactReadingsAndRowsVerified: true, bothExplanationPagesOpenedOffline: true,
    bothReturnCardsOpenedOffline: true })
})

const bilingualExports = [
  { kind: 'single-page', title: 'single-page comparison', basename: 'csv-imported-single-page', holdFirst: false },
  { kind: 'two-step-explanation', title: 'explanation', basename: 'csv-imported-explanation', holdFirst: false },
  { kind: 'return-comparison', title: 'return comparison', basename: 'csv-imported-return-comparison', holdFirst: false },
  { kind: 'single-page', title: 'single-page comparison', basename: 'csv-imported-single-page-delayed-response', holdFirst: true },
  { kind: 'two-step-explanation', title: 'explanation', basename: 'csv-imported-explanation-delayed-response', holdFirst: true },
  { kind: 'return-comparison', title: 'return comparison', basename: 'csv-imported-return-comparison-delayed-response', holdFirst: true },
] as const

for (const { kind, title, basename, holdFirst } of bilingualExports) {
  const name = holdFirst ? `keeps the clicked language when an imported CSV ${title} export response is delayed across a language switch`
    : `exports the same imported CSV ${title} in Chinese and English after switching the UI`
  it.skipIf(webSnapshotMode() === 'record')(name, async () => {
    const { fixture, files, offlinePage, open, evidence, report } = await prepareOfflineExports(
      `${basename}-locale-switch-export`, async (world, id) => {
        const { sessionId, entries } = await seedImportedCsvSourceKinds(world, id)
        const entry = entries.find(candidate => candidate.kind === kind)
        if (entry === undefined) throw new Error(`The fixture did not save an imported ${kind}`)
        return { sessionId, entry }
      }, ({ entry }) => (['zh', 'en'] as const).map(locale => ({
        sent: entry.sent, kind: kind === 'two-step-explanation' ? 'explanation' : 'comparison',
        locale, evidenceFilename: `${basename}-${locale}.html`,
      })), holdFirst ? 'first-then-second' : undefined,
    )
    const reports = []
    for (const download of files) {
      const { locale, sent, filename, evidenceFilename } = download
      await open(download)
      const label = await checkImportedOfflineExport(offlinePage, fixture.entry, locale, async (scope, suffix) => {
        if (evidence !== undefined && evidence.length > 0) {
          await scope.screenshot({ path: join(evidence, `${basename}-${locale}-${suffix}.png`) })
        }
      })
      if (evidence !== undefined && evidence.length > 0) {
        await offlinePage.screenshot({ path: join(evidence, `${basename}-${locale}-overview.png`), fullPage: true })
      }
      reports.push({ locale, sent, language: languageSettings[locale].lang, label, filename: evidenceFilename ?? filename })
    }
    await report({ kind, reports, sameLockedReadingsAndRows: true,
      ...(kind === 'two-step-explanation' ? { bothLockedPagesOpenedOfflineInEachLanguage: true } : {}),
      ...(kind === 'return-comparison' ? { bothReturnCardsOpenedIndependentlyOfflineInEachLanguage: true } : {}),
    })
  })
}

const interleavedExports: readonly { title: string; basename: string; heldOrder: HeldExportOrder; includeSinglePage?: true }[] = [
  { title: 'saves the English return export before the waiting Chinese explanation export',
    basename: 'csv-interleaved', heldOrder: 'second-before-first' },
  { title: 'releases the Chinese explanation response while the English return download is saving',
    basename: 'csv-overlapping-save', heldOrder: 'second-saving-when-first-released' },
  { title: 'saves both card exports when the Chinese and English responses are released together',
    basename: 'csv-simultaneous', heldOrder: 'responses-together' },
  { title: 'saves three card exports when the Chinese, English, and Chinese responses are released together',
    basename: 'csv-simultaneous-three', heldOrder: 'responses-together', includeSinglePage: true },
  { title: 'saves three card exports with overlapping writes when responses are released together',
    basename: 'csv-simultaneous-overlap-three', heldOrder: 'responses-together-with-overlapping-saves', includeSinglePage: true },
  { title: 'resumes three paused saves one at a time in reverse order after releasing the responses together',
    basename: 'csv-simultaneous-reverse-saves-three', heldOrder: 'responses-together-with-saves-resumed-in-reverse-order', includeSinglePage: true },
  { title: 'overlaps three paused saves resumed in reverse order after releasing the responses together',
    basename: 'csv-simultaneous-reverse-overlap', heldOrder: 'responses-together-with-overlapping-reverse-resumes', includeSinglePage: true },
  { title: 'finishes three reverse-resumed saves in click order after releasing the responses together',
    basename: 'csv-reverse-resume-forward-save', heldOrder: { resume: 'reverse', finish: 'click' }, includeSinglePage: true },
  { title: 'finishes three reverse-resumed saves in reverse click order after releasing the responses together',
    basename: 'csv-reverse-resume-reverse-save', heldOrder: { resume: 'reverse', finish: 'reverse' }, includeSinglePage: true },
  { title: 'resumes three saves in click order and finishes them in reverse order after releasing the responses together',
    basename: 'csv-forward-resume-reverse-save', heldOrder: { resume: 'click', finish: 'reverse' }, includeSinglePage: true },
  { title: 'advances and finishes three saves in click order after releasing the responses together',
    basename: 'csv-forward-resume-forward-save', heldOrder: { resume: 'click', finish: 'click' }, includeSinglePage: true },
  { title: 'finishes three paused saves after the Host has stopped',
    basename: 'csv-host-stopped-while-saving', heldOrder: { resume: 'click', finish: 'click', stopHostBeforeFinishing: true },
    includeSinglePage: true },
  { title: 'retries only the export interrupted before its response after a Host restart',
    basename: 'csv-retry-after-host-restart', heldOrder: 'retry-after-host-restart', includeSinglePage: true },
  { title: 'retries a Host-rendered export whose response socket closed during shutdown',
    basename: 'csv-retry-pending-host-response', heldOrder: 'retry-after-host-restart-with-pending-response', includeSinglePage: true },
  { title: 'retries an export after shutdown truncates its response body',
    basename: 'csv-retry-partial-host-response', heldOrder: 'retry-after-host-restart-with-partial-body', includeSinglePage: true },
  { title: 'saves an already received response during Host shutdown without resending after reconnect',
    basename: 'csv-save-complete-response-during-restart', heldOrder: 'save-complete-response-during-host-restart', includeSinglePage: true },
  { title: 'saves an already triggered download during Host shutdown without resending after reconnect',
    basename: 'csv-save-triggered-download-during-restart', heldOrder: 'save-triggered-download-during-host-restart', includeSinglePage: true },
  { title: 'saves a download from an open empty destination during Host shutdown',
    basename: 'csv-save-open-download-during-restart', heldOrder: { singlePauseBytes: 0 }, includeSinglePage: true },
  { title: 'saves a download paused after its first byte during Host shutdown',
    basename: 'csv-save-one-byte-download-during-restart', heldOrder: { singlePauseBytes: 1 }, includeSinglePage: true },
  { title: 'saves three downloads paused at two bytes during Host shutdown and reconnect',
    basename: 'csv-save-two-byte-download-during-restart', heldOrder: { singlePauseBytes: 2 }, includeSinglePage: true },
  { title: 'saves a download paused at twenty-one bytes while the other two downloads hold two bytes during Host shutdown',
    basename: 'csv-save-twenty-one-byte-download-during-restart', heldOrder: { singlePauseBytes: 21 }, includeSinglePage: true },
  { title: 'saves three card exports in reverse response order before releasing each next response',
    basename: 'csv-reverse-three', heldOrder: 'responses-in-reverse-order', includeSinglePage: true },
  { title: 'saves three card exports with overlapping writes in reverse response order',
    basename: 'csv-reverse-overlap-three', heldOrder: 'responses-in-reverse-order-with-overlapping-saves', includeSinglePage: true },
]

for (const { title, basename, heldOrder, includeSinglePage } of interleavedExports) {
  it.skipIf(webSnapshotMode() === 'record')(title, async () => {
    const plan = [
      { source: 'two-step-explanation', kind: 'explanation', locale: 'zh', evidenceFilename: `${basename}-explanation-zh.html` },
      { source: 'return-comparison', kind: 'comparison', locale: 'en', evidenceFilename: `${basename}-return-en.html` },
    ] as const
    const singlePage = { source: 'single-page', kind: 'comparison', locale: 'zh', evidenceFilename: `${basename}-single-page-zh.html` } as const
    const selections = includeSinglePage ? [...plan, singlePage] : plan
    const { fixture, files, offlinePage, open, evidence, report } = await prepareOfflineExports(
      `${basename}-card-exports`, seedImportedCsvSourceKinds, ({ entries }) => selections.map(({ source, ...selection }) => {
        const entry = entries.find(candidate => candidate.kind === source)
        if (entry === undefined) throw new Error(`The fixture did not save an imported ${source}`)
        return { sent: entry.sent, ...selection }
      }), heldOrder,
    )
    const reports = []
    for (const download of files) {
      const { locale, sent, evidenceFilename, filename } = download
      const entry = fixture.entries.find(candidate =>
        candidate.sent.messageId === sent.messageId && candidate.sent.eventSeq === sent.eventSeq)
      if (entry === undefined) throw new Error('The downloaded card is missing from the fixture')
      await open(download)
      const screenshotPrefix = `${basename}-${entry.kind}-${locale}`
      const label = await checkImportedOfflineExport(offlinePage, entry, locale, async (scope, suffix) => {
        if (evidence !== undefined && evidence.length > 0) {
          await scope.screenshot({ path: join(evidence, `${screenshotPrefix}-${suffix}.png`) })
        }
      })
      if (evidence !== undefined && evidence.length > 0) {
        await offlinePage.screenshot({ path: join(evidence, `${screenshotPrefix}-overview.png`), fullPage: true })
      }
      reports.push({ kind: entry.kind, sent, language: languageSettings[locale].lang, label, filename: evidenceFilename ?? filename })
    }
    await report({ reports, secondSavedBeforeFirstResponseReleased: heldOrder === 'second-before-first', exactLockedReadingsAndRows: true,
      bothExplanationPagesOpenedOffline: true, bothReturnCardsOpenedIndependentlyOffline: true,
      ...(includeSinglePage ? { singlePageOpenedOffline: true } : {}) })
  })
}
