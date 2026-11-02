import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_ACTION_MAX_BYTES, ARTIFACT_ACTION_MAX_DEPTH, ARTIFACT_ACTION_MAX_NODES, parseArtifactAction,
} from '../src/client/messages.ts'
import type { ArtifactId } from '../src/client/protocol.ts'

const id = 'a' as ArtifactId
const base = () => ({ kind: 'artifact-action', artifactId: id, revision: 2, action: 'approve', payload: { value: 1 } })
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

function nested(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let current = root
  for (let level = 1; level < depth; level += 1) {
    const child: Record<string, unknown> = {}
    current.child = child
    current = child
  }
  return root
}

describe('parseArtifactAction', () => {
  it('accepts the exact schema with nested JSON and repeated references', () => {
    const shared = { selected: ['a', true, null, 1.5] }
    const message = { ...base(), payload: { first: shared, second: shared } }
    expect(parseArtifactAction(message, id, 2)).toEqual({
      artifactId: 'a', revision: 2, action: 'approve', payload: message.payload,
    })
    expect(parseArtifactAction({ ...base(), payload: null }, id, 2)?.payload).toBeNull()
  })

  it.each([
    null, [], 'message',
    { ...base(), kind: 'other' },
    { ...base(), artifactId: 'b' },
    { ...base(), revision: 1 },
    { ...base(), revision: 0 },
    { ...base(), revision: 1.5 },
    { ...base(), revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...base(), action: '' },
    { ...base(), action: 1 },
    { ...base(), payload: undefined },
    { ...base(), payload: Number.NaN },
    { ...base(), payload: Number.POSITIVE_INFINITY },
    { ...base(), payload: () => true },
    { ...base(), payload: 1n },
    { ...base(), payload: new Date(0) },
    { ...base(), payload: new Map() },
    { ...base(), extra: true },
  ])('rejects malformed identities, schema, and non-JSON payloads %#', (message) => {
    expect(parseArtifactAction(message, id, 2)).toBeNull()
  })

  it('rejects cyclic payloads without recursive traversal', () => {
    const payload: { self?: unknown } = {}
    payload.self = payload
    expect(parseArtifactAction({ ...base(), payload }, id, 2)).toBeNull()
  })

  it('accepts the exact depth and node limits and rejects one level or node more', () => {
    expect(parseArtifactAction({ ...base(), payload: nested(ARTIFACT_ACTION_MAX_DEPTH) }, id, 2)).not.toBeNull()
    expect(parseArtifactAction({ ...base(), payload: nested(ARTIFACT_ACTION_MAX_DEPTH + 1) }, id, 2)).toBeNull()
    const atNodeLimit = Array.from({ length: ARTIFACT_ACTION_MAX_NODES - 1 }, () => null)
    const overNodeLimit = Array.from({ length: ARTIFACT_ACTION_MAX_NODES }, () => null)
    expect(parseArtifactAction({ ...base(), payload: atNodeLimit }, id, 2)).not.toBeNull()
    expect(parseArtifactAction({ ...base(), payload: overNodeLimit }, id, 2)).toBeNull()
  })

  it('accepts the exact UTF-8 byte limit and rejects one byte more', () => {
    const empty = { ...base(), payload: '' }
    const remaining = ARTIFACT_ACTION_MAX_BYTES - bytes(empty)
    const exact = { ...base(), payload: 'a'.repeat(remaining) }
    expect(bytes(exact)).toBe(ARTIFACT_ACTION_MAX_BYTES)
    expect(parseArtifactAction(exact, id, 2)).not.toBeNull()
    expect(parseArtifactAction({ ...base(), payload: 'a'.repeat(remaining + 1) }, id, 2)).toBeNull()
    expect(parseArtifactAction({ ...base(), payload: '😀'.repeat(5000) }, id, 2)).toBeNull()
  })
})
