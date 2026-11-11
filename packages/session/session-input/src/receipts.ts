/** Private, replayable reservation of this Session's first accepted input identities. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { UserMessage } from '@agentrans/llm'
import type { ProjectionDefinition } from '@agentrans/session-projection'

/** The original acceptance remains reserved after queue edits, removal and claim. */
export interface InputReceiptState {
  readonly inheritedEventCount: number
  readonly accepted: Readonly<Record<string, true>>
  readonly messageBuckets: Readonly<Record<string, Readonly<Record<string, string>>>>
}

/**
 * Read the first accepted content for an identity from its fixed SHA-256 bucket.
 * @param state - This Session's immutable receipt index.
 * @param messageId - Exact message identity, including otherwise special object property names.
 * @returns Its first content digest, or undefined before acceptance.
 */
export function acceptedMessageDigest(state: InputReceiptState, messageId: string): string | undefined {
  const bucket = state.messageBuckets[messageBucket(messageId)]
  return bucket !== undefined && Object.hasOwn(bucket, messageId) ? bucket[messageId] : undefined
}

function messageBucket(messageId: string): string {
  return createHash('sha256').update(messageId).digest('hex').slice(0, 2)
}

/**
 * Hash the exact source and model-facing blocks with object keys sorted and array order preserved.
 * Message text is opaque; delivery mode and later queue edits are not part of the original message.
 * @param message - The complete identified user message being admitted or replayed.
 * @returns A stable SHA-256 fingerprint independent of object insertion order.
 */
export function inputMessageDigest(message: UserMessage): string {
  const hash = createHash('sha256')
  const stack: ({ readonly kind: 'value'; readonly value: unknown } | { readonly kind: 'text'; readonly text: string })[] = [
    { kind: 'value', value: { source: message.source, content: message.content } },
  ]
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if (item.kind === 'text') { hash.update(item.text); continue }
    const value = item.value
    if (Array.isArray(value)) {
      const values: readonly unknown[] = value
      hash.update('[')
      stack.push({ kind: 'text', text: ']' })
      let more = false
      for (const child of values.toReversed()) {
        if (more) stack.push({ kind: 'text', text: ',' })
        stack.push({ kind: 'value', value: child })
        more = true
      }
    } else if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      hash.update('{')
      stack.push({ kind: 'text', text: '}' })
      let more = false
      for (const [key, child] of entries.toReversed()) {
        if (more) stack.push({ kind: 'text', text: ',' })
        stack.push({ kind: 'value', value: child }, { kind: 'text', text: `${JSON.stringify(key)}:` })
        more = true
      }
    } else hash.update(JSON.stringify(value))
  }
  return hash.digest('hex')
}

const stateSchema = z.unknown().transform((value, context): InputReceiptState | typeof z.NEVER => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('inheritedEventCount' in value) || typeof value.inheritedEventCount !== 'number'
    || !Number.isSafeInteger(value.inheritedEventCount) || value.inheritedEventCount < 0
    || !('accepted' in value) || typeof value.accepted !== 'object' || value.accepted === null || Array.isArray(value.accepted)
    || !('messageBuckets' in value) || typeof value.messageBuckets !== 'object' || value.messageBuckets === null || Array.isArray(value.messageBuckets)) {
    context.addIssue({ code: 'custom', message: 'Invalid Session input receipt checkpoint' })
    return z.NEVER
  }
  const aliases = Object.entries(value.accepted)
  if (aliases.some(([, accepted]) => accepted !== true)) {
    context.addIssue({ code: 'custom', message: 'Invalid Session input receipt value' })
    return z.NEVER
  }
  const buckets: [string, Readonly<Record<string, string>>][] = []
  for (const [key, rawBucket] of Object.entries(value.messageBuckets)) {
    const bucket: unknown = rawBucket
    if (!/^[a-f0-9]{2}$/.test(key) || bucket === null || typeof bucket !== 'object' || Array.isArray(bucket)) {
      context.addIssue({ code: 'custom', message: 'Invalid Session input receipt value' })
      return z.NEVER
    }
    const digests: [string, string][] = []
    for (const [id, digest] of Object.entries(bucket)) {
      if (messageBucket(id) !== key || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
        context.addIssue({ code: 'custom', message: 'Invalid Session input receipt value' })
        return z.NEVER
      }
      digests.push([id, digest])
    }
    buckets.push([key, Object.fromEntries(digests)])
  }
  return { inheritedEventCount: value.inheritedEventCount,
    accepted: Object.fromEntries(aliases.map(([id]) => [id, true as const])),
    messageBuckets: Object.fromEntries(buckets),
  }
})

/** First-seen message fingerprints never follow later edits of the same identity. */
export const inputReceiptProjection = {
  key: 'session/promptReceipts',
  stateVersion: 3,
  stateSchema,
  init: (_header, inheritedEventCount): InputReceiptState => ({ inheritedEventCount, accepted: {}, messageBuckets: {} }),
  apply: (state, event): InputReceiptState => {
    if (event.seq < state.inheritedEventCount) return state
    const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted
      : event.type === 'user/message' ? [event.data] : undefined
    if (messages === undefined) return state
    const accepted: [string, true][] = []
    const updates = new Map<string, [string, string][]>()
    const seen = new Set<string>()
    for (const message of messages) {
      const source = message.source
      if (source.kind === 'user' && 'rpcId' in source && typeof source.rpcId === 'string'
        && !Object.hasOwn(state.accepted, source.rpcId)) accepted.push([source.rpcId, true])
      const key = messageBucket(message.id)
      if (Object.hasOwn(state.messageBuckets[key] ?? {}, message.id) || seen.has(message.id)) continue
      seen.add(message.id)
      const bucket = updates.get(key) ?? []
      bucket.push([message.id, inputMessageDigest(message)])
      updates.set(key, bucket)
    }
    if (accepted.length === 0 && updates.size === 0) return state
    return { ...state,
      accepted: accepted.length === 0 ? state.accepted : { ...state.accepted, ...Object.fromEntries(accepted) },
      messageBuckets: updates.size === 0 ? state.messageBuckets : { ...state.messageBuckets,
        ...Object.fromEntries([...updates].map(([key, digests]) => [key, {
          ...state.messageBuckets[key], ...Object.fromEntries(digests),
        }])),
      },
    }
  },
} satisfies ProjectionDefinition<'session/promptReceipts', InputReceiptState>
