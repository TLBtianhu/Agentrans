/** Canvas layout helpers shared by the framework-free scene renderers. */

/**
 * Break text into lines that fit the context's current font.
 * @param context - Canvas context whose font measures the text.
 * @param text - Text to wrap; characters are never split.
 * @param maxWidth - Maximum line width in canvas pixels.
 * @returns Lines in reading order.
 */
export function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): readonly string[] {
  const lines: string[] = []
  let current = ''
  for (const character of text) {
    const next = current + character
    if (context.measureText(next).width > maxWidth && current.length > 0) {
      lines.push(current)
      current = character
    } else {
      current = next
    }
  }
  if (current.length > 0) lines.push(current)
  return lines
}

/** Origin and extent of scene coordinates; a degenerate axis spans one unit. */
export interface PointBounds {
  readonly minX: number
  readonly minY: number
  readonly spanX: number
  readonly spanY: number
}

/**
 * Measure the scene-space box that holds every point.
 * @param points - Scene coordinates of nodes or markers.
 * @returns The box origin and its non-zero spans.
 */
export function pointBounds(points: readonly { readonly x: number; readonly y: number }[]): PointBounds {
  const xs = points.map(point => point.x)
  const ys = points.map(point => point.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { minX, minY, spanX: Math.max(...xs) - minX || 1, spanY: Math.max(...ys) - minY || 1 }
}
