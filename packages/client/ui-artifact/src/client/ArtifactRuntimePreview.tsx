/** One physical preview lease; source views and remounts never reuse an old document's readiness. */
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { randomUUID } from '@agentrans/util-crypto'
import { deepEqualJson } from '@agentrans/util-values'
import type { ArtifactRuntimeIdentity, ArtifactRuntimeId, RuntimeReport } from '@agentrans/artifact-runtime/types'
import type { ArtifactHtmlCheckpoint } from '@agentrans/artifact/runtime-values'
import { createArtifactDocument } from './document.ts'
import { parseArtifactReplayCheckpoint, parseArtifactRuntimeMessage, type ArtifactRuntimeCommandMessage,
  type ArtifactRuntimeRestoreMessage } from './runtime-messages.ts'
import type { ArtifactSnapshot } from './protocol.ts'
import type { ArtifactRuntimeActions } from './runtime-owner.ts'
import { SceneNodeView } from './SceneNodeView.tsx'
import { nativeRuntimeFailure } from './native-runtime.ts'
import css from './ArtifactNodeView.module.css'

interface Restoration {
  readonly state: ArtifactHtmlCheckpoint
  readonly pendingText: string
  readonly restoredText: string
  readonly timeoutMs?: number
  readonly onCheckpoint?: (state: ArtifactHtmlCheckpoint | null) => void
}

const DEFAULT_RESTORATION_TIMEOUT_MS = 10_000

interface Props {
  readonly snapshot: ArtifactSnapshot
  readonly native?: ComponentProps<typeof SceneNodeView> | undefined
  readonly runtime?: { readonly key: string; readonly actions: ArtifactRuntimeActions } | undefined
  readonly title: string
  readonly failedText: string
  readonly onFrame?: ((frame: HTMLIFrameElement | null) => void) | undefined
  readonly restoration?: Restoration | undefined
}

interface NativePreviewProps { readonly native: ComponentProps<typeof SceneNodeView>; readonly failedText: string }
class NativePreview extends Component<NativePreviewProps, { readonly failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { readonly failed: boolean } { return { failed: true } }
  override componentDidCatch(error: unknown): void { this.props.native.onRuntimeReport?.({ status: 'error', error: nativeRuntimeFailure(error) }) }
  override render() { return this.state.failed ? <p role="alert">{this.props.failedText}</p> : <SceneNodeView {...this.props.native} /> }
}

/**
 * @param props - Source, actual mount callbacks, and revision-bound renderer inputs.
 * @returns One live preview or an isolated historical restore.
 */
export function ArtifactRuntimePreview({ restoration, ...props }: Props) {
  if (restoration === undefined) return <LivePreview {...props} />
  if (props.snapshot.format !== 'html') throw new Error('Only HTML Artifact previews support checkpoint restoration')
  const instance = JSON.stringify([props.snapshot.artifactId, props.snapshot.revision, restoration.onCheckpoint !== undefined])
  return <HistoricalPreview key={instance}
    snapshot={props.snapshot} title={props.title} failedText={props.failedText} restoration={restoration} />
}

function HistoricalPreview({ snapshot, title, failedText, restoration }: {
  readonly snapshot: Extract<ArtifactSnapshot, { format: 'html' }>
  readonly title: string
  readonly failedText: string
  readonly restoration: Restoration
}) {
  const [identity] = useState<ArtifactRuntimeIdentity>(() => ({ artifactId: snapshot.artifactId, revision: snapshot.revision,
    runtimeId: randomUUID() as ArtifactRuntimeId, renderer: 'html' }))
  const [status, setStatus] = useState<'starting' | 'restored' | 'error'>('starting')
  const [checkpoint] = useState(restoration.state)
  const phase = useRef<'starting' | 'restored' | 'error'>('starting')
  const onCheckpoint = useRef(restoration.onCheckpoint)
  const latest = useRef<ArtifactHtmlCheckpoint | null>(null)
  const requested = useRef(false)
  const release = useRef<(() => void) | undefined>(undefined)
  const reportState = restoration.onCheckpoint !== undefined
  const document = useMemo(() => createArtifactDocument(snapshot.source, identity, { checkpoint, reportState }),
    [snapshot.source, identity, checkpoint, reportState])
  const timeout = restoration.timeoutMs ?? DEFAULT_RESTORATION_TIMEOUT_MS
  useEffect(() => { onCheckpoint.current = restoration.onCheckpoint }, [restoration.onCheckpoint])
  const fail = useCallback(() => {
    if (phase.current === 'error') return
    phase.current = 'error'
    latest.current = null
    setStatus('error')
    onCheckpoint.current?.(null)
  }, [])
  useEffect(() => {
    if (status !== 'starting') return
    const timer = setTimeout(fail, timeout)
    return () => { clearTimeout(timer) }
  }, [status, timeout, fail])
  const attachFrame = useCallback((frame: HTMLIFrameElement | null) => {
    release.current?.()
    release.current = undefined
    if (frame === null) {
      if (latest.current !== null) {
        latest.current = null
        onCheckpoint.current?.(null)
      }
      return
    }
    const receive = (event: MessageEvent): void => {
      if (event.source !== frame.contentWindow || event.origin !== 'null' || phase.current === 'error') return
      const message = parseArtifactRuntimeMessage(event.data, identity)
      if (message?.kind === 'artifact-runtime-report' && message.report.status === 'error') {
        fail()
        return
      }
      if (!requested.current) return
      if (phase.current === 'restored') {
        if (!reportState) return
        const next = parseArtifactReplayCheckpoint(event.data, identity, 'artifact-runtime-replay-state')
        if (next === null || next.kind !== checkpoint.kind || deepEqualJson(latest.current, next)) return
        latest.current = next
        onCheckpoint.current?.(next)
        return
      }
      const restored = parseArtifactReplayCheckpoint(event.data, identity, 'artifact-runtime-restored')
      if (restored === null) return
      if (!deepEqualJson(checkpoint, restored)) { fail(); return }
      phase.current = 'restored'
      setStatus('restored')
      if (reportState) {
        latest.current = restored
        onCheckpoint.current?.(restored)
      }
    }
    window.addEventListener('message', receive)
    release.current = () => { window.removeEventListener('message', receive) }
  }, [checkpoint, identity, reportState, fail])

  return <div data-artifact-restoration={status}>
    {status === 'error' ? <p role="alert">{failedText}</p> : <>
      <p role="status">{status === 'starting' ? restoration.pendingText : restoration.restoredText}</p>
      <iframe ref={attachFrame} className={css.frame} srcDoc={document} sandbox="allow-scripts" title={title} data-artifact-replay-frame
        data-artifact-id={identity.artifactId} data-artifact-runtime-id={identity.runtimeId} data-artifact-revision={identity.revision}
        hidden={status !== 'restored'} onLoad={(event) => {
          if (requested.current) { fail(); return }
          requested.current = true
          const request: ArtifactRuntimeRestoreMessage = { kind: 'artifact-runtime-restore', identity }
          event.currentTarget.contentWindow?.postMessage(request, '*')
        }} />
    </>}
  </div>
}

function LivePreview({ snapshot, native, runtime, title, failedText, onFrame }: Omit<Props, 'restoration'>) {
  const [identity] = useState<ArtifactRuntimeIdentity>(() => ({ artifactId: snapshot.artifactId, revision: snapshot.revision,
    runtimeId: randomUUID() as ArtifactRuntimeId, renderer: snapshot.format === 'html' ? 'html' : 'native' }))
  const release = useRef<(() => void) | undefined>(undefined)
  const pendingReport = useRef<RuntimeReport | undefined>(undefined)
  const document = useMemo(() => snapshot.format === 'html' ? createArtifactDocument(snapshot.source, identity) : '', [snapshot, identity])
  const actions = runtime?.actions
  const key = runtime?.key
  const attachNative = useCallback((element: HTMLDivElement | null) => {
    release.current?.()
    release.current = element === null || actions === undefined || key === undefined ? undefined : actions.mount(key, identity)
    if (element !== null && key !== undefined && pendingReport.current !== undefined) actions?.report(key, identity, pendingReport.current)
  }, [actions, key, identity])
  const attachFrame = useCallback((frame: HTMLIFrameElement | null) => {
    release.current?.()
    release.current = undefined
    onFrame?.(frame)
    if (frame === null) return
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frame.contentWindow || actions === undefined || key === undefined) return
      const message = parseArtifactRuntimeMessage(event.data, identity)
      if (message !== null) actions.message(key, identity, message)
    }
    window.addEventListener('message', onMessage)
    const close = actions === undefined || key === undefined ? undefined : actions.mount(key, identity, (requestId, command) => {
      const message: ArtifactRuntimeCommandMessage = { kind: 'artifact-runtime-command', identity, requestId, command }
      frame.contentWindow?.postMessage(message, '*')
    })
    release.current = () => { window.removeEventListener('message', onMessage); close?.() }
  }, [actions, key, identity, onFrame])
  const report = useCallback((value: RuntimeReport) => {
    pendingReport.current = value
    if (key !== undefined) actions?.report(key, identity, value)
  }, [key, actions, identity])
  const nativeState = native?.onStateChange
  const reportState = useCallback((state: import('@agentrans/util-values').JsonValue) => {
    if (key !== undefined) actions?.state(key, identity, state)
    nativeState?.(state)
  }, [key, actions, identity, nativeState])
  if (snapshot.format === 'html') return <iframe ref={attachFrame} className={css.frame}
    srcDoc={document} onLoad={(event) => { event.currentTarget.contentWindow?.postMessage({ kind: 'artifact-runtime-request-status', identity }, '*') }} sandbox="allow-scripts" title={title} data-artifact-frame data-artifact-id={identity.artifactId} data-artifact-runtime-id={identity.runtimeId} data-artifact-revision={identity.revision} />
  if (native === undefined) throw new Error('Native preview requires renderer inputs')
  return <div ref={attachNative}><NativePreview failedText={failedText} native={{ ...native, onStateChange: reportState,
    onRuntimeReport: runtime === undefined ? undefined : report }} /></div>
}
