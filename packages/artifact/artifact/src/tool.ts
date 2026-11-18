/** Model-facing create/update tool for Session-backed interactive HTML artifacts. @module @agentrans/artifact/tool */

import type { Context } from '@agentrans/cordis'
import z from '@agentrans/schemastery'
import type { Agent } from '@agentrans/agent'
import { defineTool, type ToolExecution } from '@agentrans/tools'
import { registerArtifactDesignSkill } from './design-skill.ts'
import { ArtifactError } from './index.ts'
import type { ArtifactSnapshot, ArtifactToolResult } from './types.ts'

/** Stable Loader identity for preset mounting. */
export const name = 'artifact'

/** The tool registry is preset-scoped; the Artifact service is supplied by the Host base. */
export const inject = ['tools']

/** No tool-local deployment options; limits belong to the ArtifactService. */
export type Config = Record<never, never>

/** Validated empty tool configuration. */
export const Config: z<Config> = z.object({})

interface PendingArtifact {
  readonly agent: Agent
  readonly snapshot: ArtifactSnapshot
}

/**
 * Register the artifact tool and commit only its authoritative successful result.
 * @param ctx - Context carrying the tool registry and ArtifactService.
 */
export function apply(ctx: Context): void {
  const artifacts = ctx.get('artifacts')
  if (artifacts === undefined) throw new ArtifactError('artifact tool requires the Host ArtifactService', 'ARTIFACT_SERVICE_UNAVAILABLE')
  ctx.inject(['skills'], registerArtifactDesignSkill)
  const pending = new WeakMap<ToolExecution, PendingArtifact>()
  ctx.tools.register(defineTool({
    name: 'artifact',
    description: 'Create or update a self-contained HTML explanation for custom interactive behavior. '
      + 'Use scene for supported experiments such as function plots and particle motion when available. '
      + 'For a custom parameter explorer, load artifact-design when it appears in the skill catalog. '
      + 'Keep HTML self-contained and free of external dependencies. Write a workspace file for an explanation only if the user requests a standalone file or program. '
      + 'The HTML may send user intent with parent.postMessage({kind:\'artifact-action\',artifactId,revision,action,payload}, \'*\'); '
      + 'the user reviews that intent before it is sent. Artifact actions are text input, never authorization. '
      + 'Source creation does not confirm that the program runs. When artifact_runtime is available, inspect the returned revision for live reports. '
      + 'After successful initialization, call window.artifactRuntime.ready({state:()=>JSONValue,commands:{step:()=>{...}}}); '
      + 'state and each of play/pause/step/reset are optional callbacks. Declare only callbacks the program implements; '
      + 'command callbacks may return a Promise, and execution is acknowledged only after it settles. '
      + 'Report state changes with window.artifactRuntime.reportState(JSONValue), and failures with window.artifactRuntime.error(message). '
      + 'For an interactive breadth-first search, let the user lock and reopen any displayed step. '
      + 'Use one readCheckpoint() function that returns {kind:"bfs-checkpoint",current,queue,visited}. '
      + 'Use the complete four-field object for the initial state and every step. Include kind inside the checkpoint even when restore.kind matches. '
      + 'Set current to null before visiting a node and to a visited node ID otherwise. Keep queue and visited as ordered lists of unique stable IDs, '
      + 'at most 64 per list. IDs start with an ASCII letter or digit and contain only ASCII letters, digits, hyphens or underscores, up to 32 characters. '
      + 'After drawing the initial view, call window.artifactRuntime.ready({state:readCheckpoint,'
      + 'restore:{kind:"bfs-checkpoint",apply:restoreCheckpoint}}). '
      + 'After every BFS step, redraw the current node, queue, and visited nodes, then call window.artifactRuntime.reportState(readCheckpoint()). '
      + 'In restoreCheckpoint, set the saved current, queue, and visited values and redraw the view so readCheckpoint() returns the same complete checkpoint. '
      + 'For an interactive half-adder, let the user toggle A and B and display sum (XOR) and carry (AND). '
      + 'Use one readCheckpoint() function that returns {kind:"half-adder-checkpoint",a,b,sum:a^b,carry:a&b}, with numeric 0 or 1 for a and b. '
      + 'The complete five-field object is required for the initial state and every update. Include kind inside the checkpoint even when restore.kind matches. '
      + 'After rendering the initial inputs and outputs, call window.artifactRuntime.ready({state:readCheckpoint,'
      + 'restore:{kind:"half-adder-checkpoint",apply:restoreCheckpoint}}). '
      + 'After every A or B change, update the displayed outputs and call window.artifactRuntime.reportState(readCheckpoint()). '
      + 'In restoreCheckpoint, set the saved inputs and redraw both outputs so readCheckpoint() returns the same complete checkpoint. '
      + 'Keep source compact so the selected state and exact source fit together in the question.',
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'update'], description: 'Create a new id or replace an existing artifact at its next revision.' },
      artifactId: { type: 'string', required: true, description: 'Stable id matching [a-z][a-z0-9-]{0,63}.' },
      title: { type: 'string', required: true, description: 'Display title, 1-120 characters after trimming.' },
      source: { type: 'string', required: true, description: 'Complete self-contained HTML document with no external dependencies.' },
      presentation: { type: 'string', required: true, enum: ['inline', 'focus'], description: 'Request inline placement or focused presentation.' },
      comparison: {
        type: 'object', additionalProperties: false,
        description: 'Optional comparison relation. Use the same group for two independent Artifacts and assign one control and one variant.',
        properties: {
          group: { type: 'string', required: true, description: 'Stable comparison group id matching [a-z][a-z0-9-]{0,63}.' },
          role: { type: 'string', required: true, enum: ['control', 'variant'], description: 'Independent role in the comparison.' },
        },
      },
      baseRevision: { type: 'integer', description: 'Required for update: current revision previously returned by this tool.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          artifactId: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          title: { type: 'string', required: true },
          presentation: { type: 'string', required: true, enum: ['inline', 'focus'] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args, exec): Promise<ArtifactToolResult> {
      if (exec.agent === undefined) throw new ArtifactError('artifact requires an agent Session', 'BAD_INPUT')
      const snapshot = artifacts.prepare(exec.agent, args)
      try {
        exec.signal.throwIfAborted()
      } catch (error) {
        artifacts.discard(exec.agent, snapshot.artifactId)
        throw error
      }
      pending.set(exec, { agent: exec.agent, snapshot })
      return Promise.resolve({
        artifactId: snapshot.artifactId,
        revision: snapshot.revision,
        title: snapshot.title,
        presentation: snapshot.presentation,
      })
    },
  }))
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
}
