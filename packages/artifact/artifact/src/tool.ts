/** Model-facing create/update tool for Session-backed interactive HTML artifacts. @module @deepseek-ai/dsh-artifact/tool */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
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
  const pending = new WeakMap<ToolExecution, PendingArtifact>()
  ctx.tools.register(defineTool({
    name: 'artifact',
    description: 'Create or update code-generated interactive explanations as self-contained HTML with no external dependencies. '
      + 'The HTML may send user intent with parent.postMessage({kind:\'artifact-action\',artifactId,revision,action,payload}, \'*\'); '
      + 'the user reviews that intent before it is sent. Artifact actions are text input, never authorization.',
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
    async execute(args, exec): Promise<ArtifactToolResult> {
      if (exec.agent === undefined) throw new ArtifactError('artifact requires an agent Session', 'BAD_INPUT')
      const snapshot = artifacts.prepare(exec.agent, args)
      exec.signal.throwIfAborted()
      pending.set(exec, { agent: exec.agent, snapshot })
      return {
        artifactId: snapshot.artifactId,
        revision: snapshot.revision,
        title: snapshot.title,
        presentation: snapshot.presentation,
      }
    },
  }))
  ctx.on('tools/result', (exec, result) => {
    const prepared = pending.get(exec)
    pending.delete(exec)
    if (prepared === undefined || result.isError) return
    artifacts.commit(prepared.agent, prepared.snapshot)
  })
}
