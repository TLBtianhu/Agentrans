/** Electron-native update downloads, with inactivity deadlines and bounded binary asset reads. */
import type { RequestOptions } from 'node:http'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import type { ClientRequest, IncomingMessage } from 'electron'

const MAX_ASSET_REDIRECTS = 10

type UpdateAssetResponse = { bytes: Buffer } | { redirect: string }

/**
 * Read a complete update asset without decoding its bytes before verification.
 * @param executor - The updater transport that owns the Electron session, proxy login, and inactivity deadline.
 * @param options - HTTPS GET options from the update provider.
 * @param maxBytes - Maximum response body size in bytes.
 * @returns The asset bytes after a successful HTTP 200 response.
 * @throws HTTP failures carry `statusCode`. An unsuccessful transfer discards partial response bodies.
 */
export async function requestUpdateBytes(executor: ElectronHttpExecutor, options: RequestOptions, maxBytes: number): Promise<Buffer> {
  let requestOptions: RequestOptions = {
    ...options,
    headers: Object.assign({ 'User-Agent': 'electron-builder' }, options.headers, { 'Cache-Control': 'no-cache' }),
  }
  for (let redirects = 0; ; redirects++) {
    if (requestOptions.protocol !== 'https:') {
      throw Object.assign(new Error('desktop update: update assets require HTTPS'), { code: 'ERR_UPDATE_ASSET_INSECURE_URL' })
    }
    const response = await requestUpdateAsset(executor, requestOptions, maxBytes)
    if ('bytes' in response) return response.bytes
    if (redirects === MAX_ASSET_REDIRECTS) {
      throw Object.assign(new Error('desktop update: update asset redirected too many times'), { code: 'ERR_UPDATE_ASSET_REDIRECT_LIMIT' })
    }
    requestOptions = ElectronHttpExecutor.prepareRedirectUrlOptions(response.redirect, requestOptions)
  }
}

function requestUpdateAsset(executor: ElectronHttpExecutor, options: RequestOptions, maxBytes: number): Promise<UpdateAssetResponse> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(Object.assign(new Error('desktop update: update asset transfer was aborted'), { code: 'ERR_UPDATE_ASSET_ABORTED' }))
    }
    const request = executor.createRequest({ ...options, redirect: 'manual' }, (response: IncomingMessage) => {
      response.once('error', reject)
      response.once('aborted', onAbort)
      if (response.statusCode !== 200) {
        reject(Object.assign(new Error(`desktop update: fetching the update asset failed with HTTP ${response.statusCode}`), {
          statusCode: response.statusCode,
        }))
        request.abort()
        return
      }
      const chunks: Buffer[] = []
      let bytesReceived = 0
      const onData = (chunk: Buffer): void => {
        bytesReceived += chunk.length
        if (bytesReceived > maxBytes) {
          reject(Object.assign(new Error(`desktop update: update asset exceeds ${maxBytes} bytes`), { code: 'ERR_UPDATE_ASSET_TOO_LARGE' }))
          response.off('data', onData)
          request.abort()
          return
        }
        chunks.push(chunk)
      }
      response.on('data', onData)
      response.once('end', () => { resolve({ bytes: Buffer.concat(chunks) }) })
    })
    executor.addErrorAndTimeoutHandlers(request, reject)
    request.once('abort', onAbort)
    request.once('redirect', (_statusCode, _method, redirect) => {
      resolve({ redirect })
      request.abort()
    })
    request.end()
  })
}

/** Retains electron-updater transport and proxy handling while bounding silent connections. */
export class DesktopUpdateHttpExecutor extends ElectronHttpExecutor {
  /**
   * @param idleTimeoutMs - Maximum silence before headers or between response chunks, not a total download deadline.
   * @param proxyLogin - Existing updater login event forwarding.
   */
  constructor(private readonly idleTimeoutMs: number, proxyLogin?: ConstructorParameters<typeof ElectronHttpExecutor>[0]) {
    super(proxyLogin)
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1000 || idleTimeoutMs > 2_147_483_647) {
      throw new Error('desktop update: HTTP idle timeout must be an integer from 1000 through 2147483647')
    }
  }

  override addErrorAndTimeoutHandlers(request: ClientRequest, reject: (error: Error) => void): void {
    // The upstream socket timer is for Node HTTP; Electron ClientRequest has response/close events instead.
    super.addErrorAndTimeoutHandlers(request, reject, this.idleTimeoutMs)
    let response: IncomingMessage | undefined
    let timer: ReturnType<typeof setTimeout>
    let stopped = false
    const stop = (): void => {
      stopped = true
      clearTimeout(timer)
      request.off('response', onResponse)
      request.off('abort', stop)
      request.off('error', stop)
      response?.off('data', refresh)
      response?.off('end', stop)
      response?.off('error', stop)
      response?.off('aborted', stop)
    }
    const refresh = (): void => {
      if (stopped) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        stop()
        reject(Object.assign(new Error('Desktop update connection timed out'), { code: 'ETIMEDOUT' }))
        request.abort()
      }, this.idleTimeoutMs)
    }
    const onResponse = (incoming: IncomingMessage): void => {
      if (stopped) return
      response = incoming
      response.on('data', refresh)
      response.once('end', stop)
      response.once('error', stop)
      response.once('aborted', stop)
      refresh()
    }
    request.once('response', onResponse)
    // Electron 44 can emit writable close after finish, before response headers arrive.
    request.once('abort', stop)
    request.once('error', stop)
    refresh()
  }
}
