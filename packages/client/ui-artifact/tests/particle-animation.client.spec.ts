// @vitest-environment jsdom
import { JSDOM, VirtualConsole } from 'jsdom'
import { expect, it, onTestFinished } from 'vitest'
import type { ParticleSystemSpec } from '@agentrans/artifact/scene'
import { createParticleCheckpoint, createParticleState, stepParticleState, type ParticleCheckpoint, type ParticleState } from '@agentrans/artifact/particle-runtime'
import { buildSceneAnimationHtml } from '../src/client/scene-animation.ts'

type RendererExports = typeof import('../src/client/renderers/index.ts')
const spec: ParticleSystemSpec = {
  kind: 'particle-system', particles: [{ id: 'alpha', x: 1, y: 1, vx: 3, vy: 8, mass: 2 }],
  gravity: { x: 0, y: -9.8 }, timeStep: 1 / 30, trails: true, timeline: { duration: 0.2, fps: 30 },
}

function exportedParticleProgram(source: ParticleSystemSpec, checkpoint?: ParticleCheckpoint,
  recordingProbe?: { downloads: number; tracksStopped: number; recorderStops: number }) {
  const states: ParticleState[] = []
  const errors: Error[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => { errors.push(error) })
  const dom = new JSDOM(buildSceneAnimationHtml(source, 'Particle run', checkpoint), {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', { value: () => null })
      if (recordingProbe !== undefined) {
        Object.defineProperty(window.HTMLCanvasElement.prototype, 'captureStream', {
          value: () => ({ getTracks: () => [{ stop: () => { recordingProbe.tracksStopped++ } }] }),
        })
        Object.defineProperty(window.HTMLAnchorElement.prototype, 'click', { value: () => { recordingProbe.downloads++ } })
        Object.defineProperty(window, 'MediaRecorder', { value: class {
          state = 'inactive'
          onstop?: () => void
          start(): void { this.state = 'recording' }
          stop(): void {
            this.state = 'inactive'
            recordingProbe.recorderStops++
            this.onstop?.()
          }
        } })
      }
      // Observe the state actually passed to the canvas renderer while executing every exported script.
      let renderers: RendererExports | undefined
      Object.defineProperty(window, 'SceneRenderers', {
        configurable: true,
        get: () => renderers,
        set: (value: RendererExports) => {
          renderers = { ...value, renderParticleSystem: (...args) => {
            const state = args[4]
            if (!('stepCount' in state) || typeof state.stepCount !== 'number') throw new Error('Missing particle runtime step')
            states.push({ ...state, stepCount: state.stepCount })
          } }
        },
      })
    },
  })
  onTestFinished(() => { dom.window.close(); expect(errors).toEqual([]) })
  expect(errors).toEqual([])
  const seek = (progress: string): void => {
    const input = dom.window.document.getElementById('scrub')
    if (!(input instanceof dom.window.HTMLInputElement)) throw new Error('Missing replay scrubber')
    input.value = progress
    input.dispatchEvent(new dom.window.Event('input'))
  }
  return { document: dom.window.document, states, seek }
}

it('renders the same saved particle observation initially, after seeking, and after reset', () => {
  let preview = createParticleState(spec)
  for (let step = 0; step < 6; step++) preview = stepParticleState(spec, preview)
  const checkpoint = createParticleCheckpoint(preview)
  const exported = exportedParticleProgram(spec, checkpoint)
  expect(exported.states).toEqual([preview])
  expect(exported.states[0]!.particles[0]!.y).toBeCloseTo(2.4366666666666665, 12)
  expect(exported.document.getElementById('time')?.textContent).toBe('0.20 s')
  exported.seek('1')
  expect(exported.states.at(-1)!.stepCount).toBe(12)
  expect(exported.states.at(-1)!.particles[0]!.y).toBeCloseTo(3.481333333333333, 12)
  expect(exported.document.getElementById('time')?.textContent).toBe('0.40 s')
  exported.document.getElementById('reset')!.click()
  expect(exported.states.at(-1)).toEqual(preview)
  expect(exported.document.getElementById('time')?.textContent).toBe('0.20 s')
  expect(exported.document.getElementById('error')?.hidden).toBe(true)
})

it('samples tiny fixed steps without creating an elapsed-step loop in the player', () => {
  const source = { ...spec, timeStep: 1e-12, timeline: { duration: 1, fps: 30 } }
  const exported = exportedParticleProgram(source)
  exported.seek('1')
  const state = exported.states.at(-1)!
  expect(state.stepCount).toBe(1_000_000_000_000)
  expect(state.particles[0]!.x).toBe(4)
  expect(state.trails.alpha).toHaveLength(121)
})

it.each([
  { ...spec, timeStep: 1, particles: [{ id: 'alpha', x: 0, y: 0, vx: 1e308, vy: 0, mass: 1 }], timeline: { duration: 4, fps: 30 } },
  { ...spec, timeStep: Number.MIN_VALUE, timeline: { duration: 1, fps: 30 } },
])('stops and reports an unsupported numeric advance, then restores the intact origin', (source) => {
  const exported = exportedParticleProgram(source)
  const original = exported.states[0]
  exported.seek('1')
  expect(exported.states).toEqual([original])
  const error = exported.document.getElementById('error')
  expect(error?.hidden).toBe(false)
  expect(error?.textContent).toContain('Reset or choose an earlier time')
  expect(exported.document.getElementById('play')?.textContent).toBe('Play')
  expect(exported.document.getElementById('time')?.textContent).toBe('0.00 s')
  exported.document.getElementById('reset')!.click()
  expect(error?.hidden).toBe(true)
  expect(exported.states.at(-1)).toEqual(original)
})

it('does not apply a particle checkpoint to a different scene kind', () => {
  expect(() => buildSceneAnimationHtml({ kind: 'timeline', events: [{ id: 'start', label: 'Start', time: 0 }], playhead: 0 },
    'Timeline', { runtimeVersion: 1, stepCount: 6 }))
    .toThrow(expect.objectContaining({ code: 'INVALID_CHECKPOINT' }))
})

it('discards an incomplete recording and releases its tracks when particle advancement fails', () => {
  const recordingProbe = { downloads: 0, tracksStopped: 0, recorderStops: 0 }
  const source = { ...spec, timeStep: Number.MIN_VALUE, timeline: { duration: 1, fps: 30 } }
  const exported = exportedParticleProgram(source, undefined, recordingProbe)
  exported.document.getElementById('record')!.click()
  expect(exported.document.getElementById('play')?.textContent).toBe('Pause')
  exported.seek('1')
  expect(exported.document.getElementById('error')?.hidden).toBe(false)
  expect(recordingProbe).toEqual({ downloads: 0, tracksStopped: 1, recorderStops: 1 })
})
