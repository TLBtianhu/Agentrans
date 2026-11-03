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

export type SceneSpec = FunctionPlotSpec
export type SceneCommand = 'play' | 'pause' | 'step' | 'reset'

export interface FunctionPlotState {
  readonly x: number
  readonly parameter: number
  readonly derivative: number
  readonly integral: number
  readonly zoom: number
  readonly playing: boolean
}
