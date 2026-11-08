/** Desktop API-key setup; credentials and external navigation stay in the preload. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { WelcomeApi } from '../welcome-api.ts'

type Failure = 'blank' | 'invalid' | 'save' | 'skip' | 'link'

/**
 * Render API-key setup with shell-owned save, skip, and fixed external navigation operations.
 * @param props.api - isolated preload API; no credential is sent to a renderer network request.
 * @returns the localized setup form and continuation actions.
 */
export function Welcome({ api }: { api: WelcomeApi }) {
  const { messages: m } = api
  const [draft, setDraft] = useState('')
  const [failure, setFailure] = useState<Failure>()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    mounted.current = true
    document.documentElement.lang = api.id
    document.title = m.welcomeTitle
    input.current?.focus()
    return () => { mounted.current = false }
  }, [api.id, m.welcomeTitle])

  function isMounted() { return mounted.current }

  async function reportSaveClick() {
    try { await api.analytics?.('api_key_save_click', {}) }
    catch (_collectionFailure: unknown) {
      // Optional collection failures must not interrupt credential setup.
    }
  }

  async function saveKey(event: FormEvent) {
    event.preventDefault()
    if (busyRef.current || !isMounted()) return
    void reportSaveClick()
    const value = draft.trim()
    if (!/^[\x21-\x7e]+$/.test(value) || /^[A-Z][A-Z0-9_]*=[^=]/.test(value)
      || ((value.startsWith('"') || value.startsWith("'") || value.charCodeAt(0) === 96) && value.at(-1) === value[0])) {
      setFailure(value === '' ? 'blank' : 'invalid')
      input.current?.focus()
      return
    }
    busyRef.current = true
    setBusy(true)
    setFailure(undefined)
    try {
      const result = await api.saveApiKey(value)
      if (!mounted.current) return
      if (result.ok) setDraft('')
      else setFailure('save')
    } catch {
      if (mounted.current) setFailure('save')
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function skip() {
    if (busyRef.current || !isMounted()) return
    busyRef.current = true
    setBusy(true)
    setFailure(undefined)
    try {
      await api.skip()
      if (mounted.current) setDraft('')
    } catch {
      if (mounted.current) setFailure('skip')
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function openKeyPage() {
    if (busyRef.current || !isMounted()) return
    busyRef.current = true
    setBusy(true)
    setFailure(undefined)
    try { await api.openApiKeyPage() }
    catch {
      if (mounted.current) setFailure('link')
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const errors = {
    blank: m.welcomeKeyBlank, invalid: m.welcomeKeyInvalid, save: m.welcomeKeyFailed,
    skip: m.welcomeContinueFailed, link: m.welcomeKeyLinkFailed,
  }
  const error = failure === undefined ? '' : errors[failure]

  return <>
    <div className="titlebar" aria-hidden="true" />
    <main className="welcome" aria-labelledby="key-title">
      <div className="brand">{m.welcomeBrand}</div>
      <form id="key-form" className="key-form" noValidate onSubmit={(event) => { void saveKey(event) }} aria-busy={busy}>
        <header className="key-heading"><h1 id="key-title">{m.welcomeKeyTitle}</h1><p id="key-description">{m.welcomeKeyDescription}</p></header>
        <div className="key-field">
          <label className="visually-hidden" htmlFor="key-input">{m.welcomeKeyPlaceholder}</label>
          <input ref={input} id="key-input" type="password" autoComplete="new-password" autoCapitalize="off" spellCheck={false} required
            aria-describedby="key-description key-error" aria-invalid={failure === 'blank' || failure === 'invalid'} placeholder={m.welcomeKeyPlaceholder}
            value={draft} disabled={busy} onChange={(event) => { setDraft(event.target.value); setFailure(undefined) }} />
          <button id="get-key" className="key-link" type="button" disabled={busy} onClick={() => { void openKeyPage() }}>{m.welcomeKeyGet}</button>
          <p id="key-error" className="key-error" role="alert" hidden={error === ''}>{error}</p>
        </div>
      </form>
      <div id="key-actions" className="actions">
        <button id="save-key" className="primary" type="submit" form="key-form" disabled={busy || draft.trim() === ''}>{m.welcomeKeySave}</button>
        <button id="skip-key" className="secondary" type="button" disabled={busy} onClick={() => { void skip() }}>{m.welcomeKeyLater}</button>
      </div>
    </main>
  </>
}
