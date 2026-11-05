// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { recordSceneVideo } from '../src/client/scene-video.ts'
import type { FunctionPlotSpec } from '@deepseek-ai/dsh-artifact/scene'

const spec: FunctionPlotSpec = {
  kind: 'function-plot',
  functions: [{ id: 'sine', label: 'sin(x)', expression: 'sin(x)' }],
  parameters: { a: { value: 1, min: -2, max: 2, step: 0.1 } },
  viewport: { x: [-6, 6], y: [-2, 2] },
  trace: { x: 1, derivative: true, integral: false },
  timeline: { duration: 6, fps: 30 },
}

describe('scene video recording', () => {
  it('returns null when the environment cannot record', () => {
    const canvas = document.createElement('canvas')
    expect(recordSceneVideo(spec, canvas)).toBeNull()
  })

  it('records the canvas stream into a WebM download', () => {
    const canvas = document.createElement('canvas')
    const tracks = [{ stop: vi.fn() }]
    const stream = Object.assign(Object.create(MediaStream.prototype), { getTracks: () => tracks })
    canvas.captureStream = vi.fn(() => stream)
    class Recorder {
      ondataavailable: ((event: { data: Blob }) => void) | undefined
      onstop: (() => void) | undefined
      start(): void {
        this.ondataavailable?.({ data: new Blob(['webm'], { type: 'video/webm' }) })
        this.onstop?.()
      }
      stop(): void {}
    }
    vi.stubGlobal('MediaRecorder', Recorder)
    const create = vi.fn(() => 'blob:webm')
    const revoke = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL: create, revokeObjectURL: revoke })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const handle = recordSceneVideo(spec, canvas)
    expect(handle).not.toBeNull()
    handle?.stop()
    expect(click).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledWith('blob:webm')
    expect(tracks[0]?.stop).toHaveBeenCalledOnce()
  })
})
