import { Context } from '@agentrans/cordis'
import { createUserMessage, freezeMessage, MessageId } from '@agentrans/llm'
import SessionStore, { SessionId, SessionLogOffset } from '@agentrans/session'
import SessionProjectionRegistry from '@agentrans/session-projection'
import { describe, expect, it } from 'vitest'
import { acceptedMessageDigest, inputReceiptProjection as promptReceiptProjection, inputMessageDigest } from '../src/receipts.ts'
import type { SessionInputRequestId as SessionRequestId } from '../src/types.ts'

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const receipts = await ctx.sessionProjections.register(promptReceiptProjection)
  const session = ctx.sessions.create(SessionId('prompt-receipts'))
  return { ctx, receipts, session }
}

const prompt = (requestId: string) => createUserMessage({
  content: [{ type: 'text', text: 'Queued input' }], source: { kind: 'user', rpcId: requestId as SessionRequestId },
})

describe('private prompt receipt projection', () => {
  it('canonicalizes object keys while preserving array order and opaque message text', () => {
    const first = freezeMessage({ id: MessageId('canonical'), role: 'user', source: {
      kind: 'user', clientTimeZone: 'UTC', detail: { z: 2, a: 1 },
    }, content: [{ type: 'text', text: '{"z":2,"a":1}' }] })
    const reordered = freezeMessage({ id: first.id, content: first.content, role: 'user', source: {
      detail: { a: 1, z: 2 }, clientTimeZone: 'UTC', kind: 'user',
    } })
    expect(inputMessageDigest(first)).toBe(inputMessageDigest(reordered))
    expect(inputMessageDigest(freezeMessage({ ...first, content: [{ type: 'text', text: '{"a":1,"z":2}' }] })))
      .not.toBe(inputMessageDigest(first))
    const withBlocks = freezeMessage({ ...first, content: [
      { type: 'text', text: 'A' }, { type: 'text', text: 'B' },
    ] })
    expect(inputMessageDigest(withBlocks)).not.toBe(inputMessageDigest(freezeMessage({
      ...withBlocks, content: [...withBlocks.content].reverse(),
    })))
  })

  it('does not admit undefined optional properties into the log or poison later receipt reads', async () => {
    const { ctx, receipts, session } = await harness()
    try {
      const before = receipts.stateOf(session)
      const invalid = freezeMessage({ id: MessageId('invalid-optional'), role: 'user',
        source: { kind: 'user', clientTimeZone: undefined }, content: [{ type: 'text', text: 'Invalid optional' }] })
      expect(() => session.append('user/message', invalid, { surfaceOp: 'append' })).toThrow('non-JSON-serializable')
      expect(receipts.stateOf(session)).toBe(before)
      const valid = freezeMessage({ ...invalid, source: { kind: 'user', clientTimeZone: 'UTC' } })
      session.append('user/message', valid, { surfaceOp: 'append' })
      expect(acceptedMessageDigest(receipts.stateOf(session), valid.id)).toBe(inputMessageDigest(valid))
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps prototype-named message identities through JSON checkpoints and replay', async () => {
    const { ctx, receipts, session } = await harness()
    try {
      for (const id of ['__proto__', 'constructor', 'toString']) {
        session.append('user/message', freezeMessage({ id: MessageId(id), role: 'user',
          source: { kind: 'user' }, content: [{ type: 'text', text: id }] }), { surfaceOp: 'append' })
      }
      const persisted = promptReceiptProjection.stateSchema.parse(JSON.parse(JSON.stringify(receipts.stateOf(session))))
      expect(Object.values(persisted.messageBuckets).flatMap(bucket => Object.keys(bucket)).sort())
        .toEqual(['__proto__', 'constructor', 'toString'].sort())
      for (const id of ['__proto__', 'constructor', 'toString']) expect(acceptedMessageDigest(persisted, id)).toBeDefined()
    } finally { await ctx.fiber.dispose() }
  })

  it.each([
    null, {}, { inheritedEventCount: 0, accepted: {}, messageBuckets: { aa: { broken: 'not-a-digest' } } },
    { inheritedEventCount: 0, accepted: { broken: false }, messageBuckets: {} },
    { inheritedEventCount: 0, accepted: {}, messageBuckets: Object.fromEntries([['__proto__', []]]) },
    { inheritedEventCount: 0, accepted: {}, messageBuckets: { aa: { 'wrong-bucket': 'a'.repeat(64) } } },
  ])('rejects malformed private checkpoint values without relaxing JSON validation', (value) => {
    expect(promptReceiptProjection.stateSchema.safeParse(value).success).toBe(false)
  })

  it('copies only touched message buckets and keeps earlier snapshots immutable', async () => {
    const { ctx, receipts, session } = await harness()
    try {
      const inputs = Array.from({ length: 300 }, (_, index) => freezeMessage({
        id: MessageId(`bucketed-${index}`), role: 'user', source: { kind: 'user' }, content: [],
      }))
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: inputs })
      const before = receipts.stateOf(session)
      const snapshot: unknown = JSON.parse(JSON.stringify(before))
      const next = freezeMessage({ id: MessageId('another-bucketed-message'), role: 'user', source: { kind: 'user' }, content: [] })
      session.append('user/message', next, { surfaceOp: 'append' })
      const after = receipts.stateOf(session)
      expect(before).toEqual(snapshot)
      expect(Object.keys(after.messageBuckets).length).toBeLessThanOrEqual(256)
      expect(Object.entries(after.messageBuckets).filter(([key, bucket]) => before.messageBuckets[key] !== bucket)).toHaveLength(1)
      expect(after.accepted).toBe(before.accepted)
      for (const input of [...inputs, next]) expect(acceptedMessageDigest(after, input.id)).toBe(inputMessageDigest(input))
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps the first message when one inbox insertion repeats an identity with different content', async () => {
    const { ctx, receipts, session } = await harness()
    try {
      const first = freezeMessage({ id: MessageId('__proto__'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'First' }] })
      const later = freezeMessage({ ...first, content: [{ type: 'text', text: 'Later' }] })
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [first, later] })
      expect(acceptedMessageDigest(receipts.stateOf(session), first.id)).toBe(inputMessageDigest(first))
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps an accepted identity after queue cancellation and records committed user messages', async () => {
    const { ctx, receipts, session } = await harness()
    try {
      const queued = prompt('queued')
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [queued] })
      const accepted = receipts.stateOf(session)
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
      expect(receipts.stateOf(session)).toBe(accepted)
      session.append('user/message', prompt('committed'), { surfaceOp: 'append' })
      const committed = receipts.stateOf(session)
      session.append('user/message', queued, { surfaceOp: 'append' })
      expect(receipts.stateOf(session)).toBe(committed)
      const local = createUserMessage({ content: [], source: { kind: 'user' } })
      session.append('user/message', local, { surfaceOp: 'append' })
      expect(acceptedMessageDigest(receipts.stateOf(session), local.id)).toBe(inputMessageDigest(local))
      expect(committed.accepted).toEqual({ queued: true, committed: true })
      expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty(promptReceiptProjection.key)
    } finally { await ctx.fiber.dispose() }
  })

  it('matches cold full replay and a checkpoint suffix, including prototype-named identities', async () => {
    const { ctx, receipts, session } = await harness()
    try {
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [prompt('__proto__')] })
      const rows = ctx.sessionProjections.checkpoint(session)
      const offset = session.snapshotEvents().length
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
      session.append('user/message', prompt('constructor'), { surfaceOp: 'append' })
      session.append('user/message', prompt('toString'), { surfaceOp: 'append' })
      const events = session.snapshotEvents()
      const cached = ctx.sessionProjections.restore(
        rows, events.slice(offset), SessionLogOffset(offset), session.header, session.inheritedEventCount,
      )
      const full = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), session.header, session.inheritedEventCount)
      expect(cached).toEqual(full)
      const state = promptReceiptProjection.stateSchema.parse(cached.checkpoint[promptReceiptProjection.key]?.val)
      const persisted = promptReceiptProjection.stateSchema.parse(JSON.parse(JSON.stringify(state)))
      expect(Object.keys(persisted.accepted).sort()).toEqual(['__proto__', 'constructor', 'toString'].sort())
      for (const id of ['__proto__', 'constructor', 'toString']) expect(Object.hasOwn(persisted.accepted, id)).toBe(true)
      const cold = ctx.sessions.create(SessionId('cold-prompt-receipts'), { seed: events })
      expect(receipts.stateOf(cold)).toEqual(state)
      expect(session.snapshotEvents()).toEqual(events)
      expect(cached.snapshot.values).not.toHaveProperty(promptReceiptProjection.key)
    } finally { await ctx.fiber.dispose() }
  })

  it('excludes inherited receipts so a child can use the same request identity independently', async () => {
    const { ctx, receipts, session } = await harness()
    try {
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [prompt('shared-rpc-id')] })
      session.append('user/message', prompt('parent-message'), { surfaceOp: 'append' })
      const inherited = session.snapshotEvents()
      const child = ctx.sessions.create(SessionId('child-prompt-receipts'), {
        seed: inherited, inheritedEventCount: SessionLogOffset(inherited.length), meta: { isSeeded: true },
      })
      expect(receipts.stateOf(child).accepted).toEqual({})
      const rows = ctx.sessionProjections.checkpoint(child)
      const offset = child.snapshotEvents().length
      child.append('user/message', prompt('shared-rpc-id'), { surfaceOp: 'append' })
      expect(receipts.stateOf(child).accepted).toEqual({ 'shared-rpc-id': true })
      const events = child.snapshotEvents()
      const restored = ctx.sessionProjections.restore(
        rows, events.slice(offset), SessionLogOffset(offset), child.header, child.inheritedEventCount,
      )
      expect(restored.checkpoint[promptReceiptProjection.key]?.val).toEqual(receipts.stateOf(child))
    } finally { await ctx.fiber.dispose() }
  })
})
