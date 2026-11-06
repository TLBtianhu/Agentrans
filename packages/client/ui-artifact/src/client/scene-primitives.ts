/** Registry of SceneSpec primitives: kind → renderer and component used by the preview and the exporter. */
import type { SceneSpec } from '@deepseek-ai/dsh-artifact/scene'
import { renderFunctionPlot } from './renderers/function-plot.ts'
import { renderFlowchart } from './renderers/flowchart.ts'
import { renderParticleSystem } from './renderers/particle-system.ts'
import { renderTimeline } from './renderers/timeline.ts'
import { renderNetworkGraph } from './renderers/network-graph.ts'
import { renderMap } from './renderers/map.ts'

/** One SceneSpec primitive's renderer and its exporter name. */
export interface ScenePrimitiveEntry {
  readonly kind: SceneSpec['kind']
  readonly rendererName: string
  readonly render: (spec: SceneSpec, canvas: HTMLCanvasElement, width: number, height: number, state: unknown) => void
}

/**
 * Registered SceneSpec primitives. Add a new primitive here to make it available to the preview and the exporter.
 */
export const scenePrimitives: Readonly<Record<SceneSpec['kind'], ScenePrimitiveEntry>> = {
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
