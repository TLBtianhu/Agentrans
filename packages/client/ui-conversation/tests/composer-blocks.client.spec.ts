import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@agentrans/session/types'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'

const SESSION = 'blocked-session' as SessionId

describe('ComposerBlockRegistry', () => {
  it('keeps submission held until every independent source releases it', () => {
    const registry = new ComposerBlockRegistry()
    const listener = vi.fn()
    const store = registry.submissionFor(SESSION)
    store.subscribe(listener)

    registry.setSubmission(SESSION, 'artifact', true)
    registry.setSubmission(SESSION, 'other-feature', true)
    registry.setSubmission(SESSION, 'artifact', false)
    expect(store.getSnapshot()).toBe(true)
    expect(registry.storeFor(SESSION).getSnapshot()).toBeUndefined()
    expect(listener).toHaveBeenCalledOnce()

    registry.setSubmission(SESSION, 'other-feature', false)
    expect(store.getSnapshot()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)

    registry.setSubmission(SESSION, 'artifact', true)
    registry.forget(SESSION)
    expect(registry.submissionFor(SESSION).getSnapshot()).toBe(false)
  })

  it('republishes only when the copy changes', () => {
    const registry = new ComposerBlockRegistry()
    const listener = vi.fn()
    const store = registry.storeFor(SESSION)
    store.subscribe(listener)

    registry.set(SESSION, { reason: 'select a model first' })
    expect(store.getSnapshot()).toEqual({ reason: 'select a model first' })
    expect(listener).toHaveBeenCalledTimes(1)

    // Identical copy: no publication at all.
    registry.set(SESSION, { reason: 'select a model first' })
    expect(listener).toHaveBeenCalledTimes(1)

    registry.set(SESSION, undefined)
    expect(store.getSnapshot()).toBeUndefined()

    registry.forget(SESSION)
    expect(registry.storeFor(SESSION).getSnapshot()).toBeUndefined()
  })
})
