/**
 * SDK-facing JSON-RPC plugin over stdio. The selected dsh profile decides
 * whether to load it; see the single-launch Agent Note and package README.
 * Stdout is reserved for protocol frames, so the tree must not load a stdout logger.
 * This plugin answers `shutdown` and requests launcher-owned exit; the launcher
 * owns root disposal and process completion. Keep named plugin exports with no default export so
 * Loader `unwrapExports` preserves `name`, `inject`, `Config`, and `apply`.
 *
 * @module @agentrans/sdk-jsonrpc-server
 */

import type { Context } from '@agentrans/cordis'
import type {} from '@agentrans/cmdline'
import type { Readable, Writable } from 'node:stream'
import Schema from '@agentrans/schemastery'
import { JsonRpcLineTransport } from '@agentrans/sdk-protocol'
import { HarnessSdkJsonRpcServer } from './server.ts'

export * from './server.ts'

export const name = 'sdk-jsonrpc-server'
export const inject = ['agents', 'workingDirectory']

/** JSON-RPC deployment config plus runtime-only test hooks. */
export interface JsonRpcConfig {
  /** Report max-token turn/subagent termination as a successful SDK result. */
  maxTokensAsSuccess?: boolean
  /** Transport input override; production uses `process.stdin`. */
  input?: Readable
  /** Transport output override; production uses `process.stdout`. */
  output?: Writable
  /** Exit-request override; production uses the launcher's `appExit` service. */
  exit?: (code: number) => void
}

export const Config: Schema<JsonRpcConfig> = Schema.object({
  maxTokensAsSuccess: Schema.boolean().default(false),
})

/**
 * Serve SDK requests over the configured streams. Effect disposal shuts down
 * SDK-created agents and closes the transport. A `shutdown` response is flushed
 * before requesting launcher-owned root disposal and natural process completion.
 * A failed flush requests exit 1. EOF and signals use the same launcher lifecycle.
 */
export function apply(ctx: Context, config: JsonRpcConfig): void {
  // Cordis applies the schema default before invoking the plugin.
  const resolvedConfig = config as JsonRpcConfig & { maxTokensAsSuccess: boolean }
  const requestExit = config.exit ?? ctx.get('appExit')
  if (requestExit === undefined) {
    throw new Error('sdk-jsonrpc-server: the launcher must provide ctx.appExit or an exit request hook before the tree mounts')
  }
  const input = config.input ?? process.stdin
  /* v8 ignore next -- production stdio wiring; tests always inject the runtime hooks */
  const output = config.output ?? process.stdout

  const transport = new JsonRpcLineTransport(input, output)
  const server = new HarnessSdkJsonRpcServer(ctx, transport, {
    maxTokensAsSuccess: resolvedConfig.maxTokensAsSuccess,
  })
  // Compositions can order Schedule after its activation handler is installed.
  // Like the app startup marker, this carries readiness, not another control API.
  ctx.provide('sdkSessionActivation', { ready: true })

  // Racing shutdown requests share one flush and one launcher exit request.
  let exitTask: Promise<void> | undefined
  let exitCode = 0
  const requestExitAfterFlush = (): Promise<void> => {
    exitTask ??= (async () => {
      try {
        await transport.flush()
      } catch (error) {
        // A failed response write still requires launcher-owned teardown.
        exitCode = 1
        ctx.logger.error(error)
      } finally {
        transport.close()
        // Only the production stdin belongs to this stdio app. Caller-provided
        // inputs and HMR disposal retain their existing stream ownership.
        if (config.input === undefined) input.pause()
        requestExit(exitCode)
      }
    })()
    return exitTask
  }
  const scheduleExit = (code: number): void => {
    if (code !== 0) exitCode = code
    // The handler response reaches the output before its flush barrier.
    setImmediate(() => { void requestExitAfterFlush() })
  }

  transport.onRequest(async (method, params) => {
    // `initialize` is the SDK's readiness boundary. This plugin can activate
    // before async sibling Loader entries (for example an MCP client's initial
    // tool discovery), so do not advertise a ready runtime until the complete
    // current tree has settled. Loader settlement joins entry imports, fiber
    // lifecycle work, and synchronous effect registration; no scheduler delay
    // is part of readiness. A hand-built context without Loader remains
    // immediately usable.
    if (method === 'initialize') {
      await ctx.get('loader')?.await()
    }
    try {
      const result = await server.handleRequest(method, params)
      if (method === 'shutdown') scheduleExit(0)
      return result
    } catch (error) {
      // Preserve the teardown error response before requesting failed exit.
      if (method === 'shutdown') scheduleExit(1)
      throw error
    }
  })

  ctx.effect(() => {
    transport.start()
    return async () => {
      try {
        await server.shutdown()
      } finally {
        transport.close()
      }
    }
  }, 'jsonrpc.serve')
}
