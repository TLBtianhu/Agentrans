/** Declarative SceneSpec reference for code-generated mathematical scenes. */
export interface FunctionSpec {
  readonly id: 'sine' | 'quadratic'
  readonly label: string
  readonly expression: 'sin' | 'quadratic'
  readonly parameter?: 'a'
}

export interface ViewportSpec {
  readonly centerX: number
  readonly centerY: number
  readonly scale: number
}

export interface TraceSpec {
  readonly x: number
  readonly derivative: boolean
  readonly integral: boolean
}

export interface FunctionPlotSpec {
  readonly kind: 'function-plot'
  readonly functions: readonly FunctionSpec[]
  readonly parameters: Readonly<Record<'a', number>>
  readonly viewport: ViewportSpec
  readonly trace: TraceSpec
}

export interface FlowNodeSpec {
  readonly id: string
  readonly label: string
  readonly x: number
  readonly y: number
  readonly tone: 'accent' | 'good' | 'warn' | 'muted'
}

export interface FlowEdgeSpec {
  readonly from: string
  readonly to: string
  readonly label?: string
}

export interface FlowchartSpec {
  readonly kind: 'flowchart'
  readonly nodes: readonly FlowNodeSpec[]
  readonly edges: readonly FlowEdgeSpec[]
  readonly steps: readonly string[]
  readonly viewport: ViewportSpec
  readonly selected: string
}

export interface ParticleSpec {
  readonly id: 'alpha' | 'beta'
  readonly label: string
  readonly x: number
  readonly y: number
  readonly vx: number
  readonly vy: number
  readonly tone: 'accent' | 'good'
}

export interface ParticleSystemSpec {
  readonly kind: 'particle-system'
  readonly particles: readonly ParticleSpec[]
  readonly gravity: number
  readonly timeStep: number
  readonly viewport: ViewportSpec
  readonly selected: ParticleSpec['id']
}

export type SceneSpec = FunctionPlotSpec | FlowchartSpec | ParticleSystemSpec
export type SceneCommand = 'play' | 'pause' | 'step' | 'reset'

export interface FunctionPlotState {
  readonly x: number
  readonly parameter: number
  readonly derivative: number
  readonly integral: number
  readonly zoom: number
  readonly playing: boolean
}

export interface FlowchartState {
  readonly selected: string
  readonly step: number
  readonly zoom: number
  readonly playing: boolean
}

export interface ParticleState {
  readonly time: number
  readonly selected: ParticleSpec['id']
  readonly gravity: number
  readonly position: { readonly x: number; readonly y: number }
  readonly velocity: { readonly x: number; readonly y: number }
  readonly playing: boolean
}
