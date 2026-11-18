/** Canvas renderer registry used by Scene previews and exports. */
import type { SceneSpec } from './scene.ts'
import { renderFunctionPlot } from './renderers/function-plot.ts'
import { renderFlowchart } from './renderers/flowchart.ts'
import { renderParticleSystem } from './renderers/particle-system.ts'
import { renderTimeline } from './renderers/timeline.ts'
import { renderNetworkGraph } from './renderers/network-graph.ts'
import { renderMap } from './renderers/map.ts'

/** One SceneSpec primitive's renderer and its exporter name. */
export interface ScenePrimitiveEntry {
  readonly kind: CanvasSceneSpec['kind']
  readonly rendererName: string
  readonly render: (spec: CanvasSceneSpec, canvas: HTMLCanvasElement, width: number, height: number, state: unknown) => void
}

type CanvasSceneSpec = Exclude<SceneSpec, { readonly kind: 'csv-bar-chart' }>

/** Registered canvas-based SceneSpec primitives. */
export const scenePrimitives: Readonly<Record<CanvasSceneSpec['kind'], ScenePrimitiveEntry>> = {
  'function-plot': {
    kind: 'function-plot',
    rendererName: 'renderFunctionPlot',
    render: renderFunctionPlot as ScenePrimitiveEntry['render'],
  },
  'flowchart': {
    kind: 'flowchart',
    rendererName: 'renderFlowchart',
    render: renderFlowchart as ScenePrimitiveEntry['render'],
  },
  'particle-system': {
    kind: 'particle-system',
    rendererName: 'renderParticleSystem',
    render: renderParticleSystem as ScenePrimitiveEntry['render'],
  },
  'timeline': {
    kind: 'timeline',
    rendererName: 'renderTimeline',
    render: renderTimeline as ScenePrimitiveEntry['render'],
  },
  'network-graph': {
    kind: 'network-graph',
    rendererName: 'renderNetworkGraph',
    render: renderNetworkGraph as ScenePrimitiveEntry['render'],
  },
  'map': {
    kind: 'map',
    rendererName: 'renderMap',
    render: renderMap as ScenePrimitiveEntry['render'],
  },
}
