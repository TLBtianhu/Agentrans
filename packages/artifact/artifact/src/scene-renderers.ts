/** Shared framework-free SceneSpec renderers used by the conversation preview and the animation exporter. */
export { renderFunctionPlot, type FunctionPlotRenderState } from './renderers/function-plot.ts'
export {
  SCENE_PALETTE_ROLES, SCENE_PALETTE_TOKENS, SCENE_STYLE_PALETTES, ScenePaletteError,
  resolveScenePalette, scenePaletteOwnership,
  type ScenePalette, type ScenePaletteOwnership, type ScenePaletteRole,
} from './scene-palette.ts'
export { analyzeFunction, evaluateFunction, differentiateFunction, integrateFunction, type FunctionAnalysis } from './renderers/function-analysis.ts'
export { renderFlowchart, type FlowchartRenderState } from './renderers/flowchart.ts'
export { renderParticleSystem, type ParticleRenderState } from './renderers/particle-system.ts'
export {
  createParticleState, stepParticleState, advanceParticleState, particleStateAtTime,
  observeParticleState, createParticleCheckpoint, restoreParticleCheckpoint,
  PARTICLE_RUNTIME_VERSION, ParticleRuntimeError,
  type ParticleState, type ParticleCheckpoint, type ParticleObservation,
} from './particle-runtime.ts'
export { renderTimeline, type TimelineRenderState } from './renderers/timeline.ts'
export { renderNetworkGraph, type NetworkGraphRenderState } from './renderers/network-graph.ts'
export { renderMap, type MapRenderState } from './renderers/map.ts'
export { scenePrimitives, type ScenePrimitiveEntry } from './scene-primitives.ts'
