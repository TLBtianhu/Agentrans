/** Model-facing SceneSpec create/update tool with compare-and-set revisions. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { ArtifactError } from './index.ts'
import type { ArtifactComparison, ArtifactSnapshot } from './types.ts'

export const name = 'scene'
export const inject = ['tools']
/** Empty SceneSpec tool configuration; validation and limits belong to ArtifactService. */
export type Config = Record<never, never>
export const Config: z<Config> = z.object({})

interface PendingScene {
  readonly agent: Agent
  readonly snapshot: ArtifactSnapshot
}

interface SceneToolResult {
  readonly sceneId: ArtifactSnapshot['artifactId']
  readonly revision: number
  readonly title: string
  readonly kind: 'function-plot' | 'flowchart' | 'particle-system' | 'timeline' | 'network-graph'
  readonly presentation: 'inline' | 'focus'
}

/**
 * Register the SceneSpec tool and commit only an authoritative successful result.
 * @param ctx - Plugin context carrying the ArtifactService and tool registry.
 * @returns Nothing; registration and disposal are owned by the plugin fiber.
 */
export function apply(ctx: Context): void {
  const artifacts = ctx.get('artifacts')
  if (artifacts === undefined) throw new ArtifactError('scene tool requires the Host ArtifactService', 'ARTIFACT_SERVICE_UNAVAILABLE')
  const pending = new WeakMap<ToolExecution, PendingScene>()
  ctx.tools.register(defineTool({
    name: 'scene',
    description: 'Create or update a declarative interactive scene. Use SceneSpec JSON, not HTML. '
      + 'For function-plot, provide functions, parameters, viewport, and trace. For flowchart, provide nodes, edges, and an optional path. The host validates the spec before committing it. '
      + 'Optional style for flowchart, function-plot, particle-system, timeline, and network-graph: editorial (default), transit-map, blueprint, math-proof-lecture, or particles. '
      + 'Interactive explanations default to this scene tool, not to workspace files; only write a workspace file when the user explicitly asks for a standalone HTML file or program. '
      + 'Follow the artifact-design style reference for the visual idiom appropriate to the content. '
      + 'Two Scenes may share one comparison group with independent control and variant roles.',
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'update'], description: 'Create a new scene or replace an existing scene at its next revision.' },
      kind: { type: 'string', required: true, enum: ['function-plot', 'flowchart', 'particle-system', 'timeline', 'network-graph'], description: 'Scene primitive supported by the current SceneCatalog.' },
      sceneId: { type: 'string', required: true, description: 'Stable scene id matching [a-z][a-z0-9-]{0,63}.' },
      title: { type: 'string', required: true, description: 'Display title, 1-120 characters after trimming.' },
      spec: {
        type: 'object', additionalProperties: true, required: true,
        description: 'Complete SceneSpec JSON for the selected kind. The host validates fields, expressions, and parameter bounds.',
      },
      presentation: { type: 'string', required: true, enum: ['inline', 'focus'], description: 'Request inline placement or focused presentation.' },
      comparison: {
        type: 'object', additionalProperties: false,
        description: 'Optional comparison relation. Use the same group for two independent Scenes and assign one control and one variant.',
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
          sceneId: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
          title: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          presentation: { type: 'string', required: true, enum: ['inline', 'focus'] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec): Promise<SceneToolResult> {
      if (exec.agent === undefined) throw new ArtifactError('scene requires an agent Session', 'BAD_INPUT')
      if (args.kind !== 'function-plot' && args.kind !== 'flowchart' && args.kind !== 'particle-system' && args.kind !== 'timeline' && args.kind !== 'network-graph') throw new ArtifactError(`unsupported scene kind: ${String(args.kind)}`, 'BAD_SCENE_SPEC')
      const snapshot = artifacts.prepare(exec.agent, {
        action: args.action as 'create' | 'update',
        artifactId: String(args.sceneId),
        title: String(args.title),
        spec: args.spec as never,
        presentation: args.presentation as 'inline' | 'focus',
        format: 'scene',
        ...args.comparison === undefined ? {} : { comparison: args.comparison as ArtifactComparison },
        ...args.baseRevision === undefined ? {} : { baseRevision: args.baseRevision as number },
      })
      exec.signal.throwIfAborted()
      pending.set(exec, { agent: exec.agent, snapshot })
      return {
        sceneId: snapshot.artifactId,
        revision: snapshot.revision,
        title: snapshot.title,
        kind: snapshot.format === 'scene' ? snapshot.spec.kind : 'function-plot',
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
