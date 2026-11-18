/** Format differences between numerical experiment readings. */

/**
 * Display the signed difference between the current reading and its baseline.
 * @param current - Current reading, or null when unavailable.
 * @param baseline - Recorded baseline, or null when unavailable.
 * @returns A three-place difference, or an em dash when unavailable.
 */
export function formatReadingDifference(current: number | null, baseline: number | null): string {
  if (current === null || baseline === null) return '—'
  const difference = current - baseline
  if (!Number.isFinite(difference)) return '—'
  const magnitude = Math.abs(difference).toFixed(3)
  if (magnitude === '0.000') return magnitude
  return `${difference > 0 ? '+' : '−'}${magnitude}`
}
