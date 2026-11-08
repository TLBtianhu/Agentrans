/** SceneSpec renderer dispatch: one place that maps a SceneSpec kind to its native component. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RuntimeReport } from '@deepseek-ai/dsh-artifact-runtime/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SceneSpec } from '@deepseek-ai/dsh-artifact/scene'
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import type { ArtifactPlacement, RecordArtifactAction } from './protocol.ts'
import { FunctionPlotView } from './FunctionPlotView.tsx'
import { FlowchartView } from './FlowchartView.tsx'
import { ParticleSystemView } from './ParticleSystemView.tsx'
import { TimelineView } from './TimelineView.tsx'
import { NetworkGraphView } from './NetworkGraphView.tsx'
import { MapView } from './MapView.tsx'
import type { ParticleRun, ParticleRunCommand } from './particle-run.ts'

interface SceneNodeViewProps {
  readonly spec: SceneSpec
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly placement: ArtifactPlacement
  readonly recordAction: RecordArtifactAction
  readonly canRecord?: boolean
  readonly recordPending?: boolean
  readonly onRuntimeReport?: ((report: RuntimeReport) => void) | undefined
  readonly onStateChange?: ((state: JsonValue) => void) | undefined
  readonly particleRun: ParticleRun | null
  readonly onParticleCommand: (command: ParticleRunCommand) => void
  readonly readOnly?: boolean
  readonly t: PropsLocale<'artifact'>['t']
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
