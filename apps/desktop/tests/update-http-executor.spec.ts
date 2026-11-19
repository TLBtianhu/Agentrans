import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { RequestOptions } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientRequest, IncomingMessage } from 'electron'
import { DesktopUpdateHttpExecutor, requestUpdateBytes } from '../src/update-http-executor.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function fixture() {
  const request = outgoingRequest()
  const reject = vi.fn()
  new DesktopUpdateHttpExecutor(1000).addErrorAndTimeoutHandlers(request, reject)
  return { request, reject }
}

describe('Electron updater inactivity deadline', () => {
  it('aborts a request that never receives headers without waiting for a Node socket event', async () => {
    const { request, reject } = fixture()
    await vi.advanceTimersByTimeAsync(1000)
    expect(reject).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'ETIMEDOUT' }))
    expect(request.abort).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refreshes the deadline on actual response bytes rather than timing out a long active download', async () => {
    const { request, reject } = fixture()
    const response = new EventEmitter()
    request.emit('response', response)
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(900)
      response.emit('data', Buffer.from('data'))
    }
    expect(reject).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(reject).toHaveBeenCalledOnce()
    expect(response.listenerCount('data')).toBe(0)
  })

  it.each(['abort', 'error'])('removes the deadline on request %s', async (event) => {
    const { request, reject } = fixture()
    request.emit(event, new Error('transport failure'))
    const count = reject.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(request.abort).not.toHaveBeenCalled()
    expect(reject).toHaveBeenCalledTimes(count)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps waiting for headers after Electron closes the request writable stream', async () => {
    const { request, reject } = fixture()
    request.emit('finish')
    request.emit('close')
    await vi.advanceTimersByTimeAsync(1000)
    expect(reject).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'ETIMEDOUT' }))
  })

  it('does not leave a deadline running while completed bytes undergo verification', async () => {
    const { request, reject } = fixture()
    const response = new EventEmitter()
    request.emit('response', response)
    response.emit('end')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reject).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([0, 999, 1.5, NaN, 2_147_483_648])('rejects invalid inactivity configuration: %s', (value) => {
    expect(() => new DesktopUpdateHttpExecutor(value)).toThrow('idle timeout')
  })
})

function outgoingRequest() {
  const request = Object.assign(new EventEmitter(), { abort: vi.fn(() => { request.emit('abort') }), end: vi.fn() })
  // The fixture models the request events and methods that the executor uses.
  return request as typeof request & ClientRequest
}

function assetFixture(headers: RequestOptions['headers'] = {}, maxBytes = 32) {
  const executor = new DesktopUpdateHttpExecutor(1000)
  const requests: { options: RequestOptions & { redirect?: string }; request: ReturnType<typeof outgoingRequest> }[] = []
  vi.spyOn(executor, 'createRequest').mockImplementation((options: RequestOptions, onResponse: (response: IncomingMessage) => void) => {
    const request = outgoingRequest()
    request.once('response', onResponse)
    requests.push({ options, request })
    return request
  })
  const result = requestUpdateBytes(executor, { protocol: 'https:', hostname: 'github.com', path: '/metadata.yml', headers }, maxBytes)
  const requestAt = (index: number) => {
    const entry = requests[index]
    assert(entry, `Expected update request ${index + 1}`)
    return entry
  }
  return { requests, result, requestAt }
}

function receiveResponse(request: EventEmitter, statusCode = 200) {
  const response = Object.assign(new EventEmitter(), { statusCode })
  request.emit('response', response)
  return response
}

describe('Binary update asset transport', () => {
  it('returns exact response bytes, including a BOM, a split multibyte character, CRLF, and invalid UTF-8', async () => {
    const { requestAt, result } = assetFixture({ 'Cache-Control': 'max-age=600' }, 10)
    const { options, request } = requestAt(0)
    expect(options).toMatchObject({ redirect: 'manual', headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'electron-builder' } })
    const response = receiveResponse(request)
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0xf0, 0x9f, 0x92, 0xa1, 0x0d, 0x0a, 0xff])
    response.emit('data', bytes.subarray(0, 5))
    response.emit('data', bytes.subarray(5))
    response.emit('end')
    await expect(result).resolves.toEqual(bytes)
    expect(request.abort).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([206, 404, 503])('returns HTTP status %s as an error and stops its transfer', async (statusCode) => {
    const { requestAt, result } = assetFixture()
    const { request } = requestAt(0)
    receiveResponse(request, statusCode)
    await expect(result).rejects.toMatchObject({ statusCode })
    expect(request.abort).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts when streamed chunks exceed the byte limit', async () => {
    const { requestAt, result } = assetFixture({}, 4)
    const { request } = requestAt(0)
    const response = receiveResponse(request)
    response.emit('data', Buffer.from('12'))
    response.emit('data', Buffer.from('345'))
    response.emit('data', Buffer.from('6'))
    response.emit('end')
    await expect(result).rejects.toMatchObject({ code: 'ERR_UPDATE_ASSET_TOO_LARGE' })
    expect(request.abort).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('follows an asset redirect without leaking authentication headers to the CDN', async () => {
    const headers = { Authorization: 'token fake', Cookie: 'session=fake', 'x-user-staging-id': 'test' }
    const { requestAt, result } = assetFixture(headers)
    const first = requestAt(0).request
    first.emit('redirect', 302, 'GET', 'https://release-assets.githubusercontent.com/metadata.yml?asset=sample')
    await Promise.resolve()
    const { request, options } = requestAt(1)
    expect(first.abort).toHaveBeenCalledOnce()
    expect(options).toMatchObject({
      hostname: 'release-assets.githubusercontent.com',
      path: '/metadata.yml?asset=sample',
      headers: { 'Cache-Control': 'no-cache', 'x-user-staging-id': 'test' },
    })
    expect(options.headers).not.toHaveProperty('Authorization')
    expect(options.headers).not.toHaveProperty('Cookie')
    expect(headers).toHaveProperty('Authorization', 'token fake')
    const response = receiveResponse(request)
    response.emit('data', Buffer.from('data'))
    response.emit('end')
    await expect(result).resolves.toEqual(Buffer.from('data'))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses to follow an HTTPS redirect to HTTP', async () => {
    const { requests, requestAt, result } = assetFixture()
    requestAt(0).request.emit('redirect', 302, 'GET', 'http://example.com/metadata.yml')
    await expect(result).rejects.toMatchObject({ code: 'ERR_UPDATE_ASSET_INSECURE_URL' })
    expect(requests).toHaveLength(1)
    expect(requestAt(0).request.abort).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops a redirect loop after ten hops', async () => {
    const { requests, requestAt, result } = assetFixture()
    for (let hop = 0; hop <= 10; hop++) {
      requestAt(hop).request.emit('redirect', 302, 'GET', 'https://github.com/metadata.yml')
      await Promise.resolve()
    }
    await expect(result).rejects.toMatchObject({ code: 'ERR_UPDATE_ASSET_REDIRECT_LIMIT' })
    expect(requests).toHaveLength(11)
    for (const { request } of requests) expect(request.abort).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a response aborted after partial bytes arrive', async () => {
    const { requestAt, result } = assetFixture()
    const response = receiveResponse(requestAt(0).request)
    response.emit('data', Buffer.from('partial'))
    response.emit('aborted')
    await expect(result).rejects.toMatchObject({ code: 'ERR_UPDATE_ASSET_ABORTED' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out if a redirected request stops sending bytes', async () => {
    const { requestAt, result } = assetFixture()
    requestAt(0).request.emit('redirect', 302, 'GET', 'https://release-assets.githubusercontent.com/metadata.yml')
    await Promise.resolve()
    const { request } = requestAt(1)
    const response = receiveResponse(request)
    response.emit('data', Buffer.from('partial'))
    const rejection = expect(result).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    await vi.advanceTimersByTimeAsync(1000)
    await rejection
    expect(request.abort).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
