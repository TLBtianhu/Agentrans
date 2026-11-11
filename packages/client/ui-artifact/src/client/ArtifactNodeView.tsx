/** Isolated Artifact preview, source inspection, and confirmed action delivery. */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsLocale, PropsRuntime } from '@agentrans/client-ui-slots'
import type { PropsStore } from '@agentrans/client-store'
import { Button, IconBranchOutlineRegular, Tooltip } from '@agentrans/client-ui-primitives'
import { ArtifactRuntimePreview } from './ArtifactRuntimePreview.tsx'
import { getArtifactSourceCapabilities } from '@agentrans/artifact/capabilities'
import { runtimeQuestionAvailability } from './runtime-question.ts'
import type { ArtifactRuntimeIdentity } from '@agentrans/artifact-runtime/types'
import type { ArtifactRuntimeActions, ArtifactRuntimeSnapshot } from './runtime-owner.ts'
import { randomUUID } from '@agentrans/util-crypto'
import { useArtifactActionSubmission, type ArtifactActionSubmission } from './action-submission.ts'
import { ActionSubmissionFeedback } from './ActionSubmissionFeedback.tsx'
import { parseArtifactAction, type PendingArtifactAction } from './messages.ts'
import { artifactPresentationStore, type ArtifactDockEntry } from './presentation.ts'
import { createParticleCheckpoint, restoreParticleCheckpoint, ParticleRuntimeError } from '@agentrans/artifact/particle-runtime'
import type { ArtifactActionRequest, SavedParticleObservation } from '@agentrans/artifact/types'
import type { ParticleRun, ParticleRunCommand } from './particle-run.ts'
import { particleRuntimeKey, type ArtifactParticleRuntime } from './particle-runtime-owner.ts'
import {
  ObservationControls, observationsFor, useObservationActions,
  type ObservationControlsData, type ObservationActions, type ObservationSelection,
} from './ObservationControls.tsx'
import { ExportControls, useExportActions, type ExportControlsData, type ExportActions } from './ExportControls.tsx'
import type { JsonValue } from '@agentrans/util-values'
import type { ArtifactNodeInjected, ArtifactPlacement, ArtifactSnapshot, ViewRequest } from './protocol.ts'
import { artifactHostRouteAvailable } from './artifact-route.ts'
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
  readonly runtimeControls?: {
    readonly key: string
    readonly actions: ArtifactRuntimeActions
    readonly snapshot: ArtifactRuntimeSnapshot | undefined
  } | undefined
  readonly onSceneState?: (state: JsonValue) => void
  readonly onFrame?: (frame: HTMLIFrameElement | null) => void
  readonly observationControls?: ObservationControlsData | undefined
  readonly observationSelection?: ObservationSelection | undefined
  readonly exportControls?: ExportControlsData | undefined
  readonly particleRuntime?: {
    readonly current: ArtifactParticleRuntime | undefined
    readonly command: (command: ParticleRunCommand) => void } | undefined
  readonly promptContext?: {
    readonly chooseRuntime?: (identity: ArtifactRuntimeIdentity) => void
    readonly chooseCurrent: () => void
    readonly chooseObservation: (observation: SavedParticleObservation) => void } | undefined
  readonly hostOperationsAvailable?: boolean
}

interface QueuedArtifactAction extends PendingArtifactAction { readonly requestId: ArtifactActionRequest['requestId'] }

const PENDING_ACTION_LIMIT = 32

const PLACEMENTS: readonly ViewRequest['placement'][] = ['inline', 'beside', 'focus', 'pip']
const EMPTY_OBSERVATIONS: readonly SavedParticleObservation[] = []
const PLACEMENT_COPY: Record<ArtifactPlacement, 'view.inline' | 'view.beside' | 'view.focus' | 'view.pip'> = {
  inline: 'view.inline', beside: 'view.beside', focus: 'view.focus', pip: 'view.pip',
}

interface PendingState {
  readonly actions: readonly QueuedArtifactAction[]
  readonly overflow: boolean
}

type PendingUpdate =
  | { readonly kind: 'enqueue'; readonly action: QueuedArtifactAction }
  | { readonly kind: 'sent'; readonly requestId: ArtifactActionRequest['requestId'] }

function updatePending(state: PendingState, update: PendingUpdate): PendingState {
  if (update.kind === 'sent') {
    const actions = state.actions.filter(action => action.requestId !== update.requestId)
    return { actions, overflow: false }
  }
  if (state.actions.length >= PENDING_ACTION_LIMIT) return { ...state, overflow: true }
  return { actions: [...state.actions, update.action], overflow: state.overflow }
}

/** Pure Artifact surface: placement, dock tabs, and confirmation UI arrive as plain props. */
export function ArtifactCard(props: ArtifactCardProps) {
  return <ArtifactCardOwner key={props.snapshot.artifactId} {...props} />
}

function ArtifactCardOwner(props: ArtifactCardProps) {
  const observationActions = useObservationActions(props.observationControls)
  const exportActions = useExportActions(props.exportControls)
  const actionSubmission = useArtifactActionSubmission(props.recordAction)
  return <ArtifactCardInstance key={props.snapshot.revision} {...props}
    observationActions={observationActions} exportActions={exportActions} actionSubmission={actionSubmission}
    recordAction={actionSubmission.record} />
}

function ArtifactCardInstance({
  snapshot: latestSnapshot, origin, recordAction, t, placement, placementControls = true,
  docks = [], activeDockId = null, onPlacement, onActivateDock, onCloseDock, onBranch, onSceneState, onFrame,
  observationControls,
  observationSelection,
  observationActions,
  exportControls, exportActions, actionSubmission, particleRuntime, promptContext, hostOperationsAvailable = true, runtimeControls,
}: ArtifactCardProps & {
  readonly observationActions: ObservationActions
  readonly exportActions: ExportActions
  readonly actionSubmission: ArtifactActionSubmission
}) {
  const [showSource, setShowSource] = useState(false)
  const [previewGeneration, restartPreview] = useReducer((value: number) => value + 1, 0)
  const [{ actions: pendingActions, overflow }, dispatchPending] = useReducer(updatePending, { actions: [], overflow: false })
  const [localRestored, setRestored] = useState<{ observation: SavedParticleObservation; run: ParticleRun } | null>(null)
  const [restoreFailed, setRestoreFailed] = useState(false)
  const controlledRestored = useMemo(() => {
    const observation = observationSelection?.observation
    if (observation === undefined || observation === null) return null
    if (observation.artifact.spec.kind !== 'particle-system') throw new Error('Comparison selection requires a particle source')
    return { observation, run: {
      state: restoreParticleCheckpoint(observation.artifact.spec, observation.checkpoint), playing: false, failed: false,
    } }
  }, [observationSelection?.observation])
  const restored = observationSelection === undefined ? localRestored : controlledRestored
  const snapshot = restored?.observation.artifact ?? latestSnapshot
  const particleSpec = latestSnapshot.format === 'scene' && latestSnapshot.spec.kind === 'particle-system'
    ? latestSnapshot.spec : undefined
  const latestParticleRun = particleRuntime?.current?.revision === latestSnapshot.revision ? particleRuntime.current.run : null
  const commandParticle = useCallback((command: ParticleRunCommand): void => {
    particleRuntime?.command(command)
  }, [particleRuntime?.command])
  const particleRun = restored?.run ?? latestParticleRun
  const htmlRuntime = runtimeControls?.snapshot
  const htmlQuestion = snapshot.format === 'html' && (htmlRuntime === undefined
    || htmlRuntime.identity.artifactId === snapshot.artifactId && htmlRuntime.identity.revision === snapshot.revision)
    ? runtimeQuestionAvailability(htmlRuntime) : 'unavailable'
  const htmlQuestionAvailable = htmlQuestion === 'state' || htmlQuestion === 'error'
  const exportSource = snapshot.format !== 'scene' ? undefined : {
    artifact: snapshot,
    ...(particleRun === null ? {} : { checkpoint: createParticleCheckpoint(particleRun.state) }),
    ...(restored === null ? {} : { observationId: restored.observation.observationId }),
  }
  const backgrounded = placementControls && placement === 'beside' && activeDockId !== snapshot.artifactId
  // Hiding this surface ends playback; returning exposes the same paused state.
  useEffect(() => {
    if ((showSource || backgrounded || restored !== null) && latestParticleRun?.playing) commandParticle('pause')
  }, [showSource, backgrounded, restored !== null, latestParticleRun?.playing, commandParticle])
  const [dockTop, setDockTop] = useState<number>()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const cardRef = useRef<HTMLElement | null>(null)
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const returnedRef = useRef(false)
  const mountedRef = useRef(true)
  const setFrame = useCallback((element: HTMLIFrameElement | null): void => {
    iframeRef.current = element
    onFrame?.(element)
  }, [onFrame])

  useEffect(() => {
    if (particleSpec === undefined || latestParticleRun?.playing !== true || showSource || backgrounded || restored !== null) return
    const timer = window.setInterval(() => { commandParticle('step') }, Math.max(16, particleSpec.timeStep * 1000))
    return () => { window.clearInterval(timer) }
  }, [particleSpec, latestParticleRun?.playing, showSource, backgrounded, restored])

  const restoreObservation = (observation: SavedParticleObservation): void => {
    try {
      if (observation.artifact.spec.kind !== 'particle-system') {
        throw new ParticleRuntimeError('INVALID_CHECKPOINT', 'Saved observation does not contain a particle source')
      }
      const state = restoreParticleCheckpoint(observation.artifact.spec, observation.checkpoint)
      commandParticle('pause')
      if (observationSelection === undefined) setRestored({ observation, run: { state, playing: false, failed: false } })
      else observationSelection.onSelect(observation.observationId)
      setShowSource(false)
      setRestoreFailed(false)
    } catch (error) {
      if (!(error instanceof ParticleRuntimeError)) throw error
      setRestoreFailed(true)
    }
  }

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
      dispatchPending({ kind: 'enqueue', action: { ...action, requestId: randomUUID() as ArtifactActionRequest['requestId'] } })
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [showSource, snapshot.artifactId, snapshot.revision, snapshot.format])

  const pending = pendingActions[0]
  const send = async (submitted: QueuedArtifactAction): Promise<void> => {
    if (!hostOperationsAvailable) return
    const accepted = await actionSubmission.begin(
      submitted.artifactId, submitted.revision, submitted.action, submitted.payload, true, submitted.requestId,
    )
    if (mountedRef.current && accepted !== undefined) dispatchPending({ kind: 'sent', requestId: accepted.requestId })
  }
  const retryAction = async (): Promise<void> => {
    const accepted = await actionSubmission.retry()
    if (mountedRef.current && accepted !== undefined) dispatchPending({ kind: 'sent', requestId: accepted.requestId })
  }


  // A docked but backgrounded Artifact stays mounted and keeps its preview
  // state; only the active tab is painted.
  const card = (
    <section
      ref={cardRef}
      className={css.card}
      hidden={backgrounded}
      style={dockTop === undefined ? undefined : { '--artifact-dock-top': `${String(dockTop)}px` } as CSSProperties}
      data-placement={placementControls ? placement : 'inline'}
      data-artifact-revision={snapshot.revision}
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
          {hostOperationsAvailable && exportControls !== undefined && exportControls.canCreate !== false && exportSource !== undefined && (
            <Button size="sm" variant="ghost" className={css.placement} aria-label={t('action.exportAnimation')}
              disabled={!exportControls.ready || exportActions.state.phase !== 'idle' || exportActions.state.pending !== null
                || particleRun?.failed === true
                || snapshot.format === 'scene' && snapshot.spec.kind === 'particle-system' && particleRun === null}
              onClick={() => { void exportActions.begin(exportSource) }}>
              {t('action.exportAnimation')}
            </Button>
          )}
          {promptContext?.chooseRuntime !== undefined && snapshot.format === 'html' && restored === null && (
            <Button size="sm" variant="ghost" className={css.placement} disabled={!htmlQuestionAvailable}
              data-artifact-prompt-attach="html-runtime" onClick={() => {
                if (htmlRuntime !== undefined) promptContext.chooseRuntime?.(htmlRuntime.identity)
              }}>{t('promptContext.programAttach')}</Button>
          )}
          {promptContext !== undefined && (restored !== null || particleSpec !== undefined) && (
            <Button size="sm" variant="ghost" className={css.placement}
              disabled={restored === null && (latestParticleRun === null || latestParticleRun.failed)}
              onClick={() => {
                if (restored === null) promptContext.chooseCurrent()
                else promptContext.chooseObservation(restored.observation)
              }}>
              {t('promptContext.attach')}
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
      {restored !== null && (
        <div className={css.observationHistory} role="status">
          <span>{t('observation.viewing', { label: restored.observation.label, revision: String(snapshot.revision) })}</span>
          <Button size="sm" variant="outline" disabled={observationSelection?.disabled === true} onClick={() => {
            if (observationSelection === undefined) setRestored(null)
            else observationSelection.onSelect(null)
            setRestoreFailed(false)
          }}>
            {t('observation.returnLatest')}
          </Button>
        </div>
      )}
      {restoreFailed && <p role="alert" className={css.error}>{t('observation.restoreFailed')}</p>}
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
          : snapshot.format === 'scene' && snapshot.spec.kind === 'particle-system' && particleRun === null
            ? <p role="status">{t('promptContext.loadingRuntime')}</p>
            : snapshot.format === 'scene'
              ? <ArtifactRuntimePreview key={`${snapshot.revision}:${restored?.observation.observationId ?? 'current'}:${previewGeneration}`}
                snapshot={snapshot} runtime={restored === null ? runtimeControls : undefined} title={t('preview.frame', { title: snapshot.title })} failedText={t('runtime.failed')}
                native={{ spec: snapshot.spec, artifactId: snapshot.artifactId, revision: snapshot.revision,
                  placement: placementControls ? placement : 'inline', recordAction, canRecord: hostOperationsAvailable, recordPending: actionSubmission.pending,
                  onStateChange: restored === null ? onSceneState : undefined, readOnly: restored !== null,
                  particleRun, onParticleCommand: commandParticle, t }} />
              : <ArtifactRuntimePreview key={previewGeneration} snapshot={snapshot} runtime={runtimeControls}
                onFrame={setFrame} title={t('preview.frame', { title: snapshot.title })} failedText={t('runtime.failed')} />}
      </div>
      {runtimeControls !== undefined && restored === null && !showSource && <div data-artifact-runtime-status={runtimeControls.snapshot?.report.status ?? 'unknown'}>
        <p role="status">{runtimeControls.snapshot?.host === 'unavailable' ? t('runtime.unavailable')
          : runtimeControls.snapshot?.host === 'denied' ? t('runtime.denied')
            : runtimeControls.snapshot?.report.status === 'ready' ? t('runtime.ready')
              : runtimeControls.snapshot?.report.status === 'error' ? t('runtime.failed') : t('runtime.starting')}</p>
        {runtimeControls.snapshot?.report.status === 'error' && <p role="alert">{runtimeControls.snapshot.report.error.message}</p>}
        {(runtimeControls.snapshot?.host === 'unavailable' || runtimeControls.snapshot?.host === 'denied'
          || runtimeControls.snapshot?.report.status === 'error') && <Button size="sm" variant="ghost" onClick={restartPreview}>{t('runtime.retry')}</Button>}
      </div>}
      {promptContext !== undefined && restored === null && snapshot.format === 'html' && <p className={css.observationHint}>
        {t(`promptContext.program.${htmlQuestion}`)}
      </p>}
      {!hostOperationsAvailable && <p className={css.observationHint}>
        {t('route.subagentLocalOnly')}
      </p>}
      {promptContext !== undefined && restored === null && snapshot.format === 'scene'
        && getArtifactSourceCapabilities(latestSnapshot).questionContext === 'unsupported' && <p className={css.observationHint}>
        {t('promptContext.unsupported')}
      </p>}
      {observationControls !== undefined
        && (latestParticleRun !== null || !observationControls.ready || observationControls.observations.length > 0
          || observationActions.state.savePhase !== 'idle') && (
        <ObservationControls {...observationControls} artifactId={latestSnapshot.artifactId} revision={latestSnapshot.revision}
          checkpoint={latestParticleRun === null ? null : createParticleCheckpoint(latestParticleRun.state)}
          canSubmit={hostOperationsAvailable}
          canSave={restored === null && latestParticleRun !== null && !latestParticleRun.failed}
          onRestore={restoreObservation} actions={observationActions} selection={observationSelection} t={t} />
      )}
      {exportControls !== undefined && (exportSource !== undefined || exportControls.records.length > 0
        || exportActions.state.pending !== null) && (
        <ExportControls ready={exportControls.ready} records={exportControls.records}
          canCreate={exportControls.canCreate} canRead={exportControls.canRead}
          hostOperationsAvailable={hostOperationsAvailable} source={exportSource} actions={exportActions} t={t} />
      )}
      {pending === undefined ? null : (
        <div className={css.pending}>
          <div>
            <p className={css.pendingAction}>{t('pending.action', { action: pending.action })}</p>
            {pendingActions.length > 1 && <p className={css.pendingCount}>{t('pending.more', { count: String(pendingActions.length) })}</p>}
          </div>
          {overflow && <p className={css.error} role="alert">{t('pending.overflow')}</p>}
          {hostOperationsAvailable && <Button size="sm" variant="primary" className={css.send} disabled={actionSubmission.pending}
            aria-busy={actionSubmission.state.phase === 'sending'} onClick={() => { void send(pending) }}>
            {actionSubmission.state.phase === 'sending' ? t('send.sending') : t('send.action')}
          </Button>}
        </div>
      )}
      <ActionSubmissionFeedback state={actionSubmission.state} available={hostOperationsAvailable}
        retry={() => { void retryAction() }} dismiss={actionSubmission.dismiss} t={t} />
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
  node, sessionId, useSession, useSessions, useStore, useProjection, useAccess, actions,
  recordAction, saveObservation, sendObservation, exports, forkAt, t,
  useParticleRuntime, useArtifactRuntime, runtimeActions, commandParticleRuntime,
  chooseRuntimePromptContext, chooseParticlePromptContext, chooseObservationPromptContext,
}: ArtifactNodeViewProps) {
  const snapshot = node.data
  const artifactId = snapshot.artifactId
  const runtimeKey = particleRuntimeKey(node.key, artifactId)
  const currentRuntime = useParticleRuntime(runtimeKey)
  const reportRuntime = useArtifactRuntime(runtimeKey)
  const hostRouteAvailable = useSession(artifactHostRouteAvailable)
  const command = useCallback((command: ParticleRunCommand): void => {
    commandParticleRuntime(runtimeKey, command)
  }, [runtimeKey, commandParticleRuntime])
  const projectedObservations = useProjection('artifactObservations')
  const observations = observationsFor(projectedObservations, artifactId) ?? EMPTY_OBSERVATIONS
  const projectedExports = useProjection('artifactExports')
  const canExport = useAccess('artifactExports/create')
  const canReadExport = useAccess('artifactExports/read')
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
      key={`${sessionId}:${artifactId}`}
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
      particleRuntime={{ current: currentRuntime, command }}
      runtimeControls={{ key: runtimeKey, actions: runtimeActions, snapshot: reportRuntime }}
      promptContext={hostRouteAvailable ? {
        chooseRuntime: (identity) => { chooseRuntimePromptContext(runtimeKey, snapshot, identity) },
        chooseCurrent: () => { chooseParticlePromptContext(runtimeKey, snapshot) },
        chooseObservation: chooseObservationPromptContext } : undefined}
      hostOperationsAvailable={hostRouteAvailable}
      observationControls={{ ready: projectedObservations !== undefined, observations, save: saveObservation, send: sendObservation }}
      exportControls={exports === undefined ? undefined : {
        ...exports, ready: projectedExports !== undefined, canCreate: canExport, canRead: canReadExport,
        records: Object.values(projectedExports ?? {}).filter(record => record.frozen.artifact.artifactId === artifactId),
      }}
      t={t}
    />
  )
})
