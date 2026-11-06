/** SceneSpec renderer dispatch: one place that maps a SceneSpec kind to its native component. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SceneSpec } from '@deepseek-ai/dsh-artifact/scene'
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import type { ArtifactPlacement, RecordArtifactAction } from './protocol.ts'
import { FunctionPlotView } from './FunctionPlotView.tsx'
import { FlowchartView } from './FlowchartView.tsx'
import { ParticleSystemView } from './ParticleSystemView.tsx'
import { TimelineView } from './TimelineView.tsx'
import { NetworkGraphView } from './NetworkGraphView.tsx'

interface SceneNodeViewProps {
  readonly spec: SceneSpec
  readonly artifactId: ArtifactId
  readonly revision: number
  readonly placement: ArtifactPlacement
  readonly recordAction: RecordArtifactAction
  readonly onStateChange?: ((state: JsonValue) => void) | undefined
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
      return <ParticleSystemView {...props} spec={props.spec} />
    case 'timeline':
      return <TimelineView {...props} spec={props.spec} />
    case 'network-graph':
      return <NetworkGraphView {...props} spec={props.spec} />
  }
}
