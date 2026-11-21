/** Per-session Conversation store shared by the shell body and header. */
import { defineStore, type EngineStoreHandle } from '@agentrans/client-store'
import type { SessionId } from '@agentrans/session/types'
import type { SessionRequestId } from '@agentrans/api-session-controller/types'
import { deepEqualJson } from '@agentrans/util-values'
import type { ConversationStoreState } from './contract/views.ts'
import type { DraftInput, DraftSnapshot } from './contract/draft-editor.ts'
import { parseStoredDraft } from './draft.ts'

const CONVERSATION_STORE_KEY = 'dsh.conversation'
const CONTEXT_SUBMISSION_KEY = 'dsh.conversation.prompt'

function initialConversationState(): ConversationStoreState {
  return { draft: '', view: null, viewRequest: null }
}

/**
 * Prepare a new Session's draft before a composer or View binds to it. An empty saved draft is a deliberate state.
 * @param sessionId - Session whose Conversation store entry receives the draft.
 * @param draft - Draft to save when the entry has none.
 * @returns `saved`, `preserved` when the entry already has a draft, or `unavailable` without usable browser storage.
 */
export function writeInitialConversationDraft(sessionId: SessionId, draft: DraftSnapshot): 'saved' | 'preserved' | 'unavailable' {
  if (typeof localStorage === 'undefined') return 'unavailable'
  try {
    const key = `${CONVERSATION_STORE_KEY}.${sessionId}`
    const raw = localStorage.getItem(key)
    const value: unknown = raw === null ? undefined : JSON.parse(raw)
    const stored = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
    if ('draft' in stored) return 'preserved'
    localStorage.setItem(key, JSON.stringify({ ...initialConversationState(), ...stored, draft }))
    return 'saved'
  } catch {
    return 'unavailable'
  }
}

interface ContextSubmissionMarker {
  readonly requestId: SessionRequestId
  readonly digest: string
}

function contextSubmissionKey(sessionId: SessionId, kind: string): string {
  return `${CONTEXT_SUBMISSION_KEY}.${sessionId}.${kind}`
}

/**
 * Fingerprint the semantic draft without saving a second copy of its text or references.
 * @param draft - Draft whose object keys are sorted before hashing.
 * @returns Lowercase hexadecimal SHA-256 digest, or `undefined` without Web Crypto.
 */
export async function draftFingerprint(draft: DraftSnapshot): Promise<string | undefined> {
  if (typeof crypto === 'undefined' || typeof crypto.subtle === 'undefined') return undefined
  const normalized = JSON.stringify(draft, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, (value as Record<string, unknown>)[key]]))
  })
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('')
}

/**
 * Save the request correlation before dispatch, without putting attachment data in browser storage.
 * @param sessionId - Session receiving the prompt.
 * @param kind - Context provider that owns the marker.
 * @param marker - Request ID and draft digest of the dispatched prompt.
 */
export function recordContextSubmission(sessionId: SessionId, kind: string, marker: ContextSubmissionMarker): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(contextSubmissionKey(sessionId, kind), JSON.stringify(marker)) } catch (_error) {
    // Draft persistence may be unavailable in this browser.
  }
}

/**
 * Read a previous submission marker scoped to one context provider and Session.
 * @param sessionId - Session that received the prompt.
 * @param kind - Context provider that owns the marker.
 * @returns The stored marker, or `undefined` when absent, malformed or unreadable.
 */
export function readContextSubmission(sessionId: SessionId, kind: string): ContextSubmissionMarker | undefined {
  if (typeof localStorage === 'undefined') return undefined
  try {
    const raw = localStorage.getItem(contextSubmissionKey(sessionId, kind))
    if (raw === null) return undefined
    const marker: unknown = JSON.parse(raw)
    if (typeof marker !== 'object' || marker === null || !('requestId' in marker) || !('digest' in marker)
      || typeof marker.requestId !== 'string' || typeof marker.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(marker.digest)) return undefined
    return { requestId: marker.requestId as SessionRequestId, digest: marker.digest }
  } catch (_error) { return undefined }
}

/**
 * Finish a confirmed recovery without clearing another tab's edited draft or newer submission.
 * @param sessionId - Session that received the prompt.
 * @param kind - Context provider that owns the marker.
 * @param marker - Marker of the confirmed prompt; a different stored marker is left in place.
 * @param matchingDraft - Draft that was sent; the stored draft is cleared only while it still equals this value.
 * @returns Whether the stored draft was cleared.
 */
export function finishContextSubmission(sessionId: SessionId, kind: string, marker: ContextSubmissionMarker,
  matchingDraft: DraftSnapshot | undefined): boolean {
  try {
    const current = readContextSubmission(sessionId, kind)
    if (current?.requestId !== marker.requestId || current.digest !== marker.digest) return false
    let cleared = false
    if (matchingDraft !== undefined) {
      const key = `${CONVERSATION_STORE_KEY}.${sessionId}`
      const raw = localStorage.getItem(key)
      const stored: unknown = raw === null ? undefined : JSON.parse(raw)
      if (typeof stored === 'object' && stored !== null && 'draft' in stored && deepEqualJson(parseStoredDraft(stored.draft), matchingDraft)) {
        localStorage.setItem(key, JSON.stringify({ ...stored, draft: '' }))
        cleared = true
      }
    }
    localStorage.removeItem(contextSubmissionKey(sessionId, kind))
    return cleared
  } catch (_error) { return false }
}

/** Declared write set for the Conversation shell. */
type ConversationActions = {
  setDraft: (draft: ConversationStoreState, text: DraftInput) => void
  setView: (draft: ConversationStoreState, view: string) => void
  openView: (draft: ConversationStoreState, view: string, focus: string) => void
  completeViewRequest: (draft: ConversationStoreState) => void
}

/**
 * Declare per-session draft persistence and View selection.
 * @returns the store handle.
 */
export function createConversationStore(): EngineStoreHandle<ConversationStoreState, ConversationActions> {
  return defineStore({
    init: initialConversationState,
    persist: CONVERSATION_STORE_KEY,
    actions: {
      setDraft: (d, text: DraftInput) => { d.draft = text },
      setView: (d, view: string) => { d.view = view },
      openView: (d, view: string, focus: string) => {
        d.view = view
        d.viewRequest = { view, focus }
      },
      completeViewRequest: (d) => { d.viewRequest = null },
    },
  })
}

/**
 * Read a Session's draft before its input source is published to React.
 * @param sessionId - Session-scoped persistence suffix.
 * @returns saved semantic content, or an empty document when storage is absent or invalid.
 */
export function readConversationDraft(sessionId: SessionId): DraftSnapshot {
  const empty: DraftSnapshot = { text: '', references: [] }
  if (typeof localStorage === 'undefined') return empty
  try {
    const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return empty
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null || !('draft' in stored)) return empty
    return parseStoredDraft(stored.draft) ?? empty
  } catch (_error: unknown) {
    // Unavailable browser storage or malformed JSON has no usable saved draft.
    return empty
  }
}

/**
 * Read the persisted View preference before the Slot store is materialized.
 * @param sessionId - Session-scoped persistence suffix.
 * @returns the preferred View id, or null when storage has no usable value.
 */
export function readConversationViewPreference(sessionId: SessionId): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return null
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null || !('view' in stored)) return null
    return typeof stored.view === 'string' ? stored.view : null
  } catch {
    return null
  }
}
