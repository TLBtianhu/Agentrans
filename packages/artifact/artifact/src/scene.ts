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
  readonly style?: SceneStyle
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

/** Visual idiom for a SceneSpec. */
export type SceneStyle = 'editorial' | 'transit-map' | 'blueprint' | 'math-proof-lecture' | 'particles'

/** Declarative flowchart with nodes, directed edges, and an optional path to advance. */
export interface FlowchartSpec {
  readonly kind: 'flowchart'
  readonly nodes: readonly FlowchartNodeSpec[]
  readonly edges: readonly FlowchartEdgeSpec[]
  readonly path?: readonly string[]
  readonly style?: SceneStyle
  readonly timeline?: { readonly duration: number; readonly fps: number }
}

/** One particle in a deterministic physical simulation. */
export interface ParticleSpec {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly vx: number
  readonly vy: number
  readonly mass: number
}

/** Gravity vector for a particle simulation. */
export interface GravitySpec {
  readonly x: number
  readonly y: number
}

/** Declarative particle system with gravity, fixed time steps, and optional trails. */
export interface ParticleSystemSpec {
  readonly kind: 'particle-system'
  readonly particles: readonly ParticleSpec[]
  readonly gravity: GravitySpec
  readonly timeStep: number
  readonly trails: boolean
  readonly style?: SceneStyle
  readonly timeline?: { readonly duration: number; readonly fps: number }
}

/** One event on a timeline. */
export interface TimelineEventSpec {
  readonly id: string
  readonly label: string
  readonly time: number
  readonly description?: string
}

/** Declarative timeline with ordered events and a movable playhead. */
export interface TimelineSpec {
  readonly kind: 'timeline'
  readonly events: readonly TimelineEventSpec[]
  readonly playhead?: number
  readonly style?: SceneStyle
  readonly timeline?: { readonly duration: number; readonly fps: number }
}

/** Declarative network graph with nodes and directed edges for relationship explanations. */
export interface NetworkGraphSpec {
  readonly kind: 'network-graph'
  readonly nodes: readonly FlowchartNodeSpec[]
  readonly edges: readonly FlowchartEdgeSpec[]
  readonly style?: SceneStyle
  readonly timeline?: { readonly duration: number; readonly fps: number }
}

/** One marker on a map. */
export interface MapMarkerSpec {
  readonly id: string
  readonly label: string
  readonly x: number
  readonly y: number
  readonly description?: string
}

/** Declarative map with positioned markers and an optional route to step through. */
export interface MapSpec {
  readonly kind: 'map'
  readonly markers: readonly MapMarkerSpec[]
  readonly path?: readonly string[]
  readonly style?: SceneStyle
  readonly timeline?: { readonly duration: number; readonly fps: number }
}

/** Union of all currently supported declarative SceneSpec primitives. */
export type SceneSpec = FunctionPlotSpec | FlowchartSpec | ParticleSystemSpec | TimelineSpec | NetworkGraphSpec | MapSpec

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
  return { kind: 'function-plot', functions, parameters, viewport, trace: { x, derivative: value.trace.derivative, integral: value.trace.integral }, ...timeline === undefined ? {} : { timeline }, style: value.style === undefined ? 'editorial' : normalizeStyle(value.style) }
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
  return { kind: 'flowchart', nodes, edges, ...(path === undefined ? {} : { path }), ...(timeline === undefined ? {} : { timeline }), style: value.style === undefined ? 'editorial' : normalizeStyle(value.style) }
}

function normalizeStyle(value: unknown): SceneStyle {
  if (value === 'editorial' || value === 'transit-map' || value === 'blueprint' || value === 'math-proof-lecture' || value === 'particles') return value
  throw new SceneValidationError('/style', 'must be editorial, transit-map, blueprint, math-proof-lecture, or particles')
}

/**
 * Validate and normalize a ParticleSystem SceneSpec.
 * @param value - Untrusted model or Session snapshot value.
 * @returns A normalized ParticleSystem SceneSpec.
 * @throws {SceneValidationError} When particles, gravity, or time steps are invalid.
 */
export function normalizeParticleSystem(value: unknown): ParticleSystemSpec {
  if (!isRecord(value) || value.kind !== 'particle-system') throw new SceneValidationError('/kind', 'must be particle-system')
  if (!Array.isArray(value.particles) || value.particles.length < 1 || value.particles.length > 64) {
    throw new SceneValidationError('/particles', 'must contain 1 to 64 particles')
  }
  const particles = value.particles.map((item, index) => {
    const path = `/particles/${index}`
    if (!isRecord(item)) throw new SceneValidationError(path, 'must be an object')
    if (typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(item.id)) {
      throw new SceneValidationError(`${path}/id`, 'must match [a-z][a-z0-9-]{0,31}')
    }
    const mass = numberAt(item.mass, `${path}/mass`)
    if (mass <= 0) throw new SceneValidationError(`${path}/mass`, 'must be > 0')
    return {
      id: item.id,
      x: numberAt(item.x, `${path}/x`), y: numberAt(item.y, `${path}/y`),
      vx: numberAt(item.vx, `${path}/vx`), vy: numberAt(item.vy, `${path}/vy`), mass,
    }
  })
  if (!isRecord(value.gravity)) throw new SceneValidationError('/gravity', 'must be an object')
  const gravity = { x: numberAt(value.gravity.x, '/gravity/x'), y: numberAt(value.gravity.y, '/gravity/y') }
  const timeStep = numberAt(value.timeStep, '/timeStep')
  if (timeStep <= 0) throw new SceneValidationError('/timeStep', 'must be > 0')
  if (typeof value.trails !== 'boolean') throw new SceneValidationError('/trails', 'must be a boolean')
  let timeline: ParticleSystemSpec['timeline']
  if (value.timeline !== undefined) {
    if (!isRecord(value.timeline)) throw new SceneValidationError('/timeline', 'must be an object')
    const duration = numberAt(value.timeline.duration, '/timeline/duration')
    const fps = numberAt(value.timeline.fps, '/timeline/fps')
    if (duration <= 0) throw new SceneValidationError('/timeline/duration', 'must be > 0')
    if (!Number.isSafeInteger(fps) || fps < 1 || fps > 120) throw new SceneValidationError('/timeline/fps', 'must be an integer in [1,120]')
    timeline = { duration, fps }
  }
  return { kind: 'particle-system', particles, gravity, timeStep, trails: value.trails, ...(timeline === undefined ? {} : { timeline }), style: value.style === undefined ? 'editorial' : normalizeStyle(value.style) }
}

/**
 * Validate and normalize a Timeline SceneSpec.
 * @param value - Untrusted model or Session snapshot value.
 * @returns A normalized Timeline SceneSpec.
 * @throws {SceneValidationError} When events or the playhead are invalid.
 */
export function normalizeTimeline(value: unknown): TimelineSpec {
  if (!isRecord(value) || value.kind !== 'timeline') throw new SceneValidationError('/kind', 'must be timeline')
  if (!Array.isArray(value.events) || value.events.length < 1 || value.events.length > 64) {
    throw new SceneValidationError('/events', 'must contain 1 to 64 events')
  }
  const events = value.events.map((item, index) => {
    const path = `/events/${index}`
    if (!isRecord(item)) throw new SceneValidationError(path, 'must be an object')
    if (typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(item.id)) {
      throw new SceneValidationError(`${path}/id`, 'must match [a-z][a-z0-9-]{0,31}')
    }
    if (typeof item.label !== 'string' || item.label.trim().length === 0) {
      throw new SceneValidationError(`${path}/label`, 'must be a non-empty label')
    }
    return {
      id: item.id, label: item.label.trim(), time: numberAt(item.time, `${path}/time`),
      ...(item.description === undefined ? {} : { description: String(item.description) }),
    }
  }).sort((a, b) => a.time - b.time)
  let playhead: number | undefined
  if (value.playhead !== undefined) {
    playhead = numberAt(value.playhead, '/playhead')
    const firstTime = events.at(0)?.time
    const lastTime = events.at(-1)?.time
    if (firstTime === undefined || lastTime === undefined) throw new SceneValidationError('/events', 'must not be empty')
    if (playhead < firstTime || playhead > lastTime) {
      throw new SceneValidationError('/playhead', 'must be within the event time range')
    }
  }
  let timeline: TimelineSpec['timeline']
  if (value.timeline !== undefined) {
    if (!isRecord(value.timeline)) throw new SceneValidationError('/timeline', 'must be an object')
    const duration = numberAt(value.timeline.duration, '/timeline/duration')
    const fps = numberAt(value.timeline.fps, '/timeline/fps')
    if (duration <= 0) throw new SceneValidationError('/timeline/duration', 'must be > 0')
    if (!Number.isSafeInteger(fps) || fps < 1 || fps > 120) throw new SceneValidationError('/timeline/fps', 'must be an integer in [1,120]')
    timeline = { duration, fps }
  }
  return { kind: 'timeline', events, ...(playhead === undefined ? {} : { playhead }), ...(timeline === undefined ? {} : { timeline }), style: value.style === undefined ? 'editorial' : normalizeStyle(value.style) }
}

/** Versioned catalog of SceneSpec primitives available to model generation. */
export const sceneCatalog: Readonly<Record<SceneSpec['kind'], SceneCatalogEntry>> = {
  'function-plot': { kind: 'function-plot', catalogVersion: 1, normalize: normalizeFunctionPlot },
  'flowchart': { kind: 'flowchart', catalogVersion: 1, normalize: normalizeFlowchart },
  'particle-system': { kind: 'particle-system', catalogVersion: 1, normalize: normalizeParticleSystem },
  'timeline': { kind: 'timeline', catalogVersion: 1, normalize: normalizeTimeline },
  'network-graph': { kind: 'network-graph', catalogVersion: 1, normalize: normalizeNetworkGraph },
  'map': { kind: 'map', catalogVersion: 1, normalize: normalizeMap },
}

function normalizeMap(value: unknown): MapSpec {
  if (!isRecord(value) || value.kind !== 'map') throw new SceneValidationError('/kind', 'must be map')
  if (!Array.isArray(value.markers) || value.markers.length < 1 || value.markers.length > 64) {
    throw new SceneValidationError('/markers', 'must contain 1 to 64 markers')
  }
  const markers = value.markers.map((item, index) => {
    const path = `/markers/${index}`
    if (!isRecord(item)) throw new SceneValidationError(path, 'must be an object')
    if (typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(item.id)) {
      throw new SceneValidationError(`${path}/id`, 'must match [a-z][a-z0-9-]{0,31}')
    }
    if (typeof item.label !== 'string' || item.label.trim().length === 0) {
      throw new SceneValidationError(`${path}/label`, 'must be a non-empty label')
    }
    return {
      id: item.id, label: item.label.trim(),
      x: numberAt(item.x, `${path}/x`), y: numberAt(item.y, `${path}/y`),
      ...(item.description === undefined ? {} : { description: String(item.description) }),
    }
  })
  const ids = new Set(markers.map(marker => marker.id))
  let path: MapSpec['path']
  if (value.path !== undefined) {
    if (!Array.isArray(value.path)) throw new SceneValidationError('/path', 'must be an array of marker ids')
    for (const [index, id] of value.path.entries()) {
      if (typeof id !== 'string' || !ids.has(id)) throw new SceneValidationError(`/path/${index}`, 'must reference an existing marker')
    }
    path = value.path as readonly string[]
  }
  let timeline: MapSpec['timeline']
  if (value.timeline !== undefined) {
    if (!isRecord(value.timeline)) throw new SceneValidationError('/timeline', 'must be an object')
    const duration = numberAt(value.timeline.duration, '/timeline/duration')
    const fps = numberAt(value.timeline.fps, '/timeline/fps')
    if (duration <= 0) throw new SceneValidationError('/timeline/duration', 'must be > 0')
    if (!Number.isSafeInteger(fps) || fps < 1 || fps > 120) throw new SceneValidationError('/timeline/fps', 'must be an integer in [1,120]')
    timeline = { duration, fps }
  }
  return { kind: 'map', markers, ...(path === undefined ? {} : { path }), ...(timeline === undefined ? {} : { timeline }), style: value.style === undefined ? 'editorial' : normalizeStyle(value.style) }
}

function normalizeNetworkGraph(value: unknown): NetworkGraphSpec {
  if (!isRecord(value) || value.kind !== 'network-graph') throw new SceneValidationError('/kind', 'must be network-graph')
  const { nodes, edges, timeline } = normalizeFlowchart({ ...value, kind: 'flowchart' })
  return { kind: 'network-graph', nodes, edges, ...(timeline === undefined ? {} : { timeline }), style: value.style === undefined ? 'editorial' : normalizeStyle(value.style) }
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
