import { describe, expect, it } from 'vitest'
import { parseExpression } from '@deepseek-ai/dsh-util-values'
import { analyzeFunction, evaluateFunction, integrateFunction } from '../src/client/renderers/function-analysis.ts'

describe('function analysis', () => {
  it('reports an unavailable derivative at the square-root boundary and recovers inside its domain', () => {
    const node = parseExpression('sqrt(x)', [])
    expect(analyzeFunction(node, {}, 0)).toEqual({ value: 0, derivative: null, integral: 0 })
    const inside = analyzeFunction(node, {}, 1)
    expect(inside.value).toBe(1)
    expect(inside.derivative).toBeCloseTo(0.5, 5)
    expect(inside.integral).toBeCloseTo(2 / 3, 3)
  })

  it('does not claim an improper logarithm integral from a singular zero endpoint', () => {
    const node = parseExpression('log(x)', [])
    expect(analyzeFunction(node, {}, 1)).toEqual({ value: 0, derivative: expect.closeTo(1, 5), integral: null })
    expect(analyzeFunction(node, {}, 0)).toEqual({ value: null, derivative: null, integral: null })
  })

  it('does not return a centered derivative across an undefined trace point', () => {
    expect(analyzeFunction(parseExpression('1/x', []), {}, 0)).toEqual({ value: null, derivative: null, integral: null })
  })

  it('preserves signed integration and finite parameter-dependent readings', () => {
    expect(analyzeFunction(parseExpression('a*x', ['a']), { a: 2 }, -1)).toEqual({
      value: -2, derivative: expect.closeTo(2, 8), integral: expect.closeTo(1, 8),
    })
  })

  it('marks numerical overflow unavailable without leaking a non-finite result', () => {
    expect(evaluateFunction(parseExpression('exp(x)', []), {}, 1000)).toBeNull()
    expect(integrateFunction(parseExpression('1e308', []), {}, 1)).toBeNull()
  })

  it('propagates incomplete variable state instead of masking it as a domain gap', () => {
    expect(() => evaluateFunction(parseExpression('b*x', ['b']), {}, 1)).toThrow('Variable "b" is missing')
    expect(() => evaluateFunction(parseExpression('b*x', ['b']), { b: Number.NaN }, 1)).toThrow('Variable "b" must be a finite number')
  })
})
