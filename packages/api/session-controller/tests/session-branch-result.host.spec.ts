/** Confirmed manual-branch result return, lineage validation, isolation, and idempotency. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SESSION_FORMAT_VERSION, SessionLogOffset, SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  createSessionTestRemote, installSessionReadTestServices, testSessionPersistence,
} from './test-remote.ts'

const sid = (value: string): SessionId => value as SessionId

interface Stored {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly inheritedEventCount: SessionLogOffset
}

function header(id: string, options: { seeded?: boolean; parent?: SessionId; subagent?: boolean } = {}): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: sid(id),
    createdAt: 1,
    cwd: '/proj',
    isSeeded: options.seeded ?? false,
    ...options.parent === undefined ? {} : { parentSession: options.parent },
    ...options.subagent === true ? { origin: 'subagent' as const } : {},
  }
}

function turnStart(seq: number): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq: SessionSeq(seq), time: seq, data: { turn: 1 } }
}

function turnEnd(seq: number): SessionEvent<'turn/end'> {
  return { type: 'turn/end', seq: SessionSeq(seq), time: seq, data: { turn: 1, reason: { kind: 'completed' } } }
}

function user(seq: number, text: string): SessionEvent<'user/message'> {
  return {
    type: 'user/message', seq: SessionSeq(seq), time: seq, surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  }
}

function assistant(seq: number, text: string): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message', seq: SessionSeq(seq), time: seq, surfaceOp: 'append',
    data: {
      turn: 1, step: 1, stream: [],
      message: createAssistantMessage({
        content: [{ type: 'reasoning', text: 'reasoning must not return' }, { type: 'text', text }],
        source: { provider: 'test', model: 'test' },
      }),
    },
  }
}

function endSeed(seq: number): SessionEvent<'session/end-seed'> {
  return { type: 'session/end-seed', seq: SessionSeq(seq), time: seq, data: { inherited: true } }
}

function stored(id: string, events: readonly SessionEvent[], options: {
  seeded?: boolean
  parent?: SessionId
  subagent?: boolean
  inheritedEventCount?: number
} = {}): Stored {
  return {
    header: header(id, options),
    events,
    inheritedEventCount: SessionLogOffset(options.inheritedEventCount ?? 0),
  }
}

function branch(id: string, parent: SessionId, text: string, options: { subagent?: boolean } = {}): Stored {
  const inherited = [turnStart(0), user(1, 'P'), turnEnd(2)] as const
  return stored(id, [
    ...inherited,
    endSeed(3),
    turnStart(4),
    user(5, `${id}-prompt`),
    assistant(6, text),
    turnEnd(7),
  ], { seeded: true, parent, inheritedEventCount: inherited.length, ...options })
}

type FixtureAgent = Omit<Agent, 'followup' | 'steer' | 'runMaintenance'> & {
  readonly followup: ReturnType<typeof vi.fn<Agent['followup']>>
  readonly steer: ReturnType<typeof vi.fn<Agent['steer']>>
  readonly runMaintenance: Agent['runMaintenance']
  readonly maintenanceCalls: readonly ((signal: AbortSignal) => Promise<unknown>)[]
}

function makeAgent(ctx: Context, session: Session, status: Agent['status'] = 'idle'): FixtureAgent {
  let maintenance = false
  const unsupported = (): never => { throw new Error('Inbox mutation is not used by this fixture') }
  const followup = vi.fn<Agent['followup']>()
  const steer = vi.fn<Agent['steer']>()
  const maintenanceCalls: Array<(signal: AbortSignal) => Promise<unknown>> = []
  const runMaintenance: Agent['runMaintenance'] = async <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    maintenanceCalls.push(task)
    if (status === 'running' || maintenance) throw new Error('active work')
    maintenance = true
    try {
      return await task(new AbortController().signal)
    } finally {
      maintenance = false
    }
  }
  return {
    id: session.id,
    options: {},
    session,
    model: unsupportedModel(),
    inbox: {
      nextTurn: [], nextStep: [], clear: unsupported, append: unsupported,
      prepend: unsupported, replace: unsupported, remove: unsupported, splice: unsupported,
    },
    status,
    ctx,
    send: vi.fn(),
    followup,
    steer,
    inject: vi.fn(),
    cancel: vi.fn(),
    runMaintenance,
    maintenanceCalls,
    whenIdle: () => Promise.resolve(),
  }
}

async function composed(initial: readonly Stored[] = []) {
  const records = new Map(initial.map(value => [value.header.id, value]))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  const attach = async (session: Session, status: Agent['status'] = 'idle'): Promise<FixtureAgent> => {
    const agent = makeAgent(ctx, session, status)
    await ctx.agents.register(agent)
    return agent
  }
  const publish = async (
    ownerCtx: Context,
    sessionId: SessionId,
    options: Pick<CreateAgentOptions, 'seed' | 'meta' | 'inheritedEventCount' | 'setup'>,
  ) => {
    const session = ctx.sessions.create(sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
      ...options.inheritedEventCount === undefined
        ? {}
        : { inheritedEventCount: options.inheritedEventCount },
    })
    const agent = makeAgent(ownerCtx, session)
    await options.setup?.(ownerCtx, agent)
    await ctx.agents.register(agent)
    return { agent, dispose: () => Promise.resolve() }
  }
  ctx.agents.setFactory({
    createAgent: (ownerCtx, options) => publish(ownerCtx, options.sessionId, options),
    resume: (ownerCtx, options) => {
      const restored = records.get(options.resumeSessionId)
      if (restored === undefined) return Promise.reject(new Error('missing stored Session'))
      return publish(ownerCtx, options.resumeSessionId, {
        seed: restored.events,
        meta: restored.header,
        inheritedEventCount: restored.inheritedEventCount,
        ...options.setup === undefined ? {} : { setup: options.setup },
      })
    },
  })
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([...records.values()].map(value => value.header)),
    inspect: sessionId => Promise.resolve(records.get(sessionId) === undefined ? undefined : {
      meta: records.get(sessionId)!.header,
      events: records.get(sessionId)!.events,
      inheritedEventCount: records.get(sessionId)!.inheritedEventCount,
    }),
  }) as never)
  const remote = await createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test' }), cwd: '/proj',
  })
  return { ctx, records, remote, attach }
}

async function attachStored(
  harness: Awaited<ReturnType<typeof composed>>, value: Stored, status: Agent['status'] = 'idle',
): Promise<{ session: Session; agent: FixtureAgent }> {
  const session = harness.ctx.sessions.create(value.header.id, {
    seed: value.events,
    meta: value.header,
    inheritedEventCount: value.inheritedEventCount,
  })
  const agent = await harness.attach(session, status)
  return { session, agent }
}

function texts(session: Session): string {
  return JSON.stringify(session.snapshotEvents())
}

describe('session.returnBranchResult', () => {
  it('returns only confirmed child text, preserves siblings and later parent work, and replays idempotently', async () => {
    const parentStored = stored('parent', [turnStart(0), user(1, 'P'), turnEnd(2)])
    const childStored = branch('child', parentStored.header.id, 'C1-result')
    const siblingStored = branch('sibling', parentStored.header.id, 'C2-secret')
    const harness = await composed()
    try {
      const parent = await attachStored(harness, parentStored)
      const child = await attachStored(harness, childStored)
      const sibling = await attachStored(harness, siblingStored)
      parent.session.append('user/message', user(3, 'P-after').data, { surfaceOp: 'append' })
      const parentBefore = parent.session.snapshotEvents()
      const childBefore = child.session.snapshotEvents()
      const siblingBefore = sibling.session.snapshotEvents()
      const flush = vi.spyOn(harness.ctx.sessions, 'flush')

      const first = await harness.remote.returnBranchResult({
        sessionId: parent.session.id, branchSessionId: child.session.id, resultSeq: 6,
      })
      const [concurrentA, concurrentB] = await Promise.all([
        harness.remote.returnBranchResult({ sessionId: parent.session.id, branchSessionId: child.session.id, resultSeq: 6 }),
        harness.remote.returnBranchResult({ sessionId: parent.session.id, branchSessionId: child.session.id, resultSeq: 6 }),
        harness.remote.returnBranchResult({ sessionId: parent.session.id, branchSessionId: child.session.id, resultSeq: 6 }),
      ])
      const retry = await harness.remote.returnBranchResult({
        sessionId: parent.session.id, branchSessionId: child.session.id, resultSeq: 6,
      })

      for (const result of [first, concurrentA, concurrentB, retry]) {
        expect(result).toMatchObject({ ok: true, value: { parentSessionId: parent.session.id } })
        if (result.ok && first.ok) expect(result.value).toEqual(first.value)
      }
      expect(child.session.snapshotEvents()).toEqual(childBefore)
      expect(sibling.session.snapshotEvents()).toEqual(siblingBefore)
      expect(parent.session.snapshotEvents().slice(0, -1)).toEqual(parentBefore)
      const appended = parent.session.snapshotEvents().at(-1)
      expect(appended).toMatchObject({
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: 'C1-result' }],
          source: {
            kind: 'branch-result', branchSessionId: child.session.id, resultSeq: 6, form: 'notice',
          },
        },
      })
      expect(appended?.sourceEventSeqs).toBeUndefined()
      expect(JSON.stringify(appended)).not.toContain('P-after')
      expect(JSON.stringify(appended)).not.toContain('C2-secret')
      expect(JSON.stringify(appended)).not.toContain('reasoning must not return')
      expect(parent.agent.followup).not.toHaveBeenCalled()
      expect(parent.agent.steer).not.toHaveBeenCalled()
      expect(flush).toHaveBeenCalledWith(parent.session)
      expect(texts(child.session)).not.toContain('P-after')
      expect(texts(child.session)).not.toContain('C2-secret')
      expect(texts(sibling.session)).not.toContain('P-after')
      expect(texts(sibling.session)).not.toContain('C1-result')
    } finally {
      await harness.ctx.fiber.dispose()
    }
  })

  it('resolves a cold parent and rereads a cold child without resuming the child', async () => {
    const parentStored = stored('cold-parent', [turnStart(0), user(1, 'P'), turnEnd(2)])
    const childStored = branch('cold-child', parentStored.header.id, 'cold-result')
    const harness = await composed([parentStored, childStored])
    try {
      const result = await harness.remote.returnBranchResult({
        sessionId: parentStored.header.id, branchSessionId: childStored.header.id, resultSeq: 6,
      })

      expect(result.ok).toBe(true)
      expect(harness.ctx.agents.get(childStored.header.id)).toBeUndefined()
      const parent = harness.ctx.agents.get(parentStored.header.id)
      expect(parent).toBeDefined()
      if (!result.ok || parent === undefined) return
      expect(parent.session.snapshotEvents().at(-1)).toMatchObject({
        seq: result.value.eventSeq,
        data: { id: result.value.messageId, content: [{ type: 'text', text: 'cold-result' }] },
      })
    } finally {
      await harness.ctx.fiber.dispose()
    }
  })

  it.each([
    ['wrong-parent', 'other-parent', 6, 'wrong-parent'],
    ['inherited-result', 'parent', 0, 'inherited-result'],
    ['result-not-found', 'parent', 99, 'result-not-found'],
  ] as const)('rejects %s without changing any Session', async (_name, requestedParent, resultSeq, reason) => {
    const childStored = branch('child', sid('parent'), 'result')
    const harness = await composed()
    try {
      const parent = await attachStored(harness, stored('parent', [turnStart(0), user(1, 'P'), turnEnd(2)]))
      const other = await attachStored(harness, stored('other-parent', [turnStart(0), user(1, 'other'), turnEnd(2)]))
      const child = await attachStored(harness, childStored)
      const before = [parent.session.snapshotEvents(), other.session.snapshotEvents(), child.session.snapshotEvents()]

      const result = await harness.remote.returnBranchResult({
        sessionId: sid(requestedParent), branchSessionId: child.session.id, resultSeq,
      })

      expect(result).toMatchObject({ ok: false, error: { code: 'session/branch-result-unavailable', details: { reason } } })
      expect([parent.session.snapshotEvents(), other.session.snapshotEvents(), child.session.snapshotEvents()]).toEqual(before)
    } finally {
      await harness.ctx.fiber.dispose()
    }
  })

  it.each([
    ['not-branch', stored('ordinary', [assistant(0, 'ordinary')])],
    ['subagent', branch('subagent-child', sid('parent'), 'secret', { subagent: true })],
    ['empty-result', branch('empty-child', sid('parent'), '  \n')],
  ] as const)('rejects %s', async (reason, childStored) => {
    const harness = await composed()
    try {
      const parent = await attachStored(harness, stored('parent', [turnStart(0), user(1, 'P'), turnEnd(2)]))
      const child = await attachStored(harness, childStored)
      const before = [parent.session.snapshotEvents(), child.session.snapshotEvents()]

      const result = await harness.remote.returnBranchResult({ sessionId: parent.session.id, branchSessionId: child.session.id, resultSeq: reason === 'not-branch' ? 0 : 6 })

      expect(result).toMatchObject({ ok: false, error: { code: 'session/branch-result-unavailable', details: { reason } } })
      expect([parent.session.snapshotEvents(), child.session.snapshotEvents()]).toEqual(before)
    } finally {
      await harness.ctx.fiber.dispose()
    }
  })

  it('returns structured busy without steering or appending when the parent is running', async () => {
    const childStored = branch('child', sid('parent'), 'result')
    const harness = await composed()
    try {
      const parent = await attachStored(harness, stored('parent', [turnStart(0), user(1, 'P'), turnEnd(2)]), 'running')
      const child = await attachStored(harness, childStored)
      const before = [parent.session.snapshotEvents(), child.session.snapshotEvents()]

      const result = await harness.remote.returnBranchResult({
        sessionId: parent.session.id, branchSessionId: child.session.id, resultSeq: 6,
      })

      expect(result).toMatchObject({ ok: false, error: { code: 'session/agent-busy', details: { reason: 'branch-result-parent-busy' } } })
      expect(parent.agent.maintenanceCalls).toHaveLength(1)
      expect(parent.agent.followup).not.toHaveBeenCalled()
      expect(parent.agent.steer).not.toHaveBeenCalled()
      expect([parent.session.snapshotEvents(), child.session.snapshotEvents()]).toEqual(before)
    } finally {
      await harness.ctx.fiber.dispose()
    }
  })

  it('validates resultSeq at the wire boundary', async () => {
    const harness = await composed()
    try {
      for (const resultSeq of [-1, 0.5]) {
        await expect(harness.remote.returnBranchResult({ sessionId: sid('parent'), branchSessionId: sid('child'), resultSeq }))
          .resolves.toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
      }
    } finally {
      await harness.ctx.fiber.dispose()
    }
  })
})
