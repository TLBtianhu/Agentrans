/** Instance-bound messages exchanged with an opaque Artifact iframe. */
import type {
  ArtifactRuntimeCommand, ArtifactRuntimeFailure, ArtifactRuntimeIdentity, RuntimeReport,
} from '@deepseek-ai/dsh-artifact-runtime/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ARTIFACT_RUNTIME_FAILURE_MAX_BYTES } from '@deepseek-ai/dsh-artifact/runtime-values'
import { ARTIFACT_ACTION_MAX_BYTES, isArtifactJsonValue } from './messages.ts'

export { ARTIFACT_RUNTIME_FAILURE_MAX_BYTES } from '@deepseek-ai/dsh-artifact/runtime-values'

/** One explicit command addressed to a particular source revision and physical iframe. */
export interface ArtifactRuntimeCommandMessage {
  readonly kind: 'artifact-runtime-command'
  readonly identity: ArtifactRuntimeIdentity
  readonly requestId: string
  readonly command: ArtifactRuntimeCommand
}

/** A callback result confirms handler completion, never pixels or an experiment's correctness. */
export type ArtifactRuntimeCommandResult = { readonly ok: true }
  | { readonly ok: false; readonly error: ArtifactRuntimeFailure }

/** Validated iframe reports; the owner additionally checks MessageEvent.source. */
export type BrowserArtifactRuntimeMessage =
  | { readonly kind: 'artifact-runtime-report'; readonly identity: ArtifactRuntimeIdentity; readonly report: RuntimeReport }
  | { readonly kind: 'artifact-runtime-state'; readonly identity: ArtifactRuntimeIdentity; readonly state: JsonValue }
  | {
    readonly kind: 'artifact-runtime-command-result'
    readonly identity: ArtifactRuntimeIdentity
    readonly requestId: string
    readonly result: ArtifactRuntimeCommandResult
  }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function matchesIdentity(value: unknown, expected: ArtifactRuntimeIdentity): value is ArtifactRuntimeIdentity {
  return isRecord(value) && exactKeys(value, ['artifactId', 'revision', 'runtimeId', 'renderer'])
    && value.artifactId === expected.artifactId && value.revision === expected.revision
    && value.runtimeId === expected.runtimeId && value.renderer === expected.renderer
}

function isFailure(value: unknown): value is ArtifactRuntimeFailure {
  return isRecord(value) && exactKeys(value, ['code', 'message'])
    && typeof value.code === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,95}$/.test(value.code)
    && typeof value.message === 'string'
    && new TextEncoder().encode(JSON.stringify(value)).byteLength <= ARTIFACT_RUNTIME_FAILURE_MAX_BYTES
}

function isCommand(value: unknown): value is ArtifactRuntimeCommand {
  return value === 'play' || value === 'pause' || value === 'step' || value === 'reset'
}

function isReport(value: unknown): value is RuntimeReport {
  if (!isRecord(value)) return false
  if (value.status === 'starting') return exactKeys(value, ['status'])
  if (value.status === 'error') return exactKeys(value, ['status', 'error']) && isFailure(value.error)
  if (value.status !== 'ready' || !exactKeys(value, ['status', 'capabilities'])) return false
  const capabilities = value.capabilities
  return isRecord(capabilities) && exactKeys(capabilities, ['state', 'commands'])
    && typeof capabilities.state === 'boolean' && Array.isArray(capabilities.commands)
    && capabilities.commands.length <= 4 && capabilities.commands.every(isCommand)
    && new Set(capabilities.commands).size === capabilities.commands.length
}

function isResult(value: unknown): value is ArtifactRuntimeCommandResult {
  return isRecord(value) && (value.ok === true ? exactKeys(value, ['ok'])
    : value.ok === false && exactKeys(value, ['ok', 'error']) && isFailure(value.error))
}

/**
 * Read one exact instance-bound message under the shared complete UTF-8 and JSON limits.
 * @param data - Untrusted iframe message body; its event source is checked by the runtime owner.
 * @param identity - Exact current source revision and physical iframe identity.
 * @returns The validated message, or null for another instance, invalid fields, or exceeded limits.
 */
export function parseArtifactRuntimeMessage(data: unknown, identity: ArtifactRuntimeIdentity): BrowserArtifactRuntimeMessage | null {
  if (!isRecord(data) || !isArtifactJsonValue(data) || !matchesIdentity(data.identity, identity)
    || new TextEncoder().encode(JSON.stringify(data)).byteLength > ARTIFACT_ACTION_MAX_BYTES) return null
  if (data.kind === 'artifact-runtime-report' && exactKeys(data, ['kind', 'identity', 'report']) && isReport(data.report)) {
    return { kind: data.kind, identity, report: data.report }
  }
  if (data.kind === 'artifact-runtime-state' && exactKeys(data, ['kind', 'identity', 'state']) && isArtifactJsonValue(data.state)) {
    return { kind: data.kind, identity, state: data.state }
  }
  if (data.kind === 'artifact-runtime-command-result' && exactKeys(data, ['kind', 'identity', 'requestId', 'result'])
    && typeof data.requestId === 'string' && data.requestId.length > 0
    && new TextEncoder().encode(data.requestId).byteLength <= 128 && isResult(data.result)) {
    return { kind: data.kind, identity, requestId: data.requestId, result: data.result }
  }
  return null
}
