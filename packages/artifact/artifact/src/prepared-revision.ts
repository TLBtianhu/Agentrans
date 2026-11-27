/** Revision staging shared by the artifact and scene tools: a prepared snapshot commits only after its successful result. */
import type { Context } from '@agentrans/cordis'
import type { Agent } from '@agentrans/agent'
import type { ToolExecution } from '@agentrans/tools'
import { ArtifactError, type ArtifactService } from './index.ts'
import type { ArtifactSnapshot } from './types.ts'

interface PreparedRevision {
  readonly agent: Agent
  readonly snapshot: ArtifactSnapshot
}

/** Stage one prepared snapshot for the execution that will report its revision. */
type StagePreparedRevision = (exec: ToolExecution, agent: Agent, snapshot: ArtifactSnapshot) => void

/** Model-facing parameters both tools accept after their own content fields. */
export function revisionParameters(subject: 'Artifacts' | 'Scenes') {
  return {
    presentation: { type: 'string', required: true, enum: ['inline', 'focus'], description: 'Request inline placement or focused presentation.' },
    comparison: {
      type: 'object', additionalProperties: false,
      description: `Optional comparison relation. Use the same group for two independent ${subject} and assign one control and one variant.`,
      properties: {
        group: { type: 'string', required: true, description: 'Stable comparison group id matching [a-z][a-z0-9-]{0,63}.' },
        role: { type: 'string', required: true, enum: ['control', 'variant'], description: 'Independent role in the comparison.' },
      },
    },
    baseRevision: { type: 'integer', description: 'Required for update: current revision previously returned by this tool.' },
  } as const
}

/** Result schema fields both tools report for the prepared revision. */
export const revisionOutputProperties = {
  revision: { type: 'integer', required: true },
  title: { type: 'string', required: true },
} as const

/** Result schema field for the placement the tool requested. */
export const presentationOutputProperty = { type: 'string', required: true, enum: ['inline', 'focus'] } as const

/**
 * Require the Session agent a revision belongs to.
 * @param exec - Tool execution.
 * @param tool - Tool name for the diagnostic.
 * @returns The executing agent.
 * @throws {ArtifactError} When the execution has no agent Session.
 */
export function revisionAgent(exec: { readonly agent?: Agent | undefined }, tool: string): Agent {
  if (exec.agent === undefined) throw new ArtifactError(`${tool} requires an agent Session`, 'BAD_INPUT')
  return exec.agent
}

/**
 * Hold prepared revisions until the tool result decides them: a successful
 * result commits the revision it named, and any other outcome discards it.
 * @param ctx - Tool plugin context.
 * @param artifacts - Host Artifact service.
 * @returns stages one prepared snapshot for its execution; an execution aborted before staging discards it.
 */
export function stagePreparedRevisions(ctx: Context, artifacts: ArtifactService): StagePreparedRevision {
  const pending = new WeakMap<ToolExecution, PreparedRevision>()
  ctx.on('tools/result', (exec, result) => {
    const prepared = pending.get(exec)
    pending.delete(exec)
    if (prepared === undefined) return
    if (result.isError) {
      artifacts.discard(prepared.agent, prepared.snapshot.artifactId)
      return
    }
    try {
      artifacts.commit(prepared.agent, prepared.snapshot)
    } catch (error) {
      // The result already named a revision, so a snapshot that can no longer follow the log is a
      // contract violation for the host log rather than a user-facing failure.
      ctx.logger.error(error)
    }
  })
  return (exec, agent, snapshot) => {
    try {
      exec.signal.throwIfAborted()
    } catch (error) {
      artifacts.discard(agent, snapshot.artifactId)
      throw error
    }
    pending.set(exec, { agent, snapshot })
  }
}
