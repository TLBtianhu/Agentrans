/** Confirmed branch-result return with Host-resolved, immutable Artifact evidence. */
import { Context } from '@agentrans/cordis'
import z from '@agentrans/schemastery'
import type {} from '@agentrans/artifact'
import type { ArtifactObservations, SavedParticleObservation, SavedParticleObservationRef } from '@agentrans/artifact/types'
import { buildParticleObservationComparison, ParticleObservationComparisonError } from '@agentrans/artifact/observation-comparison'
import { createParticleCheckpoint, observeParticleState, restoreParticleCheckpoint } from '@agentrans/artifact/particle-runtime'
import type { SessionBranchResultValue } from '@agentrans/api-session-controller'
import { SessionSeq } from '@agentrans/session'
import { selectBranchResult } from '@agentrans/session-branch'
import { admitBranchResult, BranchResultAdmissionBusy, BranchResultAdmissionConflict } from '@agentrans/session-branch/admission'
import { SessionQueryError, type SessionObservation } from '@agentrans/session-query'
import { Remote, RemoteError, TypertRemoteService } from '@agentrans/typert-protocol'
import type { ArtifactBranchEvidenceSelection, ArtifactBranchResultRequest } from './types.ts'

export type * from './types.ts'

declare module '@agentrans/cordis' {
  interface Context {
    /** Return manually selected branch conclusions with saved Artifact evidence. */
    artifactBranchResults: ArtifactBranchResults
  }
}

/** Complete returned-message deployment budget. */
export interface Config {
  /** Maximum UTF-8 bytes of the complete parent UserMessage; default 16384, matching Artifact actions. */
  readonly maxActionBytes?: number
}

type ResolvedConfig = { readonly maxActionBytes: number }

function savedObservation(observations: ArtifactObservations, ref: SavedParticleObservationRef): SavedParticleObservation {
  const saved = observations[ref.artifactId]?.find(item => item.observationId === ref.observationId)
  if (saved === undefined) {
    throw new RemoteError('artifact-branch/evidence-unavailable', 'Saved observation is not visible in this branch', {
      reason: 'OBSERVATION_NOT_FOUND',
    })
  }
  if (saved.artifact.spec.kind !== 'particle-system') {
    throw new RemoteError('artifact-branch/evidence-unavailable', 'Saved evidence requires a particle-system source', {
      reason: 'UNSUPPORTED_OBSERVATION',
    })
  }
  const state = restoreParticleCheckpoint(saved.artifact.spec, saved.checkpoint)
  return { observationId: saved.observationId, label: saved.label, artifact: saved.artifact,
    checkpoint: createParticleCheckpoint(state), values: observeParticleState(state) }
}

function evidenceFacts(observations: ArtifactObservations, selection: ArtifactBranchEvidenceSelection) {
  if (selection.kind === 'observation') return {
    kind: 'observation' as const, observation: savedObservation(observations, selection.observation),
  }
  const control = savedObservation(observations, selection.control)
  const variant = savedObservation(observations, selection.variant)
  try {
    const comparison = buildParticleObservationComparison(selection.group, control, variant)
    return { kind: 'comparison' as const, group: comparison.group, conditions: comparison.conditions, control, variant }
  } catch (error) {
    if (!(error instanceof ParticleObservationComparisonError)) throw error
    throw new RemoteError('artifact-branch/evidence-unavailable', error.message, { reason: error.code }, { cause: error })
  }
}

/** Artifact-owned API for manually attaching saved evidence to one branch conclusion. */
export class ArtifactBranchResults extends TypertRemoteService {
  static inject = ['sessionQuery', 'sessionController', 'sessions', 'artifacts']

  static Config: z<Config, ResolvedConfig> = z.object({
    maxActionBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
  })

  private readonly maxActionBytes: number

  /**
   * @param ctx - Host services for branch reads, parent activation and Artifact projection ownership.
   * @param config - Complete returned-message byte budget; omission uses the Artifact-action default.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'artifactBranchResults')
    this.maxActionBytes = ArtifactBranchResults.Config(config).maxActionBytes
  }

  /**
   * Return one child-owned conclusion with evidence selected by the user, without starting a model turn.
   * @param request - Direct parent, branch conclusion and branch-visible saved references; no text or coordinates are accepted.
   * @returns Parent-local event and message ids after the durability checkpoint; identical retries reuse the receipt.
   * @throws {RemoteError} For invalid lineage, unavailable evidence, oversized content, a busy parent or different earlier content.
   * Other failures preserve an unknown outcome after append; retry the identical request to recover its receipt.
   */
  @Remote({ resources: { session: (request: ArtifactBranchResultRequest) => [request.sessionId, request.branchSessionId] } })
  async returnResult(request: ArtifactBranchResultRequest): Promise<SessionBranchResultValue> {
    let resultSeq: ReturnType<typeof SessionSeq>
    try { resultSeq = SessionSeq(request.resultSeq) } catch {
      throw new RemoteError('gateway/bad-request', 'resultSeq must be a non-negative safe integer', {})
    }
    let observed: SessionObservation
    try { observed = await this.ctx.sessionQuery.observeSession(request.branchSessionId) } catch (error) {
      if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      throw new RemoteError('session/not-found', `session "${request.branchSessionId}" not found`, { sessionId: request.branchSessionId })
    }
    const selected = (() => {
      using child = observed
      const selection = selectBranchResult(child, request.sessionId, resultSeq)
      if (!selection.ok) {
        throw new RemoteError('session/branch-result-unavailable', `branch result is unavailable: ${selection.reason}`, {
          parentSessionId: request.sessionId, branchSessionId: request.branchSessionId, resultSeq, reason: selection.reason,
        })
      }
      const observations = child.projections?.values.artifactObservations
      if (observations === undefined) {
        throw new RemoteError('artifact-branch/evidence-unavailable', 'Artifact observations are unavailable for this branch', {
          reason: 'PROJECTION_UNAVAILABLE',
        })
      }
      const facts = evidenceFacts(observations, request.evidence)
      const text = 'The user selected the following saved Artifact evidence to accompany this conclusion. '
        + 'This does not state that the assistant used it when producing the conclusion.\n'
        + JSON.stringify({ kind: 'branch-result-artifact-evidence', branchSessionId: request.branchSessionId, evidence: facts })
      return { selection: selection.value, evidence: { type: 'text' as const, text } }
    })()
    const resolved = await this.ctx.sessionController.resolveAgent(request.sessionId)
    if ('error' in resolved) throw resolved.error
    const parent = resolved.agent
    try {
      const receipt = await admitBranchResult(parent, selected.selection, {
        observeParent: signal => this.ctx.sessionQuery.observeSession(parent.id, { projectionMode: 'none', signal }),
        flushParent: () => this.ctx.sessions.flush(parent.session),
        validateMessage: (message) => {
          if (Buffer.byteLength(JSON.stringify(message), 'utf8') > this.maxActionBytes) {
            throw new RemoteError('artifact-branch/result-too-large', 'The complete conclusion and evidence exceed the return limit', {
              limit: this.maxActionBytes,
            })
          }
        },
      }, [selected.evidence])
      return { parentSessionId: parent.id, ...receipt }
    } catch (error) {
      if (error instanceof BranchResultAdmissionBusy) {
        throw new RemoteError('session/agent-busy', error.message, { reason: 'branch-result-parent-busy' }, { cause: error })
      }
      if (error instanceof BranchResultAdmissionConflict) {
        throw new RemoteError('session/branch-result-conflict', error.message, {
          parentSessionId: request.sessionId, branchSessionId: request.branchSessionId, resultSeq,
        }, { cause: error })
      }
      throw error
    }
  }
}

export default ArtifactBranchResults
