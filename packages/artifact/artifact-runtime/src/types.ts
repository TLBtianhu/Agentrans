/** Live Artifact runtime reports. @module @deepseek-ai/dsh-artifact-runtime/types */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ArtifactId, ArtifactFormat } from '@deepseek-ai/dsh-artifact/types'
import type { SceneSpec } from '@deepseek-ai/dsh-artifact/scene'
import type { ArtifactSourceCapabilities } from '@deepseek-ai/dsh-artifact/capabilities'

/** Identity of one mounted runtime, replaced whenever its document or native renderer is recreated. */
export type ArtifactRuntimeId = Branded<'ArtifactRuntimeId'>

/** Commands understood by the interactive Artifact bridge. */
export type ArtifactRuntimeCommand = 'play' | 'pause' | 'step' | 'reset'

/** Program-declared protocol support; it grants no Host business capability or permission. */
export interface ArtifactRuntimeCapabilities {
  readonly state: boolean
  readonly commands: readonly ArtifactRuntimeCommand[]
}

/** One source-bound physical runtime. */
export interface ArtifactRuntimeIdentity {
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly runtimeId: ArtifactRuntimeId
  readonly renderer: 'native' | 'html'
}

/** Stable diagnostic from the renderer or program, bounded before it enters Host state. */
export interface ArtifactRuntimeFailure {
  readonly code: string
  readonly message: string
}

/** Complete replacement of one runtime's current report; no report proves pixels or causal correctness. */
export type RuntimeReport =
  | { readonly status: 'starting' }
  | { readonly status: 'ready'; readonly capabilities: ArtifactRuntimeCapabilities }
  | { readonly status: 'error'; readonly error: ArtifactRuntimeFailure }

/** Registration or processing acknowledgement on the same live report stream. */
export type RuntimeAck =
  | { readonly kind: 'attached' }
  | { readonly kind: 'accepted'; readonly sequence: number }

/** One active report at the instant a model tool inspected it. */
export type ArtifactRuntimeRun = {
  readonly runtimeId: ArtifactRuntimeId
  readonly renderer: ArtifactRuntimeIdentity['renderer']
} & RuntimeReport

/** A bounded read of one exact current source revision and its still-connected reported runs. */
export interface ArtifactRuntimeInspection {
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly title: string
  readonly format: ArtifactFormat
  readonly sceneKind?: SceneSpec['kind']
  /** Source semantics only; not deployment availability, permission, or execution evidence. */
  readonly sourceCapabilities: ArtifactSourceCapabilities
  readonly reportAuthority: 'client-reported'
  readonly runs: readonly ArtifactRuntimeRun[]
}

/** One bounded wait, retaining independent reports rather than an overall rendering verdict. */
export interface ArtifactRuntimeWaitResult extends ArtifactRuntimeInspection {
  readonly wait: {
    /**
     * `reported` means a current run reports ready or error; other runs may disagree.
     * `timeout` retains starting reports, `no-active-report` never saw a matching run,
     * and `disconnected` follows the loss of all previously matching reports.
     */
    readonly outcome: 'reported' | 'timeout' | 'no-active-report' | 'disconnected'
    /** Requested wait budget; expiration establishes no execution outcome. */
    readonly limitMs: number
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Report registration or input was rejected; no rejected report is retained. */
    'artifact-runtime/rejected': {
      readonly reason: 'INVALID_IDENTITY' | 'INVALID_REPORT' | 'ERROR_TOO_LARGE' | 'CAPACITY' | 'DUPLICATE_RUNTIME' | 'CLOSED'
      readonly limit?: number
    }
    /** The requested source is absent or its revision has changed. */
    'artifact-runtime/source-unavailable': {
      readonly reason: 'NOT_FOUND' | 'STALE_REVISION'
      readonly currentRevision?: number
    }
    /** A wait was rejected or its owning Session or service ended; no background wait remains. */
    'artifact-runtime/wait-unavailable': {
      readonly reason: 'INVALID_WAIT' | 'CAPACITY' | 'CLOSED' | 'SESSION_DISPOSED'
      readonly limit?: number
    }
  }
}
