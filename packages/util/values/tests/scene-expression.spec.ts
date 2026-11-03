import { describe, expect, it } from 'vitest'
import { evaluateExpression, parseExpression } from '../src/index.ts'

describe('scene expression parser', () => {
  it('evaluates whitelisted functions and parameters without executing source', () => {
    const node = parseExpression('exp(-d*t)*sin(2*pi*f*t)', ['d', 't', 'f'])
    expect(evaluateExpression(node, { d: 0.2, t: 1, f: 1.2, pi: Math.PI, e: Math.E })).toBeCloseTo(0.7786592178, 8)
    expect(evaluateExpression(parseExpression('a*x^2/4', ['a', 'x']), { a: 1, x: 2 })).toBe(1)
    expect(evaluateExpression(parseExpression('pow(2,3)+max(1,4,2)', []), {})).toBe(12)
  })

  it('rejects unknown functions, variables, invalid arity, and non-finite results', () => {
    expect(() => parseExpression('alert(1)', [])).toThrow('Unknown function')
    expect(() => parseExpression('secret+1', [])).toThrow('Unknown variable')
    expect(() => parseExpression('pow(2)', [])).toThrow('requires exactly 2 arguments')
    expect(() => parseExpression('1/0', [])).not.toThrow()
    expect(() => evaluateExpression(parseExpression('1/0', []), {})).toThrow('finite')
  })
})
