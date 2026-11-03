/** Isolated Artifact preview, source inspection, and confirmed action delivery. */
import { memo, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { createArtifactDocument } from './document.ts'
import { parseArtifactAction, type PendingArtifactAction } from './messages.ts'
import type { ArtifactNodeInjected, ArtifactPlacement, ArtifactSnapshot, ViewRequest } from './protocol.ts'
import css from './ArtifactNodeView.module.css'

type ArtifactNodeViewProps =
  PropsRuntime<'conversation.chat.node', 'artifact'>
  & PropsLocale<'artifact'>
  & InjectFace<ArtifactNodeInjected>

type ArtifactCardProps = Pick<ArtifactNodeViewProps, 'recordAction' | 't'> & {
  readonly snapshot: ArtifactSnapshot
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

function ArtifactCard({ snapshot, recordAction, t }: ArtifactCardProps) {
  const [placement, setPlacement] = useState<ViewRequest['placement']>(snapshot.presentation === 'focus' ? 'focus' : 'inline')
  const [showSource, setShowSource] = useState(false)
  const [{ actions: pendingActions, overflow }, dispatchPending] = useReducer(updatePending, { actions: [], overflow: false })
  const [phase, setPhase] = useState<SendPhase>('idle')
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const sceneRef = useRef<HTMLElement>(null)
  const mountedRef = useRef(true)
  const sendingRef = useRef(false)
  const document = useMemo(() => createArtifactDocument(snapshot.source), [snapshot.source])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    const flowItem = sceneRef.current?.closest('[data-chat-flow-item]')
    if (!flowItem) return
    if (placement === 'inline') {
      flowItem.removeAttribute('data-artifact-overlay')
      return
    }
    flowItem.setAttribute('data-artifact-overlay', placement)
    return () => { flowItem.removeAttribute('data-artifact-overlay') }
  }, [placement])

  useEffect(() => {
    if (showSource) return
    const frame = iframeRef.current as HTMLIFrameElement
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frame.contentWindow) return
      const action = parseArtifactAction(event.data, snapshot.artifactId, snapshot.revision)
      if (action === null) return
      dispatchPending({ kind: 'enqueue', action })
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [showSource, snapshot.artifactId, snapshot.revision])

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

  return (
    <section
      ref={sceneRef}
      className={css.card}
      data-placement={placement}
      role={placement === 'focus' ? 'dialog' : 'complementary'}
      aria-modal={placement === 'focus' ? true : undefined}
      aria-label={t('card.label', { title: snapshot.title })}
    >
      <header className={css.header}>
        <div className={css.heading}>
          <h3 className={css.title}>{snapshot.title}</h3>
          <span className={css.revision}>{t('revision', { revision: String(snapshot.revision) })}</span>
        </div>
        <div className={css.controls}>
          {PLACEMENTS.map(option => (
            <Button key={option} size="sm" variant="outline" aria-pressed={placement === option}
              onClick={() => { setPlacement(option) }}>
              {t(PLACEMENT_COPY[option])}
            </Button>
          ))}
          <Button size="sm" variant="outline" aria-pressed={showSource}
            onClick={() => { setShowSource(value => !value) }}>
            {showSource ? t('view.preview') : t('view.source')}
          </Button>
        </div>
      </header>
      <div className={css.body}>
        {showSource
          ? <pre className={css.source} aria-label={t('source.label')}>{snapshot.source}</pre>
          : <iframe ref={iframeRef} className={css.frame} srcDoc={document} sandbox="allow-scripts"
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
}

/** Render the latest checkpoint; revision changes remount the browsing context and transient action state. */
export const ArtifactNodeView = memo(function ArtifactNodeView({ node, recordAction, t }: ArtifactNodeViewProps) {
  const snapshot = node.data
  return <ArtifactCard key={`${snapshot.artifactId}:${snapshot.revision}`} snapshot={snapshot} recordAction={recordAction} t={t} />
})
