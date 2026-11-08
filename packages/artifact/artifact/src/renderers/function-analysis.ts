/** Finite function samples and numerical analysis shared by previews and exported animations. */
import { ExpressionDomainError, evaluateExpression, type ExpressionNode } from '@deepseek-ai/dsh-util-values'

/** Readings unavailable in the real-number domain are represented by null, including in confirmed JSON. */
export interface FunctionAnalysis {
  readonly value: number | null
  readonly derivative: number | null
  readonly integral: number | null
}

/**
 * Evaluate one function sample without treating a mathematical domain gap as an application failure.
 * @param node - Parsed function expression.
 * @param parameters - Current finite scene parameters.
 * @param x - Position used for both x and t variables.
 * @returns A finite sample, or null when an operation has no finite real result.
 * @throws {Error} When required variables are missing, inputs are non-finite, or the expression tree is invalid.
 */
export function evaluateFunction(node: ExpressionNode, parameters: Readonly<Record<string, number>>, x: number): number | null {
  try {
    return evaluateExpression(node, { ...parameters, x, t: x, pi: Math.PI, e: Math.E })
  } catch (error) {
    if (error instanceof ExpressionDomainError) return null
    throw error
  }
}

/**
 * Approximate a derivative using a centered difference at a defined function point.
 * @param node - Parsed function expression.
 * @param parameters - Current finite scene parameters.
 * @param x - Analysis position.
 * @returns A finite slope, or null when the point or either neighboring sample is unavailable.
 */
export function differentiateFunction(node: ExpressionNode, parameters: Readonly<Record<string, number>>, x: number): number | null {
  if (evaluateFunction(node, parameters, x) === null) return null
  const h = 0.001
  const left = evaluateFunction(node, parameters, x - h)
  const right = evaluateFunction(node, parameters, x + h)
  if (left === null || right === null) return null
  const value = (right - left) / (2 * h)
  return Number.isFinite(value) ? value : null
}

/**
 * Approximate the integral from zero using trapezoid samples without crossing a sampled domain gap.
 * @param node - Parsed function expression.
 * @param parameters - Current finite scene parameters.
 * @param x - Signed upper integration limit.
 * @returns A finite integral, or null when any sample or the accumulated result is unavailable.
 */
export function integrateFunction(node: ExpressionNode, parameters: Readonly<Record<string, number>>, x: number): number | null {
  const steps = 200
  const width = x / steps
  let total = 0
  for (let index = 0; index <= steps; index++) {
    const sample = evaluateFunction(node, parameters, index * width)
    if (sample === null) return null
    const weight = index === 0 || index === steps ? 0.5 : 1
    total += sample * weight
    if (!Number.isFinite(total)) return null
  }
  const value = total * width
  return Number.isFinite(value) ? value : null
}

/**
 * Read the function value, centered derivative, and integral from zero at one position.
 * @param node - Parsed function expression.
 * @param parameters - Current finite scene parameters.
 * @param x - Analysis position.
 * @returns Finite numeric readings with null for each unavailable result.
 */
export function analyzeFunction(node: ExpressionNode, parameters: Readonly<Record<string, number>>, x: number): FunctionAnalysis {
  return {
    value: evaluateFunction(node, parameters, x),
    derivative: differentiateFunction(node, parameters, x),
    integral: integrateFunction(node, parameters, x),
  }
}
