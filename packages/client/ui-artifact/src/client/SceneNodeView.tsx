/** SceneSpec renderer dispatch: one place that maps a SceneSpec kind to its native component. */
import type { SceneSpec } from '@agentrans/artifact/scene'
import type { ArtifactParticleContinuation } from '@agentrans/artifact/types'
import type { FunctionPlotQuestionConditions } from '@agentrans/artifact-followup/types'
import type { SceneViewProps } from './SceneViewParts.tsx'
import { FunctionPlotView, type FunctionPlotBaseline, type RecordedFunctionPlot } from './FunctionPlotView.tsx'
import { CsvBarChartView } from './CsvBarChartView.tsx'
import { FlowchartView } from './FlowchartView.tsx'
import { ParticleSystemView } from './ParticleSystemView.tsx'
import { TimelineView } from './TimelineView.tsx'
import { NetworkGraphView } from './NetworkGraphView.tsx'
import { MapView } from './MapView.tsx'
import type { ParticleRun, ParticleRunCommand } from './particle-run.ts'

interface SceneNodeViewProps extends SceneViewProps<SceneSpec> {
  readonly onAttachPlotQuestion?: ((conditions: FunctionPlotQuestionConditions) => boolean) | undefined
  readonly onAttachCsvQuestion?: ((groupKey: string) => boolean) | undefined
  readonly replayPlot?: RecordedFunctionPlot | undefined
  readonly replayCsvGroupKey?: string | undefined
  readonly baselinePlot?: FunctionPlotBaseline | undefined
  readonly baselineParticle?: ArtifactParticleContinuation | undefined
  readonly particleGravityY?: number | undefined
  readonly particleRun: ParticleRun | null
  readonly onParticleCommand: (command: ParticleRunCommand) => void
  readonly readOnly?: boolean
}

/**
 * Render a validated SceneSpec with the native component registered for its kind.
 * @param props - SceneSpec, Artifact identity, placement, confirmation callback, and locale seat.
 * @returns The native SceneSpec component for the spec's kind.
 */
export function SceneNodeView(props: SceneNodeViewProps) {
  switch (props.spec.kind) {
    case 'function-plot':
      return <FunctionPlotView {...props} spec={props.spec} />
    case 'csv-bar-chart':
      return <CsvBarChartView spec={props.spec} revision={props.revision} readOnly={props.readOnly}
        selectedGroupKey={props.replayCsvGroupKey} onAttachCsvQuestion={props.onAttachCsvQuestion}
        onRuntimeReport={props.onRuntimeReport} t={props.t} />
    case 'flowchart':
      return <FlowchartView {...props} spec={props.spec} />
    case 'particle-system':
      if (props.particleRun === null) throw new Error('Particle scene requires a revision-owned runtime')
      return <ParticleSystemView {...props} spec={props.spec} run={props.particleRun} onCommand={props.onParticleCommand} />
    case 'timeline':
      return <TimelineView {...props} spec={props.spec} />
    case 'network-graph':
      return <NetworkGraphView {...props} spec={props.spec} />
    case 'map':
      return <MapView {...props} spec={props.spec} />
  }
}
