/** Standalone replay of a saved checkpoint in the existing HTML Artifact sandbox. */
import type {
  ArtifactBranchExportReturnedBfsValue, ArtifactBranchExportReturnedHalfAdderValue,
} from '@agentrans/artifact-branch/types'
import type { ArtifactRuntimeId, ArtifactRuntimeIdentity } from '@agentrans/artifact-runtime/types'
import type { ArtifactHtmlCheckpoint } from '@agentrans/artifact/runtime-values'
import type { SessionId } from '@agentrans/session/types'
import { ARTIFACT_CSP, createArtifactDocument } from './document.ts'
import type { BranchEvidenceReference } from './particle-runtime-owner.ts'
import { matchesHtmlCheckpoint } from './runtime-bridge.ts'

interface ExportCopy {
  readonly lang: string
  readonly revision: string
  readonly locked: string
  readonly reset: string
  readonly restoring: string
  readonly restored: string
  readonly failed: string
}

interface ReplayFile {
  readonly title: string
  readonly frameDocument: string
  readonly identity: ArtifactRuntimeIdentity
  readonly checkpoint: ArtifactHtmlCheckpoint
  readonly copy: ExportCopy
  readonly statusAttribute: string
  readonly frameAttribute: string
}

function runReplay(
  { title, frameDocument, identity, checkpoint, copy, statusAttribute, frameAttribute }: ReplayFile,
  matchesCheckpoint: typeof matchesHtmlCheckpoint,
): void {
  function element(id: string): HTMLElement {
    const node = document.getElementById(id)
    if (node === null) throw new Error(`Missing experiment replay element: ${id}`)
    return node
  }

  const stage = element('experiment-stage')
  const status = element('experiment-status')
  const container = element('experiment-program')
  let activeFrame: HTMLIFrameElement | undefined
  let timeout: number | undefined

  function fail(): void {
    window.clearTimeout(timeout)
    activeFrame?.remove()
    activeFrame = undefined
    stage.setAttribute(statusAttribute, 'failed')
    status.textContent = copy.failed
  }

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (activeFrame === undefined || event.source !== activeFrame.contentWindow || event.origin !== 'null'
      || typeof event.data !== 'object' || event.data === null) return
    const message = event.data as {
      kind?: unknown
      identity?: Partial<ArtifactRuntimeIdentity>
      state?: unknown
      report?: { status?: unknown }
    }
    const received = message.identity
    if (received?.artifactId !== identity.artifactId || received.revision !== identity.revision
      || received.runtimeId !== identity.runtimeId || received.renderer !== identity.renderer) return
    if (message.kind === 'artifact-runtime-report' && message.report?.status === 'error') {
      fail()
      return
    }
    if (stage.getAttribute(statusAttribute) !== 'restoring' || message.kind !== 'artifact-runtime-restored') return
    if (!matchesCheckpoint(checkpoint, message.state)) {
      fail()
      return
    }
    window.clearTimeout(timeout)
    stage.setAttribute(statusAttribute, 'restored')
    status.textContent = copy.restored
    activeFrame.hidden = false
  })

  function reset(): void {
    window.clearTimeout(timeout)
    stage.setAttribute(statusAttribute, 'restoring')
    status.textContent = copy.restoring
    const frame = document.createElement('iframe')
    frame.title = title
    frame.hidden = true
    frame.sandbox.add('allow-scripts')
    frame.setAttribute(frameAttribute, '')
    let loaded = false
    frame.addEventListener('load', () => {
      if (activeFrame !== frame) return
      if (loaded) {
        fail()
        return
      }
      loaded = true
      frame.contentWindow?.postMessage({ kind: 'artifact-runtime-restore', identity }, '*')
    })
    frame.srcdoc = frameDocument
    activeFrame = frame
    timeout = window.setTimeout(fail, 10_000)
    container.replaceChildren(frame)
  }

  element('experiment-reset').addEventListener('click', reset)
  reset()
}

function scriptData(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
}

function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/**
 * Package one validated checkpoint as a file with an opaque, network-restricted program frame.
 * @param data - Original HTML Artifact and exact checkpoint resolved by the Host.
 * @param ref - Address of the owning message, retained in the export identity.
 * @param originKind - Whether a return or an ordinary sent question supplied the checkpoint.
 * @param copy - File controls and status text in the language selected at download.
 * @returns Standalone HTML that restores the checkpoint on load and Reset.
 */
export function buildLockedHtmlExperiment(
  data: ArtifactBranchExportReturnedBfsValue | ArtifactBranchExportReturnedHalfAdderValue,
  ref: BranchEvidenceReference & { readonly sessionId: SessionId },
  originKind: 'returnedEvidence' | 'sentQuestion',
  copy: ExportCopy,
): string {
  const { artifact, checkpoint } = data
  const { sessionId, eventSeq, messageId } = ref
  const { title, artifactId, revision } = artifact
  const slug = checkpoint.kind === 'bfs-checkpoint' ? 'bfs' : 'half-adder'
  const originPrefix = originKind === 'sentQuestion' ? 'sent' : 'returned'
  const identity: ArtifactRuntimeIdentity = { artifactId, revision, renderer: 'html',
    runtimeId: `${originPrefix}-${slug}-${eventSeq}` as ArtifactRuntimeId }
  const frameDocument = createArtifactDocument(artifact.source, identity, { checkpoint })
  const statusAttribute = `data-${slug}-export-status`
  const frameAttribute = `data-exported-${slug}-frame`
  const initial: ReplayFile = { title, frameDocument, identity, checkpoint, copy, statusAttribute, frameAttribute }
  const origin = { exporterVersion: 1, sessionId, artifactId, revision, [originKind]: { eventSeq, messageId }, checkpoint }
  const heading = escapeText(title)
  return `<!doctype html>
<html lang="${escapeText(copy.lang)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title>
<style>
:root { color-scheme: light dark; font:16px/1.5 system-ui,sans-serif; }
body { margin:0; }
main { max-width:70rem; margin:0 auto; padding:clamp(1rem, 4vw, 2rem); }
h1 { margin:0; font-size:1.25rem; }
.meta { margin:.25rem 0 .75rem; font-size:.875rem; overflow-wrap:anywhere; }
.controls { display:flex; align-items:center; flex-wrap:wrap; gap:.5rem 1rem; margin-bottom:.75rem; }
button { font:inherit; padding:.35rem .85rem; cursor:pointer; }
iframe { box-sizing:border-box; width:100%; height:max(23rem,60vh); border:1px solid GrayText; border-radius:.5rem; }
</style>
</head>
<body>
<main id="experiment-stage" ${statusAttribute}="restoring">
  <h1>${heading}</h1>
  <p class="meta" id="artifact-export-origin">${escapeText(artifactId)} · ${escapeText(copy.revision)} ${revision} · ${escapeText(copy.locked)}</p>
  <div class="controls">
    <button type="button" id="experiment-reset">${escapeText(copy.reset)}</button>
    <span role="status" id="experiment-status">${escapeText(copy.restoring)}</span>
  </div>
  <div id="experiment-program"></div>
</main>
<script type="application/json" id="artifact-export-origin-data">${scriptData(origin)}</script>
<script>(${runReplay.toString()})(${scriptData(initial)}, (${matchesHtmlCheckpoint.toString()}));</script>
</body>
</html>
`
}
