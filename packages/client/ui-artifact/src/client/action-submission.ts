/** One transient, identity-stable Artifact action operation shared by native, iframe and current-comparison surfaces. */
import { useEffect, useRef, useState } from 'react'
import type { ArtifactActionRequest } from '@agentrans/artifact/types'
import { randomUUID } from '@agentrans/util-crypto'
import { deepFreeze } from '@agentrans/util-values'
import { ArtifactActionRequestError, type ArtifactActionFailure, type RecordArtifactAction } from './protocol.ts'

/** Complete local submission state; retained request data never follows later program or source changes. */
export type ArtifactActionSubmissionState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'sent' }
  | { readonly phase: 'sending'; readonly request: ArtifactActionRequest }
  | { readonly phase: 'unknown' | 'rejected'; readonly request: ArtifactActionRequest; readonly failure: ArtifactActionFailure }

/** Narrow callbacks over the single operation owner. */
export interface ArtifactActionSubmission {
  readonly state: ArtifactActionSubmissionState
  readonly pending: boolean
  readonly record: RecordArtifactAction
  readonly begin: (...args: Parameters<RecordArtifactAction>) => Promise<ArtifactActionRequest | undefined>
  readonly retry: () => Promise<ArtifactActionRequest | undefined>
  readonly dismiss: () => void
}

/**
 * Capture one action before sending and contain failures for every component using it.
 * @param submit - Session-scoped stable admission adapter, not a renderer's latest analysis reader.
 * @returns Local feedback and explicit start/retry/dismiss callbacks; unknown retries preserve every original value.
 */
export function useArtifactActionSubmission(submit: RecordArtifactAction): ArtifactActionSubmission {
  const owner = useRef<{ state: ArtifactActionSubmissionState; closed: boolean }>({ state: { phase: 'idle' }, closed: false })
  const [state, publish] = useState(owner.current.state)
  useEffect(() => { owner.current.closed = false; return () => { owner.current.closed = true } }, [])
  const update = (next: ArtifactActionSubmissionState): void => {
    // The controller owns synchronous admission; React publishes this same immutable value for rendering.
    owner.current.state = next
    if (!owner.current.closed) publish(next)
  }
  const send = async (request: ArtifactActionRequest, previouslyUnknown: boolean): Promise<ArtifactActionRequest | undefined> => {
    update({ phase: 'sending', request })
    try {
      await submit(request.artifactId, request.revision, request.action, request.payload, request.wake, request.requestId)
      update({ phase: 'sent' })
      return request
    } catch (error) {
      const failure = error instanceof ArtifactActionRequestError ? error.failure : 'unknown'
      const uncertain = failure === 'unknown' || previouslyUnknown && failure !== 'conflict'
      update({ phase: uncertain ? 'unknown' : 'rejected', request, failure })
      return undefined
    }
  }
  const begin: ArtifactActionSubmission['begin'] = async (artifactId, revision, action, payload, wake, requestId) => {
    const current = owner.current.state
    if (owner.current.closed || current.phase === 'sending' || current.phase === 'unknown') return undefined
    const request = deepFreeze(structuredClone({
      requestId: requestId ?? randomUUID() as ArtifactActionRequest['requestId'], artifactId, revision, action, payload, wake,
    }))
    return send(request, false)
  }
  return {
    state,
    pending: state.phase === 'sending' || state.phase === 'unknown',
    record: async (...args) => { await begin(...args) },
    begin,
    retry: async () => {
      const current = owner.current.state
      if (owner.current.closed || current.phase !== 'unknown') return undefined
      return send(current.request, true)
    },
    dismiss: () => {
      if (!owner.current.closed && owner.current.state.phase !== 'sending') update({ phase: 'idle' })
    },
  }
}
