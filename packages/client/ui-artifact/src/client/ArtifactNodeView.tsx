/** Isolated Artifact preview, source inspection, and confirmed action delivery. */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsStore } from '@deepseek-ai/dsh-client-store'
import { Button, IconBranchOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { createArtifactDocument } from './document.ts'
import { FlowchartView } from './FlowchartView.tsx'
import { FunctionPlotView } from './FunctionPlotView.tsx'
import { buildSceneAnimationHtml } from './scene-animation.ts'
import { parseArtifactAction, type PendingArtifactAction } from './messages.ts'
import { artifactPresentationStore, type ArtifactDockEntry } from './presentation.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ArtifactNodeInjected, ArtifactPlacement, ArtifactSnapshot, ViewRequest } from './protocol.ts'
import css from './ArtifactNodeView.module.css'

type ArtifactNodeViewProps =
  PropsRuntime<'conversation.chat.node', 'artifact'>
  & PropsLocale<'artifact'>
  & PropsStore<typeof artifactPresentationStore>
  & InjectFace<ArtifactNodeInjected>

export type SceneOrigin =
  | { readonly kind: 'current' }
  | { readonly kind: 'branch'; readonly title: string }

type ArtifactCardProps = Pick<ArtifactNodeViewProps, 'recordAction' | 't'> & {
  readonly snapshot: ArtifactSnapshot
  readonly origin: SceneOrigin
  readonly placement: ArtifactPlacement
  readonly placementControls?: boolean
  readonly docks?: readonly ArtifactDockEntry[]
  readonly activeDockId?: ArtifactSnapshot['artifactId'] | null
  readonly onPlacement?: (next: ArtifactPlacement) => void
  readonly onActivateDock?: (artifactId: ArtifactSnapshot['artifactId']) => void
  readonly onCloseDock?: (artifactId: ArtifactSnapshot['artifactId']) => void
  readonly onBranch?: () => void
  readonly onSceneState?: (state: JsonValue) => void
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

/** Pure Artifact surface: placement, dock tabs, and confirmation UI arrive as plain props. */
export function ArtifactCard({
  snapshot, origin, recordAction, t, placement, placementControls = true,
  docks = [], activeDockId = null, onPlacement, onActivateDock, onCloseDock, onBranch, onSceneState, onFrame,
}: ArtifactCardProps) {
  const [showSource, setShowSource] = useState(false)
  const [{ actions: pendingActions, overflow }, dispatchPending] = useReducer(updatePending, { actions: [], overflow: false })
  const [phase, setPhase] = useState<SendPhase>('idle')
  const [dockTop, setDockTop] = useState<number>()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const cardRef = useRef<HTMLElement | null>(null)
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
      // Another docked Artifact may still own the pane; only the last one
      // releases the reserved width. This card's own section is about to
      // move, so it must not count as another owner.
      const others = [...document.querySelectorAll('section[data-placement="beside"]')]
        .some(element => element !== cardRef.current)
      if (!others) body.removeAttribute('data-artifact-dock')
    }
  }, [placement, placementControls])

  // Escape leaves the full-screen view without closing the Artifact.
  useEffect(() => {
    if (!placementControls || placement !== 'focus') return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onPlacement?.('inline')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [placement, placementControls, onPlacement])

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

  // A docked but backgrounded Artifact stays mounted and keeps its preview
  // state; only the active tab is painted.
  const backgrounded = placementControls && placement === 'beside' && activeDockId !== snapshot.artifactId

  const card = (
    <section
      ref={cardRef}
      className={css.card}
      hidden={backgrounded}
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
              onClick={() => { onPlacement?.(option) }}>
              {t(PLACEMENT_COPY[option])}
            </Button>
          ))}
          <span className={css.rule} aria-hidden="true" />
          <Button size="sm" variant="ghost" className={css.placement} aria-pressed={showSource}
            onClick={() => { setShowSource(value => !value) }}>
            {showSource ? t('view.preview') : t('view.source')}
          </Button>
          {placementControls && snapshot.format === 'scene' && (
            <Button size="sm" variant="ghost" className={css.placement} aria-label={t('action.exportAnimation')}
              onClick={() => {
                const blob = new Blob([buildSceneAnimationHtml(snapshot.spec, snapshot.title)], { type: 'text/html' })
                const url = URL.createObjectURL(blob)
                const anchor = document.createElement('a')
                anchor.href = url
                anchor.download = `${snapshot.artifactId}-animation.html`
                anchor.click()
                URL.revokeObjectURL(url)
              }}>
              {t('action.exportAnimation')}
            </Button>
          )}
          {placementControls && onBranch !== undefined && (
            <Tooltip label={t('action.branch')} portal>
              <Button size="sm" variant="ghost" className={css.placement} aria-label={t('action.branch')}
                onClick={onBranch}>
                <IconBranchOutlineRegular size={14} />
              </Button>
            </Tooltip>
          )}
        </div>
      </header>
      {placementControls && placement === 'beside' && !backgrounded && docks.length > 1 && (
        <div className={css.dockTabs} role="group" aria-label={t('dock.tabs')}>
          {docks.map(entry => (
            <span key={entry.artifactId} className={css.dockTab} data-active={entry.artifactId === snapshot.artifactId ? '' : undefined}>
              <button type="button" className={css.dockTabSelect} aria-pressed={entry.artifactId === snapshot.artifactId}
                onClick={() => { onActivateDock?.(entry.artifactId) }}>{entry.title}</button>
              <button type="button" className={css.dockTabClose} aria-label={t('dock.close', { title: entry.title })}
                onClick={() => { onCloseDock?.(entry.artifactId) }}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className={css.body}>
        {showSource
          ? <pre className={css.source} aria-label={t('source.label')}>{snapshot.format === 'html' ? snapshot.source : JSON.stringify(snapshot.spec, null, 2)}</pre>
          : snapshot.format === 'scene'
            ? snapshot.spec.kind === 'flowchart'
              ? <FlowchartView spec={snapshot.spec} artifactId={snapshot.artifactId} revision={snapshot.revision}
                placement={placementControls ? placement : 'inline'} recordAction={recordAction} onStateChange={onSceneState} t={t} />
              : <FunctionPlotView spec={snapshot.spec} artifactId={snapshot.artifactId} revision={snapshot.revision}
                placement={placementControls ? placement : 'inline'} recordAction={recordAction} onStateChange={onSceneState} t={t} />
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

/** Connect one Artifact Conversation Node to the Session's presentation store. */
export const ArtifactNodeView = memo(function ArtifactNodeView({
  node, sessionId, useSessions, useStore, actions, recordAction, forkAt, t,
}: ArtifactNodeViewProps) {
  const snapshot = node.data
  const artifactId = snapshot.artifactId
  const origin = useSessions((state): SceneOrigin => {
    const current = state.byId[sessionId]
    if (current?.parentId === undefined) return { kind: 'current' }
    const parent = state.byId[current.parentId]
    return { kind: 'branch', title: parent?.displayTitle ?? current.parentId }
  })
  const placement = useStore((state): ArtifactPlacement => {
    if (state.focusId === artifactId) return 'focus'
    if (state.floatId === artifactId) return 'pip'
    if (state.docks.some(entry => entry.artifactId === artifactId)) return 'beside'
    return 'inline'
  })
  const docks = useStore(state => state.docks)
  const activeDockId = useStore(state => state.activeDockId)

  const running = useSessions(state => state.byId[sessionId]?.running === true)

  // A restored checkpoint never takes over the window: only a live turn may
  // request the expanded presentation.
  useEffect(() => {
    if (running && snapshot.presentation === 'focus') actions.focus(artifactId)
  }, [])

  // Dock tabs follow the checkpoint they show, including a new revision.
  useEffect(() => {
    actions.syncDock({ artifactId, revision: snapshot.revision, title: snapshot.title })
  }, [actions, artifactId, snapshot.revision, snapshot.title])

  // Unmounting the Node (Session switch or Node removal) releases its surfaces.
  useEffect(() => () => { actions.inline(artifactId) }, [actions, artifactId])

  const onPlacement = useCallback((next: ArtifactPlacement): void => {
    switch (next) {
      case 'inline': actions.inline(artifactId); break
      case 'beside': actions.dock({ artifactId, revision: snapshot.revision, title: snapshot.title }); break
      case 'focus': actions.focus(artifactId); break
      case 'pip': actions.float(artifactId); break
    }
  }, [actions, artifactId, snapshot.revision, snapshot.title])

  return (
    <ArtifactCard
      key={`${artifactId}:${snapshot.revision}`}
      snapshot={snapshot}
      origin={origin}
      placement={placement}
      docks={docks}
      activeDockId={activeDockId}
      onPlacement={onPlacement}
      onActivateDock={actions.activateDock}
      onCloseDock={actions.undock}
      onBranch={() => { forkAt(node.anchorSeq) }}
      recordAction={recordAction}
      t={t}
    />
  )
})
