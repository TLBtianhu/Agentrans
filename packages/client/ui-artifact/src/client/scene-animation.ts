/** Standalone HTML animation export for validated SceneSpec values. */
import type { FunctionPlotSpec, FlowchartSpec, ParticleSystemSpec, TimelineSpec } from '@deepseek-ai/dsh-artifact/scene'
import { sceneExprBundle } from './scene-expr.generated.ts'
import { sceneRenderersBundle } from './scene-renderers.generated.ts'

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Build a self-contained HTML animation program from a validated SceneSpec.
 * @param spec - SceneSpec to replay (function-plot, flowchart, or particle-system).
 * @param title - Document title for the exported page.
 * @returns A complete HTML document with an inline parser, shared renderers, and timeline player.
 */
export function buildSceneAnimationHtml(spec: FunctionPlotSpec | FlowchartSpec | ParticleSystemSpec | TimelineSpec, title: string): string {
  const specJson = JSON.stringify(spec)
  const titleHtml = escapeHtml(title)
  const timeline = spec.timeline ?? { duration: 8, fps: 30 }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleHtml} · animation</title>
<style>
:root { color-scheme: light dark; --bg:#f4f5f7; --ink:#17202b; --muted:#647184; --accent:#4f56c7; --good:#147a5b; --grid:rgba(82,96,128,0.14); --border:rgba(68,83,112,0.2); }
@media (prefers-color-scheme: dark) { :root { --bg:#101318; --ink:#edf2fb; --muted:#a1aec2; --accent:#a5b4fc; --good:#62d5a8; --grid:rgba(185,202,231,0.14); --border:rgba(184,202,232,0.22); } }
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
  <div class="legend" id="legend"></div>
  <canvas id="plot" width="900" height="420" role="img" aria-label="SceneSpec animation"></canvas>
  <div class="readout" id="readout" role="status" aria-live="polite"></div>
  <div class="controls">
    <button id="play" type="button" data-active="false">Play</button>
    <button id="record" type="button">Download WebM</button>
    <input id="scrub" type="range" min="0" max="1" step="0.001" value="0" aria-label="Timeline">
    <span id="time" class="meta">0.00 s</span>
  </div>
</main>
<script>${sceneExprBundle}</script>
<script>${sceneRenderersBundle}</script>
<script>
const spec = ${specJson}
const isFlowchart = spec.kind === 'flowchart'
const isParticleSystem = spec.kind === 'particle-system'
const isTimeline = spec.kind === 'timeline'
const path = isFlowchart ? (spec.path ?? []) : []
const timelineTimes = isTimeline ? spec.events.map(event => event.time) : []
const minTime = timelineTimes.length > 0 ? Math.min(...timelineTimes) : 0
const maxTime = timelineTimes.length > 0 ? Math.max(...timelineTimes) : 1
let pathIndex = 0
const parameters = Object.fromEntries(Object.entries(spec.parameters ?? {}).map(([key, value]) => [key, value.value]))
const functions = isFlowchart || isParticleSystem || isTimeline ? [] : spec.functions.map(fn => ({ ...fn, node: SceneExpr.parseExpression(fn.expression, Object.keys(spec.parameters)) }))
const canvas = document.getElementById('plot')
const context = canvas.getContext('2d')
const scrub = document.getElementById('scrub')
const playButton = document.getElementById('play')
const timeLabel = document.getElementById('time')
const readout = document.getElementById('readout')
const timeline = ${JSON.stringify(timeline)}
let progress = 0
let playing = false
let frame = 0
let lastTime = 0

function evaluateAt(fn, x) {
  return SceneExpr.evaluateExpression(fn.node, { ...parameters, x, t: x, pi: Math.PI, e: Math.E })
}
function derivativeAt(x) {
  const h = 0.001
  const fn = functions[0]
  return (evaluateAt(fn, x + h) - evaluateAt(fn, x - h)) / (2 * h)
}
function integralAt(x) {
  const fn = functions[0]
  const steps = 200
  const width = x / steps
  let total = 0
  for (let index = 0; index <= steps; index++) {
    const weight = index === 0 || index === steps ? 0.5 : 1
    total += evaluateAt(fn, index * width) * weight
  }
  return total * width
}
function simulateParticles(time) {
  const steps = Math.max(0, Math.floor(time / spec.timeStep))
  const particles = spec.particles.map(particle => {
    let x = particle.x
    let y = particle.y
    let vx = particle.vx
    let vy = particle.vy
    const trail = [{ x, y }]
    for (let index = 0; index < steps; index++) {
      vx += spec.gravity.x * spec.timeStep
      vy += spec.gravity.y * spec.timeStep
      x += vx * spec.timeStep
      y += vy * spec.timeStep
      if (spec.trails) trail.push({ x, y })
    }
    return { ...particle, x, y, vx, vy, trail }
  })
  const trails = {}
  for (const particle of particles) trails[particle.id] = particle.trail
  return { particles, trails }
}
function draw() {
  if (isTimeline) {
    const playhead = minTime + progress * (maxTime - minTime)
    SceneRenderers.renderTimeline(spec, canvas, canvas.width, canvas.height, { playhead })
    const currentEvent = spec.events.filter(event => event.time <= playhead).at(-1)
    readout.innerHTML = [
      ['playhead', playhead.toFixed(2)],
      ['events', String(spec.events.length)],
      ['current', currentEvent?.label ?? '—'],
      ['span', (maxTime - minTime).toFixed(2)],
    ].map(([label, text]) => '<div><span>' + label + '</span><strong>' + text + '</strong></div>').join('')
    timeLabel.textContent = playhead.toFixed(2) + ' s'
    return
  }
  if (isFlowchart) {
    pathIndex = Math.min(path.length - 1, Math.floor(progress * path.length))
    SceneRenderers.renderFlowchart(spec, canvas, canvas.width, canvas.height, { selected: path[pathIndex] ?? path[0], pathIndex })
    readout.innerHTML = [
      ['node', path[pathIndex] ?? '—'],
      ['path', path.length > 0 ? (pathIndex + 1) + '/' + path.length : '—'],
      ['nodes', String(spec.nodes.length)],
      ['edges', String(spec.edges.length)],
    ].map(([label, text]) => '<div><span>' + label + '</span><strong>' + text + '</strong></div>').join('')
    timeLabel.textContent = (progress * timeline.duration).toFixed(2) + ' s'
    return
  }
  if (isParticleSystem) {
    const { particles, trails } = simulateParticles(progress * timeline.duration)
    SceneRenderers.renderParticleSystem(spec, canvas, canvas.width, canvas.height, { time: progress * timeline.duration, particles, trails })
    readout.innerHTML = [
      ['time', (progress * timeline.duration).toFixed(2)],
      ['particles', String(particles.length)],
      ['gravity', spec.gravity.x.toFixed(2) + ', ' + spec.gravity.y.toFixed(2)],
      ['dt', spec.timeStep.toFixed(3)],
    ].map(([label, text]) => '<div><span>' + label + '</span><strong>' + text + '</strong></div>').join('')
    timeLabel.textContent = (progress * timeline.duration).toFixed(2) + ' s'
    return
  }
  const [xMin, xMax] = spec.viewport.x
  const traceX = xMin + progress * (xMax - xMin)
  SceneRenderers.renderFunctionPlot(spec, canvas, canvas.width, canvas.height, {
    traceX, scale: 1, pan: 0, parameters,
    showDerivative: spec.trace.derivative, showIntegral: spec.trace.integral,
  })
  readout.innerHTML = [
    ['x', traceX.toFixed(2)],
    ['f(x)', evaluateAt(functions[0], traceX).toFixed(3)],
    ['f′(x)', derivativeAt(traceX).toFixed(3)],
    ['∫', integralAt(traceX).toFixed(3)],
  ].map(([label, text]) => '<div><span>' + label + '</span><strong>' + text + '</strong></div>').join('')
  timeLabel.textContent = (progress * timeline.duration).toFixed(2) + ' s'
}
function tick(now) {
  if (!playing) return
  if (lastTime === 0) lastTime = now
  const delta = (now - lastTime) / 1000
  lastTime = now
  progress += delta / timeline.duration
  if (progress > 1) progress = 0
  scrub.value = String(progress)
  draw()
  frame = requestAnimationFrame(tick)
}
playButton.addEventListener('click', () => {
  playing = !playing
  playButton.dataset.active = String(playing)
  playButton.textContent = playing ? 'Pause' : 'Play'
  if (playing) { lastTime = 0; frame = requestAnimationFrame(tick) }
  else cancelAnimationFrame(frame)
})
scrub.addEventListener('input', () => {
  progress = Number(scrub.value)
  draw()
})
document.getElementById('record').addEventListener('click', () => {
  if (typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') return
  const stream = canvas.captureStream(timeline.fps)
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' })
  const chunks = []
  recorder.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data) }
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'video/webm' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'scene-animation.webm'
    anchor.click()
    URL.revokeObjectURL(url)
    for (const track of stream.getTracks()) track.stop()
  }
  recorder.start()
  if (!playing) playButton.click()
  window.setTimeout(() => {
    recorder.stop()
    if (playing) playButton.click()
  }, timeline.duration * 1000)
})
document.getElementById('legend').innerHTML = functions.map((fn, index) =>
  '<span><i class="' + (index === 0 ? '' : 'alt') + '"></i>' + fn.label + '</span>').join('')
draw()
</script>
</body>
</html>
`
}
