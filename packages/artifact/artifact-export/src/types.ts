/** Durable fixed-input HTML export vocabulary. @module @agentrans/artifact-export/types */
import type { Branded } from '@agentrans/brand'
import type { ArtifactExportSource, ArtifactExportSourceSelection } from '@agentrans/artifact/types'
import type { FileAttachmentRef } from '@agentrans/attachment/types'
import type { SessionId } from '@agentrans/session/types'
import type { SessionProjectionSummaryExcluded } from '@agentrans/session-projection/types'

/** Stable retry identity for one export within a Session. */
export type ArtifactExportId = Branded<'ArtifactExportId'>

/** User-selected immutable request; source bytes and coordinates are supplied by the Host. */
export interface ArtifactHtmlExportRequest {
  readonly exportId: ArtifactExportId
  readonly source: ArtifactExportSourceSelection
  readonly format: 'html'
}

/** Complete original source and the explicit output conditions used to generate the file. */
export interface ArtifactHtmlExportInput extends ArtifactExportSource {
  /** Original Session that admitted this export; inherited records keep this identity. */
  readonly sessionId: SessionId
  readonly exporterVersion: 1
  readonly parameters: 'source-defaults' | 'particle-checkpoint'
}

/** Terminal generation failures; failed exports retain their immutable input and identity. */
export type ArtifactHtmlExportFailure = 'RENDER_FAILED' | 'OUTPUT_TOO_LARGE' | 'STORAGE_FAILED'

/** One immutable request and its latest durable generation state; pending does not imply a live producer. */
export type ArtifactHtmlExportRecord = {
  readonly request: ArtifactHtmlExportRequest
  readonly frozen: ArtifactHtmlExportInput
} & (
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly file: FileAttachmentRef }
  | { readonly status: 'failed'; readonly failure: ArtifactHtmlExportFailure }
)

/** Complete current export records for one opened Session; result bytes remain in attachment storage. */
export type ArtifactHtmlExports = Readonly<Record<string, ArtifactHtmlExportRecord>>

declare module '@agentrans/session/types' {
  interface SessionEventMap {
    /**
     * Complete latest state of one fixed-input export; later events supersede that identity's state.
     * @param data - immutable request and original source with pending, file-ready, or failed state.
     */
    'artifact/export': ArtifactHtmlExportRecord
  }
}

declare module '@agentrans/session-projection/types' {
  interface SessionProjectionMap {
    artifactExports: SessionProjectionSummaryExcluded<ArtifactHtmlExports>
  }
}

declare module '@agentrans/typert-protocol' {
  interface RemoteErrorDetailsMap {
    'artifact-export/request-conflict': { readonly exportId: ArtifactExportId }
    'artifact-export/limit': { readonly limit: number }
    'artifact-export/input-too-large': { readonly limit: number }
    'artifact-export/source-unavailable': { readonly reason: 'NOT_FOUND' | 'STALE_REVISION' | 'UNSUPPORTED_SOURCE' | 'INVALID_CHECKPOINT' }
    'artifact-export/not-ready': { readonly exportId: ArtifactExportId }
    'artifact-export/file-unavailable': { readonly exportId: ArtifactExportId }
  }
}
