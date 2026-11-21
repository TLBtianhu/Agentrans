/** Owner-private staging of an exact comparison page before ordinary prompt admission. */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { SessionRequestId } from '@agentrans/api-session-controller/types'
import { brandString } from '@agentrans/brand'
import type { Context } from '@agentrans/cordis'
import type { SessionId } from '@agentrans/session/types'
import { defineDomain, domainTable } from '@agentrans/storage-domain'
import { RemoteError } from '@agentrans/typert-protocol'
import { deepFreeze, snapshotJsonValue } from '@agentrans/util-values'
import { z } from 'zod'
import { csvComparisonQuestionBlock, verifyCsvComparisonQuestion } from './csv-comparison.ts'
import { isComparisonFacts } from './csv-comparison-facts.ts'
import type {
  ArtifactCsvComparisonAttachment, ArtifactCsvComparisonDraft, ArtifactCsvComparisonDraftFailure, ArtifactCsvComparisonQuestionFacts,
} from './types.ts'

const receiptIdSchema = z.uuid()

const draftSchema = z.strictObject({ receiptId: receiptIdSchema, facts: z.custom<ArtifactCsvComparisonQuestionFacts>(isComparisonFacts),
  savedAfterSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().min(1).max(128).transform(value => brandString<SessionRequestId>(value)).optional() })
type StoredDraft = z.infer<typeof draftSchema>
type DraftBinding = Pick<StoredDraft, 'facts' | 'savedAfterSeq' | 'requestId'>
type DraftAdmission = 'accepted' | 'pending' | 'absent'

/**
 * The only durable draft table; Session IDs are hashed for safe per-record filenames.
 * A draft that fails the current schema, such as one saved before the `attribution` field rename,
 * is moved aside and skipped so the Host still opens; the user selects the comparison again.
 */
export const artifactCsvComparisonDraftDomain = defineDomain({
  name: 'artifact_csv_drafts', version: 1, layout: 'per-record', invalidRecords: 'backup-and-skip',
  tables: { drafts: domainTable<string, StoredDraft>(draftSchema) },
})

/** Private witnesses for exact reviewed comparison blocks bound to upcoming ordinary prompts. */
export const artifactCsvComparisonAdmissionsDomain = defineDomain({
  name: 'artifact_csv_admissions', version: 1, layout: 'per-record',
  tables: { requests: domainTable<string, string>(z.string().regex(/^[a-f0-9]{64}$/u)) },
})

/**
 * Refuse a draft operation without exposing data from another receipt or Session.
 * @param reason - Wire reason reported as `artifact-followup/csv-draft-unavailable` details.
 * @returns Never; always throws a `RemoteError`.
 */
export function csvComparisonDraftUnavailable(reason: ArtifactCsvComparisonDraftFailure): never {
  throw new RemoteError('artifact-followup/csv-draft-unavailable', 'The selected CSV comparison draft is unavailable', { reason })
}

interface DraftStore {
  read(sessionId: SessionId): ArtifactCsvComparisonDraft | null
  resolve(sessionId: SessionId, receiptId: string, requestId?: SessionRequestId): ArtifactCsvComparisonQuestionFacts | undefined
  save(sessionId: SessionId, expectedReceiptId: string | null, attachment: ArtifactCsvComparisonAttachment,
    savedAfterSeq: number): Promise<ArtifactCsvComparisonDraft>
  bind(sessionId: SessionId, receiptId: string, requestId: SessionRequestId,
    validate: (binding: DraftBinding) => Promise<void>): Promise<void>
  verifiesHistory(sessionId: SessionId, requestId: SessionRequestId, block: string): boolean
  reconcile(sessionId: SessionId, check: (binding: DraftBinding) => Promise<DraftAdmission>): Promise<ArtifactCsvComparisonDraft | null>
  clear(sessionId: SessionId, receiptId: string, validate?: (binding: DraftBinding) => Promise<void>): Promise<boolean>
}

const stores = new WeakMap<Context, DraftStore>()

/**
 * Open the private draft table before the synchronous prompt context provider starts accepting receipts.
 * @param ctx - Host context whose root owns the store; both storage domains close when it disposes.
 * @returns The draft store registered for this Host root.
 */
export async function registerCsvComparisonDrafts(ctx: Context): Promise<DraftStore> {
  const domain = await ctx.storageDomain.open(artifactCsvComparisonDraftDomain)
  ctx.effect(() => async () => { await domain.close() }, 'CSV comparison draft storage')
  const admissions = await ctx.storageDomain.open(artifactCsvComparisonAdmissionsDomain)
  ctx.effect(() => async () => { await admissions.close() }, 'CSV comparison admission storage')
  const table = domain.table('drafts')
  const requests = admissions.table('requests')
  const pending = new Map<SessionId, Promise<void>>()
  const replacingBindings = new Set<SessionId>()

  function key(sessionId: SessionId): string { return createHash('sha256').update(sessionId).digest('hex') }

  function requestKey(sessionId: SessionId, requestId: SessionRequestId): string {
    return createHash('sha256').update(JSON.stringify([sessionId, requestId])).digest('hex')
  }

  function blockDigest(block: string): string { return createHash('sha256').update(block).digest('hex') }

  function read(sessionId: SessionId): StoredDraft | null {
    const draft = table.get(key(sessionId))
    if (draft === undefined) return null
    if (draft.facts.sessionId !== sessionId) return csvComparisonDraftUnavailable('UNAVAILABLE')
    return deepFreeze(draft)
  }

  function view(draft: StoredDraft): ArtifactCsvComparisonDraft {
    return { receiptId: draft.receiptId, facts: draft.facts }
  }

  function serialize<T>(sessionId: SessionId, write: () => Promise<T>): Promise<T> {
    const result = (pending.get(sessionId) ?? Promise.resolve()).then(write)
    const tail = result.then(() => {}, () => {})
    pending.set(sessionId, tail)
    void tail.then(() => { if (pending.get(sessionId) === tail) pending.delete(sessionId) })
    return result
  }

  const owner: DraftStore = {
    read(sessionId) {
      const draft = read(sessionId)
      return draft === null ? null : view(draft)
    },
    resolve(sessionId, receiptId, requestId) {
      if (replacingBindings.has(sessionId)) return undefined
      const draft = read(sessionId)
      return draft?.receiptId === receiptId && draft.requestId === requestId ? draft.facts : undefined
    },
    save(sessionId, expectedReceiptId, attachment, savedAfterSeq) {
      if (!isComparisonFacts(attachment.facts) || attachment.facts.sessionId !== sessionId
        || !verifyCsvComparisonQuestion(ctx, attachment)) return csvComparisonDraftUnavailable('INVALID_REVIEW')
      const facts = snapshotJsonValue(attachment.facts)
      if (facts === undefined) return csvComparisonDraftUnavailable('INVALID_REVIEW')
      return serialize(sessionId, async () => {
        const current = read(sessionId)
        if (current !== null && isDeepStrictEqual(current.facts, facts)) return view(current)
        if ((current?.receiptId ?? null) !== expectedReceiptId) return csvComparisonDraftUnavailable('DRAFT_CHANGED')
        const draft = deepFreeze({ receiptId: randomUUID(), facts, savedAfterSeq })
        await table.put(key(sessionId), draft)
        return view(draft)
      })
    },
    bind(sessionId, receiptId, requestId, validate) {
      return serialize(sessionId, async () => {
        const current = read(sessionId)
        if (current?.receiptId !== receiptId) return csvComparisonDraftUnavailable('DRAFT_CHANGED')
        const admissionKey = requestKey(sessionId, requestId)
        const digest = blockDigest(csvComparisonQuestionBlock(current.facts).text)
        const existing = requests.get(admissionKey)
        if (existing !== undefined && existing !== digest) return csvComparisonDraftUnavailable('DRAFT_CHANGED')
        if (current.requestId === requestId && existing === digest) return
        replacingBindings.add(sessionId)
        try {
          if (current.requestId !== requestId) await validate(current)
          if (existing === undefined) await requests.put(admissionKey, digest)
          if (current.requestId !== requestId) await table.put(key(sessionId), deepFreeze({ ...current, requestId }))
        } finally { replacingBindings.delete(sessionId) }
      })
    },
    verifiesHistory(sessionId, requestId, block) {
      const witness = requests.get(requestKey(sessionId, requestId))
      if (witness !== undefined) return witness === blockDigest(block)
      const draft = read(sessionId)
      return draft?.requestId === requestId && csvComparisonQuestionBlock(draft.facts).text === block
    },
    reconcile(sessionId, check) {
      return serialize(sessionId, async () => {
        const current = read(sessionId)
        if (current === null) return null
        if (current.requestId === undefined) return view(current)
        const status = await check(current)
        if (status === 'pending') return { ...view(current), pendingRequestId: current.requestId }
        if (status === 'absent') return view(current)
        await table.delete(key(sessionId))
        return null
      })
    },
    clear(sessionId, receiptId, validate) {
      return serialize(sessionId, async () => {
        const current = read(sessionId)
        if (current?.receiptId !== receiptId) return false
        await validate?.(current)
        return await table.delete(key(sessionId))
      })
    },
  }
  ctx.effect(() => {
    const root = ctx.root
    stores.set(root, owner)
    return () => { if (stores.get(root) === owner) stores.delete(root) }
  }, 'CSV comparison drafts')
  return owner
}

/**
 * Access the mounted Host's private draft scope without publishing it as a Cordis tool service.
 * @param ctx - Any context under the Host root.
 * @returns The registered draft store, or `undefined` before registration or after disposal.
 */
export function csvComparisonDrafts(ctx: Context): DraftStore | undefined {
  return stores.get(ctx.root)
}
