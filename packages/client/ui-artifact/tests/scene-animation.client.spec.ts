// @vitest-environment jsdom
import { JSDOM, VirtualConsole } from 'jsdom'
import { describe, expect, it, onTestFinished } from 'vitest'
import { buildSceneAnimationHtml } from '../src/client/scene-animation.ts'
import type { FunctionPlotSpec } from '@agentrans/artifact/scene'

const spec: FunctionPlotSpec = {
  kind: 'function-plot',
  functions: [{ id: 'sine', label: 'sin(x)', expression: 'sin(x)' }],
  parameters: { a: { value: 1, min: -2, max: 2, step: 0.1 } },
  viewport: { x: [-6, 6], y: [-2, 2] },
  trace: { x: 1, derivative: true, integral: false },
  timeline: { duration: 6, fps: 30 },
}

function animationDocument(scene: Parameters<typeof buildSceneAnimationHtml>[0], title: string) {
  const errors: Error[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => { errors.push(error) })
  const dom = new JSDOM(buildSceneAnimationHtml(scene, title), {
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      // jsdom has no canvas backend; the exported DOM and script still execute.
      Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', { value: () => null })
    },
  })
  onTestFinished(() => { dom.window.close(); expect(errors).toEqual([]) })
  expect(errors).toEqual([])
  return dom.window.document
}

describe('scene animation export', () => {
  it.each([
    '</script><script>document.body.dataset.injected="script"</script>',
    '<!--<script> & math < 2 > 1',
    'quote " and apostrophe \' · 行\u2028段\u2029尾',
  ])('preserves a function label as text without changing the exported scripts: %s', (label) => {
    const document = animationDocument({ ...spec, functions: [{ ...spec.functions[0]!, label }] }, 'Safe export')
    expect(document.scripts).toHaveLength(3)
    expect(document.body.dataset.injected).toBeUndefined()
    expect(document.getElementById('legend')?.textContent).toBe(label)
    expect(document.getElementById('readout')?.textContent).toContain('f(x)')
  })

  it('shows markup in titles and function labels literally', () => {
    const label = '<img id="label-injection" src="x" onerror="document.body.dataset.injected=1"> & signal'
    const title = '<img id="title-injection" src="x"> & graph'
    const document = animationDocument({ ...spec, functions: [{ ...spec.functions[0]!, label }] }, title)
    expect(document.title).toBe(`${title} · animation`)
    expect(document.querySelector('h1')?.textContent).toBe(title)
    expect(document.getElementById('legend')?.textContent).toBe(label)
    expect(document.querySelector('img')).toBeNull()
  })

  it('keeps timeline labels as text in the readout after scrubbing', () => {
    const label = '<svg id="readout-injection" onload="document.body.dataset.injected=1"></svg> & event'
    const document = animationDocument({
      kind: 'timeline',
      events: [{ id: 'start', label: 'Start', time: 0 }, { id: 'end', label, time: 2 }],
      playhead: 0,
    }, 'Timeline')
    const scrub = document.getElementById('scrub')
    if (!(scrub instanceof document.defaultView!.HTMLInputElement)) throw new Error('Missing timeline scrubber')
    scrub.value = '1'
    scrub.dispatchEvent(new document.defaultView!.Event('input'))
    expect(document.getElementById('readout')?.textContent).toContain(label)
    expect(document.getElementById('readout-injection')).toBeNull()
    expect(document.querySelector('svg')).toBeNull()
  })

  it.each([
    { expression: 'sqrt(x)', range: [0, 4] as const, progress: '0', value: '0.000' },
    { expression: 'log(x)', range: [0, 4] as const, progress: '0', value: '—' },
    { expression: '1/x', range: [-1, 1] as const, progress: '0.5', value: '—' },
  ])('keeps $expression playable across undefined analysis points', ({ expression, range, progress, value }) => {
    const document = animationDocument({
      ...spec,
      functions: [{ id: 'domain', label: expression, expression }],
      viewport: { x: range, y: [-3, 3] },
      trace: { x: 0, derivative: false, integral: false },
    }, 'Function domains')
    const scrub = document.getElementById('scrub')
    if (!(scrub instanceof document.defaultView!.HTMLInputElement)) throw new Error('Missing function scrubber')
    scrub.value = progress
    scrub.dispatchEvent(new document.defaultView!.Event('input'))
    const measurements = [...document.querySelectorAll('#readout strong')].map(element => element.textContent)
    expect(measurements[1]).toBe(value)
    expect(measurements).toContain('—')
    expect(document.getElementById('readout')?.textContent).not.toMatch(/NaN|Infinity/)
  })

  it('embeds the SceneSpec, the safe parser, and a timeline player', () => {
    const html = buildSceneAnimationHtml(spec, 'Damped oscillator')
    expect(html).toContain('SceneExpr.parseExpression')
    expect(html).toContain('Damped oscillator')
    expect(html).toContain('id="play"')
    expect(html).toContain('id="scrub"')
    expect(html).toContain('id="record"')
    expect(html).toContain('MediaRecorder')
    expect(html).toContain('spec = {"kind":"function-plot"')
    expect(html).not.toContain('<script src=')
  })

  it('exports a flowchart replay with path advancement', () => {
    const flowchart = {
      kind: 'flowchart' as const,
      nodes: [
        { id: 'a', label: 'Collect', x: 0, y: 0 },
        { id: 'b', label: 'Analyze', x: 1, y: 0 },
        { id: 'c', label: 'Decide', x: 2, y: 0 },
      ],
      edges: [{ from: 'a', to: 'b', label: 'data' }, { from: 'b', to: 'c', label: 'insight' }],
      path: ['a', 'b', 'c'],
    }
    const html = buildSceneAnimationHtml(flowchart, 'Inquiry flow')
    expect(html).toContain('"kind":"flowchart"')
    expect(html).toContain('scenePrimitives')
    expect(html).toContain('pathIndex')
    expect(html).toContain('id="record"')
  })

  it('exports a particle-system replay with deterministic physics', () => {
    const system = {
      kind: 'particle-system' as const,
      particles: [{ id: 'p1', x: 0, y: 10, vx: 1, vy: 0, mass: 2 }],
      gravity: { x: 0, y: -9.8 },
      timeStep: 0.02,
      trails: true,
    }
    const html = buildSceneAnimationHtml(system, 'Gravity lab')
    expect(html).toContain('"kind":"particle-system"')
    expect(html).toContain('scenePrimitives')
    expect(html).toContain('spec.timeStep')
    expect(html).toContain('isFlowchart || isParticleSystem || isTimeline || isNetworkGraph || isMap ? [] : spec.functions.map')
    expect(html).toContain('id="record"')
  })

  it('exports a timeline replay with a movable playhead', () => {
    const timeline = {
      kind: 'timeline' as const,
      events: [
        { id: 'start', label: 'Start', time: 0 },
        { id: 'middle', label: 'Middle', time: 5 },
        { id: 'end', label: 'End', time: 10 },
      ],
      playhead: 0,
    }
    const html = buildSceneAnimationHtml(timeline, 'History')
    expect(html).toContain('"kind":"timeline"')
    expect(html).toContain('scenePrimitives')
    expect(html).toContain('playhead')
    expect(html).toContain('id="record"')
  })

  it('exports a network-graph replay with node stepping', () => {
    const graph = {
      kind: 'network-graph' as const,
      nodes: [
        { id: 'client', label: 'Client', x: 0, y: 0 },
        { id: 'edge', label: 'Edge', x: 1, y: 0 },
        { id: 'origin', label: 'Origin', x: 2, y: 0 },
      ],
      edges: [{ from: 'client', to: 'edge' }, { from: 'edge', to: 'origin' }],
    }
    const html = buildSceneAnimationHtml(graph, 'Request graph')
    expect(html).toContain('"kind":"network-graph"')
    expect(html).toContain('renderNetworkGraph')
    expect(html).toContain('selected')
    expect(html).toContain('id="record"')
  })

  it('exports a map replay with marker stepping', () => {
    const map = {
      kind: 'map' as const,
      markers: [
        { id: 'client', label: 'Client', x: 0, y: 0 },
        { id: 'edge', label: 'Edge', x: 1, y: 0 },
        { id: 'origin', label: 'Origin', x: 2, y: 0 },
      ],
      path: ['client', 'edge', 'origin'],
    }
    const html = buildSceneAnimationHtml(map, 'Route map')
    expect(html).toContain('"kind":"map"')
    expect(html).toContain('renderMap')
    expect(html).toContain('selected')
    expect(html).toContain('id="record"')
  })
})
