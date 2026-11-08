/** Strict JSON validation for actions crossing from an opaque Artifact iframe. */
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import type { ArtifactPayload } from './protocol.ts'
import { isBoundedArtifactJson, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES } from '@deepseek-ai/dsh-artifact/runtime-values'

/** Complete serialized message limit in UTF-8 bytes. */
export const ARTIFACT_ACTION_MAX_BYTES = 16_384
/** Maximum nested JSON values, including the payload root. */
export const ARTIFACT_ACTION_MAX_DEPTH = ARTIFACT_JSON_MAX_DEPTH
/** Maximum JSON values visited in one payload, including arrays, objects, and primitives. */
export const ARTIFACT_ACTION_MAX_NODES = ARTIFACT_JSON_MAX_NODES

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

/**
 * Validate bounded plain JSON without recursive call-stack growth.
 * @param value - Candidate iframe payload or complete runtime message.
 * @returns Whether every value satisfies the shared JSON depth and node limits.
 */
export function isArtifactJsonValue(value: unknown): value is ArtifactPayload {
  return isBoundedArtifactJson(value, ARTIFACT_ACTION_MAX_DEPTH, ARTIFACT_ACTION_MAX_NODES)
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
    || !isArtifactJsonValue(data.payload)) return null
  const serialized = JSON.stringify(data)
  if (new TextEncoder().encode(serialized).byteLength > ARTIFACT_ACTION_MAX_BYTES) return null
  return { artifactId, revision: data.revision, action: data.action, payload: data.payload }
}
