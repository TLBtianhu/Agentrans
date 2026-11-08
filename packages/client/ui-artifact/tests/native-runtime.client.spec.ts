// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { drawNativeScene } from '../src/client/native-runtime.ts'
afterEach(() => { vi.restoreAllMocks() })

describe('actual native renderer readiness', () => {
  it('reports unavailable Canvas rendering instead of treating a silent pure-renderer return as ready', () => {
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue(null)
    const draw = vi.fn()
    const report = vi.fn()
    drawNativeScene(canvas, draw, report)
    expect(draw).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledExactlyOnceWith({ status: 'error', error: {
      code: 'NATIVE_RENDER_FAILED', message: 'Canvas 2D rendering is unavailable',
    } })
  })

  it('reports ready only after a real draw call succeeds and reports bounded renderer failures', () => {
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
    const report = vi.fn()
    const draw = vi.fn(() => { expect(report).not.toHaveBeenCalled() })
    drawNativeScene(canvas, draw, report)
    expect(report).toHaveBeenCalledExactlyOnceWith({ status: 'ready', capabilities: { state: true, commands: [] } })
    report.mockClear()
    drawNativeScene(canvas, () => { throw new Error('x'.repeat(1000)) }, report)
    expect(report).toHaveBeenCalledExactlyOnceWith({ status: 'error', error: { code: 'NATIVE_RENDER_FAILED', message: 'x'.repeat(150) } })
    report.mockClear()
    drawNativeScene(canvas, () => { throw new Error('\u0000'.repeat(1000)) }, report)
    expect(new TextEncoder().encode(JSON.stringify(report.mock.calls[0]?.[0])).byteLength).toBeLessThan(1024)
  })
})
