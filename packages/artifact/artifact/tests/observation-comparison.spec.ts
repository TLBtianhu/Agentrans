import { describe, expect, it } from 'vitest'
import { buildParticleObservationComparison } from '../src/observation-comparison.ts'
import { observeParticleState, restoreParticleCheckpoint } from '../src/particle-runtime.ts'
import type { ParticleSystemSpec } from '../src/scene.ts'
import type { ArtifactId, ArtifactObservationId, SavedParticleObservation } from '../src/types.ts'

const spec: ParticleSystemSpec = {
  kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 1, vx: 3, vy: 8, mass: 1 }],
  gravity: { x: 0, y: -9.8 }, timeStep: 1 / 30, trails: true,
}

function saved(role: 'control' | 'variant', source = spec): SavedParticleObservation {
  const checkpoint = { runtimeVersion: 1, stepCount: 6 } as const
  return {
    observationId: `${role}-six` as ArtifactObservationId, label: role,
    artifact: {
      artifactId: role as ArtifactId, revision: 1, title: role, presentation: 'inline', format: 'scene',
      comparison: { group: 'gravity', role }, spec: source,
    },
    checkpoint, values: observeParticleState(restoreParticleCheckpoint(source, checkpoint)),
  }
}

describe('fixed saved-observation comparisons', () => {
  it('recomputes independent values from each saved source without drawing a conclusion', () => {
    const control = saved('control')
    const variant = saved('variant', { ...spec, gravity: { x: 0, y: -4 } })
    const comparison = buildParticleObservationComparison('gravity', { ...control, values: { time: 999, particles: [] } }, variant)
    expect(comparison).toEqual({
      kind: 'saved-particle-observation-comparison', group: 'gravity',
      conditions: { runtimeVersion: 1, stepCount: 6, timeStep: 1 / 30, time: 0.2 },
      control: { ref: { artifactId: 'control', observationId: 'control-six' }, label: 'control', revision: 1, values: control.values },
      variant: { ref: { artifactId: 'variant', observationId: 'variant-six' }, label: 'variant', revision: 1, values: variant.values },
    })
    expect(comparison.control.values.particles[0]?.y).not.toBe(comparison.variant.values.particles[0]?.y)
    expect(control.values.time).toBe(0.2)
  })

  it('requires group and roles recorded on both saved revisions', () => {
    const control = saved('control')
    const variant = saved('variant')
    expect(() => buildParticleObservationComparison('elsewhere', control, variant)).toThrow(expect.objectContaining({ code: 'GROUP_MISMATCH' }))
    expect(() => buildParticleObservationComparison('gravity', variant, control)).toThrow(expect.objectContaining({ code: 'ROLE_MISMATCH' }))
    expect(() => buildParticleObservationComparison('gravity', control, {
      ...variant, artifact: { ...variant.artifact, artifactId: control.artifact.artifactId },
    })).toThrow(expect.objectContaining({ code: 'SAME_ARTIFACT' }))
  })

  it('normalizes signed zero in observations for JSON action admission', () => {
    const signedZero: ParticleSystemSpec = {
      ...spec, gravity: { x: -0, y: -0 }, particles: [{ id: 'p', x: -0, y: -0, vx: -0, vy: -0, mass: 1 }],
    }
    const comparison = buildParticleObservationComparison('gravity', saved('control', signedZero), saved('variant', signedZero))
    expect(Object.is(comparison.control.values.particles[0]?.x, -0)).toBe(false)
    expect(Object.is(comparison.variant.values.particles[0]?.vx, -0)).toBe(false)
    expect(JSON.parse(JSON.stringify(comparison))).toEqual(comparison)
  })

  it('requires equal runtime version, step count and time step', () => {
    const control = saved('control')
    const variant = saved('variant')
    const futureRuntime = JSON.parse(JSON.stringify({
      ...variant, checkpoint: { runtimeVersion: 2, stepCount: 6 },
    })) as SavedParticleObservation
    expect(() => buildParticleObservationComparison('gravity', control, futureRuntime)).toThrow(expect.objectContaining({ code: 'RUNTIME_MISMATCH' }))
    expect(() => buildParticleObservationComparison('gravity', control, { ...variant, checkpoint: { ...variant.checkpoint, stepCount: 7 } }))
      .toThrow(expect.objectContaining({ code: 'STEP_COUNT_MISMATCH' }))
    expect(() => buildParticleObservationComparison('gravity', control, saved('variant', { ...spec, timeStep: 1 / 60 })))
      .toThrow(expect.objectContaining({ code: 'TIME_STEP_MISMATCH' }))
  })

  it('rejects non-particle source revisions and invalid restore points', () => {
    const control = saved('control')
    const variant = saved('variant')
    expect(() => buildParticleObservationComparison('gravity', control, {
      ...variant, artifact: { ...variant.artifact, spec: { kind: 'timeline', events: [] } },
    })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_OBSERVATION' }))
    expect(() => buildParticleObservationComparison('gravity', { ...control, checkpoint: { runtimeVersion: 1, stepCount: -1 } },
      { ...variant, checkpoint: { runtimeVersion: 1, stepCount: -1 } }))
      .toThrow(expect.objectContaining({ code: 'INVALID_CHECKPOINT' }))
  })
})
