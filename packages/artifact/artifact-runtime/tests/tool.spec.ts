import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import ArtifactService from '@deepseek-ai/dsh-artifact'
import * as ArtifactTool from '@deepseek-ai/dsh-artifact/tool'
import * as SceneTool from '@deepseek-ai/dsh-artifact/scene-tool'
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { PeerId, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import RuntimeService from '../src/index.ts'
import * as RuntimeTool from '../src/tool.ts'
import type { ArtifactRuntimeId, RuntimeReport } from '../src/types.ts'

const contexts: Context[] = []
const streams: (() => Promise<void>)[] = []
let calls = 0
afterEach(async () => {
  for (const close of streams.splice(0)) await close()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

async function setup(config: RuntimeTool.Config = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ArtifactService)
  await ctx.plugin(ArtifactTool)
  await ctx.plugin(SceneTool)
  await ctx.plugin(RuntimeService)
  const fiber = ctx.plugin(RuntimeTool, config)
  await fiber
  const id = SessionId('runtime-tool')
  const session = ctx.sessions.create(id)
  const agent = { id, session, ctx } as Agent
  ctx.agents.enter(agent, undefined)
  ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
    action: 'create', artifactId: 'demo', title: 'Stored HTML', source: '<script>throw new Error("not started")</script>', presentation: 'inline',
  }))
  const invoke = (name: string, args: unknown, options: { agent?: Agent; signal?: AbortSignal; parent?: ToolExecutionToken } = {}) => {
    const input = {
      callId: ToolCallId(`runtime-inspect-${++calls}`), name, arguments: args,
      signal: options.signal ?? new AbortController().signal, agent: options.agent ?? agent,
      ...options.parent === undefined ? {} : { parent: options.parent },
    }
    return options.parent === undefined ? executeModelToolFixture(ctx, input) : executeToolFixture(ctx, input)
  }
  const execute = (args: unknown) => invoke('artifact_runtime', args)
  return { ctx, session, agent, execute, invoke, fiber }
}

async function report(ctx: Context, agent: Agent, artifactId: string, revision: number, value: RuntimeReport) {
  const controller = new AbortController()
  const held = Promise.withResolvers<undefined>()
  async function* source(): AsyncIterable<RuntimeReport> { yield value; await held.promise }
  const invocation: RemoteInvocation = {
    request: { namespace: 'artifactRuntime', method: 'attach', args: {} }, service: 'artifactRuntime', signal: controller.signal,
    peer: { id: 'test-peer' as PeerId, ctx, principal: { kind: 'owner' }, interactions: 'answer', signal: controller.signal, dispose: async () => {} },
    uplink: <In>() => source() as AsyncIterable<In>,
  }
  const iterator = ctx.extend({ invocation }).artifactRuntime.attach(agent.session.id, {
    artifactId: artifactId as ArtifactId, revision, runtimeId: `tool-view-${calls++}` as ArtifactRuntimeId,
    renderer: ctx.artifacts.currentSnapshot(agent, artifactId as ArtifactId)?.format === 'scene' ? 'native' : 'html',
  }, controller.signal)[Symbol.asyncIterator]()
  const close = async (): Promise<void> => {
    held.resolve(undefined)
    controller.abort()
    await iterator.return?.()
  }
  streams.push(close)
  expect(await iterator.next()).toMatchObject({ value: { kind: 'attached' } })
  expect(await iterator.next()).toMatchObject({ value: { kind: 'accepted', sequence: 1 } })
  return close
}

const updateHtml = (artifactId = 'demo', baseRevision = 1) => ({
  action: 'update', artifactId, baseRevision, title: 'Revised program', source: '<p>Repaired</p>', presentation: 'inline',
})
const runtimeError: RuntimeReport = { status: 'error', error: { code: 'PROGRAM_ERROR', message: 'Program failed' } }
const runtimeReady: RuntimeReport = { status: 'ready', capabilities: { state: false, commands: [] } }
const queryDenial = 'Artifact runtime query budget exhausted (1 attempts this turn). '
  + 'Explain the reports already received and any uncertainty; stop querying until a new turn.'
const repairDenial = 'Artifact runtime repair budget exhausted (1 update attempts this turn). '
  + 'Stop automatic repairs and explain the reported error and unresolved result to the user.'

describe('artifact_runtime model inspection', () => {
  it('returns a bounded source-attributed point read without executing source or claiming an unopened program is ready', async () => {
    const { execute, session } = await setup()
    const events = session.snapshotEvents()
    const result = await execute({ artifactId: 'demo', revision: 1 })
    const value = {
      artifactId: 'demo', revision: 1, title: 'Stored HTML', format: 'html',
      sourceCapabilities: {
        observe: 'unsupported', save: 'unsupported', restore: 'unsupported', compare: 'unsupported', questionContext: 'program-reported', exportHtml: 'unsupported',
      },
      reportAuthority: 'client-reported', runs: [],
      wait: { outcome: 'snapshot', limitMs: 0 }, budget: { remainingQueries: 3, remainingRepairAttempts: 2 },
    }
    expect(result.isError).toBe(false)
    expect(result.value).toEqual(value)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(value) }])
    expect(session.snapshotEvents()).toEqual(events)
  })

  it.each([
    { artifactId: 'missing', revision: 1 },
    { artifactId: 'demo', revision: 2 },
    { artifactId: 'demo', revision: 0 },
    { artifactId: 'Bad ID', revision: 1 },
  ])('rejects absent, changed and invalid selections through the executor: $artifactId revision $revision', async (args) => {
    const { execute, session } = await setup()
    const events = session.snapshotEvents()
    expect((await execute(args)).isError).toBe(true)
    expect(session.snapshotEvents()).toEqual(events)
  })

  it('returns explicit snapshot and bounded wait outcomes with remaining attempts', async () => {
    const h = await setup()
    expect((await h.execute({ artifactId: 'demo', revision: 1, waitMs: 0 })).value).toMatchObject({
      wait: { outcome: 'snapshot', limitMs: 0 }, budget: { remainingQueries: 3, remainingRepairAttempts: 2 },
    })
    await report(h.ctx, h.agent, 'demo', 1, runtimeReady)
    const result = await h.execute({ artifactId: 'demo', revision: 1, waitMs: 100 })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      runs: [{ status: 'ready' }], wait: { outcome: 'reported', limitMs: 100 },
      budget: { remainingQueries: 2, remainingRepairAttempts: 2 },
    })
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid wait milliseconds %s without running source', async (waitMs) => {
    const h = await setup({ maxQueriesPerTurn: 1 })
    const before = h.session.snapshotEvents()
    expect((await h.execute({ artifactId: 'demo', revision: 1, waitMs })).isError).toBe(true)
    expect((await h.execute({ artifactId: 'demo', revision: 1 })).error?.message).toBe(queryDenial)
    expect(h.session.snapshotEvents()).toEqual(before)
  })

  it('charges rejected attempts and cannot be re-enabled by a pre-execute allow listener', async () => {
    const h = await setup({ maxQueriesPerTurn: 1 })
    expect((await h.execute({ artifactId: 'missing', revision: 1 })).isError).toBe(true)
    h.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }))
    const denied = await h.execute({ artifactId: 'demo', revision: 1 })
    expect(denied.isError).toBe(true)
    expect(denied.content).toEqual([{ type: 'text', text: `Error: ${queryDenial}` }])
  })

  it('keeps a spent query after its bounded wait is cancelled', async () => {
    const h = await setup({ maxQueriesPerTurn: 1 })
    const entered = Promise.withResolvers<undefined>()
    const wait = h.ctx.artifactRuntime.wait.bind(h.ctx.artifactRuntime)
    vi.spyOn(h.ctx.artifactRuntime, 'wait').mockImplementation((...args) => {
      entered.resolve(undefined)
      return wait(...args)
    })
    const controller = new AbortController()
    const pending = h.invoke('artifact_runtime', { artifactId: 'demo', revision: 1, waitMs: 100 }, { signal: controller.signal })
    await entered.promise
    controller.abort()
    expect((await pending).isError).toBe(true)
    expect((await h.execute({ artifactId: 'demo', revision: 1 })).error?.message).toBe(queryDenial)
  })

  it('keeps a shared query limit across ids and steps, resets at new turns, and isolates child Agents', async () => {
    const h = await setup({ maxQueriesPerTurn: 1 })
    h.session.append('turn/start', { turn: 1 })
    expect((await h.execute({ artifactId: 'demo', revision: 1 })).isError).toBe(false)
    h.ctx.artifacts.commit(h.agent, h.ctx.artifacts.prepare(h.agent, {
      action: 'create', artifactId: 'other', title: 'Other program', source: '<p>Other</p>', presentation: 'inline',
    }))
    expect((await h.execute({ artifactId: 'other', revision: 1 })).error?.message).toBe(queryDenial)
    const seed = h.session.snapshotEvents()
    const child = h.ctx.sessions.create(SessionId('runtime-budget-child'), {
      seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { parentSession: h.session.id, isSeeded: true },
    })
    const childAgent = { id: child.id, session: child, ctx: h.ctx } as Agent
    h.ctx.agents.enter(childAgent, undefined)
    expect((await h.invoke('artifact_runtime', { artifactId: 'demo', revision: 1 }, { agent: childAgent })).isError).toBe(false)
    expect((await h.execute({ artifactId: 'demo', revision: 1 })).error?.message).toBe(queryDenial)
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    h.session.append('turn/start', { turn: 2 })
    expect((await h.execute({ artifactId: 'demo', revision: 1 })).value).toMatchObject({ budget: { remainingQueries: 0 } })
  })

  it('shares repair attempts across failed HTML and Scene objects while allowing other edits', async () => {
    const h = await setup({ maxRepairAttemptsPerTurn: 1 })
    const sceneArgs = {
      action: 'create', sceneId: 'scene-demo', title: 'Scene program', kind: 'particle-system', presentation: 'inline',
      spec: { kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 0, vx: 0, vy: 0, mass: 1 }],
        gravity: { x: 0, y: -1 }, timeStep: 1 / 30, trails: false },
    }
    expect((await h.invoke('scene', sceneArgs)).isError).toBe(false)
    await report(h.ctx, h.agent, 'demo', 1, runtimeError)
    await report(h.ctx, h.agent, 'scene-demo', 1, runtimeError)
    expect((await h.execute({ artifactId: 'demo', revision: 1 })).isError).toBe(false)
    expect((await h.execute({ artifactId: 'scene-demo', revision: 1 })).isError).toBe(false)
    expect((await h.invoke('artifact', updateHtml())).isError).toBe(false)
    const denied = await h.invoke('scene', { ...sceneArgs, action: 'update', baseRevision: 1 })
    expect(denied.content).toEqual([{ type: 'text', text: `Error: ${repairDenial}` }])
    expect(h.ctx.artifacts.currentSnapshot(h.agent, 'scene-demo' as ArtifactId)?.revision).toBe(1)
    expect((await h.invoke('artifact', {
      action: 'create', artifactId: 'other', title: 'Other program', source: '<p>Other</p>', presentation: 'inline',
    })).isError).toBe(false)
    expect((await h.invoke('artifact', updateHtml('other'))).isError).toBe(false)
  })

  it('retains the repair limit across a new revision and a later ready report', async () => {
    const h = await setup({ maxRepairAttemptsPerTurn: 1 })
    await report(h.ctx, h.agent, 'demo', 1, runtimeError)
    expect((await h.execute({ artifactId: 'demo', revision: 1 })).isError).toBe(false)
    expect((await h.invoke('artifact', updateHtml())).isError).toBe(false)
    await report(h.ctx, h.agent, 'demo', 2, runtimeReady)
    expect((await h.execute({ artifactId: 'demo', revision: 2 })).value).toMatchObject({ budget: { remainingRepairAttempts: 0 } })
    expect((await h.invoke('artifact', updateHtml('demo', 2))).error?.message).toBe(repairDenial)
  })

  it('clears error qualification on the next turn and isolates an inherited child source', async () => {
    const h = await setup({ maxRepairAttemptsPerTurn: 0 })
    h.session.append('turn/start', { turn: 1 })
    await report(h.ctx, h.agent, 'demo', 1, runtimeError)
    await h.execute({ artifactId: 'demo', revision: 1 })
    expect((await h.invoke('artifact', updateHtml())).isError).toBe(true)
    const seed = h.session.snapshotEvents()
    const child = h.ctx.sessions.create(SessionId('repair-budget-child'), {
      seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { parentSession: h.session.id, isSeeded: true },
    })
    const childAgent = { id: child.id, session: child, ctx: h.ctx } as Agent
    h.ctx.agents.enter(childAgent, undefined)
    expect((await h.invoke('artifact', updateHtml(), { agent: childAgent })).isError).toBe(false)
    expect(h.ctx.artifacts.currentSnapshot(h.agent, 'demo' as ArtifactId)?.revision).toBe(1)
    h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    h.session.append('turn/start', { turn: 2 })
    expect((await h.invoke('artifact', updateHtml())).isError).toBe(false)
  })

  it.each(['blocked', 'replaced'] as const)('does not qualify an error hidden by the final %s tool result', async (mode) => {
    const h = await setup({ maxRepairAttemptsPerTurn: 0 })
    await report(h.ctx, h.agent, 'demo', 1, runtimeError)
    h.ctx.on('tools/post-execute', (exec, result, next) => {
      if (exec.name !== 'artifact_runtime' || result.isError) return next()
      if (mode === 'blocked') return Promise.resolve({ kind: 'block', feedback: [{ type: 'text', text: 'Query blocked' }] })
      const value = result.value
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected inspection result')
      return Promise.resolve({ kind: 'accept', value: { ...value, runs: [] } })
    })
    const queried = await h.execute({ artifactId: 'demo', revision: 1 })
    expect(queried.isError).toBe(mode === 'blocked')
    expect((await h.invoke('artifact', updateHtml())).isError).toBe(false)
  })

  it('does not apply repair limits to normal edits before an error is inspected', async () => {
    const h = await setup({ maxRepairAttemptsPerTurn: 0 })
    await report(h.ctx, h.agent, 'demo', 1, runtimeError)
    expect((await h.invoke('artifact', updateHtml())).isError).toBe(false)
    await report(h.ctx, h.agent, 'demo', 2, runtimeError)
    expect((await h.execute({ artifactId: 'demo', revision: 2 })).isError).toBe(false)
    expect((await h.invoke('artifact', updateHtml('demo', 2))).error?.message).toBe(
      'Artifact runtime repair budget exhausted (0 update attempts this turn). '
      + 'Stop automatic repairs and explain the reported error and unresolved result to the user.',
    )
  })

  it('reserves repair attempts before dispatch, including invalid and nested calls', async () => {
    const h = await setup({ maxRepairAttemptsPerTurn: 1 })
    await report(h.ctx, h.agent, 'demo', 1, runtimeError)
    expect((await h.execute({ artifactId: 'demo', revision: 1 })).isError).toBe(false)
    const parent = Symbol('ptc-parent') as ToolExecutionToken
    const first = await h.invoke('artifact', { ...updateHtml(), baseRevision: 99 }, { parent })
    expect(first.isError).toBe(true)
    expect(first.error?.message).not.toBe(repairDenial)
    expect((await h.invoke('artifact', updateHtml(), { parent })).error?.message).toBe(repairDenial)
    expect((await h.invoke('artifact', updateHtml())).error?.message).toBe(repairDenial)
    expect(h.ctx.artifacts.currentSnapshot(h.agent, 'demo' as ArtifactId)?.revision).toBe(1)
  })

  it('does not refund a repair reserved before cancellation prevents its body', async () => {
    const h = await setup({ maxRepairAttemptsPerTurn: 1 })
    await report(h.ctx, h.agent, 'demo', 1, runtimeError)
    await h.execute({ artifactId: 'demo', revision: 1 })
    const controller = new AbortController()
    h.ctx.on('tools/execute', (exec, next) => {
      if (exec.name === 'artifact') controller.abort()
      return next()
    })
    expect((await h.invoke('artifact', updateHtml(), { signal: controller.signal })).isError).toBe(true)
    expect(h.ctx.artifacts.currentSnapshot(h.agent, 'demo' as ArtifactId)?.revision).toBe(1)
    expect((await h.invoke('artifact', updateHtml())).error?.message).toBe(repairDenial)
  })

  it('reserves concurrent query attempts once and removes its guard on disposal', async () => {
    const h = await setup({ maxQueriesPerTurn: 1 })
    const results = await Promise.all([
      h.execute({ artifactId: 'demo', revision: 1 }), h.execute({ artifactId: 'demo', revision: 1 }),
    ])
    expect(results.filter(result => !result.isError)).toHaveLength(1)
    expect(results.filter(result => result.error?.message === queryDenial)).toHaveLength(1)
    await h.fiber.dispose()
    expect(h.ctx.tools.get('artifact_runtime')).toBeUndefined()
    h.ctx.tools.register({
      name: 'artifact_runtime', description: 'Replacement query', parameters: {},
      output: { schema: { type: 'boolean' }, render: () => [] }, execute: () => Promise.resolve(true),
    })
    expect((await h.execute({})).isError).toBe(false)
  })

  it('pins model guidance about one bounded wait and stopping when attempts are exhausted', async () => {
    const h = await setup()
    expect(h.ctx.tools.get('artifact_runtime')?.description).toBe(
      'Inspect an exact current Artifact revision before treating generated code as usable. '
      + 'Returns source-supported operations and currently connected renderer/program reports. '
      + 'An empty runs list means no active report; ready is a Client/program claim, not proof of correct pixels, observations or conclusions. '
      + 'Capabilities describe source semantics, not enabled plugins or permissions. Omit waitMs or use zero for a snapshot; '
      + 'a positive waitMs gives the current revision one bounded opportunity to attach and report ready or error. '
      + 'The wait stops when any run reports ready or error; other runs may disagree. '
      + 'No active report at the deadline is distinct from a timeout with an active starting report; neither establishes execution success or failure. '
      + 'Queries do not run code, modify the Artifact, retry commands or send user input. '
      + 'Use an error report to update the same Artifact with its current revision, within the shared repair budget. '
      + 'Query and repair attempts are limited per turn; rejected or cancelled attempts are not refunded. '
      + 'When the budget is exhausted, explain the known result and uncertainty instead of continuing automatic queries or repairs.',
    )
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])('rejects invalid configured attempt limit %s', (value) => {
    expect(() => RuntimeTool.Config({ maxQueriesPerTurn: value })).toThrow()
    expect(() => RuntimeTool.Config({ maxRepairAttemptsPerTurn: value })).toThrow()
  })
})
