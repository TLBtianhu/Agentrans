import { describe, expect, it } from 'vitest'
import { ExpressionDomainError, evaluateExpression, parseExpression } from '../src/index.ts'

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

  it.each(['sqrt(-1)', 'log(0)', '1/0', 'exp(1000)', '1e308*1e308'])('distinguishes the mathematical domain failure in %s', (expression) => {
    expect(() => evaluateExpression(parseExpression(expression, []), {})).toThrow(ExpressionDomainError)
  })

  it('keeps missing and non-finite variables separate from mathematical domain failures', () => {
    const node = parseExpression('a*x', ['a'])
    for (const variables of [{ x: 1 }, { x: 1, a: Number.NaN }]) {
      const evaluate = (): number => evaluateExpression(node, variables)
      expect(evaluate).toThrow(Error)
      expect(evaluate).not.toThrow(ExpressionDomainError)
    }
  })
})
