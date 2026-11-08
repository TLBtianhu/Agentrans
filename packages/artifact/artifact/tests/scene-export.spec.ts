import { JSDOM, VirtualConsole } from 'jsdom'
import { describe, expect, it, onTestFinished } from 'vitest'
import { buildSceneAnimationHtml, SCENE_EXPORTER_VERSION, type SceneExportOrigin } from '../src/scene-export.ts'
import type { ParticleSystemSpec } from '../src/scene.ts'

const particles: ParticleSystemSpec = {
  kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 1, vx: 3, vy: 8, mass: 1 }],
  gravity: { x: 0, y: -9.8 }, timeStep: 1 / 30, trails: true,
}

function exportedDocument(html: string): Document {
  const errors: Error[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => { errors.push(error) })
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', virtualConsole,
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
})
