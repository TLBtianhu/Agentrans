import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@agentrans/cordis'
import type { Agent } from '@agentrans/agent'
import { MessageId } from '@agentrans/llm'
import SessionStore, { SessionId, SessionSeq, type SessionEvent } from '@agentrans/session'
import { admitBranchResult, BranchResultAdmissionBusy, BranchResultAdmissionConflict } from '../src/admission.ts'
import type { BranchResultSelection } from '../src/types.ts'

const contexts: Context[] = []
const selection: BranchResultSelection = {
  reference: { kind: 'branch-result', branchSessionId: SessionId('child'), resultSeq: SessionSeq(1),
    resultMessageId: MessageId('conclusion'), form: 'notice' },
  content: [{ type: 'text', text: 'Selected conclusion' }],
}

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function setup(seed?: readonly SessionEvent[]) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('parent'), seed === undefined ? {} : { seed })
  let maintenance = false
  const parent: Pick<Agent, 'session' | 'runMaintenance'> = {
    session,
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      if (maintenance) throw new Error('Parent has active maintenance')
      maintenance = true
      return task(new AbortController().signal).finally(() => { maintenance = false })
    },
  }
  const capabilities = {
    observeParent: vi.fn(async () => ({ events: session.snapshotEvents(), [Symbol.dispose]: (): void => {} })),
    flushParent: vi.fn(async (): Promise<void> => {}),
  }
  return { ctx, session, parent, capabilities }
}

describe('branch-result admission', () => {
  it('returns one durable parent message and reuses its receipt on identical cold retries', async () => {
    const first = await setup()
    const initial = await admitBranchResult(first.parent, selection, first.capabilities)
    expect(await admitBranchResult(first.parent, selection, first.capabilities)).toEqual(initial)
    expect(first.session.snapshotEvents()).toHaveLength(1)
    expect(first.capabilities.flushParent).toHaveBeenCalledTimes(2)
    const second = await setup(first.session.snapshotEvents())
    expect(await admitBranchResult(second.parent, selection, second.capabilities)).toEqual(initial)
    expect(second.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(1)
  })

  it('rejects changed evidence or adding evidence to an already returned plain conclusion', async () => {
    const fixture = await setup()
    await admitBranchResult(fixture.parent, selection, fixture.capabilities)
    await expect(admitBranchResult(fixture.parent, selection, fixture.capabilities, [{ type: 'text', text: 'Evidence' }]))
      .rejects.toBeInstanceOf(BranchResultAdmissionConflict)
    expect(fixture.session.snapshotEvents()).toHaveLength(1)
  })

  it('rejects dropping or replacing previously returned evidence', async () => {
    const fixture = await setup()
    const evidence = [{ type: 'text' as const, text: 'Evidence A' }]
    const receipt = await admitBranchResult(fixture.parent, selection, fixture.capabilities, evidence)
    await expect(admitBranchResult(fixture.parent, selection, fixture.capabilities)).rejects.toBeInstanceOf(BranchResultAdmissionConflict)
    await expect(admitBranchResult(fixture.parent, selection, fixture.capabilities, [{ type: 'text', text: 'Evidence B' }]))
      .rejects.toBeInstanceOf(BranchResultAdmissionConflict)
    expect(await admitBranchResult(fixture.parent, selection, fixture.capabilities, evidence)).toEqual(receipt)
    expect(fixture.session.snapshotEvents()).toHaveLength(1)
  })

  it('keeps a flush rejection unknown after append and recovers the same receipt on retry', async () => {
    const fixture = await setup()
    const failure = new Error('Durability acknowledgement lost')
    fixture.capabilities.flushParent.mockRejectedValueOnce(failure)
    await expect(admitBranchResult(fixture.parent, selection, fixture.capabilities)).rejects.toBe(failure)
    expect(fixture.session.snapshotEvents()).toHaveLength(1)
    const receipt = await admitBranchResult(fixture.parent, selection, fixture.capabilities)
    expect(receipt.eventSeq).toBe(0)
    expect(fixture.session.snapshotEvents()).toHaveLength(1)
  })

  it('preserves read failures once the maintenance job has started', async () => {
    const fixture = await setup()
    const failure = new Error('Parent read failed')
    fixture.capabilities.observeParent.mockRejectedValueOnce(failure)
    await expect(admitBranchResult(fixture.parent, selection, fixture.capabilities)).rejects.toBe(failure)
    expect(fixture.session.snapshotEvents()).toHaveLength(0)
  })

  it('classifies only failures before the maintenance callback starts as busy', async () => {
    const fixture = await setup()
    const failure = new Error('Parent active')
    const sync: typeof fixture.parent = { session: fixture.session, runMaintenance: () => { throw failure } }
    const asynchronous: typeof fixture.parent = { session: fixture.session, runMaintenance: () => Promise.reject(failure) }
    await expect(admitBranchResult(sync, selection, fixture.capabilities)).rejects.toBeInstanceOf(BranchResultAdmissionBusy)
    await expect(admitBranchResult(asynchronous, selection, fixture.capabilities)).rejects.toBeInstanceOf(BranchResultAdmissionBusy)
    expect(fixture.capabilities.observeParent).not.toHaveBeenCalled()
  })

  it('serializes competing content and reports a conflict on its later retry', async () => {
    const fixture = await setup()
    const gate = Promise.withResolvers<boolean>()
    fixture.capabilities.observeParent.mockImplementationOnce(async () => {
      await gate.promise
      return { events: fixture.session.snapshotEvents(), [Symbol.dispose]: (): void => {} }
    })
    const plain = admitBranchResult(fixture.parent, selection, fixture.capabilities)
    const evidence = [{ type: 'text' as const, text: 'Evidence' }]
    await expect(admitBranchResult(fixture.parent, selection, fixture.capabilities, evidence))
      .rejects.toBeInstanceOf(BranchResultAdmissionBusy)
    gate.resolve(true)
    await plain
    await expect(admitBranchResult(fixture.parent, selection, fixture.capabilities, evidence))
      .rejects.toBeInstanceOf(BranchResultAdmissionConflict)
    expect(fixture.session.snapshotEvents()).toHaveLength(1)
  })

  it('validates the complete new message after receipt lookup and before append', async () => {
    const fixture = await setup()
    const policy = vi.fn(() => { throw new Error('Message budget exceeded') })
    await expect(admitBranchResult(fixture.parent, selection, { ...fixture.capabilities, validateMessage: policy }))
      .rejects.toThrow('Message budget exceeded')
    expect(fixture.session.snapshotEvents()).toHaveLength(0)
    const receipt = await admitBranchResult(fixture.parent, selection, fixture.capabilities)
    expect(await admitBranchResult(fixture.parent, selection, { ...fixture.capabilities, validateMessage: policy })).toEqual(receipt)
    expect(policy).toHaveBeenCalledOnce()
  })
})
