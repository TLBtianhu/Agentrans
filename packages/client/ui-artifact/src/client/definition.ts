/** Whole-checkpoint Artifact events folded into one stable Chat Node per artifact id. */
import type { SessionEventLike } from '@agentrans/api-session-controller/client'
import type {} from '@agentrans/artifact/types'
import type {} from '@agentrans/client-ui-chat/client'
import type { ConversationNodeDefinition } from '@agentrans/client-ui-conversation/client'
import type { ArtifactSnapshot } from './protocol.ts'

declare module '@agentrans/client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Latest complete HTML Artifact snapshot. */
    artifact: ArtifactSnapshot
  }
}

function snapshotOf(event: SessionEventLike): ArtifactSnapshot {
  if (event.type !== 'artifact/upsert') throw new Error('artifact requires artifact/upsert')
  return event.data
}

/** Full checkpoints initialize from any tail and replace earlier revisions without changing Context identity. */
export const artifactDefinition: ConversationNodeDefinition<ArtifactSnapshot> = {
  kind: 'artifact',
  target: 'chat',
  match: event => event.type === 'artifact/upsert' && event.data.comparison === undefined
    ? { id: event.data.artifactId, role: 'start', exclusive: true }
    : null,
  start: (_context, match) => snapshotOf(match.event),
  update: (_context, match) => snapshotOf(match.event),
  buildViewNode: (context) => {
    if (context.state === undefined || context.start === undefined) return null
    return {
      key: context.key,
      kind: 'artifact',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      // A committed Artifact is a result of its Turn, not part of the process
      // run: it keeps its own row so the inline card stays visible while the
      // process group is folded.
      groupTree: 'turn',
      data: context.state,
    }
  },
}
