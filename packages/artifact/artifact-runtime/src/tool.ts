/** Model-facing inspection of source semantics and currently connected runtime reports. @module @deepseek-ai/dsh-artifact-runtime/tool */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ArtifactId } from '@deepseek-ai/dsh-artifact/types'
import { ArtifactError } from '@deepseek-ai/dsh-artifact'
import type {} from './index.ts'

/** Stable Loader identity for preset mounting. */
export const name = 'artifact-runtime-tool'
/** The Host provides live reports; the model-facing registry belongs to the Agent preset. */
export const inject = ['tools', 'agents', 'artifactRuntime']
/** Attempt budgets for one live Agent turn; plugin reload starts a fresh budget. */
export interface Config {
  /** Maximum runtime query attempts per turn; default 4, zero disables model queries. */
  readonly maxQueriesPerTurn?: number
  /** Maximum update attempts across objects whose errors this turn inspected; default 2. */
  readonly maxRepairAttemptsPerTurn?: number
}
/** Validated model query and repair attempt limits. */
export const Config: z<Config, Required<Config>> = z.object({
  maxQueriesPerTurn: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(4),
  maxRepairAttemptsPerTurn: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(2),
})

interface TurnBudget {
  readonly turnStartSeq: TurnBoundaryProjection['openTurnStartSeq']
  queries: number
  repairs: number
  readonly failedArtifactIds: Set<ArtifactId>
}

const runIdentity = {
  runtimeId: { type: 'string', required: true },
  renderer: { type: 'string', required: true, enum: ['native', 'html'] },
} as const

const inspectionSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    artifactId: { type: 'string', required: true }, revision: { type: 'integer', required: true },
    title: { type: 'string', required: true }, format: { type: 'string', required: true, enum: ['scene', 'html'] },
    sceneKind: { type: 'string', enum: ['function-plot', 'flowchart', 'particle-system', 'timeline', 'network-graph', 'map'] },
    sourceCapabilities: { type: 'object', additionalProperties: false, required: true, properties: {
      observe: { type: 'string', required: true, enum: ['particle', 'unsupported'] },
      save: { type: 'string', required: true, enum: ['particle', 'unsupported'] },
      restore: { type: 'string', required: true, enum: ['particle', 'unsupported'] },
      compare: { type: 'string', required: true, enum: ['saved-particle-pair', 'unsupported'] },
      questionContext: { type: 'string', required: true, enum: ['particle', 'program-reported', 'unsupported'] },
      exportHtml: { type: 'string', required: true, enum: ['particle-checkpoint-or-source-defaults', 'source-defaults', 'unsupported'] },
    } },
    reportAuthority: { type: 'string', required: true, enum: ['client-reported'] },
    runs: { type: 'array', required: true, items: { oneOf: [
      { type: 'object', additionalProperties: false, properties: { ...runIdentity, status: { type: 'string', required: true, enum: ['starting'] } } },
      { type: 'object', additionalProperties: false, properties: { ...runIdentity,
        status: { type: 'string', required: true, enum: ['ready'] },
        capabilities: { type: 'object', additionalProperties: false, required: true, properties: {
          state: { type: 'boolean', required: true },
          commands: { type: 'array', required: true, items: { type: 'string', enum: ['play', 'pause', 'step', 'reset'] } },
        } },
      } },
      { type: 'object', additionalProperties: false, properties: { ...runIdentity,
        status: { type: 'string', required: true, enum: ['error'] },
        error: { type: 'object', additionalProperties: false, required: true, properties: {
          code: { type: 'string', required: true }, message: { type: 'string', required: true },
        } },
      } },
    ] } },
  },
} as const

/**
 * Register bounded exact-revision queries and update attempts after an observed error.
 * @param ctx - Preset tool registry and live Artifact runtime service.
 * @param config - Per-turn attempt budgets; reload starts a new live budget.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const limits = Config(config)
  const budgets = new WeakMap<Agent, TurnBudget>()
  const queries = new WeakMap<Readonly<ToolExecution>, TurnBudget>()

  function budgetOf(agent: Agent): TurnBudget {
    const turnStartSeq = ctx.agents.turnBoundaryOf(agent.session).openTurnStartSeq
    const previous = budgets.get(agent)
    if (previous !== undefined && previous.turnStartSeq === turnStartSeq) return previous
    const budget = { turnStartSeq, queries: 0, repairs: 0, failedArtifactIds: new Set<ArtifactId>() }
    budgets.set(agent, budget)
    return budget
  }

  ctx.tools.guard((exec) => {
    if (exec.agent === undefined) return undefined
    if (exec.name === 'artifact_runtime') {
      const budget = budgetOf(exec.agent)
      if (budget.queries >= limits.maxQueriesPerTurn) {
        return `Artifact runtime query budget exhausted (${limits.maxQueriesPerTurn} attempts this turn). `
          + 'Explain the reports already received and any uncertainty; stop querying until a new turn.'
      }
      budget.queries += 1
      queries.set(exec, budget)
      return undefined
    }
    if (exec.name !== 'artifact' && exec.name !== 'scene') return undefined
    const args = exec.arguments
    if (args === null || typeof args !== 'object' || Array.isArray(args) || !('action' in args) || args.action !== 'update') return undefined
    const id = exec.name === 'artifact' && 'artifactId' in args ? args.artifactId
      : exec.name === 'scene' && 'sceneId' in args ? args.sceneId : undefined
    if (typeof id !== 'string') return undefined
    const budget = budgetOf(exec.agent)
    if (!budget.failedArtifactIds.has(id as ArtifactId)) return undefined
    if (budget.repairs >= limits.maxRepairAttemptsPerTurn) {
      return `Artifact runtime repair budget exhausted (${limits.maxRepairAttemptsPerTurn} update attempts this turn). `
        + 'Stop automatic repairs and explain the reported error and unresolved result to the user.'
    }
    budget.repairs += 1
    return undefined
  })

  ctx.on('tools/result', (exec, result) => {
    const budget = queries.get(exec)
    queries.delete(exec)
    if (budget === undefined || result.isError) return
    const value = result.value
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return
    const { artifactId, runs } = value
    if (typeof artifactId !== 'string' || !Array.isArray(runs)) return
    if (runs.some(run => run !== null && typeof run === 'object' && !Array.isArray(run) && run.status === 'error')) {
      budget.failedArtifactIds.add(artifactId as ArtifactId)
    }
  })

  ctx.tools.register(defineTool({
    name: 'artifact_runtime',
    description: 'Inspect an exact current Artifact revision before treating generated code as usable. '
      + 'Returns source-supported operations and currently connected renderer/program reports. '
      + 'An empty runs list means no active report; ready is a Client/program claim, not proof of correct pixels, observations or conclusions. '
      + 'Capabilities describe source semantics, not enabled plugins or permissions. Omit waitMs or use zero for a snapshot; '
      + 'a positive waitMs gives the current revision one bounded opportunity to attach and report ready or error. '
      + 'The wait stops when any run reports ready or error; other runs may disagree. '
      + 'No active report at the deadline is distinct from a timeout with an active starting report; neither establishes execution success or failure. '
      + 'Queries do not run code, modify the Artifact, retry commands or send user input. '
      + 'Use an error report to update the same Artifact with its current revision, within the shared repair budget. '
      + 'Query and repair attempts are limited per turn; rejected or cancelled attempts are not refunded. '
      + 'When the budget is exhausted, explain the known result and uncertainty instead of continuing automatic queries or repairs.',
    parameters: {
      artifactId: { type: 'string', required: true, description: 'Artifact id in this Session.' },
      revision: { type: 'integer', required: true, description: 'Exact positive source revision returned by artifact or scene.' },
      waitMs: { type: 'integer', description: 'Optional nonnegative wait in milliseconds, within the configured service limit. Omit or zero for an immediate snapshot.' },
    },
    output: {
      schema: { ...inspectionSchema, properties: { ...inspectionSchema.properties,
        wait: { type: 'object', additionalProperties: false, required: true, properties: {
          outcome: { type: 'string', required: true, enum: ['snapshot', 'reported', 'timeout', 'no-active-report', 'disconnected'] },
          limitMs: { type: 'integer', required: true },
        } },
        budget: { type: 'object', additionalProperties: false, required: true, properties: {
          remainingQueries: { type: 'integer', required: true },
          remainingRepairAttempts: { type: 'integer', required: true },
        } },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new ArtifactError('Artifact runtime inspection requires an Agent Session', 'BAD_INPUT')
      if (typeof args.artifactId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(args.artifactId)
        || typeof args.revision !== 'number' || !Number.isSafeInteger(args.revision) || args.revision < 1) {
        throw new ArtifactError('Artifact runtime inspection requires an Artifact id and positive source revision', 'BAD_INPUT')
      }
      if (args.waitMs !== undefined && (!Number.isSafeInteger(args.waitMs) || args.waitMs < 0)) {
        throw new ArtifactError('Artifact runtime wait requires nonnegative safe integer milliseconds', 'BAD_INPUT')
      }
      const budget = queries.get(exec)
      if (budget === undefined) throw new ArtifactError('Artifact runtime query requires guarded tool execution', 'BAD_INPUT')
      const inspection = args.waitMs !== undefined && args.waitMs > 0
        ? await ctx.artifactRuntime.wait(exec.agent, args.artifactId as ArtifactId, args.revision, args.waitMs, exec.signal)
        : { ...ctx.artifactRuntime.inspect(exec.agent, args.artifactId as ArtifactId, args.revision), wait: { outcome: 'snapshot' as const, limitMs: 0 } }
      return { ...inspection, budget: {
        remainingQueries: limits.maxQueriesPerTurn - budget.queries,
        remainingRepairAttempts: limits.maxRepairAttemptsPerTurn - budget.repairs,
      }, runs: inspection.runs.map(run => run.status === 'ready'
        ? { ...run, capabilities: { ...run.capabilities, commands: [...run.capabilities.commands] } }
        : run) }
    },
  }))
}
