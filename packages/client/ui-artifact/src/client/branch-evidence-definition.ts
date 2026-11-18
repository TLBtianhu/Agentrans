/** Visible Chat notices for returned branch conclusions with replayable evidence. */
import type {} from '@agentrans/client-ui-chat/client'
import type { ConversationNodeDefinition } from '@agentrans/client-ui-conversation/client'
import type { SessionEvent, SessionId } from '@agentrans/session/types'
import { isAppendSurfaceEvent } from '@agentrans/session/surface'
import { parseBranchEvidenceNotice, type BranchEvidenceNotice } from './branch-evidence-text.ts'

interface BranchEvidenceViewData extends BranchEvidenceNotice {
  readonly messageId: SessionEvent<'user/message'>['data']['id']
  readonly branchSessionId: SessionId
}

declare module '@agentrans/client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Parent-local conclusion and replayable evidence returned from a branch. */
    'artifact-branch-evidence': BranchEvidenceViewData
  }
}

/** Project a self-contained evidence notice from the original append. */
export const artifactBranchEvidenceDefinition: ConversationNodeDefinition<BranchEvidenceViewData | null> = {
  kind: 'artifact-branch-evidence',
  target: 'chat',
  match: event => event.type === 'user/message' && event.data.source.kind === 'branch-result' && isAppendSurfaceEvent(event)
    ? { id: event.data.id, role: 'start' }
    : null,
  start: (_context, { event }) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'branch-result') return null
    const notice = parseBranchEvidenceNotice(event.data)
    return notice === null ? null : { ...notice, messageId: event.data.id, branchSessionId: event.data.source.branchSessionId }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (!context.state || context.start === undefined) return null
    return {
      key: context.key,
      kind: 'artifact-branch-evidence',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state,
    }
  },
}
