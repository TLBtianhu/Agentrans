/** Standalone HTML animation export for validated SceneSpec values. */
import type { FunctionPlotSpec, FlowchartSpec, ParticleSystemSpec, TimelineSpec, NetworkGraphSpec, MapSpec } from './scene.ts'
import {
  createParticleCheckpoint, createParticleState, restoreParticleCheckpoint, ParticleRuntimeError, type ParticleCheckpoint,
} from './particle-runtime.ts'
import { sceneExprBundle } from './scene-expr.generated.ts'
import { sceneRenderersBundle } from './scene-renderers.generated.ts'
import type { ScenePaletteRole } from './scene-palette.ts'

/** Version of the standalone SceneSpec HTML program and its fixed output options. */
export const SCENE_EXPORTER_VERSION = 1

/**
 * Palette the exported document carries, light scheme.
 *
 * An export has no host theme to read, so it pins its own values under the same
 * role names the live preview resolves. That keeps one renderer drawing both,
 * and it is why the exported file looks the same on a machine whose application
 * theme differs from the viewer's.
 */
const EXPORT_PALETTE_LIGHT: Readonly<Record<ScenePaletteRole, string>> = {
  ink: '#17202b', inkMuted: '#647184', accent: '#4f56c7', success: '#147a5b',
  surface: '#f4f5f7', grid: 'rgba(82,96,128,0.14)', highlight: '#b45309',
  series1: '#2f6fd0', series2: '#b45309', series3: '#147a5b', series4: '#5b52c9',
}

/** Palette the exported document carries, dark scheme. */
const EXPORT_PALETTE_DARK: Readonly<Record<ScenePaletteRole, string>> = {
  ink: '#edf2fb', inkMuted: '#a1aec2', accent: '#a5b4fc', success: '#62d5a8',
  surface: '#101318', grid: 'rgba(185,202,231,0.14)', highlight: '#fbbf24',
  series1: '#7aa2ff', series2: '#fbbf24', series3: '#62d5a8', series4: '#a5b4fc',
}

/** Inert JSON carrying both pinned palettes to the exported program. */
const EXPORT_PALETTES_JSON = JSON.stringify({ light: EXPORT_PALETTE_LIGHT, dark: EXPORT_PALETTE_DARK }).replaceAll('<', '\\u003c')

/** Source identity embedded in a standalone export; particle conditions use the replay checkpoint. */
export interface SceneExportOrigin {
  readonly exporterVersion: typeof SCENE_EXPORTER_VERSION
  readonly exportId: string
  /** Original Session that admitted this export; absent for standalone non-Session callers. */
  readonly sessionId?: string
  readonly artifactId: string
  readonly revision: number
  readonly observationId?: string
  readonly checkpoint?: ParticleCheckpoint
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Build a self-contained HTML animation program from a validated SceneSpec.
 * Scene strings remain data inside scripts and text inside the document.
 * @param spec - Validated SceneSpec to replay.
 * @param title - Document title for the exported page.
 * @param checkpoint - Optional particle replay origin, bound to this exact spec and Artifact revision.
 * @param origin - Optional export identity; when absent no identity block is added. When present,
 * source identity and the resolved particle checkpoint are embedded as inert JSON and shown as text.
 * @returns A complete HTML document with an inline parser, shared renderers, and timeline player.
 */
export function buildSceneAnimationHtml(
  spec: FunctionPlotSpec | FlowchartSpec | ParticleSystemSpec | TimelineSpec | NetworkGraphSpec | MapSpec,
  title: string,
  checkpoint?: ParticleCheckpoint,
  origin?: SceneExportOrigin,
): string {
  if (checkpoint !== undefined && spec.kind !== 'particle-system') {
    throw new ParticleRuntimeError('INVALID_CHECKPOINT', 'A particle checkpoint requires a particle-system source')
  }
  const particleCheckpoint = spec.kind === 'particle-system'
    ? createParticleCheckpoint(checkpoint === undefined ? createParticleState(spec) : restoreParticleCheckpoint(spec, checkpoint))
    : null
  // The HTML parser sees script-closing tags before JavaScript decodes strings.
  const specJson = JSON.stringify(spec).replaceAll('<', '\\u003c')
  const checkpointJson = JSON.stringify(particleCheckpoint).replaceAll('<', '\\u003c')
  const titleHtml = escapeHtml(title)
  const metadata = origin === undefined ? null : { ...origin, checkpoint: particleCheckpoint ?? undefined }
  const metadataBlock = metadata === null ? '' : `<script type="application/json" id="artifact-export-origin-data">${JSON.stringify(metadata).replaceAll('<', '\\u003c')}</script>`
  const identityLabel = origin === undefined ? '' : `<p class="meta" id="artifact-export-origin">${escapeHtml(origin.artifactId)} · revision ${origin.revision} · ${particleCheckpoint === null ? 'Source defaults' : `runtime ${particleCheckpoint.runtimeVersion} · step ${particleCheckpoint.stepCount}`}</p>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleHtml} · animation</title>
<style>
:root { color-scheme: light dark; --bg:${EXPORT_PALETTE_LIGHT.surface}; --ink:${EXPORT_PALETTE_LIGHT.ink}; --muted:${EXPORT_PALETTE_LIGHT.inkMuted}; --accent:${EXPORT_PALETTE_LIGHT.accent}; --good:${EXPORT_PALETTE_LIGHT.success}; --grid:${EXPORT_PALETTE_LIGHT.grid}; --border:${EXPORT_PALETTE_LIGHT.grid}; }
@media (prefers-color-scheme: dark) { :root { --bg:${EXPORT_PALETTE_DARK.surface}; --ink:${EXPORT_PALETTE_DARK.ink}; --muted:${EXPORT_PALETTE_DARK.inkMuted}; --accent:${EXPORT_PALETTE_DARK.accent}; --good:${EXPORT_PALETTE_DARK.success}; --grid:${EXPORT_PALETTE_DARK.grid}; --border:${EXPORT_PALETTE_DARK.grid}; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:13px/1.5 ui-sans-serif, system-ui, sans-serif; font-variant-numeric: tabular-nums; }
main { width:min(980px,100%); margin:0 auto; padding:20px; display:grid; gap:12px; }
h1 { margin:0; font-size:18px; }
.meta { margin:0; color:var(--muted); font-size:11px; }
canvas { display:block; width:100%; height:auto; border-top:0.5px solid var(--border); border-bottom:0.5px solid var(--border); background:transparent; }
.controls { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
button { padding:6px 12px; border:0.5px solid var(--border); border-radius:6px; background:transparent; color:var(--ink); cursor:pointer; font:inherit; }
button[data-active] { background:var(--accent); color:white; border-color:var(--accent); }
input[type='range'] { flex:1; min-width:160px; accent-color:var(--accent); }
.readout { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }
.readout span { display:block; color:var(--muted); font-size:10px; text-transform:uppercase; letter-spacing:0.06em; }
.readout strong { font-family:ui-monospace,monospace; font-size:13px; }
.legend { display:flex; flex-wrap:wrap; gap:12px; color:var(--muted); font-size:11px; }
.legend i { display:inline-block; width:12px; height:2px; margin-right:5px; background:var(--accent); vertical-align:middle; }
.legend .alt { background:var(--good); }
</style>
</head>
<body>
<main>
  <h1>${titleHtml}</h1>
  <p class="meta">SceneSpec animation · deterministic replay</p>
  ${identityLabel}
  <div class="legend" id="legend"></div>
  <canvas id="plot" width="900" height="420" role="img" aria-label="SceneSpec animation"></canvas>
  <div class="readout" id="readout" role="status" aria-live="polite"></div>
  <p id="error" role="alert" hidden></p>
  <div class="controls">
    <button id="play" type="button" data-active="false">Play</button>
    <button id="reset" type="button">Reset</button>
    <button id="record" type="button">Download WebM</button>
    <input id="scrub" type="range" min="0" max="1" step="0.001" value="0" aria-label="Timeline">
    <span id="time" class="meta">0.00 s</span>
  </div>
</main>
${metadataBlock}
<script>${sceneExprBundle}</script>
<script>${sceneRenderersBundle}</script>
<script>
const spec = ${specJson}
const isFlowchart = spec.kind === 'flowchart'
const isParticleSystem = spec.kind === 'particle-system'
const isTimeline = spec.kind === 'timeline'
const isNetworkGraph = spec.kind === 'network-graph'
const isMap = spec.kind === 'map'
const particleCheckpoint = ${checkpointJson}
const particleBaseState = isParticleSystem ? SceneRenderers.restoreParticleCheckpoint(spec, particleCheckpoint) : null
const path = isFlowchart ? (spec.path ?? []) : []
const timelineTimes = isTimeline ? spec.events.map(event => event.time) : []
const minTime = timelineTimes.length > 0 ? Math.min(...timelineTimes) : 0
const maxTime = timelineTimes.length > 0 ? Math.max(...timelineTimes) : 1
let pathIndex = 0
const parameters = Object.fromEntries(Object.entries(spec.parameters ?? {}).map(([key, value]) => [key, value.value]))
const functions = isFlowchart || isParticleSystem || isTimeline || isNetworkGraph || isMap ? [] : spec.functions.map(fn => ({ ...fn, node: SceneExpr.parseExpression(fn.expression, Object.keys(spec.parameters)) }))
const canvas = document.getElementById('plot')
const context = canvas.getContext('2d')
// The document pins its own palette under the shared role names, so the same
// renderers draw here and in the conversation preview.
const exportPalettes = ${EXPORT_PALETTES_JSON}
const palette = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
  ? exportPalettes.dark
  : exportPalettes.light
const scrub = document.getElementById('scrub')
const playButton = document.getElementById('play')
const timeLabel = document.getElementById('time')
const readout = document.getElementById('readout')
const errorNotice = document.getElementById('error')
const timeline = spec.timeline ?? { duration: 8, fps: 30 }
let progress = 0
let playing = false
let frame = 0
let lastTime = 0
let activeRecording = null

function renderReadout(entries) {
  readout.replaceChildren(...entries.map(([label, text]) => {
    const row = document.createElement('div')
    const caption = document.createElement('span')
    caption.textContent = label
    const value = document.createElement('strong')
    value.textContent = text
    row.append(caption, value)
    return row
  }))
}
function formatMeasurement(value) {
  return value === null ? '—' : value.toFixed(3)
}
function drawScene() {
  if (isMap) {
    const index = Math.min(spec.markers.length - 1, Math.floor(progress * spec.markers.length))
    const selected = spec.markers[index]?.id
    SceneRenderers.renderMap(spec, canvas, canvas.width, canvas.height, { selected }, palette)
    renderReadout([
      ['selected', selected ?? '—'],
      ['markers', String(spec.markers.length)],
    ])
    timeLabel.textContent = (progress * timeline.duration).toFixed(2) + ' s'
    return
  }
  if (isNetworkGraph) {
    const index = Math.min(spec.nodes.length - 1, Math.floor(progress * spec.nodes.length))
    const selected = spec.nodes[index]?.id
    const neighbours = selected === undefined ? [] : spec.edges.filter(edge => edge.from === selected || edge.to === selected).length
    SceneRenderers.renderNetworkGraph(spec, canvas, canvas.width, canvas.height, { selected }, palette)
    renderReadout([
      ['selected', selected ?? '—'],
      ['neighbours', String(neighbours)],
      ['nodes', String(spec.nodes.length)],
      ['edges', String(spec.edges.length)],
    ])
    timeLabel.textContent = (progress * timeline.duration).toFixed(2) + ' s'
    return
  }
  if (isTimeline) {
    const playhead = minTime + progress * (maxTime - minTime)
    SceneRenderers.renderTimeline(spec, canvas, canvas.width, canvas.height, { playhead }, palette)
    const currentEvent = spec.events.filter(event => event.time <= playhead).at(-1)
    renderReadout([
      ['playhead', playhead.toFixed(2)],
      ['events', String(spec.events.length)],
      ['current', currentEvent?.label ?? '—'],
      ['span', (maxTime - minTime).toFixed(2)],
    ])
    timeLabel.textContent = playhead.toFixed(2) + ' s'
    return
  }
  if (isFlowchart) {
    pathIndex = Math.min(path.length - 1, Math.floor(progress * path.length))
    SceneRenderers.renderFlowchart(spec, canvas, canvas.width, canvas.height, { selected: path[pathIndex] ?? path[0], pathIndex }, palette)
    renderReadout([
      ['node', path[pathIndex] ?? '—'],
      ['path', path.length > 0 ? (pathIndex + 1) + '/' + path.length : '—'],
      ['nodes', String(spec.nodes.length)],
      ['edges', String(spec.edges.length)],
    ])
    timeLabel.textContent = (progress * timeline.duration).toFixed(2) + ' s'
    return
  }
  if (isParticleSystem) {
    const state = progress === 0 ? particleBaseState
      : SceneRenderers.particleStateAtTime(spec, progress * timeline.duration, particleCheckpoint)
    SceneRenderers.renderParticleSystem(spec, canvas, canvas.width, canvas.height, state, palette)
    renderReadout([
      ['time', state.time.toFixed(2)],
      ['particles', String(state.particles.length)],
      ['gravity', spec.gravity.x.toFixed(2) + ', ' + spec.gravity.y.toFixed(2)],
      ['dt', spec.timeStep.toFixed(3)],
    ])
    timeLabel.textContent = state.time.toFixed(2) + ' s'
    return
  }
  const [xMin, xMax] = spec.viewport.x
  const traceX = xMin + progress * (xMax - xMin)
  SceneRenderers.renderFunctionPlot(spec, canvas, canvas.width, canvas.height, {
    traceX, scale: 1, pan: 0, parameters,
    showDerivative: spec.trace.derivative, showIntegral: spec.trace.integral,
  }, palette)
  const analysis = SceneRenderers.analyzeFunction(functions[0].node, parameters, traceX)
  renderReadout([
    ['x', traceX.toFixed(2)],
    ['f(x)', formatMeasurement(analysis.value)],
    ['f′(x)', formatMeasurement(analysis.derivative)],
    ['∫', formatMeasurement(analysis.integral)],
  ])
  timeLabel.textContent = (progress * timeline.duration).toFixed(2) + ' s'
}
function stopPlayback() {
  playing = false
  cancelAnimationFrame(frame)
  playButton.dataset.active = 'false'
  playButton.textContent = 'Play'
}
function draw() {
  try {
    drawScene()
    errorNotice.hidden = true
    errorNotice.textContent = ''
    return true
  } catch (error) {
    if (!(error instanceof SceneRenderers.ParticleRuntimeError)) throw error
    stopPlayback()
    activeRecording?.fail()
    errorNotice.textContent = 'The simulation cannot continue at this time. Reset or choose an earlier time.'
    errorNotice.hidden = false
    return false
  }
}
function tick(now) {
  if (!playing) return
  if (lastTime === 0) lastTime = now
  const delta = (now - lastTime) / 1000
  lastTime = now
  progress += delta / timeline.duration
  if (progress > 1) progress = 0
  scrub.value = String(progress)
  if (!draw()) return
  frame = requestAnimationFrame(tick)
}
playButton.addEventListener('click', () => {
  playing = !playing
  playButton.dataset.active = String(playing)
  playButton.textContent = playing ? 'Pause' : 'Play'
  if (playing) { lastTime = 0; frame = requestAnimationFrame(tick) }
  else cancelAnimationFrame(frame)
})
document.getElementById('reset').addEventListener('click', () => {
  stopPlayback()
  progress = 0
  scrub.value = '0'
  draw()
})
scrub.addEventListener('input', () => {
  progress = Number(scrub.value)
  draw()
})
document.getElementById('record').addEventListener('click', () => {
  if (activeRecording !== null || typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') return
  const stream = canvas.captureStream(timeline.fps)
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' })
  const chunks = []
  let failed = false
  let recordingTimer
  activeRecording = { recorder, fail() {
    failed = true
    if (recorder.state !== 'inactive') recorder.stop()
  } }
  recorder.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data) }
  recorder.onstop = () => {
    window.clearTimeout(recordingTimer)
    activeRecording = null
    if (!failed) {
      const blob = new Blob(chunks, { type: 'video/webm' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'scene-animation.webm'
      anchor.click()
      URL.revokeObjectURL(url)
    }
    for (const track of stream.getTracks()) track.stop()
  }
  recorder.start()
  if (!playing) playButton.click()
  recordingTimer = window.setTimeout(() => {
    if (recorder.state !== 'inactive') recorder.stop()
    if (playing) playButton.click()
  }, timeline.duration * 1000)
})
document.getElementById('legend').replaceChildren(...functions.map((fn, index) => {
  const item = document.createElement('span')
  const swatch = document.createElement('i')
  if (index !== 0) swatch.className = 'alt'
  item.append(swatch, document.createTextNode(fn.label))
  return item
}))
draw()
</script>
</body>
</html>
`
}
