import { Context } from '@agentrans/cordis'
import SessionStore, { SessionId, type Session, type SessionSeq } from '@agentrans/session'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@agentrans/llm'
import { SessionTitleProviderId } from '@agentrans/session-title'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as latch from './fixtures/session-title-stability-latch.ts'

class FixtureAdapter extends LlmAdapter {
  readonly calls: string[] = []
  auxiliaryError: Error | undefined
  auxiliaryWait: Promise<void> | undefined
  auxiliaryStarted: (() => void) | undefined

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options.provider)
    if (options.provider === 'title-replay') {
      this.auxiliaryStarted?.()
      await this.auxiliaryWait
      if (this.auxiliaryError !== undefined) throw this.auxiliaryError
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup(timeoutMs = 1000) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const adapter = new FixtureAdapter()
  ctx.llm.registerAdapter(['deepseek-official', 'title-replay'], adapter)
  const fiber = await ctx.plugin(latch, { timeoutMs })
  const session = ctx.sessions.create(SessionId('title-latch'))
  return { ctx, adapter, fiber, session }
}

function human(session: Session): SessionSeq {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Title this human prompt.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

function request(session: Session, messageSeqs: SessionSeq[]): void {
  session.append('session/title-llm-request', {
    titleProvider: SessionTitleProviderId('session-title-all-prompts-llm'), messageSeqs,
    route: { provider: 'title-replay', model: 'title-model' }, system: 'title fixture', messages: [], maxTokens: 32,
  })
}

function title(session: Session, messageSeqs: SessionSeq[], provider = 'session-title-all-prompts-llm'): void {
  session.append('session/title', {
    title: 'Fixture title', messageSeqs,
    source: { kind: 'provider', provider: SessionTitleProviderId(provider), model: { provider: 'title-replay', model: 'title-model' } },
  })
}

function main(ctx: Context, session: Session, signal?: AbortSignal): Promise<StreamChunk[]> {
  const stream = ctx.llm.stream({ provider: 'deepseek-official', model: 'fixture-main', messages: [], sessionId: session.id,
    ...signal === undefined ? {} : { signal } })
  return (async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks
  })()
}

async function auxiliary(ctx: Context, session: Session, signal?: AbortSignal): Promise<void> {
  for await (const _chunk of ctx.llm.stream({
    provider: 'title-replay', model: 'title-model', messages: [], purpose: 'session-title', sessionId: session.id,
    ...signal === undefined ? {} : { signal },
  })) { /* Consume the fixed local auxiliary stream. */ }
}

describe('title-stability replay latch', () => {
  it('forwards request middleware but holds main dispatch while real request metadata arrives asynchronously', async () => {
    const { ctx, adapter, session } = await setup()
    const seq = human(session)
    let forwarded = false
    ctx.on('llm/stream', (_options, next) => { forwarded = true; return next() })
    const next = main(ctx, session)
    expect(forwarded).toBe(true)
    request(session, [seq])
    await auxiliary(ctx, session)
    expect(adapter.calls).toEqual(['title-replay'])
    title(session, [seq])
    await expect(next).resolves.toMatchObject([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(adapter.calls).toEqual(['title-replay', 'deepseek-official'])
  })

  it('ignores fallback, foreign Session/provider, stale and incomplete watermarks', async () => {
    const { ctx, adapter, session } = await setup()
    const old = human(session)
    request(session, [old])
    title(session, [old])
    const current = human(session)
    request(session, [old, current])
    const next = main(ctx, session)
    session.append('session/title', { title: 'fallback', messageSeqs: [old], source: { kind: 'fallback' } })
    const other = ctx.sessions.create(SessionId('foreign-title-latch'))
    title(other, [old, current])
    title(session, [old, current], 'foreign-provider')
    title(session, [old])
    title(session, [current])
    await auxiliary(ctx, session)
    expect(adapter.calls).toEqual(['title-replay'])
    title(session, [old, current])
    await next
    expect(adapter.calls).toEqual(['title-replay', 'deepseek-official'])
  })

  it('retains an exact title committed before main iteration begins', async () => {
    const { ctx, adapter, session } = await setup()
    const seq = human(session)
    request(session, [seq])
    title(session, [seq])
    await main(ctx, session)
    expect(adapter.calls).toEqual(['deepseek-official'])
  })

  it('fails the held main request on an auxiliary failure without dispatching it', async () => {
    const { ctx, adapter, session } = await setup()
    const seq = human(session)
    request(session, [seq])
    adapter.auxiliaryError = new Error('fixed auxiliary failure')
    const rejected = expect(main(ctx, session)).rejects.toMatchObject({ code: 'SNAPSHOT_TITLE_LATCH', reason: 'auxiliary-failed' })
    await auxiliary(ctx, session)
    await rejected
    expect(adapter.calls).toEqual(['title-replay'])
  })

  it('preserves a synchronous downstream middleware error and releases its held main request', async () => {
    const { ctx, session } = await setup()
    const seq = human(session)
    request(session, [seq])
    const error = new Error('fixed synchronous middleware failure')
    const dispose = ctx.on('llm/stream', (options, next) => {
      if (options.provider === 'title-replay') throw error
      return next()
    })
    const rejected = expect(main(ctx, session)).rejects.toBe(error)
    await expect(auxiliary(ctx, session)).rejects.toBe(error)
    await rejected
    dispose()
    const current = human(session)
    request(session, [seq, current])
    title(session, [seq, current])
    await main(ctx, session)
  })

  it.each(['main', 'auxiliary'] as const)('preserves %s cancellation and leaves the next human gate usable', async (kind) => {
    const { ctx, adapter, session } = await setup()
    const seq = human(session)
    request(session, [seq])
    const controller = new AbortController()
    const reason = new Error('cancel this fixture operation')
    const rejected = expect(main(ctx, session, kind === 'main' ? controller.signal : undefined)).rejects.toBe(reason)
    controller.abort(reason)
    if (kind === 'auxiliary') await auxiliary(ctx, session, controller.signal)
    await rejected
    const nextSeq = human(session)
    request(session, [seq, nextSeq])
    title(session, [seq, nextSeq])
    await main(ctx, session)
    expect(adapter.calls.at(-1)).toBe('deepseek-official')
  })

  it('releases a superseded gate without accepting its late title for the next human', async () => {
    const { ctx, adapter, session } = await setup()
    const old = human(session)
    request(session, [old])
    const rejected = expect(main(ctx, session)).rejects.toMatchObject({ reason: 'superseded' })
    const current = human(session)
    await rejected
    request(session, [old, current])
    const next = main(ctx, session)
    title(session, [old])
    await auxiliary(ctx, session)
    expect(adapter.calls).toEqual(['title-replay'])
    title(session, [old, current])
    await next
  })

  it('keeps a late failed auxiliary stream bound to its superseded human gate', async () => {
    const { ctx, adapter, session } = await setup()
    const old = human(session)
    request(session, [old])
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    adapter.auxiliaryStarted = () => { entered.resolve(undefined) }
    adapter.auxiliaryWait = release.promise
    adapter.auxiliaryError = new Error('late auxiliary failure')
    const rejected = expect(main(ctx, session)).rejects.toMatchObject({ reason: 'superseded' })
    const oldAuxiliary = auxiliary(ctx, session)
    await entered.promise
    const current = human(session)
    await rejected
    request(session, [old, current])
    const next = main(ctx, session)
    release.resolve(undefined)
    await oldAuxiliary
    expect(adapter.calls).toEqual(['title-replay'])
    title(session, [old, current])
    await next
  })

  it('releases held iteration when its fixture unloads', async () => {
    const { ctx, adapter, fiber, session } = await setup()
    human(session)
    const rejected = expect(main(ctx, session)).rejects.toMatchObject({ reason: 'fixture-disposed' })
    await fiber.dispose()
    await rejected
    expect(adapter.calls).toEqual([])
  })

  it('releases held iteration when its Session is disposed', async () => {
    const { ctx, adapter } = await setup()
    let owned!: Session
    const owner = await ctx.plugin({ inject: ['sessions'], apply(child) { owned = child.sessions.create(SessionId('owned-title-latch')) } })
    human(owned)
    const rejected = expect(main(ctx, owned)).rejects.toMatchObject({ reason: 'session-disposed' })
    await owner.dispose()
    await rejected
    expect(adapter.calls).toEqual([])
  })

  it('fails a missing commit at its diagnostic deadline instead of releasing main output', async () => {
    const { ctx, adapter, session } = await setup(5)
    const seq = human(session)
    request(session, [seq])
    await auxiliary(ctx, session)
    await expect(main(ctx, session)).rejects.toMatchObject({ reason: 'timeout' })
    expect(adapter.calls).toEqual(['title-replay'])
  })

  it('fails a main stream with no normal human input instead of waiting for an unrelated title', async () => {
    const { ctx, session } = await setup()
    expect(() => main(ctx, session)).toThrow(latch.TitleStabilityLatchError)
  })

  it.each([undefined, 0, 1.5, NaN, 2_147_483_648])('rejects an invalid diagnostic deadline %s before registering listeners', (timeoutMs) => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    expect(() => { latch.apply(ctx, timeoutMs === undefined ? {} : { timeoutMs }) }).toThrow('requires a positive integer timeoutMs')
  })
})
