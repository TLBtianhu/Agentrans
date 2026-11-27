/**
 * Fork seed construction over an exact source-event prefix.
 * @module @agentrans/session/fork
 */

import { openTurnClosers } from './repair.ts'
import { SessionSeq } from './types.ts'
import type { SessionEvent, SessionSeq as SessionSeqType } from './types.ts'

/**
 * Copy an inclusive event prefix, mark its inherited cut, and close its open tail with forked results
 * and step/turn endings. Closed steps and turns are preserved unchanged.
 * The caller validates that the boundary is an existing contiguous event seq;
 * Session construction snapshots the borrowed events before publication.
 *
 * @param events - source log with contiguous seqs from zero.
 * @param boundary - inclusive source event seq the child inherits through.
 * @returns a new array retaining the source event objects, followed by synthetic
 *   closers outside the inherited prefix counted by `inheritedEventCount`.
 */
export function buildForkSeed(events: readonly SessionEvent[], boundary: SessionSeqType): SessionEvent[] {
  const prefix = events.slice(0, boundary + 1)
  prefix.push({
    type: 'session/end-seed', seq: SessionSeq(boundary + 1),
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the caller validated this exact source event.
    time: events[boundary]!.time,
    data: { inherited: true },
  })
  return prefix.concat(openTurnClosers(prefix, { kind: 'forked' }))
}

/** The tree facts {@link branchReturnParent} reads from one listed Session. */
export interface BranchTreeEntry<Id extends string> {
  readonly id: Id
  readonly origin?: string
  readonly parentId?: Id
}

/**
 * Find the Session a branch conclusion returns to: the direct parent of a
 * non-subagent Session, when that parent is not a subagent either.
 * @param byId - Listed Sessions by id.
 * @param sessionId - Branch whose conclusion would return.
 * @returns The parent id, or `undefined` when this Session has no eligible parent.
 */
export function branchReturnParent<Id extends string>(
  byId: Readonly<Partial<Record<Id, BranchTreeEntry<Id>>>>, sessionId: Id,
): Id | undefined {
  const current = byId[sessionId]
  if (current?.origin === 'subagent' || current?.parentId === undefined) return undefined
  const parent = byId[current.parentId]
  return parent?.origin === 'subagent' ? undefined : parent?.id
}
