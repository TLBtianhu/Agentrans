/** Model-facing SceneSpec create/update tool with compare-and-set revisions. */
import type { Context } from '@agentrans/cordis'
import z from '@agentrans/schemastery'
import type { Agent } from '@agentrans/agent'
import type {} from '@agentrans/system-prompt'
import { defineTool, type ToolExecution } from '@agentrans/tools'
import { ArtifactError } from './index.ts'
import type { FunctionPlotSpec, ParticleSystemSpec } from './scene.ts'
import type { ArtifactSnapshot } from './types.ts'

export const name = 'scene'
export const inject = ['tools', 'systemPrompt']
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
  readonly kind: 'function-plot' | 'flowchart' | 'particle-system' | 'timeline' | 'network-graph' | 'map'
  readonly presentation: 'inline' | 'focus'
}

const INTERACTIVE_EXPLANATION_GUIDANCE = 'For explanations, answer directly in text when that is sufficient. '
  + 'For a definition or a calculation with fixed inputs, give the result and reasoning in text. A derivative at one point is a text answer. '
  + 'When the user needs to try different inputs or step through a process to verify an outcome and a native scene supports the interaction, use the native scene tool directly. '
  + 'Use function-plot to vary a mathematical coefficient and compare slopes or values. Use particle-system to step motion and inspect its '
  + 'current position and velocity. The particle scene already provides step, play, reset and numeric readings. '
  + 'When a single native scene supports the requested interaction, keep it as the only experiment. '
  + 'Offer the experiment in the reply even if the user did not ask for a visualization. Give them one concrete thing to try or observe. '
  + 'Keep self-contained explanations in chat. Use workspace discovery, file tools, or shell commands only for requests '
  + 'about workspace content or implementation.'

const FUNCTION_PLOT_EXAMPLE = {
  kind: 'function-plot',
  functions: [{ id: 'wave', label: 'a sin(x)', expression: 'a*sin(x)' }],
  parameters: { a: { value: 1, min: 0.5, max: 2, step: 0.25 } },
  viewport: { x: [-4, 4], y: [-3, 3] },
  trace: { x: 0, derivative: true, integral: false },
} satisfies FunctionPlotSpec

const PARTICLE_SYSTEM_EXAMPLE = {
  kind: 'particle-system',
  particles: [{ id: 'dot', x: 0, y: 2, vx: 1, vy: 0, mass: 1 }],
  gravity: { x: 0, y: -2 },
  timeStep: 0.05,
  trails: true,
} satisfies ParticleSystemSpec

/**
 * Register the SceneSpec tool and commit only an authoritative successful result.
 * @param ctx - Plugin context carrying the ArtifactService and tool registry.
 * @returns Nothing; registration and disposal are owned by the plugin fiber.
 */
export function apply(ctx: Context): void {
  const artifacts = ctx.get('artifacts')
  if (artifacts === undefined) throw new ArtifactError('scene tool requires the Host ArtifactService', 'ARTIFACT_SERVICE_UNAVAILABLE')
  const pending = new WeakMap<ToolExecution, PendingScene>()
  ctx.systemPrompt.section({
    name: 'artifact:interactive-explanations',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SCENE'),
    text: ({ scope, toolSet }) => ctx.tools.get('scene', scope, toolSet) === undefined ? '' : INTERACTIVE_EXPLANATION_GUIDANCE,
  })
  ctx.tools.register(defineTool({
    name: 'scene',
    description: 'Create or update a declarative interactive scene. '
      + 'Use confirmed readings when answering a follow-up. If the user asks to change or extend the same experiment, update its existing '
      + 'sceneId with the current revision as baseRevision. Explain the readings directly when the experiment needs no change. '
      + 'Use the matching spec example as a template for its fields and adapt the values to the question. '
      + 'When validation fails, use the diagnostic to correct the SceneSpec and retry the scene. '
      + 'For flowchart, provide nodes, edges, and an optional path. '
      + 'Optional style for flowchart, function-plot, particle-system, timeline, and network-graph: editorial (default), transit-map, blueprint, math-proof-lecture, or particles. '
      + 'Use inline presentation for explanations in chat. Write a workspace file for an explanation only if the user requests a standalone file or program. '
      + 'Two Scenes may share one comparison group with independent control and variant roles. '
      + 'A successful result confirms validated source, not a running renderer. When artifact_runtime is available, '
      + 'inspect the returned scene id and exact revision for current readiness or error reports before claiming it runs.',
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'update'], description: 'Create a new scene or replace an existing scene at its next revision.' },
      kind: { type: 'string', required: true, enum: ['function-plot', 'flowchart', 'particle-system', 'timeline', 'network-graph', 'map'], description: 'Scene primitive supported by the current SceneCatalog.' },
      sceneId: { type: 'string', required: true, description: 'Stable scene id matching [a-z][a-z0-9-]{0,63}.' },
      title: { type: 'string', required: true, description: 'Display title, 1-120 characters after trimming.' },
      spec: {
        type: 'object', additionalProperties: true, required: true,
        description: 'Complete SceneSpec JSON. An omitted spec.kind defaults to the outer kind. An explicit spec.kind must match it. '
          + 'Function entries require id. Parameters are keyed by name. Each viewport axis is [min,max]. '
          + 'Use the exact boolean field names shown for trace and trails.\n'
          + `Function plot example: ${JSON.stringify(FUNCTION_PLOT_EXAMPLE)}\n`
          + `Particle system example: ${JSON.stringify(PARTICLE_SYSTEM_EXAMPLE)}`,
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
    execute(args, exec): Promise<SceneToolResult> {
      if (exec.agent === undefined) throw new ArtifactError('scene requires an agent Session', 'BAD_INPUT')
      const kind: string = args.kind
      if (kind !== 'function-plot' && kind !== 'flowchart' && kind !== 'particle-system' && kind !== 'timeline' && kind !== 'network-graph' && kind !== 'map') throw new ArtifactError(`unsupported scene kind: ${kind}`, 'BAD_SCENE_SPEC')
      if (Object.hasOwn(args.spec, 'kind') && Reflect.get(args.spec, 'kind') !== kind) {
        throw new ArtifactError(`/kind: spec.kind must match the outer kind ${kind}`, 'BAD_SCENE_SPEC')
      }
      const snapshot = artifacts.prepare(exec.agent, {
        action: args.action,
        artifactId: args.sceneId,
        title: args.title,
        spec: { ...args.spec, kind } as never,
        presentation: args.presentation,
        format: 'scene',
        ...args.comparison === undefined ? {} : { comparison: args.comparison },
        ...args.baseRevision === undefined ? {} : { baseRevision: args.baseRevision },
      })
      try {
        exec.signal.throwIfAborted()
      } catch (error) {
        artifacts.discard(exec.agent, snapshot.artifactId)
        throw error
      }
      pending.set(exec, { agent: exec.agent, snapshot })
      return Promise.resolve({
        sceneId: snapshot.artifactId,
        revision: snapshot.revision,
        title: snapshot.title,
        kind,
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
