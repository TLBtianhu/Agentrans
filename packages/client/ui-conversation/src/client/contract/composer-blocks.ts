import type { SnapshotStore } from '@agentrans/client-store'
import type { SessionId } from '@agentrans/session/types'

/** Why one session's composer is inert. */
export interface ComposerBlock {
  /** Localized placeholder owned by the plugin that raised the block. */
  readonly reason: string
}

/** The registry face other plugins reach through `ctx.conversation.blocks`. */
export interface ComposerBlocks {
  /**
   * Raise or clear this session's block.
   * @param sessionId - Session whose composer is affected.
   * @param block - Block to raise, or undefined to clear it.
   */
  set(sessionId: SessionId, block: ComposerBlock | undefined): void
  /**
   * Resolve the observable block state for one Session.
   * @param sessionId - Session to observe.
   * @returns Identity-stable block store.
   */
  storeFor(sessionId: SessionId): SnapshotStore<ComposerBlock | undefined>
  /**
   * Hold or release one source's submission block while allowing draft editing.
   * @param sessionId - Session whose submission is affected.
   * @param source - Stable key owned by the caller.
   * @param blocked - Whether this source currently holds the block.
   */
  setSubmission(sessionId: SessionId, source: string, blocked: boolean): void
  /**
   * Resolve the submission block for one Session.
   * @param sessionId - Session to observe.
   * @returns Identity-stable store reporting whether any source holds the block.
   */
  submissionFor(sessionId: SessionId): SnapshotStore<boolean>
  /**
   * Drop one Session's store.
   * @param sessionId - Session being released.
   */
  forget(sessionId: SessionId): void
}
