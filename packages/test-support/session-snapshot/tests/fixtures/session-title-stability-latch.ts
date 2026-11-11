/** Order the title-stability replay by committed title facts rather than relative model latency. */

import type { Context } from '@agentrans/cordis'
import type { GenerateOptions, StreamChunk } from '@agentrans/llm'
import type { Session, SessionSeq } from '@agentrans/session'
import type {} from '@agentrans/session-title'
import type {} from '@agentrans/session-title-llm'

export const name = 'snapshot-session-title-stability-latch'
export const inject = ['llm', 'sessions']

/** Failure-only deadline for a title that never commits. */
export interface Config {
  /** Maximum wait for the exact title commit; never used to release a successful stream. */
  timeoutMs: number
}

type Failure = 'missing-input' | 'superseded' | 'auxiliary-failed' | 'session-disposed' | 'fixture-disposed' | 'timeout'

/** A failed test fixture gate; main model output has not started when it rejects. */
export class TitleStabilityLatchError extends Error {
  override readonly name = 'TitleStabilityLatchError'
  readonly code = 'SNAPSHOT_TITLE_LATCH'

  /**
   * Describe the gate that could not observe its required title commit.
   * @param reason - machine-readable failure category.
   * @param sessionId - affected live Session identity.
   * @param options - underlying failure, when one exists.
   */
  constructor(readonly reason: Failure, readonly sessionId: string, options?: ErrorOptions) {
    super(`title-stability replay gate ${reason} for session ${sessionId}`, options)
  }
}

type Outcome = { kind: 'committed' } | { kind: 'failed'; reason: unknown }

interface Gate {
  humanSeq: SessionSeq
  messageSeqs?: readonly SessionSeq[]
  outcome: Promise<Outcome>
  finish: (outcome: Outcome) => void
}

const TITLE_PROVIDER = 'session-title-all-prompts-llm'
const MAIN_PROVIDER = 'deepseek-official'
const TITLE_ROUTE = 'title-replay'

function fail(gate: Gate, reason: unknown): void {
  gate.finish({ kind: 'failed', reason })
}

function waitForTitle(
  session: Session, gate: Gate, stream: AsyncIterable<StreamChunk>, options: GenerateOptions, timeoutMs: number,
): AsyncIterable<StreamChunk> {
  return (async function* () {
    const abort = (): void => { fail(gate, options.signal?.reason) }
    const timer = setTimeout(() => { fail(gate, new TitleStabilityLatchError('timeout', session.id)) }, timeoutMs)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    try {
      const outcome = await gate.outcome
      if (outcome.kind === 'failed') throw outcome.reason
      options.signal?.throwIfAborted()
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
    yield* stream
  })()
}

function observeTitleStream(
  session: Session, gate: Gate, stream: AsyncIterable<StreamChunk>, options: GenerateOptions,
): AsyncIterable<StreamChunk> {
  return (async function* () {
    let stopped = false
    const abort = (): void => { fail(gate, options.signal?.reason) }
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    try {
      for await (const chunk of stream) {
        if (chunk.type === 'finish') {
          stopped = chunk.reason.kind === 'stop'
          if (!stopped) fail(gate, new TitleStabilityLatchError('auxiliary-failed', session.id, { cause: chunk.reason }))
        }
        yield chunk
      }
    } catch (error) {
      fail(gate, error)
      throw error
    } finally {
      options.signal?.removeEventListener('abort', abort)
      if (!stopped) fail(gate, new TitleStabilityLatchError('auxiliary-failed', session.id))
    }
  })()
}

/**
 * Hold conversation stream iteration until its exact all-prompts title commits; auxiliary calls remain free.
 * @param ctx - the real replay runtime carrying Session events and the LLM waterfall.
 * @param config - required missing-commit deadline; cancellation and disposal end waits immediately.
 */
export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const timeoutMs = config.timeoutMs
  if (timeoutMs === undefined || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('title-stability replay gate requires a positive integer timeoutMs')
  }
  const gates = new Map<Session, Gate>()
  ctx.effect(() => () => {
    for (const [session, gate] of gates) fail(gate, new TitleStabilityLatchError('fixture-disposed', session.id))
    gates.clear()
  }, 'snapshot title-stability gates')

  ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'user/message': {
        if (event.data.source.kind !== 'user'
          || !event.data.content.some(block => block.type === 'text' && block.text.trim().length > 0)) return
        const previous = gates.get(session)
        if (previous !== undefined) fail(previous, new TitleStabilityLatchError('superseded', session.id))
        const outcome = Promise.withResolvers<Outcome>()
        gates.set(session, { humanSeq: event.seq, outcome: outcome.promise, finish: outcome.resolve })
        break
      }
      case 'session/title-llm-request': {
        const gate = gates.get(session)
        if (gate !== undefined && event.data.titleProvider === TITLE_PROVIDER
          && event.data.route.provider === TITLE_ROUTE && event.data.route.model === 'title-model'
          && event.data.messageSeqs.at(-1) === gate.humanSeq) {
          gate.messageSeqs = [...event.data.messageSeqs]
        }
        break
      }
      case 'session/title': {
        const gate = gates.get(session)
        const expected = gate?.messageSeqs
        if (gate !== undefined && expected !== undefined && event.data.source.kind === 'provider'
          && event.data.source.provider === TITLE_PROVIDER && event.data.source.model?.provider === TITLE_ROUTE
          && event.data.source.model.model === 'title-model'
          && event.data.messageSeqs.length === expected.length
          && event.data.messageSeqs.every((seq, index) => seq === expected[index])) {
          gate.finish({ kind: 'committed' })
        }
        break
      }
      default:
        // Other records do not advance this fixture's human-input/title gate.
        break
    }
  })
  ctx.on('session/disposed', (session) => {
    const gate = gates.get(session)
    if (gate !== undefined) fail(gate, new TitleStabilityLatchError('session-disposed', session.id))
    gates.delete(session)
  })
  ctx.on('llm/stream', (options, next) => {
    const main = options.provider === MAIN_PROVIDER && options.purpose === undefined
    const auxiliary = options.provider === TITLE_ROUTE && options.purpose === 'session-title'
    if (!main && !auxiliary) return next()
    const session = options.sessionId === undefined ? undefined : ctx.sessions.get(options.sessionId)
    const gate = session === undefined ? undefined : gates.get(session)
    if (main && (session === undefined || gate === undefined)) {
      throw new TitleStabilityLatchError('missing-input', options.sessionId ?? '<missing>')
    }
    // Forward synchronous request middleware before waiting, so title generation can start.
    let stream: AsyncIterable<StreamChunk>
    try { stream = next() }
    catch (error) {
      if (gate !== undefined) fail(gate, error)
      throw error
    }
    if (session === undefined || gate === undefined) return stream
    return main ? waitForTitle(session, gate, stream, options, timeoutMs)
      : observeTitleStream(session, gate, stream, options)
  })
}
