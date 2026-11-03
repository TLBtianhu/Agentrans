/** Comparison-group Artifact events folded into one stable Chat Node per group. */
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-artifact/types'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ArtifactComparisonSnapshot, ArtifactSnapshot } from './protocol.ts'

interface ComparisonState {
  readonly control?: ArtifactSnapshot
  readonly variant?: ArtifactSnapshot
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Independent control and variant snapshots belonging to one comparison group. */
    'artifact-comparison': ArtifactComparisonSnapshot
  }
}

function comparisonOf(event: SessionEventLike): ArtifactSnapshot['comparison'] | undefined {
  return event.type === 'artifact/upsert' ? event.data.comparison : undefined
}

function stateOf(state: ComparisonState, event: SessionEventLike): ComparisonState {
  if (event.type !== 'artifact/upsert') throw new Error('artifact comparison requires artifact/upsert')
  const comparison = event.data.comparison
  if (comparison === undefined) throw new Error('artifact comparison requires comparison metadata')
  return { ...state, [comparison.role]: event.data }
}

/** Grouped checkpoints initialize independently and merge only by comparison role. */
export const artifactComparisonDefinition: ConversationNodeDefinition<ComparisonState> = {
  kind: 'artifact-comparison',
  target: 'chat',
  match: (event) => {
    const comparison = comparisonOf(event)
    return comparison === undefined ? null : { id: `comparison:${comparison.group}`, role: 'start', exclusive: true }
  },
  start: (_context, match) => stateOf({}, match.event),
  update: (context, match) => stateOf(context.state, match.event),
  buildViewNode: (context) => {
    if (context.state === undefined || context.start === undefined) return null
    const group = context.id.slice('comparison:'.length)
    return {
      key: context.key,
      kind: 'artifact-comparison',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: { group, ...context.state },
    }
  },
}
