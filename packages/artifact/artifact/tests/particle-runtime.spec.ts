import { describe, expect, it } from 'vitest'
import type { ParticleSystemSpec } from '../src/scene.ts'
import {
  PARTICLE_RUNTIME_VERSION, ParticleRuntimeError, advanceParticleState,
  createParticleCheckpoint, createParticleState, observeParticleState, particleStateAtTime,
  restoreParticleCheckpoint, stepParticleState,
} from '../src/particle-runtime.ts'

const spec: ParticleSystemSpec = {
  kind: 'particle-system',
  particles: [{ id: 'alpha', x: 1, y: 1, vx: 3, vy: 8, mass: 2 }],
  gravity: { x: 0, y: -9.8 }, timeStep: 1 / 30, trails: true,
}

describe('particle runtime', () => {
  it('uses the preview explicit-Euler order and reports the same observation at six steps', () => {
    const initial = createParticleState(spec)
    let state = initial
    for (let step = 0; step < 6; step++) state = stepParticleState(spec, state)
    expect(state.time).toBe(6 * spec.timeStep)
    expect(state.particles[0]).toMatchObject({ x: 1.6, mass: 2 })
    expect(state.particles[0]!.y).toBeCloseTo(2.4366666666666665, 12)
    expect(state.particles[0]!.vy).toBeCloseTo(6.04, 12)
    expect(state).toEqual(advanceParticleState(spec, initial, 6))
    expect(state).toEqual(particleStateAtTime(spec, 0.2))
    expect(observeParticleState(state)).toEqual({
      time: state.time, particles: state.particles.map(({ id, x, y, vx, vy }) => ({ id, x, y, vx, vy })),
    })
    expect(initial).toEqual({ stepCount: 0, time: 0, particles: spec.particles, trails: {} })
  })

  it('normalizes signed zero only in action observations while retaining the internal state', () => {
    const state = {
      time: -0, stepCount: 0, trails: {}, particles: [{ id: 'zero', x: -0, y: -0, vx: -0, vy: -0, mass: 1 }],
    }
    const observation = observeParticleState(state)
    expect(observation).toEqual({ time: 0, particles: [{ id: 'zero', x: 0, y: 0, vx: 0, vy: 0 }] })
    expect(Object.is(state.time, -0)).toBe(true)
    expect(Object.is(state.particles[0]?.x, -0)).toBe(true)
  })

  it.each([1 / 30, 0.02, 0.1])('samples exact and partial step boundaries for dt=%s', (timeStep) => {
    const source = { ...spec, timeStep }
    expect(particleStateAtTime(source, 6 * timeStep).stepCount).toBe(6)
    expect(particleStateAtTime(source, 6.9 * timeStep).stepCount).toBe(6)
    expect(particleStateAtTime(source, 5.999 * timeStep).stepCount).toBe(5)
    expect(particleStateAtTime(source, 0).stepCount).toBe(0)
  })

  it('matches a simple independent Euler loop with horizontal and vertical acceleration', () => {
    const source = { ...spec, gravity: { x: 2.5, y: -7 }, timeStep: 0.02 }
    const expected = { ...source.particles[0]! }
    for (let step = 0; step < 100; step++) {
      expected.x += expected.vx * source.timeStep
      expected.y += expected.vy * source.timeStep
      expected.vx += source.gravity.x * source.timeStep
      expected.vy += source.gravity.y * source.timeStep
    }
    const actual = advanceParticleState(source, createParticleState(source), 100).particles[0]!
    for (const key of ['x', 'y', 'vx', 'vy'] as const) expect(actual[key]).toBeCloseTo(expected[key], 10)
  })

  it('restores a checkpoint and samples elapsed export time from that same origin', () => {
    const state = advanceParticleState(spec, createParticleState(spec), 6)
    const checkpoint = createParticleCheckpoint(state)
    expect(checkpoint).toEqual({ runtimeVersion: PARTICLE_RUNTIME_VERSION, stepCount: 6 })
    expect(restoreParticleCheckpoint(spec, JSON.parse(JSON.stringify(checkpoint)))).toEqual(state)
    expect(particleStateAtTime(spec, 0, checkpoint)).toEqual(state)
    expect(particleStateAtTime(spec, 0.2, checkpoint)).toEqual(advanceParticleState(spec, state, 6))
  })

  it('bounds retained trails for a trillion fixed steps without iterating through the elapsed steps', () => {
    const source = { ...spec, timeStep: 1e-12 }
    const state = particleStateAtTime(source, 1)
    expect(state.stepCount).toBe(1_000_000_000_000)
    expect(state.time).toBe(1)
    expect(state.particles[0]!.x).toBe(4)
    expect(state.trails.alpha).toHaveLength(121)
    expect(state.trails.alpha!.at(-1)!.x).toBeCloseTo(4, 10)
    expect(stepParticleState(source, createParticleState(source)).trails.alpha).toEqual([{ x: 1, y: 1 }])
    expect(advanceParticleState({ ...source, trails: false }, createParticleState(source), 1_000).trails).toEqual({})
  })

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an unsafe step count %s without mutating state', (steps) => {
    const initial = createParticleState(spec)
    expect(() => advanceParticleState(spec, initial, steps))
      .toThrow(expect.objectContaining({ code: 'INVALID_STEP_COUNT' }))
    expect(initial).toEqual(createParticleState(spec))
  })

  it('rejects a step-count addition that loses integer precision', () => {
    const state = advanceParticleState({ ...spec, timeStep: 1e-16 }, createParticleState(spec), Number.MAX_SAFE_INTEGER)
    expect(() => stepParticleState(spec, state)).toThrow(expect.objectContaining({ code: 'INVALID_STEP_COUNT' }))
  })

  it.each([-1, NaN, Infinity])('rejects replay time %s', (time) => {
    expect(() => particleStateAtTime(spec, time)).toThrow(expect.objectContaining({ code: 'INVALID_TIME' }))
  })

  it('reports finite-range failures with a typed code and preserves the last valid state', () => {
    const source = { ...spec, gravity: { x: Number.MAX_VALUE, y: 0 }, timeStep: 1 }
    const initial = createParticleState(source)
    const once = stepParticleState(source, initial)
    expect(() => stepParticleState(source, once)).toThrow(ParticleRuntimeError)
    expect(() => stepParticleState(source, once)).toThrow(expect.objectContaining({ code: 'NON_FINITE_STATE' }))
    expect(once).toEqual(stepParticleState(source, initial))
    expect(() => advanceParticleState({ ...spec, timeStep: Number.MAX_VALUE }, initial, 2))
      .toThrow(expect.objectContaining({ code: 'NON_FINITE_STATE' }))
  })

  it.each([
    null, [], {}, { runtimeVersion: 2, stepCount: 6 }, { runtimeVersion: 1, stepCount: -1 },
    { runtimeVersion: 1, stepCount: 0.5 }, { runtimeVersion: 1, stepCount: NaN },
    { runtimeVersion: 1, stepCount: '6' }, { runtimeVersion: 1, stepCount: 6, particles: [] },
  ])('rejects unsupported or malformed serialized checkpoints: %j', (checkpoint) => {
    expect(() => restoreParticleCheckpoint(spec, checkpoint))
      .toThrow(expect.objectContaining({ code: 'INVALID_CHECKPOINT' }))
  })
})
