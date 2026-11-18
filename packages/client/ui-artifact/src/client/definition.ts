/** Whole-checkpoint Artifact events folded into one stable Chat Node per artifact id. */
import type { SessionEventLike } from '@agentrans/api-session-controller/client'
import type {} from '@agentrans/artifact/types'
import type {} from '@agentrans/client-ui-chat/client'
import type { ConversationNodeDefinition } from '@agentrans/client-ui-conversation/client'
import type { CsvBarChartSpec, FunctionPlotSpec, ParticleSystemSpec } from '@agentrans/artifact/scene'
import type { SceneArtifactSnapshot } from '@agentrans/artifact/types'
import type { ArtifactSnapshot } from './protocol.ts'

/** A loaded revision with a read-only native preview. */
export type ReviewableSceneRevision = SceneArtifactSnapshot & { readonly spec: CsvBarChartSpec | FunctionPlotSpec | ParticleSystemSpec }

/** Earlier reviewable scene revisions in descending order. */
export interface SceneRevisionHistory {
  readonly snapshot: ReviewableSceneRevision
  readonly earlier: SceneRevisionHistory | null
}

interface ArtifactViewData {
  readonly snapshot: ArtifactSnapshot
  readonly history: SceneRevisionHistory | null
  /** Checkpoint used by the inquiry action when the display moves to a later turn. */
  readonly firstSeq: number
}

declare module '@agentrans/client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Current Artifact and earlier reviewable scene revisions in the loaded transcript. */
    artifact: ArtifactViewData
  }
}

function snapshotOf(event: SessionEventLike): ArtifactSnapshot {
  if (event.type !== 'artifact/upsert') throw new Error('artifact requires artifact/upsert')
  return event.data
}

function isReviewableSceneRevision(snapshot: ArtifactSnapshot): snapshot is ReviewableSceneRevision {
  return snapshot.format === 'scene'
    && (snapshot.spec.kind === 'csv-bar-chart' || snapshot.spec.kind === 'particle-system' || snapshot.spec.kind === 'function-plot')
}

/** Reviewable standalone scenes follow their latest commit and retain earlier reviewable revisions. */
export const artifactDefinition: ConversationNodeDefinition<ArtifactViewData> = {
  kind: 'artifact',
  target: 'chat',
  match: event => event.type === 'artifact/upsert' && event.data.comparison === undefined
    ? { id: event.data.artifactId, role: 'start', exclusive: true }
    : null,
  start: (_context, match) => ({ snapshot: snapshotOf(match.event), history: null, firstSeq: match.event.seq }),
  update: ({ state: { snapshot, history, firstSeq } }, match) => ({
    snapshot: snapshotOf(match.event),
    history: isReviewableSceneRevision(snapshot) ? { snapshot, earlier: history } : history,
    firstSeq,
  }),
  buildViewNode: (context) => {
    if (context.state === undefined || context.start === undefined) return null
    const { snapshot } = context.state
    if (snapshot.format === 'scene' && snapshot.csvContinuation !== undefined) return null
    const anchor = isReviewableSceneRevision(context.state.snapshot) ? context.matches.at(-1) ?? context.start : context.start
    return {
      key: context.key,
      kind: 'artifact',
      id: context.id,
      target: 'chat',
      anchorSeq: anchor.event.seq,
      location: anchor.location,
      visibility: 'visible',
      // A committed Artifact is a result of its Turn, not part of the process
      // run: it keeps its own row so the inline card stays visible while the
      // process group is folded.
      groupTree: 'turn',
      data: context.state,
    }
  },
}
