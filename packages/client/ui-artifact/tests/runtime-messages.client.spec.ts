import { describe, expect, it } from 'vitest'
import type { ArtifactRuntimeId, ArtifactRuntimeIdentity } from '@deepseek-ai/dsh-artifact-runtime/types'
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import { ARTIFACT_ACTION_MAX_BYTES } from '../src/client/messages.ts'
import { ARTIFACT_RUNTIME_FAILURE_MAX_BYTES, parseArtifactRuntimeMessage } from '../src/client/runtime-messages.ts'

const identity: ArtifactRuntimeIdentity = {
  artifactId: 'runtime-source' as ArtifactId, revision: 2, runtimeId: 'runtime-a' as ArtifactRuntimeId, renderer: 'html',
}
const ready = () => ({ kind: 'artifact-runtime-report', identity, report: { status: 'ready', capabilities: { state: true, commands: ['step'] } } })
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

describe('parseArtifactRuntimeMessage', () => {
  it('accepts exact readiness, state, error and callback-result messages', () => {
    for (const message of [
      ready(),
      { kind: 'artifact-runtime-report', identity, report: { status: 'starting' } },
      { kind: 'artifact-runtime-report', identity, report: { status: 'error', error: { code: 'SCRIPT_ERROR', message: 'Failed' } } },
      { kind: 'artifact-runtime-state', identity, state: { selected: 'a', time: 2, visible: true } },
      { kind: 'artifact-runtime-command-result', identity, requestId: 'request-a', result: { ok: true } },
      { kind: 'artifact-runtime-command-result', identity, requestId: 'request-a', result: { ok: false, error: { code: 'COMMAND_FAILED', message: 'Failed' } } },
    ]) expect(parseArtifactRuntimeMessage(message, identity)).toEqual(message)
  })

  it.each([
    { artifactId: 'another-source' }, { revision: 1 }, { runtimeId: 'runtime-old' }, { renderer: 'native' },
    { extra: true },
  ])('rejects a different source, revision or physical runtime %#', (difference) => {
    expect(parseArtifactRuntimeMessage({ ...ready(), identity: { ...identity, ...difference } }, identity)).toBeNull()
  })

  it.each([
    null, [], { kind: 'artifact-state', state: {} }, { ...ready(), extra: true },
    { ...ready(), report: { status: 'ready', capabilities: { state: true, commands: ['step', 'step'] } } },
    { ...ready(), report: { status: 'ready', capabilities: { state: true, commands: ['seek'] } } },
    { ...ready(), report: { status: 'ready', capabilities: { state: 'yes', commands: [] } } },
    { ...ready(), report: { status: 'ready', capabilities: { state: true, commands: [], save: true } } },
    { ...ready(), report: { status: 'starting', capabilities: { state: true, commands: [] } } },
    { ...ready(), report: { status: 'error', error: { code: 'bad code', message: 'Failed' } } },
    { kind: 'artifact-runtime-state', identity, state: { value: Number.NaN } },
    { kind: 'artifact-runtime-state', identity, state: new Date(0) },
    { kind: 'artifact-runtime-command-result', identity, requestId: '', result: { ok: true } },
    { kind: 'artifact-runtime-command-result', identity, requestId: 'x'.repeat(129), result: { ok: true } },
    { kind: 'artifact-runtime-command-result', identity, requestId: 'r', result: { ok: true, error: { code: 'FAILED', message: '' } } },
  ])('rejects malformed declarations and non-JSON values %#', (value) => {
    expect(parseArtifactRuntimeMessage(value, identity)).toBeNull()
  })

  it('enforces complete UTF-8 message and diagnostic bounds', () => {
    const empty = { kind: 'artifact-runtime-state', identity, state: '' }
    const exact = { ...empty, state: 'a'.repeat(ARTIFACT_ACTION_MAX_BYTES - bytes(empty)) }
    expect(bytes(exact)).toBe(ARTIFACT_ACTION_MAX_BYTES)
    expect(parseArtifactRuntimeMessage(exact, identity)).toEqual(exact)
    expect(parseArtifactRuntimeMessage({ ...exact, state: exact.state + 'a' }, identity)).toBeNull()
    expect(parseArtifactRuntimeMessage({ ...empty, state: '😀'.repeat(5000) }, identity)).toBeNull()

    const error = { code: 'SCRIPT_ERROR', message: '' }
    const exactError = { ...error, message: 'a'.repeat(ARTIFACT_RUNTIME_FAILURE_MAX_BYTES - bytes(error)) }
    expect(bytes(exactError)).toBe(ARTIFACT_RUNTIME_FAILURE_MAX_BYTES)
    const message = { ...ready(), report: { status: 'error', error: exactError } }
    expect(parseArtifactRuntimeMessage(message, identity)).toEqual(message)
    expect(parseArtifactRuntimeMessage({ ...message, report: { status: 'error', error: { ...exactError, message: exactError.message + 'a' } } }, identity)).toBeNull()
  })

  it('rejects cycles, excessive depth and excessive node counts', () => {
    const state: { self?: unknown } = {}
    state.self = state
    expect(parseArtifactRuntimeMessage({ kind: 'artifact-runtime-state', identity, state }, identity)).toBeNull()
    let nested: unknown = null
    for (let level = 0; level < 40; level++) nested = { nested }
    expect(parseArtifactRuntimeMessage({ kind: 'artifact-runtime-state', identity, state: nested }, identity)).toBeNull()
    expect(parseArtifactRuntimeMessage({ kind: 'artifact-runtime-state', identity, state: Array.from({ length: 2048 }, () => null) }, identity)).toBeNull()
  })
})
