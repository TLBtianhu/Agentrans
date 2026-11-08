/** Fixed-step particle evaluation shared by interactive previews and exported programs. */
import type { ParticleSpec, ParticleSystemSpec } from './scene.ts'

/** Explicit-Euler semantics: positions advance with the velocity at the start of each step. */
export const PARTICLE_RUNTIME_VERSION = 1

const TRAIL_POINT_LIMIT = 121

/** One sampled position retained for a particle trail. */
export interface ParticleTrailPoint {
  readonly x: number
  readonly y: number
}

/** Complete derived state of one particle-system revision at an integer fixed step. */
export interface ParticleState {
  readonly stepCount: number
  readonly time: number
  readonly particles: readonly ParticleSpec[]
  readonly trails: Readonly<Record<string, readonly ParticleTrailPoint[]>>
}

/**
 * A restore point for the same immutable ParticleSystemSpec and Artifact revision.
 * Positions and trails are derived from the spec; this value is not an independent work file.
 */
export interface ParticleCheckpoint {
  readonly runtimeVersion: typeof PARTICLE_RUNTIME_VERSION
  readonly stepCount: number
}

/** Confirmable observations; mass and renderer-only trails remain in the source and runtime. */
export type ParticleObservation = {
  time: number
  particles: { id: string; x: number; y: number; vx: number; vy: number }[]
}

/** Failures that leave the caller's previous state intact. */
export type ParticleRuntimeErrorCode = 'INVALID_CHECKPOINT' | 'INVALID_STEP_COUNT' | 'INVALID_TIME' | 'NON_FINITE_STATE'

/** A rejected restore point, time request, or non-finite simulation result. */
export class ParticleRuntimeError extends Error {
  /**
   * @param code - Stable discriminator for restore and simulation failures.
   * @param message - Diagnostic for the caller owning the failed operation.
   */
  constructor(readonly code: ParticleRuntimeErrorCode, message: string) {
    super(message)
    this.name = 'ParticleRuntimeError'
  }
}

function fixedStep(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ParticleRuntimeError('INVALID_STEP_COUNT', 'Particle step count must be a non-negative safe integer')
  }
  return value
}

function finite(value: number): number {
  if (!Number.isFinite(value)) {
    throw new ParticleRuntimeError('NON_FINITE_STATE', 'Particle advancement produced a non-finite result')
  }
  return value
}

function samplePosition(particle: ParticleSpec, spec: ParticleSystemSpec, stepCount: number): ParticleTrailPoint {
  const elapsed = finite(stepCount * spec.timeStep)
  // The closed form sums the same fixed-step explicit-Euler sequence without a step-sized loop.
  const accelerationTime = (stepCount - 1) * spec.timeStep
  return {
    x: finite(particle.x + particle.vx * elapsed + 0.5 * spec.gravity.x * elapsed * accelerationTime),
    y: finite(particle.y + particle.vy * elapsed + 0.5 * spec.gravity.y * elapsed * accelerationTime),
  }
}

function sampleParticle(particle: ParticleSpec, spec: ParticleSystemSpec, stepCount: number): ParticleSpec {
  const elapsed = finite(stepCount * spec.timeStep)
  return {
    ...particle,
    ...samplePosition(particle, spec, stepCount),
    vx: finite(particle.vx + spec.gravity.x * elapsed),
    vy: finite(particle.vy + spec.gravity.y * elapsed),
  }
}

function sampleState(spec: ParticleSystemSpec, stepCount: number, previous?: ParticleState): ParticleState {
  fixedStep(stepCount)
  const time = finite(stepCount * spec.timeStep)
  const particles = spec.particles.map(particle => sampleParticle(particle, spec, stepCount))
  const trails: Record<string, ParticleTrailPoint[]> = {}
  if (spec.trails && stepCount > 0) {
    const first = Math.max(0, stepCount - TRAIL_POINT_LIMIT)
    for (const [index, particle] of spec.particles.entries()) {
      if (previous !== undefined) {
        const previousParticle = previous.particles[index]
        if (previousParticle === undefined) throw new Error('Particle state does not match its source revision')
        const { x, y } = previousParticle
        trails[particle.id] = [...(previous.trails[particle.id] ?? []).slice(-(TRAIL_POINT_LIMIT - 1)), { x, y }]
        continue
      }
      const points: ParticleTrailPoint[] = []
      for (let step = first; step < stepCount; step++) {
        points.push(samplePosition(particle, spec, step))
      }
      trails[particle.id] = points
    }
  }
  return { stepCount, time, particles, trails }
}

/**
 * Derive the initial state of an already validated particle-system revision.
 * @param spec - Immutable validated particle-system source.
 * @returns Positions and velocities before the first fixed step.
 */
export function createParticleState(spec: ParticleSystemSpec): ParticleState {
  return sampleState(spec, 0)
}

/**
 * Advance one fixed step, using the source revision rather than accumulating rounding drift.
 * @param spec - The same immutable source used to create state.
 * @param state - Previous state for that source.
 * @returns A new state; failures do not mutate the previous state.
 */
export function stepParticleState(spec: ParticleSystemSpec, state: ParticleState): ParticleState {
  return advanceParticleState(spec, state, 1)
}

/**
 * Advance an integer number of steps with at most 121 trail samples per particle.
 * @param spec - The same immutable source used to create state.
 * @param state - Previous state for that source.
 * @param steps - Non-negative safe integer number of additional fixed steps.
 * @returns A new state evaluated from the source at the resulting absolute step.
 * @throws {ParticleRuntimeError} For unsafe step counts or non-finite results.
 */
export function advanceParticleState(spec: ParticleSystemSpec, state: ParticleState, steps: number): ParticleState {
  fixedStep(steps)
  return sampleState(spec, fixedStep(state.stepCount + steps), steps === 1 ? state : undefined)
}

/**
 * Sample elapsed replay time after a checkpoint, or after the initial state when none is supplied.
 * @param spec - Immutable validated particle-system source.
 * @param elapsed - Non-negative finite seconds since the replay's starting checkpoint.
 * @param checkpoint - Starting checkpoint belonging to the same spec and revision.
 * @returns The state at the latest complete fixed step, independent of render frame rate.
 * @throws {ParticleRuntimeError} For invalid times, unsafe steps, or non-finite results.
 */
export function particleStateAtTime(spec: ParticleSystemSpec, elapsed: number, checkpoint?: ParticleCheckpoint): ParticleState {
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    throw new ParticleRuntimeError('INVALID_TIME', 'Particle replay time must be non-negative and finite')
  }
  const quotient = elapsed / spec.timeStep
  // Arithmetic around an exact step boundary can lose a few ulps (for example 0.2 / (1 / 30)).
  const nearest = Math.round(quotient)
  const additional = Math.abs(quotient - nearest) <= Number.EPSILON * Math.max(1, Math.abs(quotient)) * 4
    ? nearest : Math.floor(quotient)
  return sampleState(spec, fixedStep((checkpoint?.stepCount ?? 0) + fixedStep(additional)))
}

/**
 * Read the same time and particle values used by rendering without granting any external authority.
 * @param state - Current derived particle state.
 * @returns Bounded semantic values suitable for a user-confirmed JSON action; signed zero becomes zero.
 */
export function observeParticleState(state: ParticleState): ParticleObservation {
  const jsonNumber = (value: number): number => value === 0 ? 0 : value
  return {
    time: jsonNumber(state.time),
    particles: state.particles.map(({ id, x, y, vx, vy }) => ({
      id, x: jsonNumber(x), y: jsonNumber(y), vx: jsonNumber(vx), vy: jsonNumber(vy),
    })),
  }
}

/**
 * Capture the current fixed step for later use with the same source revision.
 * @param state - Current derived state.
 * @returns A small restore point; creating it does not persist or send an Agent message.
 */
export function createParticleCheckpoint(state: ParticleState): ParticleCheckpoint {
  return { runtimeVersion: PARTICLE_RUNTIME_VERSION, stepCount: state.stepCount }
}

/**
 * Validate a serialized checkpoint and derive its state against the caller's source revision.
 * @param spec - The exact immutable source revision associated with the checkpoint.
 * @param value - Untrusted checkpoint data read across a serialization boundary.
 * @returns A completely recomputed state; checkpoint data never supplies particle coordinates.
 * @throws {ParticleRuntimeError} For unsupported versions, malformed checkpoints, or non-finite state.
 */
export function restoreParticleCheckpoint(spec: ParticleSystemSpec, value: unknown): ParticleState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== 2 || !('runtimeVersion' in value) || !('stepCount' in value)
    || value.runtimeVersion !== PARTICLE_RUNTIME_VERSION || typeof value.stepCount !== 'number'
    || !Number.isSafeInteger(value.stepCount) || value.stepCount < 0) {
    throw new ParticleRuntimeError('INVALID_CHECKPOINT', 'Particle checkpoint requires runtime version 1 and a non-negative safe step count')
  }
  return sampleState(spec, value.stepCount)
}
