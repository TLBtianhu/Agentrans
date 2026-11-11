/** One physical preview lease; source views and remounts never reuse an old document's readiness. */
import { Component, useCallback, useMemo, useRef, useState, type ComponentProps } from 'react'
import { randomUUID } from '@agentrans/util-crypto'
import type { ArtifactRuntimeIdentity, ArtifactRuntimeId, RuntimeReport } from '@agentrans/artifact-runtime/types'
import { createArtifactDocument } from './document.ts'
import { parseArtifactRuntimeMessage, type ArtifactRuntimeCommandMessage } from './runtime-messages.ts'
import type { ArtifactSnapshot } from './protocol.ts'
import type { ArtifactRuntimeActions } from './runtime-owner.ts'
import { SceneNodeView } from './SceneNodeView.tsx'
import { nativeRuntimeFailure } from './native-runtime.ts'
import css from './ArtifactNodeView.module.css'

interface Props {
  readonly snapshot: ArtifactSnapshot
  readonly native?: ComponentProps<typeof SceneNodeView> | undefined
  readonly runtime?: { readonly key: string; readonly actions: ArtifactRuntimeActions } | undefined
  readonly title: string
  readonly failedText: string
  readonly onFrame?: ((frame: HTMLIFrameElement | null) => void) | undefined
}

interface NativePreviewProps { readonly native: ComponentProps<typeof SceneNodeView>; readonly failedText: string }
class NativePreview extends Component<NativePreviewProps, { readonly failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { readonly failed: boolean } { return { failed: true } }
  override componentDidCatch(error: unknown): void { this.props.native.onRuntimeReport?.({ status: 'error', error: nativeRuntimeFailure(error) }) }
  override render() { return this.state.failed ? <p role="alert">{this.props.failedText}</p> : <SceneNodeView {...this.props.native} /> }
}

/** @param props - Source, actual mount callbacks, and revision-bound renderer inputs. @returns A single isolated current preview. */
export function ArtifactRuntimePreview({ snapshot, native, runtime, title, failedText, onFrame }: Props) {
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
