import { JSDOM, VirtualConsole } from 'jsdom'
import { describe, expect, it, onTestFinished } from 'vitest'
import { buildSceneAnimationHtml, FUNCTION_PLOT_BASELINE_EXPORTER_VERSION, SCENE_EXPORTER_VERSION, type SceneExportOrigin } from '../src/scene-export.ts'
import { normalizeFunctionPlot, type CsvBarChartSpec, type FunctionPlotSpec, type ParticleSystemSpec } from '../src/scene.ts'
import { observeParticleState, restoreParticleCheckpoint } from '../src/particle-runtime.ts'
import { analyzeFunctionPlotSelection } from '../src/renderers/function-analysis.ts'

const particles: ParticleSystemSpec = {
  kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 1, vx: 3, vy: 8, mass: 1 }],
  gravity: { x: 0, y: -9.8 }, timeStep: 1 / 30, trails: true,
}

function exportedDocument(html: string): Document {
  const errors: Error[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => { errors.push(error) })
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', virtualConsole, pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', { value: () => null })
    },
  })
  onTestFinished(() => { dom.window.close(); expect(errors).toEqual([]) })
  expect(errors).toEqual([])
  return dom.window.document
}

describe('shared standalone SceneSpec export', () => {
  it('generates an HTML program on a Host without a browser environment', () => {
    expect(typeof document).toBe('undefined')
    const html = buildSceneAnimationHtml(particles, 'Host export', { runtimeVersion: 1, stepCount: 6 })
    expect(html).toContain('const particleCheckpoint = {"runtimeVersion":1,"stepCount":6}')
    expect(html).not.toContain('id="artifact-export-origin-data"')
    expect(html).not.toContain('<script src=')
  })

  it('embeds the fixed source identity and the resolved particle checkpoint as inert JSON', () => {
    const origin: SceneExportOrigin = {
      exporterVersion: SCENE_EXPORTER_VERSION, exportId: 'export-six', sessionId: 'source-session', artifactId: 'fall', revision: 1,
      observationId: 'saved-six',
    }
    const checkpoint = { runtimeVersion: 1, stepCount: 6 } as const
    const document = exportedDocument(buildSceneAnimationHtml(particles, 'Saved run', checkpoint, origin))
    const metadata = document.getElementById('artifact-export-origin-data')
    expect(metadata?.getAttribute('type')).toBe('application/json')
    expect(JSON.parse(metadata?.textContent ?? '')).toEqual({ ...origin, checkpoint })
    expect(document.getElementById('artifact-export-origin')?.textContent).toBe('fall · revision 1 · runtime 1 · step 6')
    expect(document.getElementById('time')?.textContent).toBe('0.20 s')
    expect(document.getElementById('particle-readings')).toBeNull()
  })

  it('shows returned particle readings at the locked step and restores them after seeking', () => {
    const scene = { ...particles, gravity: { x: 0, y: -5 } }
    const checkpoint = { runtimeVersion: 1, stepCount: 6 } as const
    const origin: SceneExportOrigin = {
      exporterVersion: SCENE_EXPORTER_VERSION, exportId: 'return-9', sessionId: 'parent', artifactId: 'fall', revision: 2,
      returnedEvidence: { eventSeq: 9, messageId: 'returned-run' },
    }
    const document = exportedDocument(buildSceneAnimationHtml(scene, 'Returned run', checkpoint, origin))
    const readout = (name: string) => [...document.querySelectorAll('#readout > div')]
      .find(row => row.querySelector('span')?.textContent === name)?.querySelector('strong')?.textContent
    const readings = () => Object.fromEntries([...document.querySelectorAll('#particle-readings [data-particle-coordinate]')]
      .map(cell => [cell.getAttribute('data-particle-coordinate') ?? '', Number(cell.textContent)] as const))
    const locked = observeParticleState(restoreParticleCheckpoint(scene, checkpoint)).particles[0]!
    const expected = { x: locked.x, y: locked.y, vx: locked.vx, vy: locked.vy }
    const originData = document.getElementById('artifact-export-origin-data')?.textContent
    expect(JSON.parse(originData ?? '')).toEqual({ ...origin, checkpoint })
    expect(readout('step')).toBe('6')
    expect(readout('gravity')).toBe('0.00, -5.00')
    expect(document.querySelector('#particle-readings tr[data-particle-id] th')?.textContent).toBe(locked.id)
    expect(readings()).toEqual(expected)
    const scrub = document.querySelector<HTMLInputElement>('#scrub')!
    scrub.value = '0.5'
    scrub.dispatchEvent(new document.defaultView!.Event('input'))
    expect(Number(readout('step'))).toBeGreaterThan(6)
    expect(readings()).not.toEqual(expected)
    document.querySelector<HTMLButtonElement>('#reset')!.click()
    expect(readout('step')).toBe('6')
    expect(readings()).toEqual(expected)
  })

  it('keeps source labels and identity strings from escaping scripts or adding markup', () => {
    const artifactId = '</script><script>document.body.dataset.injected="identity"</script><img src=x>'
    const origin: SceneExportOrigin = { exporterVersion: 1, exportId: '<!--', artifactId, revision: 2 }
    const document = exportedDocument(buildSceneAnimationHtml(particles, 'Safe source', undefined, origin))
    expect(document.body.dataset.injected).toBeUndefined()
    expect(document.querySelector('img')).toBeNull()
    expect(document.scripts).toHaveLength(4)
    expect(JSON.parse(document.getElementById('artifact-export-origin-data')?.textContent ?? '')).toEqual({
      ...origin, checkpoint: { runtimeVersion: 1, stepCount: 0 },
    })
    expect(document.getElementById('artifact-export-origin')?.textContent).toContain(artifactId)
  })

  it('labels non-particle replay as source defaults without claiming a runtime checkpoint', () => {
    const origin: SceneExportOrigin = { exporterVersion: 1, exportId: 'timeline-export', artifactId: 'timeline', revision: 3 }
    const document = exportedDocument(buildSceneAnimationHtml({
      kind: 'timeline', events: [{ id: 'start', label: 'Start', time: 0 }], playhead: 0,
    }, 'Timeline', undefined, origin))
    expect(JSON.parse(document.getElementById('artifact-export-origin-data')?.textContent ?? '')).toEqual(origin)
    expect(document.getElementById('artifact-export-origin')?.textContent).toBe('timeline · revision 3 · Source defaults')
  })

  it('starts and resets at the locked function, parameters, and off-viewport position', () => {
    const spec: FunctionPlotSpec = {
      kind: 'function-plot',
      functions: [{ id: 'line', label: 'Reference line', expression: 'x' },
        { id: 'quadratic', label: 'Selected parabola', expression: 'a*x^2' }],
      parameters: { a: { value: 1, min: 1, max: 2, step: 0.25 } },
      viewport: { x: [-2, 2], y: [-2, 2] }, trace: { x: 1, derivative: true, integral: true },
    }
    const origin: SceneExportOrigin = {
      exporterVersion: FUNCTION_PLOT_BASELINE_EXPORTER_VERSION, exportId: 'export-lock', artifactId: 'plot', revision: 1,
    }
    const baseline = { functionId: 'quadratic', x: 8, parameters: { a: 1.25 },
      values: { value: 80, derivative: 20, integral: 640 / 3 } }
    const document = exportedDocument(buildSceneAnimationHtml(spec, 'Locked plot', undefined, origin, baseline))
    const readout = () => Object.fromEntries([...document.querySelectorAll('#readout > div')]
      .map(row => [row.querySelector('span')?.textContent ?? '', row.querySelector('strong')?.textContent ?? ''] as const))
    const originData = document.getElementById('artifact-export-origin-data')?.textContent
    expect(JSON.parse(originData ?? '')).toEqual({ ...origin, functionPlotBaseline: baseline })
    const expected = { Function: 'Selected parabola', a: '1.25', x: '8.00', 'f(x)': '80.000', 'f′(x)': '20.000' }
    expect(readout()).toMatchObject(expected)
    const scrub = document.querySelector<HTMLInputElement>('#scrub')!
    scrub.value = '1'
    scrub.dispatchEvent(new document.defaultView!.Event('input'))
    expect(readout()).toMatchObject({ Function: 'Selected parabola', a: '1.25', x: '10.00', 'f′(x)': '25.000' })
    document.querySelector<HTMLButtonElement>('#reset')!.click()
    expect(readout()).toMatchObject(expected)
  })

  it('replays the first matching function in an archived plot follow-up with a repeated ID', () => {
    const spec = normalizeFunctionPlot({
      kind: 'function-plot',
      functions: [{ id: 'curve', label: 'Archived line', expression: 'x' },
        { id: 'curve', label: 'Archived parabola', expression: 'x^2' }],
      parameters: {}, viewport: { x: [-3, 3], y: [-2, 5] }, trace: { x: 0, derivative: true, integral: false },
    })
    const conditions = { functionId: 'curve', x: 2, parameters: {} }
    const values = analyzeFunctionPlotSelection(spec, conditions)
    expect(values?.value).toBe(2)
    if (values === undefined) throw new Error('expected the archived selection to remain valid')
    const origin: SceneExportOrigin = {
      exporterVersion: FUNCTION_PLOT_BASELINE_EXPORTER_VERSION, exportId: 'question-12', artifactId: 'archived', revision: 1,
      sentQuestion: { eventSeq: 12, messageId: 'archived-question' },
    }
    const document = exportedDocument(buildSceneAnimationHtml(spec, 'Archived follow-up', undefined, origin, { ...conditions, values }))
    expect(document.querySelector('#readout')?.textContent).toContain('FunctionArchived line')
    expect(document.querySelector('#readout')?.textContent).toContain('f(x)2.000')
  })

  it('keeps CSV labels as text and exposes the frozen revision through offline controls', () => {
    const groupKey = '</script><img src=x onerror="alert(1)">'
    const spec: CsvBarChartSpec = { kind: 'csv-bar-chart', attachmentId: `sha256:${'a'.repeat(64)}` as CsvBarChartSpec['attachmentId'],
      groupBy: 'Trial', valueColumn: 'Latency', aggregate: 'mean', rowCount: 3,
      groups: [{ key: 'Warm', value: 30, count: 2 }, { key: groupKey, value: -50, count: 1 }] }
    const origin: SceneExportOrigin = { exporterVersion: 1, exportId: 'export-mean', artifactId: 'latencies', revision: 1 }
    const document = exportedDocument(buildSceneAnimationHtml(spec, 'Mean <latency>', undefined, origin))
    expect(document.querySelector('img')).toBeNull()
    expect(JSON.parse(document.getElementById('csv-export-spec')?.textContent ?? '')).toEqual(spec)
    expect(JSON.parse(document.getElementById('artifact-export-origin-data')?.textContent ?? '')).toEqual(origin)
    const buttons = document.querySelectorAll<HTMLButtonElement>('#csv-group-chart button')
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true')
    buttons[1]?.click()
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[data-csv-export-group]')?.textContent).toBe(groupKey)
    expect(document.querySelector('[data-csv-export-value]')?.textContent).toBe('-50')
    expect(document.querySelector('[data-csv-export-count]')?.textContent).toBe('1')
  })

  it('includes a frozen CSV filter and handles an empty matching set', () => {
    const spec: CsvBarChartSpec = { kind: 'csv-bar-chart', attachmentId: `sha256:${'a'.repeat(64)}` as CsvBarChartSpec['attachmentId'],
      groupBy: 'Trial', valueColumn: 'Latency', aggregate: 'sum', filter: { column: 'Batch', value: '<img src=x>' }, rowCount: 0, groups: [] }
    const document = exportedDocument(buildSceneAnimationHtml(spec, 'Filtered totals'))
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('[data-csv-export-filter]')?.textContent).toContain('"Batch" = "<img src=x>"')
    expect(document.querySelectorAll('#csv-group-chart button')).toHaveLength(0)
    expect(document.body.textContent).toContain('No matching records')
  })
})
