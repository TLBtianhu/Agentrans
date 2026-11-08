import { MESSAGES_RESPONSE } from './messages-response.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as jsonrpc from '../src/index.ts'

/**
 * Mount the real namespace plugin with in-memory stdio and exit hooks. Covers
 * the full transport/server path, response-before-exit shutdown exactly once,
 * and bare-fiber disposal without process exit.
 */

/** One ordered frame, write completion, or exit observation. */
type WireEvent =
  | { kind: 'frame'; frame: Record<string, unknown> }
  | { kind: 'write-complete'; ids: (string | number)[] }
  | { kind: 'root-disposed' }
  | { kind: 'exit'; code: number }

interface ApplyHarness {
  ctx: Context
  input: PassThrough
  /** The plugin fiber used by the bare-dispose case. */
  fiber: Awaited<ReturnType<Context['plugin']>>
  /** Frames, write completions, and exits in observation order. */
  events: WireEvent[]
  outputErrors: Error[]
  send(frame: Record<string, unknown>): void
  sendRaw(text: string): void
  frames(): Record<string, unknown>[]
  exits(): number[]
  waitForFrame(predicate: (frame: Record<string, unknown>) => boolean, description: string): Promise<Record<string, unknown>>
  dispose(): Promise<void>
}

/** Adapter whose route registration is the delayed Loader entry's readiness fact. */
class DelayedAdapter extends LlmAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('not exercised')
  }
}

/** Poll asynchronous output for up to five seconds. */
async function waitFor<T>(get: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 5000
  for (;;) {
    const value = get()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Drain asynchronous work before a negative assertion. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 25))
}

/** Mount the real plugin on a minimal harness with in-memory stdio and exit. */
async function mountPlugin(
  storageDir: string,
  options: {
    writeDelayMs?: number
    failFlush?: boolean
    defaultInput?: boolean
    exitViaLauncher?: boolean
    launcherExit?: (code: number) => void
    beforeServer?: (ctx: Context) => Promise<void> | void
  } = {},
): Promise<ApplyHarness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: storageDir })
  await new Promise(resolve => setTimeout(resolve, 50))
  await options.beforeServer?.(ctx)

  const input = new PassThrough()
  const events: WireEvent[] = []
  const outputErrors: Error[] = []
  let pendingOutput = ''
  // Record frame admission separately from write completion so delayed output
  // tests the flush barrier.
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const ids: (string | number)[] = []
      pendingOutput += chunk.toString('utf8')
      for (;;) {
        const newline = pendingOutput.indexOf('\n')
        if (newline < 0) break
        const line = pendingOutput.slice(0, newline).trim()
        pendingOutput = pendingOutput.slice(newline + 1)
        if (line) {
          const frame = JSON.parse(line) as Record<string, unknown>
          events.push({ kind: 'frame', frame })
          if (typeof frame.id === 'string' || typeof frame.id === 'number') ids.push(frame.id)
        }
      }
      const complete = (): void => {
        if (options.failFlush === true && chunk.length === 0) {
          callback(new Error('flush callback failed'))
          return
        }
        events.push({ kind: 'write-complete', ids })
        callback()
      }
      if ((options.writeDelayMs ?? 0) > 0) setTimeout(complete, options.writeDelayMs)
      else complete()
    },
  })
  output.on('error', (error: Error) => { outputErrors.push(error) })
  const exit = (code: number): void => { events.push({ kind: 'exit', code }) }
  if (options.exitViaLauncher === true || options.launcherExit !== undefined) {
    ctx.provide('appExit', options.launcherExit ?? exit)
  }

  ctx.effect(() => () => { events.push({ kind: 'root-disposed' }) }, 'jsonrpc test root-disposal witness')
  const fiber = await ctx.plugin(jsonrpc, {
    ...options.defaultInput === true ? {} : { input },
    output,
    ...options.exitViaLauncher === true ? {} : { exit },
  })

  const frames = (): Record<string, unknown>[] =>
    events.flatMap(event => event.kind === 'frame' ? [event.frame] : [])
  return {
    ctx,
    input,
    fiber,
    events,
    outputErrors,
    send: (frame) => { input.write(`${JSON.stringify(frame)}\n`) },
    sendRaw: (text) => { input.write(text) },
    frames,
    exits: () => events.flatMap(event => event.kind === 'exit' ? [event.code] : []),
    waitForFrame: (predicate, description) => waitFor(() => frames().find(predicate), description),
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  vi.unstubAllEnvs()
})

/** Keyless SSE endpoint for completing a prompt turn. */
async function mockCompletionServer(): Promise<{ url: string; requests: unknown[] }> {
  const requests: unknown[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(MESSAGES_RESPONSE)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, requests }
}

describe('dsh-sdk-jsonrpc-server plugin apply', () => {
  it('serves initialize over the injected stdio pair', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-init-'))
    const harness = await mountPlugin(storageDir, {
      beforeServer(ctx) {
        ctx.llm.registerAdapter(['deepseek-official'], new DelayedAdapter())
      },
    })
    try {
      harness.send({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'apply-model' } })

      const response = await harness.waitForFrame(frame => frame.id === 'init-1', 'initialize response')
      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 'init-1',
        result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } },
      })
      expect(harness.exits()).toEqual([])
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('waits for Loader-owned adapter registration before initialize', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-readiness-'))
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    let markStarted!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const ready = new Promise<void>((resolve) => { release = resolve })
    let delayedEntry: Promise<string> | undefined
    const harness = await mountPlugin(storageDir, {
      beforeServer: async (ctx) => {
        await ctx.plugin(Loader)
        ctx.loader.builtins['delayed-readiness'] = {
          inject: ['llm'],
          async apply(entryCtx: Context) {
            markStarted()
            await ready
            entryCtx.llm.registerAdapter(['delayed-private'], new DelayedAdapter())
          },
        }
        delayedEntry = ctx.loader.create({ name: 'cordis:delayed-readiness' })
        await started
      },
    })
    try {
      const initialize = {
        jsonrpc: '2.0',
        id: 'init-delayed',
        method: 'initialize',
        params: { cwd: storageDir, provider: 'delayed-private', model: 'apply-model' },
      }
      const probe = { jsonrpc: '2.0', id: 'probe-during-delay', method: 'nope/unknown' }
      harness.sendRaw(`${JSON.stringify(initialize)}\n${JSON.stringify(probe)}\n`)

      // The transport processes independent requests concurrently. Receiving
      // this later probe proves the preceding initialize handler has reached
      // its Loader wait, without relying on a scheduler delay.
      await harness.waitForFrame(frame => frame.id === 'probe-during-delay', 'probe while initialize waits')
      expect(harness.frames().some(frame => frame.id === 'init-delayed')).toBe(false)

      release()
      await delayedEntry
      const response = await harness.waitForFrame(frame => frame.id === 'init-delayed', 'initialize response after Loader settlement')
      expect(response).toMatchObject({
        id: 'init-delayed',
        result: { serverInfo: { name: 'deepseek-harness-sdk-runtime' } },
      })
      expect(harness.ctx.llm.listProviders()).toContainEqual({ id: 'delayed-private', name: 'delayed-private' })
    } finally {
      release()
      await Promise.allSettled(delayedEntry === undefined ? [] : [delayedEntry])
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('drives a session/prompt turn end-to-end and forwards session notifications as output frames', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-prompt-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const harness = await mountPlugin(storageDir, {
      beforeServer: async (ctx) => { await ctx.plugin(LlmDeepSeek) },
    })
    try {
      harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'dsagent-model' } })
      await harness.waitForFrame(frame => frame.id === 1, 'initialize response')

      harness.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 'main', contentBlocks: [{ type: 'text', text: 'fix it' }] },
      })
      const response = await harness.waitForFrame(frame => frame.id === 2, 'prompt response')
      expect((response.result as { messageId?: unknown }).messageId).toBeTypeOf('string')
      await harness.waitForFrame(
        frame => frame.method === 'session.status'
          && (frame.params as { status?: string } | undefined)?.status === 'idle',
        'idle session status',
      )

      expect(llmServer.requests).toHaveLength(1)
      const body = llmServer.requests[0] as { model: string; messages: { role: string }[] }
      expect(body.model).toBe('dsagent-model')
      expect(body.messages.at(-1)?.role).toBe('user')

      // Notifications use the same transport and arrive as id-less frames.
      const notifications = harness.frames().filter(frame => frame.id === undefined)
      expect(notifications.some(frame => frame.method === 'session.event')).toBe(true)
      expect(notifications.findLast(frame => frame.method === 'session.status')).toMatchObject({
        jsonrpc: '2.0',
        params: { sessionId: 'main', status: 'idle' },
      })
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it.each([false, true])('flushes shutdown before requesting exit exactly once without disposing the launcher tree (appExit=%s)', async (exitViaLauncher) => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-shutdown-'))
    const harness = await mountPlugin(storageDir, { writeDelayMs: 10, exitViaLauncher })
    const pause = vi.spyOn(harness.input, 'pause')
    const destroy = vi.spyOn(harness.input, 'destroy')
    try {
      // One chunk makes the two deferred exit callbacks race.
      const first = { jsonrpc: '2.0', id: 'sd-1', method: 'shutdown' }
      const second = { jsonrpc: '2.0', id: 'sd-2', method: 'shutdown' }
      harness.sendRaw(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)

      await waitFor(() => harness.exits().length > 0 ? true : undefined, 'exit recorder call')
      expect(harness.exits()).toEqual([0])

      // Both response writes and the flush barrier complete before exit.
      const exitIndex = harness.events.findIndex(event => event.kind === 'exit')
      const firstResponse = harness.events.findIndex(event => event.kind === 'frame' && event.frame.id === 'sd-1')
      const secondResponse = harness.events.findIndex(event => event.kind === 'frame' && event.frame.id === 'sd-2')
      const firstComplete = harness.events.findIndex(event => event.kind === 'write-complete' && event.ids.includes('sd-1'))
      const secondComplete = harness.events.findIndex(event => event.kind === 'write-complete' && event.ids.includes('sd-2'))
      const flushComplete = harness.events.findIndex(event => event.kind === 'write-complete' && event.ids.length === 0)
      expect(firstResponse).toBeGreaterThanOrEqual(0)
      expect(secondResponse).toBeGreaterThanOrEqual(0)
      expect(firstComplete).toBeGreaterThan(firstResponse)
      expect(secondComplete).toBeGreaterThan(secondResponse)
      expect(flushComplete).toBeGreaterThan(firstComplete)
      expect(flushComplete).toBeGreaterThan(secondComplete)
      expect(exitIndex).toBeGreaterThan(flushComplete)
      expect(harness.events.some(event => event.kind === 'root-disposed')).toBe(false)
      expect(pause).not.toHaveBeenCalled()
      expect(destroy).not.toHaveBeenCalled()

      await settle()
      expect(harness.exits()).toEqual([0])
      expect(harness.events.filter(event => event.kind === 'root-disposed')).toHaveLength(0)

      const before = harness.frames().length
      harness.send({ jsonrpc: '2.0', id: 'after-exit', method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'x' } })
      await settle()
      expect(harness.frames().length).toBe(before)
      await harness.dispose()
      expect(harness.events.filter(event => event.kind === 'root-disposed')).toHaveLength(1)
    } finally {
      pause.mockRestore()
      destroy.mockRestore()
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it.each([false, true])('requests failed exit without disposing the launcher tree when flush fails (appExit=%s)', async (exitViaLauncher) => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-flush-failure-'))
    const harness = await mountPlugin(storageDir, { failFlush: true, exitViaLauncher })
    try {
      harness.send({ jsonrpc: '2.0', id: 'sd-fail', method: 'shutdown' })

      await waitFor(() => harness.exits().length > 0 ? true : undefined, 'exit after flush failure')
      await settle()
      expect(harness.exits()).toEqual([1])
      expect(harness.events.filter(event => event.kind === 'root-disposed')).toHaveLength(0)
      expect(harness.outputErrors.map(error => error.message)).toEqual(['flush callback failed'])

      const before = harness.frames().length
      harness.send({ jsonrpc: '2.0', id: 'after-flush-failure', method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'x' } })
      await settle()
      expect(harness.frames().length).toBe(before)
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('stops serving on a bare fiber dispose (HMR-style unload) without calling exit', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-apply-dispose-'))
    const harness = await mountPlugin(storageDir)
    const pause = vi.spyOn(harness.input, 'pause')
    const destroy = vi.spyOn(harness.input, 'destroy')
    try {
      // Prove the handler-rejection path is live before disposal.
      harness.send({ jsonrpc: '2.0', id: 'probe-1', method: 'nope/unknown' })
      const error = await harness.waitForFrame(frame => frame.id === 'probe-1', 'error response for unknown method')
      expect(error.error).toMatchObject({
        code: -32603,
        message: 'unknown DeepSeek Harness SDK runtime method: nope/unknown',
      })

      await harness.fiber.dispose()
      expect(harness.events.some(event => event.kind === 'root-disposed')).toBe(false)

      const before = harness.frames().length
      harness.send({ jsonrpc: '2.0', id: 'probe-2', method: 'initialize', params: { cwd: storageDir, provider: 'deepseek-official', model: 'x' } })
      await settle()
      expect(harness.frames().length).toBe(before)
      expect(harness.exits()).toEqual([])
      expect(pause).not.toHaveBeenCalled()
      expect(destroy).not.toHaveBeenCalled()
    } finally {
      pause.mockRestore()
      destroy.mockRestore()
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('refuses to mount without a launcher exit service or an explicit exit request hook', async () => {
    const ctx = new Context()
    try {
      expect(() => { jsonrpc.apply(ctx, {}) }).toThrow('the launcher must provide ctx.appExit or an exit request hook')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses an explicit exit request hook before the launcher service', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-exit-hook-'))
    const launcherExit = vi.fn()
    const harness = await mountPlugin(storageDir, { launcherExit })
    try {
      harness.send({ jsonrpc: '2.0', id: 'shutdown-hook', method: 'shutdown' })
      await waitFor(() => harness.exits().length > 0 ? true : undefined, 'explicit exit request')
      expect(harness.exits()).toEqual([0])
      expect(launcherExit).not.toHaveBeenCalled()
      expect(harness.events.some(event => event.kind === 'root-disposed')).toBe(false)
    } finally {
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it.each([false, true])('pauses default process stdin for protocol shutdown but not HMR unload (shutdown=%s)', async (protocolShutdown) => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-default-stdin-'))
    const wasPaused = process.stdin.isPaused()
    const pause = vi.spyOn(process.stdin, 'pause')
    const destroy = vi.spyOn(process.stdin, 'destroy')
    const harness = await mountPlugin(storageDir, { defaultInput: true, exitViaLauncher: true })
    try {
      if (protocolShutdown) {
        process.stdin.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 'shutdown-stdin', method: 'shutdown' })}\n`))
        await waitFor(() => harness.exits().length > 0 ? true : undefined, 'default-stdin exit request')
      } else {
        await harness.fiber.dispose()
      }
      expect(pause).toHaveBeenCalledTimes(protocolShutdown ? 1 : 0)
      expect(destroy).not.toHaveBeenCalled()
      expect(harness.exits()).toEqual(protocolShutdown ? [0] : [])
      expect(harness.events.some(event => event.kind === 'root-disposed')).toBe(false)
    } finally {
      await harness.dispose()
      pause.mockRestore()
      destroy.mockRestore()
      if (wasPaused) process.stdin.pause()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('preserves a shutdown error response and requests failed exit after flush without disposing the launcher tree', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-shutdown-error-'))
    const failure = new Error('SDK-owned teardown failed')
    const shutdown = vi.spyOn(jsonrpc.HarnessSdkJsonRpcServer.prototype, 'shutdown')
      .mockRejectedValueOnce(failure).mockResolvedValueOnce({})
    const harness = await mountPlugin(storageDir, { exitViaLauncher: true, writeDelayMs: 10 })
    try {
      harness.sendRaw(`${JSON.stringify({ jsonrpc: '2.0', id: 'shutdown-error', method: 'shutdown' })}\n`
        + `${JSON.stringify({ jsonrpc: '2.0', id: 'shutdown-success', method: 'shutdown' })}\n`)
      await waitFor(() => harness.exits().length > 0 ? true : undefined, 'failed exit request')
      expect(harness.frames()).toEqual([
        { jsonrpc: '2.0', id: 'shutdown-error', error: { code: -32603, message: failure.message } },
        { jsonrpc: '2.0', id: 'shutdown-success', result: {} },
      ])
      const exitIndex = harness.events.findIndex(event => event.kind === 'exit')
      const flushIndex = harness.events.findIndex(event => event.kind === 'write-complete' && event.ids.length === 0)
      const errorWrite = harness.events.findIndex(event => event.kind === 'write-complete' && event.ids.includes('shutdown-error'))
      expect(flushIndex).toBeGreaterThan(errorWrite)
      expect(exitIndex).toBeGreaterThan(flushIndex)
      expect(harness.exits()).toEqual([1])
      expect(harness.events.some(event => event.kind === 'root-disposed')).toBe(false)
    } finally {
      shutdown.mockRestore()
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('does not acknowledge shutdown before the SDK-owned teardown settles', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-shutdown-pending-'))
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<Record<string, never>>()
    const shutdown = vi.spyOn(jsonrpc.HarnessSdkJsonRpcServer.prototype, 'shutdown').mockImplementationOnce(() => {
      entered.resolve(undefined)
      return release.promise
    })
    const harness = await mountPlugin(storageDir, { exitViaLauncher: true })
    try {
      harness.send({ jsonrpc: '2.0', id: 'shutdown-pending', method: 'shutdown' })
      await entered.promise
      harness.send({ jsonrpc: '2.0', id: 'probe-pending', method: 'nope/unknown' })
      await harness.waitForFrame(frame => frame.id === 'probe-pending', 'probe while SDK teardown waits')
      expect(harness.frames().some(frame => frame.id === 'shutdown-pending')).toBe(false)
      expect(harness.exits()).toEqual([])
      release.resolve({})
      expect(await harness.waitForFrame(frame => frame.id === 'shutdown-pending', 'settled shutdown response'))
        .toEqual({ jsonrpc: '2.0', id: 'shutdown-pending', result: {} })
      await waitFor(() => harness.exits().length > 0 ? true : undefined, 'exit request after SDK teardown')
      expect(harness.exits()).toEqual([0])
    } finally {
      release.resolve({})
      shutdown.mockRestore()
      await harness.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })
})
