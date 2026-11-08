/** Fixed saved-observation comparison rules shared by Host admission and Client review. */
import { observeParticleState, restoreParticleCheckpoint } from './particle-runtime.ts'
import type {
  ParticleObservationComparison, ParticleObservationComparisonErrorCode, ParticleObservationComparisonSide,
  SavedParticleObservation,
} from './types.ts'

export type {
  ParticleObservationComparison, ParticleObservationComparisonErrorCode, ParticleObservationComparisonSide,
  SavedParticleObservationRef, ArtifactObservationComparisonResult,
} from './types.ts'

/** A pair rejected before comparison input is admitted. */
export class ParticleObservationComparisonError extends Error {
  /**
   * @param code - Stable condition that prevents the comparison.
   * @param message - Diagnostic owned by the caller presenting the failed selection.
   */
  constructor(readonly code: ParticleObservationComparisonErrorCode, message: string) {
    super(message)
    this.name = 'ParticleObservationComparisonError'
  }
}

function side(saved: SavedParticleObservation): ParticleObservationComparisonSide {
  if (saved.artifact.spec.kind !== 'particle-system') {
    throw new ParticleObservationComparisonError('UNSUPPORTED_OBSERVATION', 'Comparison requires particle-system observations')
  }
  return {
    ref: { artifactId: saved.artifact.artifactId, observationId: saved.observationId },
    label: saved.label,
    revision: saved.artifact.revision,
    values: observeParticleState(restoreParticleCheckpoint(saved.artifact.spec, saved.checkpoint)),
  }
}

/**
 * Resolve a fixed control/variant pair using its saved sources and checkpoints.
 * @param group - Comparison group recorded on both saved source revisions.
 * @param control - Saved control observation; current Artifact revisions are irrelevant.
 * @param variant - Saved variant observation; supplied values are recomputed from its source.
 * @returns Independent observations at equal runtime version, fixed step and time step.
 * @throws {ParticleObservationComparisonError} When source roles or sampled conditions differ.
 * @throws {ParticleRuntimeError} When a saved checkpoint cannot produce finite observations.
 */
export function buildParticleObservationComparison(
  group: string, control: SavedParticleObservation, variant: SavedParticleObservation,
): ParticleObservationComparison {
  if (control.artifact.comparison?.group !== group || variant.artifact.comparison?.group !== group) {
    throw new ParticleObservationComparisonError('GROUP_MISMATCH', 'Both saved source revisions must belong to the selected comparison group')
  }
  if (control.artifact.comparison.role !== 'control' || variant.artifact.comparison.role !== 'variant') {
    throw new ParticleObservationComparisonError('ROLE_MISMATCH', 'Saved source revisions must retain their control and variant roles')
  }
  if (control.artifact.artifactId === variant.artifact.artifactId) {
    throw new ParticleObservationComparisonError('SAME_ARTIFACT', 'Comparison requires two different Artifacts')
  }
  if (control.artifact.spec.kind !== 'particle-system' || variant.artifact.spec.kind !== 'particle-system') {
    throw new ParticleObservationComparisonError('UNSUPPORTED_OBSERVATION', 'Comparison requires particle-system observations')
  }
  const controlVersion: { readonly runtimeVersion: number } = control.checkpoint
  if (controlVersion.runtimeVersion !== variant.checkpoint.runtimeVersion) {
    throw new ParticleObservationComparisonError('RUNTIME_MISMATCH', 'Saved observations use different particle runtime versions')
  }
  if (control.artifact.spec.timeStep !== variant.artifact.spec.timeStep) {
    throw new ParticleObservationComparisonError('TIME_STEP_MISMATCH', 'Saved observations use different fixed time steps')
  }
  if (control.checkpoint.stepCount !== variant.checkpoint.stepCount) {
    throw new ParticleObservationComparisonError('STEP_COUNT_MISMATCH', 'Saved observations use different fixed step counts')
  }
  const controlSide = side(control)
  const variantSide = side(variant)
  return {
    kind: 'saved-particle-observation-comparison', group,
    conditions: {
      runtimeVersion: control.checkpoint.runtimeVersion, stepCount: control.checkpoint.stepCount,
      timeStep: control.artifact.spec.timeStep, time: controlSide.values.time,
    },
    control: controlSide, variant: variantSide,
  }
}
