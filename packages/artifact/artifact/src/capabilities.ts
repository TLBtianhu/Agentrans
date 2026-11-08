/** Source-supported operations, independent of renderer reports, installed services, and access policy. */
import { sceneCatalog } from './scene.ts'
import type { ArtifactSnapshot } from './types.ts'

/** Supported source semantics; each operation still validates its own inputs and authority. */
export type ArtifactSourceCapabilities = {
  /** Observation values the Host can recompute from source and recorded conditions. */
  readonly observe: 'particle' | 'unsupported'
  /** Named observations the source can preserve with complete replay conditions. */
  readonly save: 'particle' | 'unsupported'
  /** Recorded conditions the source can restore with its versioned runtime. */
  readonly restore: 'particle' | 'unsupported'
  /** Fixed saved observations the Host can compare at compatible conditions. */
  readonly compare: 'saved-particle-pair' | 'unsupported'
  /** Question-context mode, retaining HTML reports as program claims rather than Host calculations. */
  readonly questionContext: 'particle' | 'program-reported' | 'unsupported'
  /** Conditions an installed HTML exporter can preserve; source defaults omit local view state. */
  readonly exportHtml: 'particle-checkpoint-or-source-defaults' | 'source-defaults' | 'unsupported'
}

const htmlCapabilities: ArtifactSourceCapabilities = Object.freeze({
  observe: 'unsupported',
  save: 'unsupported',
  restore: 'unsupported',
  compare: 'unsupported',
  questionContext: 'program-reported',
  exportHtml: 'unsupported',
})

/**
 * Read immutable source support without executing content or reading a renderer instance.
 * @param snapshot - Validated HTML or SceneSpec source revision.
 * @returns The source declaration, which grants no authority and implies neither service availability,
 * renderer readiness nor result verification. Authored HTML reports do not change this declaration.
 */
export function getArtifactSourceCapabilities(snapshot: ArtifactSnapshot): ArtifactSourceCapabilities {
  return snapshot.format === 'html' ? htmlCapabilities : sceneCatalog[snapshot.spec.kind].sourceCapabilities
}
