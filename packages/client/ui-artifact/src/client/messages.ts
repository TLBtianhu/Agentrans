/** Strict JSON validation for actions crossing from an opaque Artifact iframe. */
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import type { ArtifactPayload, ArtifactStateMessage } from './protocol.ts'

/** Complete serialized message limit in UTF-8 bytes. */
export const ARTIFACT_ACTION_MAX_BYTES = 16_384
/** Maximum nested JSON values, including the payload root. */
export const ARTIFACT_ACTION_MAX_DEPTH = 32
/** Maximum JSON values visited in one payload, including arrays, objects, and primitives. */
export const ARTIFACT_ACTION_MAX_NODES = 2_048

/** One validated action awaiting explicit user confirmation. */
export interface PendingArtifactAction {
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly action: string
  readonly payload: ArtifactPayload
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Iterative validation avoids call-stack growth on hostile nested input. */
function isJsonValue(value: unknown): value is ArtifactPayload {
  const ancestors = new WeakSet<object>()
  const pending: Array<{ readonly value: unknown; readonly depth: number; readonly exit: boolean }> = [{ value, depth: 1, exit: false }]
  let nodes = 0
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (current.exit) {
      ancestors.delete(current.value as object)
      continue
    }
    nodes += 1
    if (nodes > ARTIFACT_ACTION_MAX_NODES || current.depth > ARTIFACT_ACTION_MAX_DEPTH) return false
    const item = current.value
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue
    if (typeof item === 'number') {
      if (Number.isFinite(item)) continue
      return false
    }
    if (typeof item !== 'object') return false
    if (ancestors.has(item)) return false
    if (!Array.isArray(item)) {
      const prototype: unknown = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) return false
    }
    ancestors.add(item)
    pending.push({ value: item, depth: current.depth, exit: true })
    for (const child of Object.values(item)) pending.push({ value: child, depth: current.depth + 1, exit: false })
  }
  return true
}

/**
 * Read the exact Artifact action schema and enforce its complete UTF-8 JSON bound.
 * @param data - untrusted message body; event source is checked by the iframe owner.
 * @param artifactId - currently mounted Artifact id.
 * @param revision - currently mounted positive revision.
 * @returns a validated pending action, or null for every malformed or oversized message.
 */
export function parseArtifactAction(data: unknown, artifactId: ArtifactId, revision: number): PendingArtifactAction | null {
  if (!isRecord(data) || Object.keys(data).length !== 5
    || data.kind !== 'artifact-action'
    || typeof data.artifactId !== 'string' || data.artifactId !== artifactId
    || typeof data.revision !== 'number' || !Number.isSafeInteger(data.revision)
    || data.revision < 1 || data.revision !== revision
    || typeof data.action !== 'string' || data.action.length === 0
    || !isJsonValue(data.payload)) return null
  const serialized = JSON.stringify(data)
  if (new TextEncoder().encode(serialized).byteLength > ARTIFACT_ACTION_MAX_BYTES) return null
  return { artifactId, revision: data.revision, action: data.action, payload: data.payload }
}

/**
 * Validate one local-only Artifact state report; source ownership is checked by the comparison host.
 * @param data - Candidate postMessage value.
 * @returns The validated state message, or null when it is malformed or oversized.
 */
export function parseArtifactState(data: unknown): ArtifactStateMessage | null {
  if (!isRecord(data) || Object.keys(data).length !== 2 || data.kind !== 'artifact-state' || !isJsonValue(data.state)) return null
  const serialized = JSON.stringify(data)
  if (new TextEncoder().encode(serialized).byteLength > ARTIFACT_ACTION_MAX_BYTES) return null
  return { kind: 'artifact-state', state: data.state }
}
