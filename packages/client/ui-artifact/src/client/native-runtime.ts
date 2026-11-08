/** Actual canvas draw results; calculation availability alone is not renderer readiness. */
import type { RuntimeReport } from '@deepseek-ai/dsh-artifact-runtime/types'

/**
 * Bound one renderer failure for the live report stream.
 * @param error - Renderer diagnostic.
 * @returns A bounded plain diagnostic suitable for the live report stream.
 */
export function nativeRuntimeFailure(error: unknown): { readonly code: string; readonly message: string } {
  return { code: 'NATIVE_RENDER_FAILED', message: error instanceof Error ? Array.from(error.message).slice(0, 150).join('') : 'Native renderer failed' }
}

/**
 * Draw one actual canvas frame and report its result, without changing the shared pure renderer API.
 * @param canvas - Mounted canvas.
 * @param draw - The existing renderer invocation.
 * @param report - Actual native renderer report, when a runtime is registered.
 */
export function drawNativeScene(canvas: HTMLCanvasElement | null, draw: () => void,
  report?: (report: RuntimeReport) => void): void {
  if (canvas === null) return
  if (report === undefined) { draw(); return }
  try {
    if (canvas.getContext('2d') === null) throw new Error('Canvas 2D rendering is unavailable')
    draw()
    report({ status: 'ready', capabilities: { state: true, commands: [] } })
  } catch (error) {
    report({ status: 'error', error: nativeRuntimeFailure(error) })
  }
}
