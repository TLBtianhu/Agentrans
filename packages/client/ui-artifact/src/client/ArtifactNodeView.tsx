/** Isolated Artifact preview, source inspection, and confirmed action delivery. */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { createArtifactDocument } from './document.ts'
import { FunctionPlotView } from './FunctionPlotView.tsx'
import { parseArtifactAction, type PendingArtifactAction } from './messages.ts'
import type { ArtifactNodeInjected, ArtifactPlacement, ArtifactSnapshot, ViewRequest } from './protocol.ts'
import css from './ArtifactNodeView.module.css'

type ArtifactNodeViewProps =
  PropsRuntime<'conversation.chat.node', 'artifact'>
  & PropsLocale<'artifact'>
  & InjectFace<ArtifactNodeInjected>

export type SceneOrigin =
  | { readonly kind: 'current' }
  | { readonly kind: 'branch'; readonly title: string }

type ArtifactCardProps = Pick<ArtifactNodeViewProps, 'recordAction' | 't'> & {
  readonly snapshot: ArtifactSnapshot
  readonly origin: SceneOrigin
  readonly placementControls?: boolean
  readonly onFrame?: (frame: HTMLIFrameElement | null) => void
}

type SendPhase = 'idle' | 'sending' | 'failed'

const PENDING_ACTION_LIMIT = 32

const PLACEMENTS: readonly ViewRequest['placement'][] = ['inline', 'beside', 'focus', 'pip']
const PLACEMENT_COPY: Record<ArtifactPlacement, 'view.inline' | 'view.beside' | 'view.focus' | 'view.pip'> = {
  inline: 'view.inline', beside: 'view.beside', focus: 'view.focus', pip: 'view.pip',
}

interface PendingState {
  readonly actions: readonly PendingArtifactAction[]
  readonly overflow: boolean
}

type PendingUpdate =
  | { readonly kind: 'enqueue'; readonly action: PendingArtifactAction }
  | { readonly kind: 'sent'; readonly action: PendingArtifactAction }

function updatePending(state: PendingState, update: PendingUpdate): PendingState {
  if (update.kind === 'sent') {
    const actions = state.actions.filter(action => action !== update.action)
    return { actions, overflow: false }
  }
  if (state.actions.length >= PENDING_ACTION_LIMIT) return { ...state, overflow: true }
  return { actions: [...state.actions, update.action], overflow: state.overflow }
}

export function ArtifactCard({ snapshot, origin, recordAction, t, placementControls = true, onFrame }: ArtifactCardProps) {
  const [placement, setPlacement] = useState<ViewRequest['placement']>(snapshot.presentation === 'focus' ? 'focus' : 'inline')
  const [showSource, setShowSource] = useState(false)
  const [{ actions: pendingActions, overflow }, dispatchPending] = useReducer(updatePending, { actions: [], overflow: false })
  const [phase, setPhase] = useState<SendPhase>('idle')
  const [dockTop, setDockTop] = useState<number>()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const returnedRef = useRef(false)
  const mountedRef = useRef(true)
  const sendingRef = useRef(false)
  const artifactDocument = useMemo(() => snapshot.format === 'html' ? createArtifactDocument(snapshot.source) : '', [snapshot])
  const setFrame = useCallback((element: HTMLIFrameElement | null): void => {
    iframeRef.current = element
    onFrame?.(element)
  }, [onFrame])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // A docked Artifact owns the right edge of the conversation body: the same
  // body reserves that width and reports its top so the Session header keeps
  // its full width above the pane. This is a layout measurement that CSS
  // cannot express (the pane is portalled outside the header's subtree), and
  // it runs before paint so the pane never appears at the viewport top first.
  useLayoutEffect(() => {
    if (!placementControls || placement !== 'beside') {
      setDockTop(undefined)
      return
    }
    const body = anchorRef.current?.closest<HTMLElement>('[data-conversation-content]')
    if (body === undefined || body === null) return
    body.setAttribute('data-artifact-dock', '')
    const measure = (): void => { setDockTop(body.getBoundingClientRect().top) }
    measure()
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(body)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      body.removeAttribute('data-artifact-dock')
    }
  }, [placement, placementControls])

  // Escape leaves the full-screen view without closing the Artifact.
  useEffect(() => {
    if (!placementControls || placement !== 'focus') return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPlacement('inline')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [placement, placementControls])

  // Returning to the flow brings the Artifact's own row back into view; the
  // first render only records that return handling has not been armed yet.
  useEffect(() => {
    if (!placementControls) return
    if (!returnedRef.current) {
      returnedRef.current = true
      return
    }
    const anchor = anchorRef.current
    if (placement === 'inline' && anchor !== null && typeof anchor.scrollIntoView === 'function') {
      anchor.scrollIntoView({ block: 'center' })
    }
  }, [placement, placementControls])

  useEffect(() => {
    if (showSource || snapshot.format !== 'html') return
    const frame = iframeRef.current as HTMLIFrameElement
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frame.contentWindow) return
      const action = parseArtifactAction(event.data, snapshot.artifactId, snapshot.revision)
      if (action === null) return
      dispatchPending({ kind: 'enqueue', action })
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [showSource, snapshot.artifactId, snapshot.revision, snapshot.format])

  const pending = pendingActions[0]
  const send = async (submitted: PendingArtifactAction): Promise<void> => {
    if (sendingRef.current) return
    sendingRef.current = true
    setPhase('sending')
    try {
      await recordAction(submitted.artifactId, submitted.revision, submitted.action, submitted.payload, true)
      if (mountedRef.current) {
        dispatchPending({ kind: 'sent', action: submitted })
        setPhase('idle')
      }
    } catch {
      if (mountedRef.current) setPhase('failed')
    } finally {
      sendingRef.current = false
    }
  }

  const card = (
    <section
      className={css.card}
      style={dockTop === undefined ? undefined : { '--artifact-dock-top': `${String(dockTop)}px` } as CSSProperties}
      data-placement={placementControls ? placement : 'inline'}
      role={placementControls && placement === 'focus' ? 'dialog' : 'complementary'}
      aria-modal={placementControls && placement === 'focus' ? true : undefined}
      aria-label={t('card.label', { title: snapshot.title })}
    >
      <header className={css.header}>
        <div className={css.heading}>
          <h3 className={css.title}>{snapshot.title}</h3>
          <p className={css.meta}>
            <span>{t('revision', { revision: String(snapshot.revision) })}</span>
            <span className={css.dot} aria-hidden="true" />
            <span>{origin.kind === 'current' ? t('origin.current') : t('origin.branch', { parent: origin.title })}</span>
          </p>
        </div>
        <div className={css.controls} role="group" aria-label={t('view.group')}>
          {placementControls && PLACEMENTS.map(option => (
            <Button key={option} size="sm" variant="ghost" className={css.placement}
              data-selected={placement === option ? '' : undefined}
              aria-pressed={placement === option}
              onClick={() => { setPlacement(option) }}>
              {t(PLACEMENT_COPY[option])}
            </Button>
          ))}
          <span className={css.rule} aria-hidden="true" />
          <Button size="sm" variant="ghost" className={css.placement} aria-pressed={showSource}
            onClick={() => { setShowSource(value => !value) }}>
            {showSource ? t('view.preview') : t('view.source')}
          </Button>
        </div>
      </header>
      <div className={css.body}>
        {showSource
          ? <pre className={css.source} aria-label={t('source.label')}>{snapshot.format === 'html' ? snapshot.source : JSON.stringify(snapshot.spec, null, 2)}</pre>
          : snapshot.format === 'scene'
            ? <FunctionPlotView spec={snapshot.spec} artifactId={snapshot.artifactId} revision={snapshot.revision}
              placement={placementControls ? placement : 'inline'} recordAction={recordAction} t={t} />
            : <iframe ref={setFrame} className={css.frame} srcDoc={artifactDocument} sandbox="allow-scripts"
              title={t('preview.frame', { title: snapshot.title })} data-artifact-frame />}
      </div>
      {pending === undefined ? null : (
        <div className={css.pending}>
          <div>
            <p className={css.pendingAction}>{t('pending.action', { action: pending.action })}</p>
            {pendingActions.length > 1 && <p className={css.pendingCount}>{t('pending.more', { count: String(pendingActions.length) })}</p>}
          </div>
          {overflow && <p className={css.error} role="alert">{t('pending.overflow')}</p>}
          {phase === 'failed' && <p className={css.error} role="alert">{t('send.failed')}</p>}
          <Button size="sm" variant="primary" className={css.send} disabled={phase === 'sending'}
            aria-busy={phase === 'sending'} onClick={() => { void send(pending) }}>
            {phase === 'sending' ? t('send.sending') : phase === 'failed' ? t('send.retry') : t('send.action')}
          </Button>
        </div>
      )}
    </section>
  )
  // Comparison cells share one grid, so only a standalone Artifact owns the
  // flow anchor that docked views return to.
  if (!placementControls) return card
  return (
    <>
      <span ref={anchorRef} className={css.anchor} aria-hidden="true" />
      {placement === 'inline' ? card : createPortal(card, document.body)}
    </>
  )
}

/** Render the latest checkpoint; revision changes remount the browsing context and transient action state. */
export const ArtifactNodeView = memo(function ArtifactNodeView({ node, sessionId, useSessions, recordAction, t }: ArtifactNodeViewProps) {
  const snapshot = node.data
  const origin = useSessions((state): SceneOrigin => {
    const current = state.byId[sessionId]
    if (current?.parentId === undefined) return { kind: 'current' }
    const parent = state.byId[current.parentId]
    return { kind: 'branch', title: parent?.displayTitle ?? current.parentId }
  })
  return <ArtifactCard key={`${snapshot.artifactId}:${snapshot.revision}`} snapshot={snapshot} origin={origin} recordAction={recordAction} t={t} />
})
