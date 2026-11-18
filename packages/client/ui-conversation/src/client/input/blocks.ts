/**
 * Composer blocks let plugins hold editing or submission in a session.
 *
 * The composer cannot read the plugins that would know — the dependency runs
 * ui-model-selection → ui-conversation, never back — so a blocker pushes here and the
 * bar reads its own session's store. A block carries the localized reason it
 * exists, because the plugin that raised it owns that copy; the composer only
 * knows how to render an inert textarea with a placeholder, exactly as it
 * already does for a session with no workspace.
 *
 * This is an affordance, not enforcement: the Host refuses a prompt it cannot
 * route regardless of what any client disables.
 */

import { createSnapshotStore, type SnapshotStore } from '@agentrans/client-store'
import type { SessionId } from '@agentrans/session/types'
import type { ComposerBlock, ComposerBlocks } from '../contract/composer-blocks.ts'

/** The per-session composer-block registry (one instance per plugin fiber). */
export class ComposerBlockRegistry implements ComposerBlocks {
  private readonly stores = new Map<SessionId, SnapshotStore<ComposerBlock | undefined>>()
  private readonly submissions = new Map<SessionId, { sources: Set<string>; store: SnapshotStore<boolean> }>()

  /** @inheritdoc */
  set(sessionId: SessionId, block: ComposerBlock | undefined): void {
    const store = this.storeFor(sessionId)
    const current = store.getSnapshot()
    if (current?.reason === block?.reason) return
    store.set(block)
  }

  /** @inheritdoc */
  storeFor(sessionId: SessionId): SnapshotStore<ComposerBlock | undefined> {
    const existing = this.stores.get(sessionId)
    if (existing !== undefined) return existing
    const created = createSnapshotStore<ComposerBlock | undefined>(undefined)
    this.stores.set(sessionId, created)
    return created
  }

  /** @inheritdoc */
  setSubmission(sessionId: SessionId, source: string, blocked: boolean): void {
    const entry = this.submissionEntry(sessionId)
    if (blocked) entry.sources.add(source)
    else entry.sources.delete(source)
    entry.store.set(entry.sources.size > 0)
  }

  /** @inheritdoc */
  submissionFor(sessionId: SessionId): SnapshotStore<boolean> {
    return this.submissionEntry(sessionId).store
  }

  /** @inheritdoc */
  forget(sessionId: SessionId): void {
    this.stores.delete(sessionId)
    this.submissions.delete(sessionId)
  }

  private submissionEntry(sessionId: SessionId): { sources: Set<string>; store: SnapshotStore<boolean> } {
    const existing = this.submissions.get(sessionId)
    if (existing !== undefined) return existing
    const created = { sources: new Set<string>(), store: createSnapshotStore(false) }
    this.submissions.set(sessionId, created)
    return created
  }
}
