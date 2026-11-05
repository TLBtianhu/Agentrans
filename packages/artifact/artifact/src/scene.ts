/** Versioned SceneSpec definitions and validation for model-generated scenes. */
import { parseExpression } from '@deepseek-ai/dsh-util-values'

/** Bounded numeric parameter exposed by a SceneSpec. */
export interface SceneParameterSpec {
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step: number
}

/** Named mathematical function and its safe expression. */
export interface SceneFunctionSpec {
  readonly id: string
  readonly label: string
  readonly expression: string
}

/** Declarative function-plot scene with functions, parameters, viewport, and trace settings. */
export interface FunctionPlotSpec {
  readonly kind: 'function-plot'
  readonly functions: readonly SceneFunctionSpec[]
  readonly parameters: Readonly<Record<string, SceneParameterSpec>>
  readonly viewport: { readonly x: readonly [number, number]; readonly y: readonly [number, number] }
  readonly trace: { readonly x: number; readonly derivative: boolean; readonly integral: boolean }
  readonly timeline?: { readonly duration: number; readonly fps: number }
}

/** One node in a flowchart. */
export interface FlowchartNodeSpec {
  readonly id: string
  readonly label: string
  readonly x: number
  readonly y: number
}

/** One directed edge in a flowchart. */
export interface FlowchartEdgeSpec {
  readonly from: string
  readonly to: string
  readonly label?: string
}

/** Declarative flowchart with nodes, directed edges, and an optional path to advance. */
export interface FlowchartSpec {
  readonly kind: 'flowchart'
  readonly nodes: readonly FlowchartNodeSpec[]
  readonly edges: readonly FlowchartEdgeSpec[]
  readonly path?: readonly string[]
  readonly timeline?: { readonly duration: number; readonly fps: number }
}

/** Union of all currently supported declarative SceneSpec primitives. */
export type SceneSpec = FunctionPlotSpec | FlowchartSpec

/** Catalog entry owning one primitive's version and normalization. */
export interface SceneCatalogEntry {
  readonly kind: SceneSpec['kind']
  readonly catalogVersion: number
  readonly normalize: (value: unknown) => SceneSpec
}

/** Error with the exact SceneSpec path that failed validation. */
export class SceneValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'SceneValidationError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new SceneValidationError(path, 'must be a finite number')
  return value
}

function parameterAt(value: unknown, path: string): SceneParameterSpec {
  if (!isRecord(value)) throw new SceneValidationError(path, 'must be an object')
  const current = numberAt(value.value, `${path}.value`)
  const min = numberAt(value.min, `${path}.min`)
  const max = numberAt(value.max, `${path}.max`)
  const step = numberAt(value.step, `${path}.step`)
  if (min > max) throw new SceneValidationError(path, 'min must be <= max')
  if (step <= 0) throw new SceneValidationError(`${path}.step`, 'must be > 0')
  if (current < min || current > max) throw new SceneValidationError(`${path}.value`, 'must be within [min,max]')
  return { value: current, min, max, step }
}

function rangeAt(value: unknown, path: string): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new SceneValidationError(path, 'must be [min,max]')
  const min = numberAt(value[0], `${path}[0]`)
  const max = numberAt(value[1], `${path}[1]`)
  if (min >= max) throw new SceneValidationError(path, 'min must be < max')
  return [min, max]
}

/**
 * Validate and normalize a FunctionPlot SceneSpec.
 * @param value - Untrusted model or Session snapshot value.
 * @returns A normalized FunctionPlot SceneSpec.
 * @throws {SceneValidationError} When structure, references, bounds, or expressions are invalid.
 */
export function normalizeFunctionPlot(value: unknown): FunctionPlotSpec {
  if (!isRecord(value) || value.kind !== 'function-plot') throw new SceneValidationError('/kind', 'must be function-plot')
  if (!Array.isArray(value.functions) || value.functions.length < 1 || value.functions.length > 8) {
    throw new SceneValidationError('/functions', 'must contain 1 to 8 functions')
  }
  if (!isRecord(value.parameters)) throw new SceneValidationError('/parameters', 'must be an object')
  const parameters: Record<string, SceneParameterSpec> = {}
  for (const [key, parameter] of Object.entries(value.parameters)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new SceneValidationError(`/parameters/${key}`, 'must be an identifier')
    parameters[key] = parameterAt(parameter, `/parameters/${key}`)
  }
  const allowedVariables = [...Object.keys(parameters), 'x', 't', 'pi', 'e']
  const functions = value.functions.map((item, index) => {
    const path = `/functions/${index}`
    if (!isRecord(item)) throw new SceneValidationError(path, 'must be an object')
    if (typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(item.id)) {
      throw new SceneValidationError(`${path}/id`, 'must match [a-z][a-z0-9-]{0,31}')
    }
    if (typeof item.expression !== 'string' || item.expression.trim().length === 0) {
      throw new SceneValidationError(`${path}/expression`, 'must be a non-empty expression')
    }
    parseExpression(item.expression, allowedVariables)
    return {
      id: item.id,
      label: typeof item.label === 'string' && item.label.trim().length > 0 ? item.label.trim() : item.id,
      expression: item.expression,
    }
  })
  if (!isRecord(value.viewport)) throw new SceneValidationError('/viewport', 'must be an object')
  const viewport = { x: rangeAt(value.viewport.x, '/viewport/x'), y: rangeAt(value.viewport.y, '/viewport/y') }
  if (!isRecord(value.trace)) throw new SceneValidationError('/trace', 'must be an object')
  const x = numberAt(value.trace.x, '/trace/x')
  if (x < viewport.x[0] || x > viewport.x[1]) throw new SceneValidationError('/trace/x', 'must be within viewport.x')
  if (typeof value.trace.derivative !== 'boolean') throw new SceneValidationError('/trace/derivative', 'must be boolean')
  if (typeof value.trace.integral !== 'boolean') throw new SceneValidationError('/trace/integral', 'must be boolean')
  let timeline: FunctionPlotSpec['timeline']
  if (value.timeline !== undefined) {
    if (!isRecord(value.timeline)) throw new SceneValidationError('/timeline', 'must be an object')
    const duration = numberAt(value.timeline.duration, '/timeline/duration')
    const fps = numberAt(value.timeline.fps, '/timeline/fps')
    if (duration <= 0) throw new SceneValidationError('/timeline/duration', 'must be > 0')
    if (!Number.isSafeInteger(fps) || fps < 1 || fps > 120) throw new SceneValidationError('/timeline/fps', 'must be an integer in [1,120]')
    timeline = { duration, fps }
  }
  return { kind: 'function-plot', functions, parameters, viewport, trace: { x, derivative: value.trace.derivative, integral: value.trace.integral }, ...timeline === undefined ? {} : { timeline } }
}

/**
 * Validate and normalize a Flowchart SceneSpec.
 * @param value - Untrusted model or Session snapshot value.
 * @returns A normalized Flowchart SceneSpec.
 * @throws {SceneValidationError} When nodes, edges, references, or the path are invalid.
 */
export function normalizeFlowchart(value: unknown): FlowchartSpec {
  if (!isRecord(value) || value.kind !== 'flowchart') throw new SceneValidationError('/kind', 'must be flowchart')
  if (!Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > 24) {
    throw new SceneValidationError('/nodes', 'must contain 1 to 24 nodes')
  }
  const nodes = value.nodes.map((item, index) => {
    const path = `/nodes/${index}`
    if (!isRecord(item)) throw new SceneValidationError(path, 'must be an object')
    if (typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(item.id)) {
      throw new SceneValidationError(`${path}/id`, 'must match [a-z][a-z0-9-]{0,31}')
    }
    if (typeof item.label !== 'string' || item.label.trim().length === 0) {
      throw new SceneValidationError(`${path}/label`, 'must be a non-empty label')
    }
    return { id: item.id, label: item.label.trim(), x: numberAt(item.x, `${path}/x`), y: numberAt(item.y, `${path}/y`) }
  })
  const ids = new Set(nodes.map(node => node.id))
  if (!Array.isArray(value.edges)) throw new SceneValidationError('/edges', 'must be an array')
  const edges = value.edges.map((item, index) => {
    const path = `/edges/${index}`
    if (!isRecord(item)) throw new SceneValidationError(path, 'must be an object')
    if (typeof item.from !== 'string' || !ids.has(item.from)) throw new SceneValidationError(`${path}/from`, 'must reference an existing node')
    if (typeof item.to !== 'string' || !ids.has(item.to)) throw new SceneValidationError(`${path}/to`, 'must reference an existing node')
    if (item.label !== undefined && (typeof item.label !== 'string' || item.label.trim().length === 0)) {
      throw new SceneValidationError(`${path}/label`, 'must be empty when omitted or a non-empty string')
    }
    return { from: item.from, to: item.to, ...(item.label === undefined ? {} : { label: item.label.trim() }) }
  })
  let path: FlowchartSpec['path']
  if (value.path !== undefined) {
    if (!Array.isArray(value.path)) throw new SceneValidationError('/path', 'must be an array of node ids')
    for (const [index, id] of value.path.entries()) {
      if (typeof id !== 'string' || !ids.has(id)) throw new SceneValidationError(`/path/${index}`, 'must reference an existing node')
    }
    path = value.path as readonly string[]
  }
  let timeline: FlowchartSpec['timeline']
  if (value.timeline !== undefined) {
    if (!isRecord(value.timeline)) throw new SceneValidationError('/timeline', 'must be an object')
    const duration = numberAt(value.timeline.duration, '/timeline/duration')
    const fps = numberAt(value.timeline.fps, '/timeline/fps')
    if (duration <= 0) throw new SceneValidationError('/timeline/duration', 'must be > 0')
    if (!Number.isSafeInteger(fps) || fps < 1 || fps > 120) throw new SceneValidationError('/timeline/fps', 'must be an integer in [1,120]')
    timeline = { duration, fps }
  }
  return { kind: 'flowchart', nodes, edges, ...(path === undefined ? {} : { path }), ...(timeline === undefined ? {} : { timeline }) }
}

/** Versioned catalog of SceneSpec primitives available to model generation. */
export const sceneCatalog: Readonly<Record<SceneSpec['kind'], SceneCatalogEntry>> = {
  'function-plot': { kind: 'function-plot', catalogVersion: 1, normalize: normalizeFunctionPlot },
  'flowchart': { kind: 'flowchart', catalogVersion: 1, normalize: normalizeFlowchart },
}

/**
 * Normalize a SceneSpec through the catalog entry that owns its primitive.
 * @param value - Untrusted model or Session snapshot value.
 * @returns The normalized SceneSpec.
 * @throws {SceneValidationError} When the kind is unsupported or its spec is invalid.
 */
export function normalizeSceneSpec(value: unknown): SceneSpec {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new SceneValidationError('/kind', 'must be a known scene kind')
  const entry = sceneCatalog[value.kind as FunctionPlotSpec['kind']]
  if (entry === undefined) throw new SceneValidationError('/kind', `unsupported scene kind: ${value.kind}`)
  return entry.normalize(value)
}
