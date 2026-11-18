/** Browser transport and retained-session retry outcomes shared by live and replay CSV fixtures. */
import { join } from 'node:path'
import { parseRemoteStreamClientMessage, parseRemoteStreamServerMessage } from '@agentrans/api-gateway/stream-protocol'
import type { SessionFollowFrame } from '@agentrans/api-session-controller/types'
import type { SessionId } from '@agentrans/session'
import type { Locator, Page, Request, Route } from 'playwright'
import { expect } from 'vitest'
import { scrollIntoView } from './support.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function objectField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function rpcRequest(request: Request): unknown {
  return objectField(objectField(objectField(request.postDataJSON(), 'payload'), 'args'), 'request')
}

type HistorySnapshot = Extract<SessionFollowFrame, { type: 'snapshot' }>

/** Alter only the next observed browser snapshot of this Session, leaving durable history intact. */
export async function interceptCsvHistorySnapshot(page: Page, sessionId: SessionId,
  edit: (snapshot: HistorySnapshot) => HistorySnapshot): Promise<() => number> {
  let edited = 0
  await page.routeWebSocket('**/api/remote.mux', (socket) => {
    const server = socket.connectToServer()
    const follows = new Set<string>()
    socket.onMessage((message) => {
      if (edited === 0) {
        const frame = parseRemoteStreamClientMessage(String(message))
        if (frame.type === 'open' && frame.endpoint === 'session/follow') {
          const address = objectField(objectField(objectField(frame.payload, 'args'), 'request'), 'address')
          if (objectField(address, 'kind') === 'session' && objectField(address, 'sessionId') === sessionId) follows.add(frame.streamId)
        }
      }
      server.send(message)
    })
    server.onMessage((message) => {
      if (edited === 0 && follows.size > 0) {
        const frame = parseRemoteStreamServerMessage(String(message))
        if (frame.type === 'item' && follows.has(frame.streamId) && objectField(frame.value, 'type') === 'snapshot') {
          follows.delete(frame.streamId)
          edited++
          socket.send(JSON.stringify({ ...frame, value: edit(frame.value as HistorySnapshot) }))
          return
        }
      }
      socket.send(message)
    })
  })
  return () => edited
}

export function createCsvHistoryControls(page: Page, sessionId: SessionId, fallbackEventSeq: number) {
  const pageHistoryPattern = '**/api/session/page'
  const isEarlierPage = (incoming: Request, beforeSeq: number = fallbackEventSeq): boolean => {
    const request = rpcRequest(incoming)
    const address = objectField(request, 'address')
    return objectField(address, 'kind') === 'session' && objectField(address, 'sessionId') === sessionId
      && objectField(request, 'beforeSeq') === beforeSeq
  }
  let unavailableEarlierPages = 0
  const rejectEarlierPage = async (route: Route): Promise<void> => {
    if (!isEarlierPage(route.request())) {
      await route.continue()
      return
    }
    unavailableEarlierPages++
    await route.fulfill({ json: { type: 'server-response', rpcId: objectField(route.request().postDataJSON(), 'rpcId'),
      result: { ok: false, error: { code: 'gateway/internal', message: 'Temporary fixture history read failure', details: {} } } } })
  }
  const holdEarlierPage = async (beforeSeq: number = fallbackEventSeq, maxMessages?: number) => {
    const ready = Promise.withResolvers<unknown>()
    const release = Promise.withResolvers<undefined>()
    const delivered = Promise.withResolvers<undefined>()
    let requests = 0
    const delay = async (route: Route): Promise<void> => {
      if (!isEarlierPage(route.request(), beforeSeq)) {
        await route.fallback()
        return
      }
      requests++
      try {
        let postData: string | undefined
        if (maxMessages !== undefined) {
          const raw: unknown = route.request().postDataJSON()
          const request = rpcRequest(route.request())
          if (!isRecord(raw) || !isRecord(request)) throw new Error('The history request is not a Session page')
          const { turnWindow: _turnWindow, ...window } = request
          postData = JSON.stringify({ ...raw, payload: { args: { request: { ...window, maxMessages } } } })
        }
        const upstream = await route.fetch({ maxRetries: 0, ...(postData === undefined ? {} : { postData }) })
        try {
          const result = objectField(await upstream.json(), 'result')
          expect(objectField(result, 'ok')).toBe(true)
          ready.resolve(objectField(result, 'value'))
          await release.promise
          await route.fulfill({ response: upstream })
          delivered.resolve(undefined)
        } finally { await upstream.dispose() }
      } catch (error) {
        ready.reject(error)
        delivered.reject(error)
      }
    }
    void ready.promise.catch(() => {})
    void delivered.promise.catch(() => {})
    await page.route(pageHistoryPattern, delay)
    return {
      count: () => requests,
      async waitForResponse() {
        await expect.poll(() => requests).toBe(1)
        return await ready.promise
      },
      async deliver() {
        release.resolve(undefined)
        await delivered.promise
      },
      async close() {
        release.resolve(undefined)
        await page.unroute(pageHistoryPattern, delay)
      },
    }
  }
  const matchingHistoryRequest = (request: Request, beforeSeq: number = fallbackEventSeq): boolean =>
    new URL(request.url()).pathname === '/api/session/page' && isEarlierPage(request, beforeSeq)
  const deliverEarlierPage = async (held: Awaited<ReturnType<typeof holdEarlierPage>>, beforeSeq: number): Promise<void> => {
    const [response, finished] = await Promise.all([
      page.waitForResponse(response => matchingHistoryRequest(response.request(), beforeSeq)),
      page.waitForEvent('requestfinished', { predicate: request => matchingHistoryRequest(request, beforeSeq) }),
      held.deliver(),
    ])
    expect(response.request()).toBe(finished)
    expect(objectField(objectField(await response.json(), 'result'), 'ok')).toBe(true)
  }
  const watchEarlierPages = (): { readonly count: () => number; readonly stop: () => void } => {
    let requests = 0
    const watch = (request: Request): void => {
      if (new URL(request.url()).pathname !== '/api/session/page') return
      if (objectField(objectField(rpcRequest(request), 'address'), 'sessionId') === sessionId) requests++
    }
    page.on('request', watch)
    return { count: () => requests, stop: () => { page.off('request', watch) } }
  }
  return { pageHistoryPattern, rejectEarlierPage, holdEarlierPage, deliverEarlierPage, watchEarlierPages, matchingHistoryRequest,
    unavailableEarlierPages: () => unavailableEarlierPages }
}

interface HistoryPoint {
  readonly eventSeq: number
  readonly messageId: string
}

type ReplayPath = 'fallback' | 'retained' | 'other'

export interface RetainedCsvRetryBrowserOptions {
  readonly page: Page
  readonly retainedSessionId: SessionId
  readonly otherSessionId: SessionId
  readonly fallback: HistoryPoint
  readonly retainedTarget: HistoryPoint
  readonly otherOrigin: HistoryPoint
  readonly otherTarget: HistoryPoint
  readonly roundTrips: number
  readonly openRetainedSource: () => Promise<void>
  readonly readTraffic: () => readonly number[]
  readonly reloadAndCheck: (check: () => Promise<void>) => Promise<void>
  readonly assertPath?: (path: ReplayPath) => Promise<void>
  readonly assertUnchanged?: () => Promise<void>
  readonly evidence?: string
  readonly stage?: (name: string) => void
}

type ComparisonFocus = 'visible' | 'retained'

export async function expectFocusedCsvComparison(toggle: Locator, focus: ComparisonFocus = 'visible'): Promise<void> {
  await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
  const expected = focus === 'retained' ? { focused: true } : { focused: true, uncovered: true }
  await expect.poll(() => toggle.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const center = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    return { focused: document.activeElement === element, uncovered: center !== null && element.contains(center) }
  })).toMatchObject(expected)
}

const OUTCOMES = ['retry-before-delivery', 'stay-in-b', 'retry-after-delivery'] as const
type Outcome = typeof OUTCOMES[number]

type AssertSameSidebar = () => Promise<void>

/** Run one two-page overlap control and the three final outcomes with actual browser history delivery. */
export async function runRetainedCsvRetryScenarios(options: RetainedCsvRetryBrowserOptions) {
  const { page, retainedSessionId, otherSessionId, fallback, retainedTarget, otherOrigin, otherTarget, roundTrips,
    openRetainedSource, readTraffic, reloadAndCheck, assertPath, assertUnchanged, evidence, stage } = options
  if (!Number.isInteger(roundTrips) || roundTrips < 2) throw new RangeError('Expected at least two complete retained-session round trips')
  const { pageHistoryPattern, rejectEarlierPage, holdEarlierPage, deliverEarlierPage, watchEarlierPages, unavailableEarlierPages }
    = createCsvHistoryControls(page, retainedSessionId, fallback.eventSeq)
  const sessionRow = (sessionId: SessionId) => page.locator(`[data-row-key="session:${sessionId}"]`)
  const conversation = (sessionId: SessionId) => page.locator(`[data-conversation-session="${sessionId}"]`)
  const retained = conversation(retainedSessionId)
  const other = conversation(otherSessionId)
  const rowFor = (container: Locator, point: HistoryPoint) => container.locator(
    `[data-chat-message-id="${point.messageId}"][data-chat-message-seq="${point.eventSeq}"]`,
  )
  const replay = (row: Locator) => row.locator('[data-csv-compare-attached]')
  const toggle = (row: Locator) => replay(row).locator('[data-chat-message-control="artifact-csv-comparison"]')
  const trail = (row: Locator) => replay(row).locator('[data-csv-source-trail]')
  const expectCurrentTrail = async (row: Locator, point: HistoryPoint): Promise<void> => {
    const current = trail(row).locator('[data-csv-source-trail-stop][aria-current="location"]')
    await expect.poll(() => current.getAttribute('data-csv-source-message-id')).toBe(point.messageId)
    expect(await current.getAttribute('data-csv-source-event-seq')).toBe(String(point.eventSeq))
  }
  const expectOnlyTrail = async (): Promise<void> => {
    expect(await page.locator('[data-csv-source-trail]:visible').count()).toBe(1)
  }
  const fallbackRow = rowFor(retained, fallback)
  const targetRow = rowFor(retained, retainedTarget)
  const otherOriginRow = rowFor(other, otherOrigin)
  const otherTargetRow = rowFor(other, otherTarget)
  const retry = replay(fallbackRow).locator('[data-csv-source-recovery-retry]')
  const unavailable = retained.locator('[data-csv-source-recovery="unavailable"]')
  const sidebar = page.locator(`[data-sidebar-right-session="${retainedSessionId}"]:not([data-sidebar-right-session] [data-sidebar-right-session])`)
  const sidebarBody = sidebar.locator('[data-fixture-retained-sidebar]')
  const takeScreenshot = async (name: string, scope?: Locator): Promise<void> => {
    if (evidence === undefined) return
    if (scope === undefined) await page.screenshot({ path: join(evidence, name) })
    else await scope.screenshot({ path: join(evidence, name) })
  }
  const expectFallback = async (focus: ComparisonFocus = 'visible'): Promise<void> => {
    await expectFocusedCsvComparison(toggle(fallbackRow), focus)
    await expectCurrentTrail(fallbackRow, fallback)
    expect(await trail(targetRow).count()).toBe(0)
    await assertPath?.('fallback')
  }
  const expectRetainedTarget = async (): Promise<void> => {
    await expect.poll(() => sessionRow(retainedSessionId).getAttribute('aria-selected')).toBe('true')
    await other.waitFor({ state: 'hidden' })
    await expectFocusedCsvComparison(toggle(targetRow))
    await expectCurrentTrail(targetRow, retainedTarget)
    expect(await unavailable.count()).toBe(0)
    await expectOnlyTrail()
    await assertPath?.('retained')
  }
  const expectOtherTarget = async (): Promise<void> => {
    await expect.poll(() => sessionRow(otherSessionId).getAttribute('aria-selected')).toBe('true')
    await retained.waitFor({ state: 'hidden' })
    await expectFocusedCsvComparison(toggle(otherTargetRow))
    await expectCurrentTrail(otherTargetRow, otherTarget)
    expect(await trail(otherTargetRow).locator('[data-csv-source-trail-stop]').evaluateAll(stops => stops.map(stop => ({
      messageId: stop.getAttribute('data-csv-source-message-id'), eventSeq: Number(stop.getAttribute('data-csv-source-event-seq')),
    })))).toEqual([otherOrigin, otherTarget])
    await expectOnlyTrail()
    await assertPath?.('other')
  }
  const ensureRetainedRoute = async (): Promise<void> => {
    if (await sessionRow(retainedSessionId).getAttribute('aria-selected') !== 'true') await sessionRow(retainedSessionId).click()
    await retained.waitFor({ state: 'visible' })
    await openRetainedSource()
    await expectRetainedTarget()
  }
  const reloadDegraded = async (): Promise<void> => {
    const shortened = await interceptCsvHistorySnapshot(page, retainedSessionId, (snapshot) => {
      const records = snapshot.records.filter(record => record.event.seq >= fallback.eventSeq)
      expect(records[0]?.event.seq).toBe(fallback.eventSeq)
      expect(records.length).toBeLessThan(snapshot.records.length)
      return { ...snapshot, records, hasMore: true }
    })
    const failures = unavailableEarlierPages()
    await page.route(pageHistoryPattern, rejectEarlierPage)
    try {
      await reloadAndCheck(async () => {
        await expectFallback()
        await retry.waitFor({ state: 'visible' })
        expect(shortened()).toBe(1)
        expect(unavailableEarlierPages()).toBe(failures + 1)
        expect(await targetRow.count()).toBe(0)
      })
    } finally { await page.unroute(pageHistoryPattern, rejectEarlierPage) }
    if (!await sidebarBody.isVisible()) {
      const expander = page.locator('[data-sidebar-right-expand]')
      if (await expander.isVisible()) await expander.click()
      await sidebar.locator('[data-sidebar-right-guide-entry="fixture-retained-sidebar"]').click()
    }
  }
  const switchToOther = async (expectSameSidebar: AssertSameSidebar, openSource: boolean): Promise<void> => {
    await sessionRow(otherSessionId).click()
    await otherOriginRow.waitFor({ state: 'visible' })
    await retained.waitFor({ state: 'hidden' })
    await sidebar.waitFor({ state: 'attached' })
    expect(await sidebar.getAttribute('hidden')).not.toBeNull()
    await expectSameSidebar()
    if (openSource) {
      const originToggle = toggle(otherOriginRow)
      if (await originToggle.getAttribute('aria-expanded') === 'false') await originToggle.click()
      await replay(otherOriginRow).locator('[data-csv-view-source-question]').click()
      await expectOtherTarget()
    }
  }
  const returnToFallback = async (expectSameSidebar: AssertSameSidebar): Promise<void> => {
    await sessionRow(retainedSessionId).click()
    await retained.waitFor({ state: 'visible' })
    await expectSameSidebar()
    expect(await targetRow.count()).toBe(0)
    const fallbackToggle = toggle(fallbackRow)
    if (await fallbackToggle.getAttribute('aria-expanded') === 'false') await fallbackToggle.click()
    await retry.waitFor({ state: 'visible' })
    expect(await retry.getAttribute('aria-disabled')).toBe('false')
    await scrollIntoView(fallbackToggle)
    await fallbackToggle.focus()
    await expectFallback()
  }
  const expectHistoryHeld = async (): Promise<void> => {
    expect(await sidebarBody.getAttribute('data-fixture-history-loading-older')).toBe('true')
    expect(await sidebarBody.getAttribute('data-fixture-history-first-seq')).toBe(String(fallback.eventSeq))
  }
  const startRetry = async (): Promise<void> => {
    await retry.click()
    await expect.poll(() => retry.getAttribute('aria-disabled')).toBe('true')
    const fallbackToggle = toggle(fallbackRow)
    await scrollIntoView(fallbackToggle)
    await fallbackToggle.focus()
    await expectFallback()
    expect(await targetRow.count()).toBe(0)
    await expectHistoryHeld()
  }
  const committedHistoryStart = async (): Promise<number> => {
    await expect.poll(() => sidebarBody.getAttribute('data-fixture-history-loading-older')).toBe('false')
    const firstSeq = async (): Promise<number> => {
      const first = await sidebarBody.getAttribute('data-fixture-history-first-seq')
      return first === null ? Infinity : Number(first)
    }
    await expect.poll(firstSeq).toBeLessThanOrEqual(retainedTarget.eventSeq)
    return await firstSeq()
  }
  const historyRecords = (payload: unknown): readonly unknown[] => {
    const records = objectField(payload, 'records')
    if (!Array.isArray(records)) throw new Error('The real Host returned no history records')
    return records
  }
  const withHeldTarget = async <T>(
    finish: (deliver: () => Promise<void>, expectSameSidebar: AssertSameSidebar) => Promise<T>, captureOverlap = false,
  ) => {
    await reloadDegraded()
    await sidebarBody.waitFor({ state: 'visible' })
    const body = await sidebarBody.elementHandle()
    if (body === null) throw new Error('The retained sidebar body was not mounted')
    const expectSameSidebar: AssertSameSidebar = async () => {
      expect(await sidebarBody.evaluate((current, previous) => current === previous, body)).toBe(true)
    }
    try {
      const firstPage = await holdEarlierPage(fallback.eventSeq, 1)
      try {
        await retry.click()
        const initial = await firstPage.waitForResponse()
        const records = historyRecords(initial)
        const first = objectField(objectField(records[0], 'event'), 'seq')
        const last = objectField(objectField(records.at(-1), 'event'), 'seq')
        if (typeof first !== 'number' || typeof last !== 'number') throw new Error('The first Host page is missing its record range')
        expect(first).toBeGreaterThan(retainedTarget.eventSeq)
        expect(last).toBe(fallback.eventSeq - 1)
        expect(objectField(initial, 'hasMore')).toBe(true)
        await switchToOther(expectSameSidebar, false)
        await returnToFallback(expectSameSidebar)
        const targetPage = await holdEarlierPage(first)
        try {
          await startRetry()
          expect(firstPage.count()).toBe(1)
          expect(targetPage.count()).toBe(0)
          if (captureOverlap) await takeScreenshot('csv-retained-overlap-fresh-retry-before-old-page.png')
          await deliverEarlierPage(firstPage, fallback.eventSeq)
          const later = await targetPage.waitForResponse()
          expect(historyRecords(later).some((record) => {
            const event = objectField(record, 'event')
            return objectField(event, 'seq') === retainedTarget.eventSeq
              && objectField(objectField(event, 'data'), 'id') === retainedTarget.messageId
          })).toBe(true)
          await expectFallback()
          expect(await retry.getAttribute('aria-disabled')).toBe('true')
          expect(await targetRow.count()).toBe(0)
          if (captureOverlap) await takeScreenshot('csv-retained-overlap-old-page-arrived-fresh-still-pending.png')
          const result = await finish(async () => { await deliverEarlierPage(targetPage, first) }, expectSameSidebar)
          expect(firstPage.count()).toBe(1)
          expect(targetPage.count()).toBe(1)
          return { olderPages: [firstPage.count(), targetPage.count()], firstPageStart: first, firstPageThrough: last,
            targetPageBefore: first, result }
        } finally { await targetPage.close() }
      } finally { await firstPage.close() }
    } finally { await body.dispose() }
  }

  stage?.('csv-retained-first-overlap')
  const beforeFirst = [...readTraffic()]
  await ensureRetainedRoute()
  const { result: firstOverlapResult, ...firstPages } = await withHeldTarget(async (deliver, expectSameSidebar) => {
    await deliver()
    const committedFirstSeq = await committedHistoryStart()
    await expectSameSidebar()
    await expectRetainedTarget()
    return { committedFirstSeq }
  }, true)
  await reloadAndCheck(expectRetainedTarget)
  await assertUnchanged?.()
  expect(readTraffic()).toEqual(beforeFirst)
  await takeScreenshot('csv-retained-overlap-fresh-retry-exact-source-after-reload.png')
  const firstOverlap = { ...firstPages, ...firstOverlapResult, browserResponseFinished: true }

  const runOutcome = async (outcome: Outcome) => {
    const prefix = `csv-retained-retry-${outcome}`
    stage?.(`${prefix}-begin`)
    const before = [...readTraffic()]
    if (await sessionRow(retainedSessionId).getAttribute('aria-selected') !== 'true') await ensureRetainedRoute()
    const { result, ...pages } = await withHeldTarget(async (deliver, expectSameSidebar) => {
      const targetFocus = await page.evaluateHandle(({ eventSeq, messageId }) => {
        let count = 0
        const observe = ({ target }: FocusEvent): void => {
          if (!(target instanceof HTMLElement) || target.getAttribute('data-chat-message-control') !== 'artifact-csv-comparison') return
          const row = target.closest('[data-chat-message-id]')
          if (row?.getAttribute('data-chat-message-id') === messageId
            && row.getAttribute('data-chat-message-seq') === String(eventSeq)) count += 1
        }
        document.addEventListener('focusin', observe)
        return { count: () => count, stop: () => { document.removeEventListener('focusin', observe) } }
      }, retainedTarget)
      const focusCount = () => targetFocus.evaluate(observer => observer.count())
      const addedPaging = watchEarlierPages()
      const returnFromOther = async (screenshot?: string): Promise<void> => {
        await switchToOther(expectSameSidebar, true)
        await expectHistoryHeld()
        if (screenshot !== undefined) await takeScreenshot(screenshot, otherTargetRow)
        await returnToFallback(expectSameSidebar)
        await expectHistoryHeld()
      }
      const deliverAndCommit = async (): Promise<number> => {
        expect(await focusCount()).toBe(0)
        await deliver()
        const firstSeq = await committedHistoryStart()
        await expectSameSidebar()
        return firstSeq
      }
      try {
        // The first round trip is done. A final return, when needed, forms the last round trip.
        const setupRoundTrips = outcome === 'stay-in-b' ? roundTrips : roundTrips - 1
        for (let completed = 1; completed < setupRoundTrips; completed += 1) {
          stage?.(`${prefix}-round-trip-${completed + 1}`)
          await returnFromOther()
          await startRetry()
          expect(addedPaging.count()).toBe(0)
        }
        stage?.(`${prefix}-release-target`)
        let committedFirstSeq: number
        switch (outcome) {
          case 'retry-before-delivery':
            await returnFromOther(`${prefix}-b-before-return.png`)
            await startRetry()
            await expectSameSidebar()
            await takeScreenshot(`${prefix}-pending.png`)
            committedFirstSeq = await deliverAndCommit()
            await expectRetainedTarget()
            await takeScreenshot(`${prefix}-a-after-delivery.png`)
            break
          case 'stay-in-b':
            await takeScreenshot(`${prefix}-pending.png`)
            await switchToOther(expectSameSidebar, true)
            await expectHistoryHeld()
            await takeScreenshot(`${prefix}-b-before-a-target-page.png`, otherTargetRow)
            committedFirstSeq = await deliverAndCommit()
            expect(await sidebar.getAttribute('hidden')).not.toBeNull()
            await expectOtherTarget()
            await takeScreenshot(`${prefix}-b-after-a-target-page.png`, otherTargetRow)
            break
          case 'retry-after-delivery':
            await returnFromOther(`${prefix}-b-before-a-target-page.png`)
            await takeScreenshot(`${prefix}-a-fallback-before-target-page.png`)
            committedFirstSeq = await deliverAndCommit()
            await targetRow.waitFor({ state: 'attached' })
            expect(await toggle(targetRow).getAttribute('aria-expanded')).toBe('false')
            // Older rows can shift the viewport. Check native focus before Retry scrolls into view.
            await expectFallback('retained')
            expect(await retry.getAttribute('aria-disabled')).toBe('false')
            await other.waitFor({ state: 'hidden' })
            await takeScreenshot(`${prefix}-a-fallback-after-target-page.png`)
            break
        }
        const targetFocusEventsAfterDelivery = await focusCount()
        expect(targetFocusEventsAfterDelivery).toBe(outcome === 'retry-before-delivery' ? 1 : 0)
        let explicitRetryHistoryRequests: number | undefined
        if (outcome === 'retry-after-delivery') {
          stage?.(`${prefix}-explicit-retry`)
          const beforeRetry = addedPaging.count()
          await retry.click()
          await expectRetainedTarget()
          explicitRetryHistoryRequests = addedPaging.count() - beforeRetry
          expect(explicitRetryHistoryRequests).toBe(0)
        }
        const targetFocusEvents = await focusCount()
        expect(targetFocusEvents).toBe(outcome === 'stay-in-b' ? 0 : 1)
        const extraHistoryRequests = addedPaging.count()
        expect(extraHistoryRequests).toBe(0)
        return { committedFirstSeq, extraHistoryRequests, explicitRetryHistoryRequests, targetFocusEventsAfterDelivery, targetFocusEvents }
      } finally {
        addedPaging.stop()
        await targetFocus.evaluate((observer) => { observer.stop() })
        await targetFocus.dispose()
      }
    })
    stage?.(`${prefix}-reload`)
    const activeOnlyAfterReload = outcome === 'stay-in-b' ? 'B' : 'A'
    if (activeOnlyAfterReload === 'B') {
      await reloadAndCheck(expectOtherTarget)
      await takeScreenshot(`${prefix}-b-only-after-reload.png`, otherTargetRow)
    } else {
      await reloadAndCheck(expectRetainedTarget)
      await takeScreenshot(`${prefix}-a-only-after-reload.png`)
    }
    await assertUnchanged?.()
    expect(readTraffic()).toEqual(before)
    return { outcome, roundTrips, lastRetryBeforeDelivery: outcome === 'retry-after-delivery' ? roundTrips : roundTrips + 1,
      ...(outcome === 'retry-after-delivery' ? { explicitRetryAfterDelivery: roundTrips + 1 } : {}),
      retainedSession: retainedSessionId, visitedSession: otherSessionId, retainedTarget, visitedOrigin: otherOrigin,
      visitedTarget: otherTarget, ...pages, ...result, browserResponseFinished: true,
      sameSidebarBodyKept: true, fallbackFocusPreserved: true, targetFocusEventsBeforeDelivery: 0, activeOnlyAfterReload,
      promptRequests: 0, modelRequests: 0, originalReads: 0, csvLookups: 0 }
  }
  const retainedRetryScenarios: Awaited<ReturnType<typeof runOutcome>>[] = []
  for (const outcome of OUTCOMES) retainedRetryScenarios.push(await runOutcome(outcome))
  return { firstOverlap, retainedRetryScenarios }
}
