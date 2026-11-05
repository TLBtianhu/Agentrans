/** Standalone HTML animation export for a validated FunctionPlot SceneSpec. */
import type { FunctionPlotSpec } from '@deepseek-ai/dsh-artifact/scene'
import { sceneExprBundle } from './scene-expr.generated.ts'

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Build a self-contained HTML animation program from a validated SceneSpec.
 * @param spec - Function-plot SceneSpec to replay.
 * @param title - Document title for the exported page.
 * @returns A complete HTML document with an inline parser, scene data, and timeline player.
 */
export function buildSceneAnimationHtml(spec: FunctionPlotSpec, title: string): string {
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
  <canvas id="plot" width="900" height="420" role="img" aria-label="Function plot animation"></canvas>
  <div class="readout" id="readout" role="status" aria-live="polite"></div>
  <div class="controls">
    <button id="play" type="button" data-active="false">Play</button>
    <button id="record" type="button">Download WebM</button>
    <input id="scrub" type="range" min="0" max="1" step="0.001" value="0" aria-label="Timeline">
    <span id="time" class="meta">0.00 s</span>
  </div>
</main>
<script>${sceneExprBundle}</script>
<script>
const spec = ${specJson}
const parameters = Object.fromEntries(Object.entries(spec.parameters).map(([key, value]) => [key, value.value]))
const functions = spec.functions.map(fn => ({ ...fn, node: SceneExpr.parseExpression(fn.expression, Object.keys(spec.parameters)) }))
const canvas = document.getElementById('plot')
const context = canvas.getContext('2d')
const scrub = document.getElementById('scrub')
const playButton = document.getElementById('play')
const timeLabel = document.getElementById('time')
const readout = document.getElementById('readout')
const timeline = ${JSON.stringify(timeline)}
const totalFrames = Math.max(1, Math.round(timeline.duration * timeline.fps))
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
function draw() {
  const [xMin, xMax] = spec.viewport.x
  const [yMin, yMax] = spec.viewport.y
  const xToPixel = x => ((x - xMin) / (xMax - xMin)) * canvas.width
  const yToPixel = y => canvas.height - ((y - yMin) / (yMax - yMin)) * canvas.height
  const pixelToX = pixel => xMin + (pixel / canvas.width) * (xMax - xMin)
  const traceX = xMin + progress * (xMax - xMin)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.strokeStyle = getComputedStyle(canvas).getPropertyValue('--grid')
  context.lineWidth = 1
  for (let index = 0; index <= 6; index++) {
    const x = xMin + (index / 6) * (xMax - xMin)
    context.beginPath(); context.moveTo(xToPixel(x), 0); context.lineTo(xToPixel(x), canvas.height); context.stroke()
  }
  for (let index = 0; index <= 4; index++) {
    const y = yMin + (index / 4) * (yMax - yMin)
    context.beginPath(); context.moveTo(0, yToPixel(y)); context.lineTo(canvas.width, yToPixel(y)); context.stroke()
  }
  const accent = getComputedStyle(canvas).getPropertyValue('--accent')
  const good = getComputedStyle(canvas).getPropertyValue('--good')
  if (spec.trace.integral) {
    context.fillStyle = good
    context.globalAlpha = 0.1
    context.beginPath()
    context.moveTo(xToPixel(xMin), yToPixel(0))
    for (let pixel = 0; pixel <= canvas.width; pixel++) {
      const x = pixelToX(pixel)
      if (x > traceX) break
      context.lineTo(pixel, yToPixel(evaluateAt(functions[0], x)))
    }
    context.lineTo(xToPixel(traceX), yToPixel(0))
    context.closePath(); context.fill(); context.globalAlpha = 1
  }
  for (const [index, fn] of functions.entries()) {
    context.strokeStyle = index === 0 ? accent : good
    context.lineWidth = index === 0 ? 2.5 : 1.5
    context.globalAlpha = index === 0 ? 1 : 0.5
    context.beginPath()
    let drawing = false
    for (let pixel = 0; pixel <= canvas.width; pixel++) {
      const y = evaluateAt(fn, pixelToX(pixel))
      if (!Number.isFinite(y)) { drawing = false; continue }
      if (drawing) context.lineTo(pixel, yToPixel(y))
      else { context.moveTo(pixel, yToPixel(y)); drawing = true }
    }
    context.stroke()
  }
  context.globalAlpha = 1
  if (spec.trace.derivative) {
    const slope = derivativeAt(traceX)
    const value = evaluateAt(functions[0], traceX)
    context.strokeStyle = accent
    context.setLineDash([4, 4])
    context.beginPath()
    for (let pixel = 0; pixel <= canvas.width; pixel++) {
      const x = pixelToX(pixel)
      const y = value + slope * (x - traceX)
      if (pixel === 0) context.moveTo(pixel, yToPixel(y))
      else context.lineTo(pixel, yToPixel(y))
    }
    context.stroke(); context.setLineDash([])
  }
  context.strokeStyle = getComputedStyle(canvas).getPropertyValue('--muted')
  context.setLineDash([3, 3])
  context.beginPath(); context.moveTo(xToPixel(traceX), 0); context.lineTo(xToPixel(traceX), canvas.height); context.stroke()
  context.setLineDash([])
  context.beginPath(); context.arc(xToPixel(traceX), yToPixel(evaluateAt(functions[0], traceX)), 4.5, 0, Math.PI * 2)
  context.fillStyle = good; context.fill()
  context.fillStyle = getComputedStyle(canvas).getPropertyValue('--muted')
  context.font = '10px ui-monospace, monospace'
  for (let index = 0; index <= 6; index++) {
    const x = xMin + (index / 6) * (xMax - xMin)
    context.fillText(x.toFixed(1), xToPixel(x) + 4, canvas.height - 4)
  }
  for (let index = 0; index <= 4; index++) {
    const y = yMin + (index / 4) * (yMax - yMin)
    context.fillText(y.toFixed(1), 5, yToPixel(y) - 7)
  }
  const value = evaluateAt(functions[0], traceX)
  readout.innerHTML = [
    ['x', traceX.toFixed(2)],
    ['f(x)', value.toFixed(3)],
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
