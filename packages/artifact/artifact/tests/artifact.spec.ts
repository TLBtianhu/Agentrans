import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import ArtifactService, { ArtifactError, type Config } from '../src/index.ts'
import * as ArtifactTool from '../src/tool.ts'
import type { ArtifactPrepareInput, ArtifactSnapshot } from '../src/types.ts'

const contexts: Context[] = []
let sequence = 0

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

interface RoutedAgent extends Agent {
  readonly inject: ReturnType<typeof vi.fn<(message: UserMessage) => void>>
  readonly steer: ReturnType<typeof vi.fn<(message: UserMessage) => void>>
}

function makeAgent(ctx: Context, id: string, seed?: readonly SessionEvent[]): RoutedAgent {
  const agentId = SessionId(id)
  return {
    id: agentId,
    session: Session.create(agentId, seed),
    ctx,
    inject: vi.fn<(message: UserMessage) => void>(),
    steer: vi.fn<(message: UserMessage) => void>(),
  } as RoutedAgent
}

async function setup(config: Config = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ArtifactService, config)
  const toolFiber = ctx.plugin(ArtifactTool, {})
  await toolFiber
  const agent = makeAgent(ctx, `artifact-${++sequence}`)
  ctx.agents.enter(agent, undefined)
  const execute = (args: unknown, signal = new AbortController().signal) => executeModelToolFixture(ctx, {
    callId: ToolCallId(`artifact-call-${++sequence}`), name: 'artifact', arguments: args, signal, agent,
  })
  return { ctx, agent, execute, service: ctx.artifacts, toolFiber }
}

function createInput(): ArtifactPrepareInput {
  return {
    action: 'create', artifactId: 'demo', title: '  Demo  ', source: '<!doctype html><title>Demo</title>', presentation: 'inline',
  }
}

function mutation(value: unknown): ArtifactPrepareInput {
  return value as ArtifactPrepareInput
}

function json(value: unknown): JsonValue {
  return value as JsonValue
}

function upserts(agent: Agent): ArtifactSnapshot[] {
  return agent.session.snapshotEvents().filter(event => event.type === 'artifact/upsert').map(event => event.data)
}

function actionText(agent: RoutedAgent, wake: boolean): string {
  const calls = wake ? agent.steer.mock.calls : agent.inject.mock.calls
  const message = calls[0]?.[0]
  expect(message?.content).toHaveLength(1)
  const block = message?.content[0]
  if (block?.type !== 'text') throw new Error('expected one artifact-action text block')
  return block.text
}

describe('ArtifactService prepare and commit', () => {
  it('creates and updates complete snapshots with trimmed titles and increasing revisions', async () => {
    const { agent, service } = await setup()
    const created = service.prepare(agent, createInput())
    expect(created).toEqual({
      artifactId: 'demo', revision: 1, format: 'html', title: 'Demo',
      source: '<!doctype html><title>Demo</title>', presentation: 'inline',
    })
    expect(upserts(agent)).toEqual([])
    service.commit(agent, created)
    const updated = service.prepare(agent, {
      ...createInput(), action: 'update', baseRevision: 1, title: 'Next', source: '<p>new</p>', presentation: 'focus',
    })
    expect(updated.revision).toBe(2)
    service.commit(agent, updated)
    expect(upserts(agent)).toEqual([created, updated])
  })

  it('keeps comparison metadata independent and validates group roles', async () => {
    const { agent, service } = await setup()
    const control = service.prepare(agent, {
      ...createInput(), artifactId: 'control', comparison: { group: 'damping-study', role: 'control' },
    })
    const variant = service.prepare(agent, {
      ...createInput(), artifactId: 'variant', comparison: { group: 'damping-study', role: 'variant' },
    })
    expect(control.comparison).toEqual({ group: 'damping-study', role: 'control' })
    expect(variant.comparison).toEqual({ group: 'damping-study', role: 'variant' })
    service.commit(agent, control)
    service.commit(agent, variant)
    expect(upserts(agent).map(snapshot => snapshot.comparison)).toEqual([control.comparison, variant.comparison])
    expect(() => service.prepare(agent, mutation({
      ...createInput(), artifactId: 'bad-role', comparison: { group: 'damping-study', role: 'other' },
    }))).toThrow(expect.objectContaining({ code: 'BAD_INPUT' }))
    expect(() => service.prepare(agent, mutation({
      ...createInput(), artifactId: 'bad-group', comparison: { group: 'Invalid Group', role: 'control' },
    }))).toThrow(expect.objectContaining({ code: 'BAD_INPUT' }))
  })

  it('rejects duplicate ids, missing updates, and stale base revisions without committing', async () => {
    const { agent, service } = await setup()
    service.commit(agent, service.prepare(agent, createInput()))
    expect(() => service.prepare(agent, createInput())).toThrow(expect.objectContaining({ code: 'ARTIFACT_EXISTS' }))
    expect(() => service.prepare(agent, { ...createInput(), action: 'update', baseRevision: 0 }))
      .toThrow(expect.objectContaining({ code: 'BAD_INPUT' }))
    expect(() => service.prepare(agent, { ...createInput(), action: 'update' }))
      .toThrow(expect.objectContaining({ code: 'BAD_INPUT' }))
    expect(() => service.prepare(agent, { ...createInput(), action: 'update', baseRevision: 2 }))
      .toThrow(expect.objectContaining({ code: 'STALE_REVISION' }))
    expect(() => service.prepare(agent, { ...createInput(), action: 'update', artifactId: 'missing', baseRevision: 1 }))
      .toThrow(expect.objectContaining({ code: 'ARTIFACT_NOT_FOUND' }))
    expect(upserts(agent)).toHaveLength(1)
  })

  it.each([
    null,
    { ...createInput(), action: 'delete' },
    { ...createInput(), artifactId: '' },
    { ...createInput(), artifactId: 'Upper' },
    { ...createInput(), artifactId: `a${'b'.repeat(64)}` },
    { ...createInput(), title: '   ' },
    { ...createInput(), title: 7 },
    { ...createInput(), title: 'x'.repeat(121) },
    { ...createInput(), presentation: 'modal' },
    { ...createInput(), baseRevision: 1 },
  ])('rejects malformed or unsupported model input %#', async (input) => {
    const { agent, service } = await setup()
    expect(() => service.prepare(agent, mutation(input))).toThrow(ArtifactError)
    expect(upserts(agent)).toEqual([])
  })

  it.each(['', '   '])('rejects empty HTML source', async (source) => {
    const { agent, service } = await setup()
    expect(() => service.prepare(agent, { ...createInput(), source }))
      .toThrow(expect.objectContaining({ code: 'BAD_SOURCE' }))
  })

  it('validates snapshots again at the persistent commit boundary', async () => {
    const { agent, service } = await setup()
    const valid = service.prepare(agent, createInput())
    for (const snapshot of [
      0,
      { ...valid, format: 'markdown' },
      { ...valid, revision: 0 },
      { ...valid, source: '' },
      { ...valid, presentation: 'other' },
    ]) {
      expect(() => service.commit(agent, snapshot as ArtifactSnapshot)).toThrow(ArtifactError)
    }
    expect(upserts(agent)).toEqual([])
  })

  it('updates from the latest upsert after Session recovery', async () => {
    const { ctx, agent, service } = await setup()
    service.commit(agent, service.prepare(agent, createInput()))
    const recovered = makeAgent(ctx, 'recovered-artifact', agent.session.snapshotEvents())
    const updated = service.prepare(recovered, {
      ...createInput(), action: 'update', baseRevision: 1, title: 'Recovered', source: '<p>restored</p>',
    })
    service.commit(recovered, updated)
    expect(upserts(recovered).map(snapshot => snapshot.revision)).toEqual([1, 2])
    expect(upserts(recovered)[1]?.title).toBe('Recovered')
  })

  it('rejects a malformed matching snapshot read from recovered Session data', async () => {
    const { ctx, agent, service } = await setup()
    const created = service.prepare(agent, createInput())
    service.commit(agent, created)
    const seed = agent.session.snapshotEvents().map(event => event.type === 'artifact/upsert'
      ? { ...event, data: { ...created, title: '' } }
      : event)
    const recovered = makeAgent(ctx, 'malformed-recovered-artifact', seed)
    expect(() => service.prepare(recovered, { ...createInput(), action: 'update', baseRevision: 1 }))
      .toThrow(expect.objectContaining({ code: 'BAD_INPUT' }))
  })
})

describe('ArtifactService record', () => {
  it('exposes the Remote method and routes reviewed JSON intent without granting side effects', async () => {
    const { agent, service } = await setup()
    expect(remoteMethods(service)).toContainEqual({ method: 'record', invocation: { kind: 'direct' } })
    service.commit(agent, service.prepare(agent, createInput()))
    expect(service.record(agent, 'demo' as ArtifactSnapshot['artifactId'], 1, '  file.delete  ', { path: '/not-read' }, false))
      .toEqual({ accepted: true, revision: 1 })
    expect(agent.inject).toHaveBeenCalledOnce()
    expect(agent.steer).not.toHaveBeenCalled()
    const message = agent.inject.mock.calls[0]?.[0]
    expect(message?.source).toEqual({ kind: 'artifact-action', artifactId: 'demo', revision: 1 })
    expect(JSON.parse(actionText(agent, false))).toEqual({
      kind: 'artifact_action', artifactId: 'demo', revision: 1, action: 'file.delete', payload: { path: '/not-read' },
    })
  })

  it('uses steer when wake is true', async () => {
    const { agent, service } = await setup()
    service.commit(agent, service.prepare(agent, createInput()))
    service.record(agent, 'demo' as ArtifactSnapshot['artifactId'], 1, 'refresh', [1, { ok: true }], true)
    expect(agent.steer).toHaveBeenCalledOnce()
    expect(agent.inject).not.toHaveBeenCalled()
    expect(JSON.parse(actionText(agent, true)).action).toBe('refresh')
  })

  it('rejects unknown and stale revisions before routing', async () => {
    const { agent, service } = await setup()
    service.commit(agent, service.prepare(agent, createInput()))
    expect(() => service.record(agent, 'missing' as ArtifactSnapshot['artifactId'], 1, 'go', null, false))
      .toThrow(expect.objectContaining({ code: 'ARTIFACT_NOT_FOUND' }))
    expect(() => service.record(agent, 'demo' as ArtifactSnapshot['artifactId'], 2, 'go', null, false))
      .toThrow(expect.objectContaining({ code: 'STALE_REVISION' }))
    expect(agent.inject).not.toHaveBeenCalled()
  })

  it.each([
    '', '   ', '1start', 'white space', 'slash/name', 'a'.repeat(65),
  ])('rejects invalid action name %j', async (action) => {
    const { agent, service } = await setup()
    service.commit(agent, service.prepare(agent, createInput()))
    expect(() => service.record(agent, 'demo' as ArtifactSnapshot['artifactId'], 1, action, null, false))
      .toThrow(expect.objectContaining({ code: 'BAD_INPUT' }))
    expect(agent.inject).not.toHaveBeenCalled()
  })

  it.each([
    undefined, () => 'no', Number.NaN, Number.POSITIVE_INFINITY, -0, 1n, new Date(),
  ])('rejects a non-JSON payload %#', async (payload) => {
    const { agent, service } = await setup()
    service.commit(agent, service.prepare(agent, createInput()))
    expect(() => service.record(agent, 'demo' as ArtifactSnapshot['artifactId'], 1, 'go', json(payload), false))
      .toThrow(expect.objectContaining({ code: 'BAD_INPUT' }))
  })

  it('rejects a non-string action before normalization', async () => {
    const { agent, service } = await setup()
    service.commit(agent, service.prepare(agent, createInput()))
    expect(() => service.record(agent, 'demo' as ArtifactSnapshot['artifactId'], 1, 7 as never, null, false))
      .toThrow(expect.objectContaining({ code: 'BAD_INPUT' }))
    expect(agent.inject).not.toHaveBeenCalled()
  })

  it('rejects cyclic payloads and non-boolean wake values', async () => {
    const { agent, service } = await setup()
    service.commit(agent, service.prepare(agent, createInput()))
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() => service.record(agent, 'demo' as ArtifactSnapshot['artifactId'], 1, 'go', json(cyclic), false))
      .toThrow(expect.objectContaining({ code: 'BAD_INPUT' }))
    expect(() => service.record(agent, 'demo' as ArtifactSnapshot['artifactId'], 1, 'go', null, json('yes') as boolean))
      .toThrow(expect.objectContaining({ code: 'BAD_INPUT' }))
  })

  it('requires the exact live root Agent', async () => {
    const { ctx, agent, service } = await setup()
    service.commit(agent, service.prepare(agent, createInput()))
    const detached = makeAgent(ctx, 'detached-artifact')
    expect(() => service.record(detached, 'demo' as ArtifactSnapshot['artifactId'], 1, 'go', null, false))
      .toThrow(expect.objectContaining({ code: 'CALLER_NOT_LIVE_ROOT' }))
    const child = makeAgent(ctx, 'child-artifact', agent.session.snapshotEvents())
    ctx.agents.enter(child, agent)
    expect(() => service.record(child, 'demo' as ArtifactSnapshot['artifactId'], 1, 'go', null, false))
      .toThrow(expect.objectContaining({ code: 'CALLER_NOT_LIVE_ROOT' }))
  })

  it('fails loud when the Agent registry is absent', async () => {
    const { agent } = await setup()
    const isolated = new Context()
    contexts.push(isolated)
    await isolated.plugin(ArtifactService)
    expect(() => isolated.artifacts.record(agent, 'demo' as ArtifactSnapshot['artifactId'], 1, 'go', null, false))
      .toThrow(expect.objectContaining({ code: 'AGENT_REGISTRY_UNAVAILABLE' }))
  })
})

describe('artifact resource limits and configuration', () => {
  it('applies UTF-8 source limits at the exact boundary', async () => {
    const source = '<p>é</p>'
    const bytes = Buffer.byteLength(source, 'utf8')
    const { agent, service } = await setup({ maxSourceBytes: bytes })
    service.commit(agent, service.prepare(agent, { ...createInput(), source }))
    expect(upserts(agent)[0]?.source).toBe(source)
    expect(() => service.prepare(agent, {
      ...createInput(), action: 'update', baseRevision: 1, source: `${source}é`,
    })).toThrow(expect.objectContaining({ code: 'BAD_SOURCE' }))
  })

  it('bounds the complete wrapped action JSON, including multibyte payload text', async () => {
    const id = 'demo' as ArtifactSnapshot['artifactId']
    const payload = { note: 'é' }
    const text = JSON.stringify({ kind: 'artifact_action', artifactId: id, revision: 1, action: 'go', payload })
    const { agent, service } = await setup({ maxActionBytes: Buffer.byteLength(text, 'utf8') })
    service.commit(agent, service.prepare(agent, createInput()))
    expect(service.record(agent, id, 1, 'go', payload, false)).toEqual({ accepted: true, revision: 1 })
    expect(() => service.record(agent, id, 1, 'go', { note: 'éé' }, false))
      .toThrow(expect.objectContaining({ code: 'ACTION_TOO_LARGE' }))
    expect(agent.inject).toHaveBeenCalledOnce()
  })

  it('refuses to advance beyond the maximum safe revision', async () => {
    const { agent, service } = await setup()
    const created = service.prepare(agent, createInput())
    service.commit(agent, { ...created, revision: Number.MAX_SAFE_INTEGER })
    expect(() => service.prepare(agent, {
      ...createInput(), action: 'update', baseRevision: Number.MAX_SAFE_INTEGER,
    })).toThrow(expect.objectContaining({ code: 'BAD_INPUT' }))
  })

  it('retains the action limit default when only the source limit is configured', async () => {
    const { agent, service } = await setup({ maxSourceBytes: 1024 })
    service.commit(agent, service.prepare(agent, createInput()))
    expect(service.record(agent, 'demo' as ArtifactSnapshot['artifactId'], 1, 'go', null, false))
      .toEqual({ accepted: true, revision: 1 })
  })

  it('validates schema defaults and direct-composition limits', async () => {
    expect(ArtifactService.Config({})).toEqual({ maxSourceBytes: 262_144, maxActionBytes: 16_384 })
    const directContext = new Context()
    contexts.push(directContext)
    expect(() => new ArtifactService(directContext, {})).not.toThrow()
    for (const config of [
      { maxSourceBytes: 0 }, { maxActionBytes: 1.5 }, { maxSourceBytes: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => ArtifactService.Config(config)).toThrow()
      const ctx = new Context()
      contexts.push(ctx)
      expect(() => new ArtifactService(ctx, config)).toThrow('positive safe integer')
    }
  })
})

describe('artifact tool', () => {
  it('commits only the compact result fields and never repeats source', async () => {
    const { agent, execute } = await setup()
    const created = await execute(createInput())
    expect(created.isError).toBe(false)
    expect(created.value).toEqual({ artifactId: 'demo', revision: 1, title: 'Demo', presentation: 'inline' })
    expect(JSON.stringify(created.content)).not.toContain('<!doctype html>')
    const updated = await execute({
      ...createInput(), action: 'update', baseRevision: 1, title: 'Second', source: '<p>second</p>', presentation: 'focus',
    })
    expect(updated.isError).toBe(false)
    expect(updated.value).toEqual({ artifactId: 'demo', revision: 2, title: 'Second', presentation: 'focus' })
    expect(upserts(agent).map(snapshot => snapshot.revision)).toEqual([1, 2])
  })

  it('does not commit validation failures or duplicate ids', async () => {
    const { agent, execute } = await setup()
    expect((await execute(createInput())).isError).toBe(false)
    const initial = upserts(agent).length
    expect((await execute(createInput())).isError).toBe(true)
    expect((await execute({ ...createInput(), action: 'update', baseRevision: 9 })).isError).toBe(true)
    expect((await execute({ ...createInput(), source: '' })).isError).toBe(true)
    expect(upserts(agent)).toHaveLength(initial)
  })

  it('does not commit when post-execution policy blocks the result', async () => {
    const { ctx, agent, execute } = await setup()
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      await next()
      return { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }
    })
    expect((await execute(createInput())).isError).toBe(true)
    expect(upserts(agent)).toEqual([])
  })

  it('does not commit when cancellation replaces the successful body result', async () => {
    const { ctx, agent, execute } = await setup()
    const controller = new AbortController()
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      controller.abort()
      return next()
    })
    expect((await execute(createInput(), controller.signal)).isError).toBe(true)
    expect(upserts(agent)).toEqual([])
  })

  it('requires an owning Agent and unregisters with its plugin fiber', async () => {
    const { ctx, agent, toolFiber } = await setup()
    const detached = await executeToolFixture(ctx, {
      callId: ToolCallId('agentless-artifact'), name: 'artifact', arguments: createInput(), signal: new AbortController().signal,
    })
    expect(detached.isError).toBe(true)
    expect(upserts(agent)).toEqual([])
    await toolFiber.dispose()
    expect(ctx.tools.get('artifact', agent)).toBeUndefined()
  })

  it('fails loud when the Host ArtifactService is absent', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    let failure: unknown
    try {
      await ctx.plugin(ArtifactTool, {})
    } catch (error) {
      failure = error
    }
    expect(failure instanceof ArtifactError && failure.code).toBe('ARTIFACT_SERVICE_UNAVAILABLE')
  })
})
