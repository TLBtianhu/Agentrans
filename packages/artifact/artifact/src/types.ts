/** Artifact protocol values shared by Host services, tools, and Clients. @module @deepseek-ai/dsh-artifact/types */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Stable identity of one artifact within a Session. */
export type ArtifactId = Branded<'ArtifactId'>

/** Serialized artifact representation supported by this protocol version. */
export type ArtifactFormat = 'html'

/** Client placement requested for an artifact. */
export type ArtifactPresentation = 'inline' | 'focus'

/** Optional comparison relation between two independent Artifact snapshots. */
export interface ArtifactComparison {
  /** Stable comparison group id within one Session. */
  readonly group: string
  /** Independent role in the comparison; parameters never merge across roles. */
  readonly role: 'control' | 'variant'
}

/** Complete durable value carried by every artifact update. */
export interface ArtifactSnapshot {
  readonly artifactId: ArtifactId
  /** Positive safe integer, starting at 1 and increasing by one per update. */
  readonly revision: number
  readonly format: ArtifactFormat
  /** Trimmed, non-empty display title of at most 120 characters. */
  readonly title: string
  /** Complete self-contained HTML document. */
  readonly source: string
  readonly presentation: ArtifactPresentation
  readonly comparison?: ArtifactComparison
}

/** Complete new values accepted for a create or compare-and-set update. */
export interface ArtifactPrepareInput {
  readonly action: 'create' | 'update'
  readonly artifactId: string
  readonly title: string
  readonly source: string
  readonly presentation: ArtifactPresentation
  readonly comparison?: ArtifactComparison
  /** Required for update; must equal the current durable revision. */
  readonly baseRevision?: number
}

/** Compact tool result which does not repeat the HTML source. */
export interface ArtifactToolResult {
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly title: string
  readonly presentation: ArtifactPresentation
}

/** User intent encoded as the sole text block of an artifact-action message. */
export interface ArtifactActionMessage {
  readonly kind: 'artifact_action'
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly action: string
  readonly payload: JsonValue
}

/** Acknowledgement that an artifact action entered the Agent inbox. */
export interface ArtifactRecordResult {
  readonly accepted: true
  readonly revision: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Complete current value of one artifact revision; later events for the same id supersede earlier ones.
     * @param data - independently renderable snapshot for one artifact id and revision.
     */
    'artifact/upsert': ArtifactSnapshot
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * User-reviewed intent from an artifact. It supplies text input only and grants no file, network, or approval authority.
     * @persistenceAttribution
     */
    'artifact-action': { kind: 'artifact-action'; artifactId: ArtifactId; revision: number }
  }
}
