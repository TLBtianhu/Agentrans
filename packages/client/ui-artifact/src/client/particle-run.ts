/** Local controls for one Artifact revision's particle simulation. */
import type { ParticleSystemSpec } from '@agentrans/artifact/scene'
import { nativeRuntimeFailure } from './native-runtime.ts'
import { assertNever } from '@agentrans/util-values'
import {
  ParticleRuntimeError, createParticleState, stepParticleState, type ParticleState,
} from '@agentrans/artifact/particle-runtime'

/** Simulation values and playback intent owned by the Artifact card. */
export interface ParticleRun {
  readonly state: ParticleState
  readonly playing: boolean
  readonly failed: boolean
  readonly failure?: { readonly code: string; readonly message: string }
}

/** Commands supported by the particle preview in this runtime version. */
export type ParticleRunCommand = 'play' | 'pause' | 'step' | 'reset'

/**
 * Create the first local run for a validated particle specification.
 * @param spec - Immutable source for the current Artifact revision.
 * @returns The initial paused simulation.
 */
export function createParticleRun(spec: ParticleSystemSpec): ParticleRun {
  return { state: createParticleState(spec), playing: false, failed: false }
}

/**
 * Apply local playback intent while retaining the last finite state on numeric failure.
 * @param spec - Immutable source for the current Artifact revision.
 * @param run - Current simulation and controls.
 * @param command - User control or one timer-driven step.
 * @returns Updated run; unexpected programming errors propagate.
 */
export function updateParticleRun(spec: ParticleSystemSpec, run: ParticleRun, command: ParticleRunCommand): ParticleRun {
  switch (command) {
    case 'reset': return createParticleRun(spec)
    case 'pause': return run.playing ? { ...run, playing: false } : run
    case 'play': return run.failed || run.playing ? run : { ...run, playing: true }
    case 'step':
      if (run.failed) return run
      try {
        return { ...run, state: stepParticleState(spec, run.state) }
      } catch (error) {
        if (!(error instanceof ParticleRuntimeError)) throw error
        return { ...run, playing: false, failed: true, failure: { code: error.code, message: nativeRuntimeFailure(error).message } }
      }
    default: return assertNever(command)
  }
}
