/** Question availability over the sole latest program report, without copying payloads into selection state. */
import type { ArtifactRuntimeSnapshot } from './runtime-owner.ts'

/** Availability of a program report before the user chooses a physical preview. */
export type RuntimeQuestionAvailability = 'state' | 'error' | 'waiting' | 'unsupported' | 'missing-state' | 'unavailable'

/**
 * Distinguish actual received reports from unsupported, absent, and disconnected reports.
 * @param runtime - The existing live runtime source's latest value.
 * @returns The reason a report can or cannot be attached; Host delivery never verifies its contents.
 */
export function runtimeQuestionAvailability(runtime: ArtifactRuntimeSnapshot | undefined): RuntimeQuestionAvailability {
  if (runtime === undefined) return 'waiting'
  if (runtime.identity.renderer !== 'html' || runtime.host === 'denied' || runtime.host === 'unavailable') return 'unavailable'
  if (runtime.report.status === 'error') return 'error'
  if (runtime.report.status === 'starting') return 'waiting'
  if (!runtime.report.capabilities.state) return 'unsupported'
  return runtime.state === undefined ? 'missing-state' : 'state'
}
