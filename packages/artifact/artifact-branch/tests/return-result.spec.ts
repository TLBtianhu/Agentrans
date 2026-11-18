import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@agentrans/cordis'
import AgentRegistry, { type Agent } from '@agentrans/agent'
import type { SessionController } from '@agentrans/api-session-controller'
import type { SessionRequestId } from '@agentrans/api-session-controller/types'
import ArtifactService from '@agentrans/artifact'
import type { ArtifactId, ArtifactObservationId, SavedParticleObservationRef, SceneArtifactSnapshot } from '@agentrans/artifact/types'
import type { CsvBarChartSpec, FunctionPlotSpec, ParticleSystemSpec } from '@agentrans/artifact/scene'
import { analyzeFunctionPlotSelection } from '@agentrans/artifact/scene-renderers'
import {
  CONTINUED_CSV_QUESTION_PREFIX, CSV_COMPARISON_EXPLANATION_PREFIX, CSV_COMPARISON_QUESTION_PREFIX, IMPORTED_CSV_COMPARISON_QUESTION_PREFIX,
  IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX, IMPORTED_CSV_EXPLANATION_SOURCE_TEXT, IMPORTED_CSV_RETURN_SOURCE_TEXT,
  IMPORTED_CSV_SINGLE_SOURCE_TEXT, csvComparisonChangesText, type ArtifactHtmlCheckpoint,
} from '@agentrans/artifact/runtime-values'
import { observeParticleState, restoreParticleCheckpoint } from '@agentrans/artifact/particle-runtime'
import * as ArtifactFollowup from '@agentrans/artifact-followup'
import type { ArtifactCsvComparisonAttachment } from '@agentrans/artifact-followup/types'
import { createAssistantMessage, createUserMessage, MessageId, type UserMessage } from '@agentrans/llm'
import SessionStore, { SessionId, SessionLogOffset, type Session } from '@agentrans/session'
import { buildForkSeed } from '@agentrans/session/fork'
import { selectBranchResult } from '@agentrans/session-branch'
import { admitBranchResult } from '@agentrans/session-branch/admission'
import SessionProjectionRegistry from '@agentrans/session-projection'
import SessionQueryEngine, { type SessionEventSearchRequest } from '@agentrans/session-query'
import { remoteErrorOf, type PeerId, type RemoteInvocation } from '@agentrans/typert-protocol'
import ArtifactBranchResults, { type Config } from '../src/index.ts'
import { resolveSentCsvComparisonExport } from '../src/csv-analysis.ts'
import type { ArtifactBranchContinueParticleRequest, ArtifactBranchContinuePlotRequest, ArtifactBranchContinuePlotRequestId, ArtifactBranchResultRequest } from '../src/types.ts'

declare module '@agentrans/typert-protocol' {
  interface PrincipalMap {
    'artifact-branch-test-guest': { readonly kind: 'artifact-branch-test-guest' }
  }
}

const contexts: Context[] = []
let sequence = 0
const control: SavedParticleObservationRef = { artifactId: 'control' as ArtifactId, observationId: 'six' as ArtifactObservationId }
const variant: SavedParticleObservationRef = { artifactId: 'variant' as ArtifactId, observationId: 'six' as ArtifactObservationId }
const spec: ParticleSystemSpec = {
  kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 1, vx: 3, vy: 8, mass: 1 }],
  gravity: { x: 0, y: -9.8 }, timeStep: 1 / 30, trails: true,
}

class TestQuery extends SessionQueryEngine {
  override searchSessions() { return Promise.resolve({ items: [] }) }
  override async searchEvents(request: SessionEventSearchRequest) {
    return { session: (await this.readSurface(request.sessionId)).session, items: [] }
  }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

function makeAgent(ctx: Context, session: Session) {
  let maintenance = false
  let busy = false
  const steer = vi.fn<(message: UserMessage) => void>()
  const inject = vi.fn<(message: UserMessage) => void>()
  const runMaintenance: Agent['runMaintenance'] = <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (maintenance || busy) throw new Error('Agent is busy')
    maintenance = true
    return task(new AbortController().signal).finally(() => { maintenance = false })
  }
  const agent = {
    id: session.id, session, ctx, runMaintenance,
    steer: (message: UserMessage): void => { steer(message) },
    inject: (message: UserMessage): void => { inject(message) },
  } as Agent
  ctx.agents.enter(agent, undefined)
  return { agent, steer, inject, setBusy: (value: boolean): void => { busy = value } }
}

async function setup(config: Config = {}, restored?: { parent: Session; child: Session; continued?: Session; withFollowup?: boolean },
  withFollowup = restored?.withFollowup === true) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TestQuery)
  await ctx.plugin(ArtifactService)
  const parentSession = restored === undefined ? ctx.sessions.create(SessionId(`parent-${++sequence}`))
    : ctx.sessions.create(restored.parent.id, { seed: restored.parent.snapshotEvents(), meta: restored.parent.header,
      inheritedEventCount: restored.parent.inheritedEventCount })
  if (restored === undefined) parentSession.append('user/message', createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'Original parent question' }],
  }), { surfaceOp: 'append' })
  const parent = makeAgent(ctx, parentSession)
  const childSession = restored === undefined ? ctx.sessions.create(SessionId(`child-${sequence}`), {
    seed: parentSession.snapshotEvents(), meta: { isSeeded: true, parentSession: parentSession.id },
    inheritedEventCount: SessionLogOffset(parentSession.seq),
  }) : ctx.sessions.create(restored.child.id, { seed: restored.child.snapshotEvents(), meta: restored.child.header,
    inheritedEventCount: restored.child.inheritedEventCount })
  const child = makeAgent(ctx, childSession)
  if (restored?.continued !== undefined) {
    const { continued } = restored
    ctx.sessions.create(continued.id, { seed: continued.snapshotEvents(), meta: continued.header,
      inheritedEventCount: continued.inheritedEventCount })
  }
  const resolveAgent = vi.fn<SessionController['resolveAgent']>(async (id) => {
    if (id !== parentSession.id) throw new Error('Only the parent may be activated')
    return { agent: parent.agent }
  })
  const forkObserved = vi.fn<SessionController['forkObserved']>(async (source, boundary, preparation) => {
    expect(source.projections).toBeDefined()
    if (ctx.sessions.get(preparation.childId) === undefined) {
      const fork = ctx.sessions.create(preparation.childId, {
        seed: buildForkSeed(source.events, boundary), meta: { isSeeded: true, parentSession: source.header.id },
        inheritedEventCount: SessionLogOffset(boundary + 1),
      })
      const { agent } = makeAgent(ctx, fork)
      preparation.initialise?.(agent)
    } else {
      using child = await ctx.sessionQuery.observeSession(preparation.childId, { projectionMode: 'none' })
      preparation.verifyExisting(child)
    }
    return { sessionId: preparation.childId }
  })
  let resolvePromptContext: Parameters<SessionController['registerPromptContext']>[1] | undefined
  const sessionController = {
    resolveAgent: (id: Parameters<SessionController['resolveAgent']>[0]) => resolveAgent(id),
    forkObserved,
    registerPromptContext: (_kind: string, resolve: Parameters<SessionController['registerPromptContext']>[1]) => {
      resolvePromptContext = resolve
      return () => { resolvePromptContext = undefined }
    },
  } satisfies Pick<SessionController, 'resolveAgent' | 'forkObserved' | 'registerPromptContext'>
  ctx.provide('sessionController', sessionController as never)
  if (withFollowup) {
    ctx.provide('storageDomain', {
      open: () => {
        const records = new Map<string, unknown>()
        return Promise.resolve({ table: () => ({
          get: (key: string) => records.get(key),
          put: (key: string, value: unknown) => { records.set(key, value); return Promise.resolve() },
          delete: (key: string) => Promise.resolve(records.delete(key)),
        }), close: () => Promise.resolve() })
      },
    } as never)
    await ctx.plugin(ArtifactFollowup)
  }
  const fiber = ctx.plugin(ArtifactBranchResults, config)
  await fiber
  return { ctx, parent, child, parentSession, childSession, resolveAgent, forkObserved, resolvePromptContext,
    service: ctx.artifactBranchResults, fiber }
}

function savePair(fixture: Awaited<ReturnType<typeof setup>>, variantSpec = spec) {
  const { ctx, child } = fixture
  for (const [role, ref, source] of [['control', control, spec], ['variant', variant, variantSpec]] as const) {
    ctx.artifacts.commit(child.agent, ctx.artifacts.prepare(child.agent, {
      action: 'create', artifactId: ref.artifactId, title: role, presentation: 'inline', format: 'scene', spec: source,
      comparison: { group: 'gravity', role },
    }))
    ctx.artifacts.saveObservation(child.agent, ref.artifactId, 1, ref.observationId, role, { runtimeVersion: 1, stepCount: 6 })
  }
}

function conclusion(session: Session, text = 'The variant falls less over the same time.', turn = 1) {
  session.append('turn/start', { turn })
  const event = session.append('assistant/message', {
    turn, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'test', model: 'test' },
      content: [{ type: 'reasoning', text: 'Private reasoning must stay in the child' }, { type: 'text', text }],
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return event.seq
}

function request(fixture: Awaited<ReturnType<typeof setup>>, resultSeq: number): ArtifactBranchResultRequest {
  return { sessionId: fixture.parentSession.id, branchSessionId: fixture.childSession.id, resultSeq,
    evidence: { kind: 'comparison', group: 'gravity', control, variant } }
}

const nativeContextPrefix = 'The user selected the following experiment context for this question. '
const particleContextPrefix = nativeContextPrefix
  + 'Particle values are recomputed by the Host from the recorded source and checkpoint; no causal conclusion is inferred.\n'
const adjustedParticleContextPrefix = nativeContextPrefix
  + 'This question uses the adjusted particle experiment. Use facts.gravityY for the selected vertical gravity '
  + 'and facts.values for the readings the Host recomputed at the confirmed checkpoint. The source spec records the baseline gravity.\n'
const plotContextPrefix = nativeContextPrefix
  + 'Function-plot values are recomputed by the Host from the recorded source, selected function, parameters and trace position. '
  + 'Derivative and integral readings are numerical approximations.\n'
const bfsContextPrefix = 'The user selected the following program-reported context for this question. '
  + 'The Host checked the source identity and revision and validated the BFS checkpoint shape. '
  + 'Use facts.capture.state for the selected current node, queue and visited nodes. '
  + 'This program-reported checkpoint can be reopened with the recorded HTML revision.\n'
const halfAdderContextPrefix = 'The user selected the following program-reported context for this question. '
  + 'The Host checked the source identity and revision and validated the half-adder checkpoint. '
  + 'Use facts.capture.state for the selected input bits a and b and output bits sum and carry. '
  + 'This program-reported checkpoint can be reopened with the recorded HTML revision.\n'

function createScene(fixture: Awaited<ReturnType<typeof setup>>, scene: ParticleSystemSpec | FunctionPlotSpec): SceneArtifactSnapshot {
  const { ctx, child } = fixture
  ctx.artifacts.commit(child.agent, ctx.artifacts.prepare(child.agent, {
    action: 'create', artifactId: control.artifactId, title: 'Branch experiment', presentation: 'inline', format: 'scene', spec: scene,
  }))
  const source = ctx.artifacts.currentSnapshot(child.agent, control.artifactId)
  if (source?.format !== 'scene') throw new Error('Expected an original native scene')
  return source
}

function appendQuestion(session: Session, prefix: string, facts: object, sessionId = session.id) {
  return session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'text', text: 'Explain these readings.' },
    { type: 'text', text: prefix + JSON.stringify({ kind: 'artifact-question-context', sessionId, facts }) },
  ] }), { surfaceOp: 'append' }).seq
}

function questionRequest(fixture: Awaited<ReturnType<typeof setup>>, resultSeq: number, questionSeq: number): ArtifactBranchResultRequest {
  return { ...request(fixture, resultSeq), evidence: { kind: 'question', questionSeq, blockIndex: 1 } }
}

function artifactGuestInvocation(ctx: Context, method: string): RemoteInvocation {
  const signal = new AbortController().signal
  return {
    request: { namespace: 'artifactBranchResults', method, args: {} },
    service: 'artifactBranchResults',
    peer: { id: 'artifact-branch-test-guest' as PeerId, ctx, principal: { kind: 'artifact-branch-test-guest' },
      interactions: 'answer', signal, dispose: async () => {} },
    signal,
    uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
  }
}

function sceneExportOrigin(html: string): unknown {
  const origin = /<script type="application\/json" id="artifact-export-origin-data">([^<]+)<\/script>/u.exec(html)?.[1]
  if (origin === undefined) throw new Error('Expected returned evidence metadata')
  return JSON.parse(origin)
}

function returnedEvidence(session: Session): unknown {
  const returned = session.snapshotEvents().at(-1)
  const block = returned?.type === 'user/message' ? returned.data.content[1] : undefined
  if (block?.type !== 'text') throw new Error('Expected returned experiment evidence')
  return JSON.parse(block.text.slice(block.text.indexOf('\n') + 1))
}

async function returnPlain(fixture: Awaited<ReturnType<typeof setup>>, resultSeq: number) {
  using child = await fixture.ctx.sessionQuery.observeSession(fixture.childSession.id, { projectionMode: 'none' })
  const selected = selectBranchResult(child, fixture.parentSession.id, resultSeq as ReturnType<typeof conclusion>)
  if (!selected.ok) throw new Error('Expected a child-owned conclusion')
  return await admitBranchResult(fixture.parent.agent, selected.value, {
    observeParent: signal => fixture.ctx.sessionQuery.observeSession(fixture.parentSession.id, { projectionMode: 'none', signal }),
    flushParent: () => fixture.ctx.sessions.flush(fixture.parentSession),
  })
}

describe('Artifact branch-result evidence', () => {
  it('exports the original half-adder revision and valid locked bits from the exact return', async () => {
    const fixture = await setup()
    const { ctx, child, childSession, parentSession } = fixture
    ctx.artifacts.commit(child.agent, ctx.artifacts.prepare(child.agent, {
      action: 'create', artifactId: control.artifactId, title: 'Half-adder', presentation: 'inline', format: 'html', source: '<p>Circuit</p>',
    }))
    const artifact = ctx.artifacts.currentSnapshot(child.agent, control.artifactId)
    if (artifact?.format !== 'html') throw new Error('Expected a half-adder revision')
    const state = { kind: 'half-adder-checkpoint', a: 1, b: 1, sum: 0, carry: 1 }
    const capture = { status: 'ready', restore: state.kind, state }
    const facts = { kind: 'html-runtime', artifact, runtimeId: 'half-adder-runtime', attribution: 'program-reported', capture }
    const badOutput = appendQuestion(childSession, halfAdderContextPrefix, {
      ...facts, capture: { ...capture, state: { ...state, sum: 1 } },
    })
    const wrongPrefix = appendQuestion(childSession, bfsContextPrefix, facts)
    const questionSeq = appendQuestion(childSession, halfAdderContextPrefix, facts)
    ctx.artifacts.commit(child.agent, ctx.artifacts.prepare(child.agent, {
      action: 'update', artifactId: artifact.artifactId, baseRevision: 1, title: 'Revised circuit',
      presentation: 'inline', format: 'html', source: '<p>New circuit</p>',
    }))
    const resultSeq = conclusion(childSession, 'Two set inputs produce a carry.')
    for (const seq of [badOutput, wrongPrefix]) {
      await expect(fixture.service.returnResult(questionRequest(fixture, resultSeq, seq)))
        .rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    }
    const returned = await fixture.service.returnResult(questionRequest(fixture, resultSeq, questionSeq))
    expect(parentSession.snapshotEvents()[returned.eventSeq]).toMatchObject({ data: { source: { artifactEvidence: state.kind } } })
    expect(returnedEvidence(parentSession)).toMatchObject({ evidence: { kind: 'question', questionSeq, facts } })

    const reopened = await setup({}, { parent: parentSession, child: childSession })
    const parentBeforeDownload = reopened.parentSession.snapshotEvents()
    const childBeforeDownload = reopened.childSession.snapshotEvents()
    const request = { sessionId: parentSession.id, eventSeq: returned.eventSeq, messageId: returned.messageId }
    const observe = vi.spyOn(reopened.ctx.sessionQuery, 'observeSession')
    await expect(reopened.service.exportReturnedHalfAdder(request)).resolves.toEqual({ artifact, checkpoint: state })
    expect(observe).toHaveBeenCalledExactlyOnceWith(parentSession.id, expect.objectContaining({ projectionMode: 'none' }))
    await expect(reopened.service.exportReturnedHalfAdder({ ...request, messageId: MessageId('wrong-return') }))
      .rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    await expect(reopened.service.exportReturnedBfs(request)).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    await expect(reopened.service.exportReturnedHalfAdder({ ...request, sessionId: childSession.id }))
      .rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    const guest = reopened.ctx.extend({ invocation: artifactGuestInvocation(reopened.ctx, 'exportReturnedHalfAdder') })
    observe.mockClear()
    await expect(guest.artifactBranchResults.exportReturnedHalfAdder(request))
      .rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    expect(observe).not.toHaveBeenCalled()
    expect(reopened.resolveAgent).not.toHaveBeenCalled()
    expect(reopened.forkObserved).not.toHaveBeenCalled()
    expect(reopened.parentSession.snapshotEvents()).toEqual(parentBeforeDownload)
    expect(reopened.childSession.snapshotEvents()).toEqual(childBeforeDownload)
  })

  it('returns only a source-bound BFS checkpoint with verified branch-result attribution', async () => {
    const fixture = await setup()
    const { ctx, child, childSession, parent, parentSession } = fixture
    const html = '<p>Original breadth-first search</p>'
    ctx.artifacts.commit(child.agent, ctx.artifacts.prepare(child.agent, {
      action: 'create', artifactId: control.artifactId, title: 'Branch BFS', presentation: 'inline', format: 'html', source: html,
    }))
    const artifact = ctx.artifacts.currentSnapshot(child.agent, control.artifactId)
    if (artifact?.format !== 'html') throw new Error('Expected original HTML revision')
    const state = { kind: 'bfs-checkpoint', current: 'B', queue: ['D', 'C'], visited: ['A', 'B'] }
    const capture = { status: 'ready', restore: 'bfs-checkpoint', state }
    const facts = { kind: 'html-runtime', artifact, runtimeId: 'bfs-runtime', attribution: 'program-reported', capture }
    const wrongSource = appendQuestion(childSession, bfsContextPrefix, { ...facts, artifact: { ...artifact, source: '<p>Other HTML</p>' } })
    const wrongState = appendQuestion(childSession, bfsContextPrefix, { ...facts, capture: { ...capture, state: { ...state, current: 'C' } } })
    const wrongAttribution = appendQuestion(childSession, bfsContextPrefix, { ...facts, attribution: 'host-recomputed' })
    const missingRestore = appendQuestion(childSession, bfsContextPrefix, { ...facts, capture: { status: 'ready', state } })
    const questionSeq = appendQuestion(childSession, bfsContextPrefix, facts)
    ctx.artifacts.commit(child.agent, ctx.artifacts.prepare(child.agent, {
      action: 'update', artifactId: artifact.artifactId, baseRevision: 1, title: 'Revised BFS', presentation: 'inline',
      format: 'html', source: '<p>New breadth-first search</p>',
    }))
    const resultSeq = conclusion(childSession, 'B is current, and D is next in the confirmed queue.')
    for (const invalid of [wrongSource, wrongState, wrongAttribution, missingRestore]) {
      await expect(fixture.service.returnResult(questionRequest(fixture, resultSeq, invalid))).rejects.toMatchObject({
        code: 'artifact-branch/evidence-unavailable', details: { reason: 'QUESTION_EVIDENCE_UNAVAILABLE' },
      })
    }
    expect(fixture.resolveAgent).not.toHaveBeenCalled()
    const selected = questionRequest(fixture, resultSeq, questionSeq)
    const returned = await fixture.service.returnResult(selected)
    expect(parentSession.snapshotEvents().at(-1)).toMatchObject({ type: 'user/message', data: { source: {
      kind: 'branch-result', branchSessionId: childSession.id, resultSeq, artifactEvidence: 'bfs-checkpoint',
    } } })
    expect(returnedEvidence(parentSession)).toEqual({ kind: 'branch-result-artifact-evidence',
      branchSessionId: childSession.id, evidence: { kind: 'question', questionSeq, facts } })
    const reopened = await setup({}, { parent: parentSession, child: childSession })
    const beforeRetry = reopened.parentSession.snapshotEvents()
    expect(await reopened.service.returnResult(selected)).toEqual(returned)
    expect(reopened.parentSession.snapshotEvents()).toEqual(beforeRetry)
    expect(reopened.parentSession.snapshotEvents()[returned.eventSeq]).toEqual(parentSession.snapshotEvents()[returned.eventSeq])
    const notice = reopened.parentSession.snapshotEvents()[returned.eventSeq]
    if (notice?.type !== 'user/message') throw new Error('Expected the returned BFS notice')
    const copiedNotice = createUserMessage({ source: { kind: 'user' }, content: [...notice.data.content] })
    const copied = reopened.parentSession.append('user/message', copiedNotice, { surfaceOp: 'append' })
    const parentBeforeDownload = reopened.parentSession.snapshotEvents()
    const childBeforeDownload = reopened.childSession.snapshotEvents()
    const observe = vi.spyOn(reopened.ctx.sessionQuery, 'observeSession')
    reopened.resolveAgent.mockClear()
    const download = { sessionId: parentSession.id, eventSeq: returned.eventSeq, messageId: returned.messageId }
    await expect(reopened.service.exportReturnedBfs(download)).resolves.toEqual({ artifact, checkpoint: state })
    expect(observe).toHaveBeenCalledExactlyOnceWith(parentSession.id, expect.objectContaining({ projectionMode: 'none' }))
    await expect(reopened.service.exportReturnedBfs({ ...download, messageId: copiedNotice.id }))
      .rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    await expect(reopened.service.exportReturnedBfs({ ...download, eventSeq: copied.seq, messageId: copiedNotice.id }))
      .rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    await expect(reopened.service.exportReturnedParticle(download)).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    await expect(reopened.service.exportReturnedHalfAdder(download)).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    const guest = reopened.ctx.extend({ invocation: artifactGuestInvocation(reopened.ctx, 'exportReturnedBfs') })
    observe.mockClear()
    await expect(guest.artifactBranchResults.exportReturnedBfs(download)).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    expect(observe).not.toHaveBeenCalled()
    expect(reopened.resolveAgent).not.toHaveBeenCalled()
    expect(reopened.forkObserved).not.toHaveBeenCalled()
    expect(reopened.parentSession.snapshotEvents()).toEqual(parentBeforeDownload)
    expect(reopened.childSession.snapshotEvents()).toEqual(childBeforeDownload)
    expect(parent.steer).not.toHaveBeenCalled()
    expect(parent.inject).not.toHaveBeenCalled()
    expect(child.steer).not.toHaveBeenCalled()
    expect(child.inject).not.toHaveBeenCalled()
  })

  it.each(['BFS', 'half-adder'] as const)('downloads the locked checkpoint on an exact sent %s follow-up read-only', async (experiment) => {
    const fixture = await setup()
    const { ctx, child, childSession, parentSession } = fixture
    const bfs = experiment === 'BFS'
    const original = `Original ${experiment}`
    const exportSent = bfs ? 'exportSentBfs' : 'exportSentHalfAdder'
    const exportOther = bfs ? 'exportSentHalfAdder' : 'exportSentBfs'
    const exportReturn = bfs ? 'exportReturnedBfs' : 'exportReturnedHalfAdder'
    const artifact = ctx.artifacts.prepare(child.agent, {
      action: 'create', artifactId: control.artifactId, title: `Branch ${experiment}`, presentation: 'inline', format: 'html',
      source: `<p>${original}</p>`,
    })
    ctx.artifacts.commit(child.agent, artifact)
    const returnedState: ArtifactHtmlCheckpoint = bfs
      ? { kind: 'bfs-checkpoint', current: 'B', queue: ['C', 'D', 'E'], visited: ['A', 'B'] }
      : { kind: 'half-adder-checkpoint', a: 1, b: 1, sum: 0, carry: 1 }
    const questionSeq = appendQuestion(childSession, bfs ? bfsContextPrefix : halfAdderContextPrefix, {
      kind: 'html-runtime', artifact, runtimeId: 'experiment-runtime',
      attribution: 'program-reported', capture: { status: 'ready', restore: returnedState.kind, state: returnedState },
    })
    const resultSeq = conclusion(childSession, 'The readings match the confirmed checkpoint.')
    const returned = await fixture.service.returnResult(questionRequest(fixture, resultSeq, questionSeq))
    ctx.artifacts.commit(child.agent, ctx.artifacts.prepare(child.agent, {
      action: 'update', artifactId: artifact.artifactId, baseRevision: 1, title: `Revised ${experiment}`,
      presentation: 'inline', format: 'html', source: `<p>New ${experiment}</p>`,
    }))

    const withFollowup = await setup({}, { parent: parentSession, child: childSession, withFollowup: true })
    const { resolvePromptContext } = withFollowup
    if (resolvePromptContext === undefined) throw new Error('Expected prompt context admission')
    const checkpoint: ArtifactHtmlCheckpoint = bfs
      ? { kind: 'bfs-checkpoint', current: 'C', queue: ['D', 'E', 'F'], visited: ['A', 'B', 'C'] }
      : { kind: 'half-adder-checkpoint', a: 1, b: 0, sum: 1, carry: 0 }
    const requestId = 'sent-checkpoint-question' as SessionRequestId
    const branchRef = { capturedSessionId: parentSession.id, eventSeq: returned.eventSeq, messageId: returned.messageId }
    const [block] = resolvePromptContext(withFollowup.parent.agent, checkpoint.kind === 'bfs-checkpoint'
      ? { kind: 'branch-bfs-checkpoint', ...branchRef, state: checkpoint }
      : { kind: 'branch-half-adder-checkpoint', ...branchRef, state: checkpoint }, requestId)
    if (block === undefined) throw new Error('Expected locked checkpoint attachment')
    const parent = withFollowup.parentSession
    const followup = { type: 'text', text: 'Explain this new checkpoint.' } as const
    const message = createUserMessage({ source: { kind: 'user', rpcId: requestId },
      content: [followup, block] })
    const sent = parent.append('user/message', message, { surfaceOp: 'append' })
    const copy = createUserMessage({ source: { kind: 'user' }, content: [...message.content] })
    const copied = parent.append('user/message', copy, { surfaceOp: 'append' })
    const pasted = createUserMessage({ source: { kind: 'user', rpcId: 'pasted-checkpoint' as SessionRequestId }, content: [block] })
    const pastedEvent = parent.append('user/message', pasted, { surfaceOp: 'append' })
    const forged = createUserMessage({ source: { kind: 'user', rpcId: 'forged-checkpoint' as SessionRequestId },
      content: [followup, { type: 'text', text: block.text.replace(original, `Forged ${experiment}`) }] })
    const forgedEvent = parent.append('user/message', forged, { surfaceOp: 'append' })
    const wrongOrigin = createUserMessage({ source: { kind: 'user', rpcId: 'wrong-checkpoint-origin' as SessionRequestId },
      content: [followup, { type: 'text', text: block.text.replace(returned.messageId, message.id) }] })
    const wrongOriginEvent = parent.append('user/message', wrongOrigin, { surfaceOp: 'append' })
    const malformed = createUserMessage({ source: { kind: 'user', rpcId: 'malformed-checkpoint' as SessionRequestId },
      content: [followup, { type: 'text', text: bfs
        ? block.text.replace('"current":"C"', '"current":"F"') : block.text.replace('"sum":1', '"sum":0') }] })
    const malformedEvent = parent.append('user/message', malformed, { surfaceOp: 'append' })
    const reopened = await setup({}, { parent, child: withFollowup.childSession })
    const seeded = reopened.ctx.sessions.create(SessionId(`inherited-checkpoint-${sequence}`), {
      seed: buildForkSeed(reopened.parentSession.snapshotEvents(), sent.seq), meta: { isSeeded: true, parentSession: parent.id },
      inheritedEventCount: SessionLogOffset(sent.seq + 1),
    })

    const before = reopened.parentSession.snapshotEvents()
    const childBefore = reopened.childSession.snapshotEvents()
    const observe = vi.spyOn(reopened.ctx.sessionQuery, 'observeSession')
    const download = { sessionId: parent.id, eventSeq: sent.seq, messageId: message.id }
    await expect(reopened.service[exportSent](download)).resolves.toEqual({ artifact, checkpoint })
    expect(observe).toHaveBeenCalledExactlyOnceWith(parent.id, expect.objectContaining({ projectionMode: 'none' }))
    await expect(reopened.service[exportOther](download)).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    await expect(reopened.service[exportReturn]({ sessionId: parent.id, eventSeq: returned.eventSeq, messageId: returned.messageId }))
      .resolves.toEqual({ artifact, checkpoint: returnedState })
    for (const address of [
      { ...download, messageId: copied.data.id },
      { ...download, eventSeq: returned.eventSeq, messageId: returned.messageId },
      { ...download, eventSeq: copied.seq, messageId: copy.id },
      { ...download, eventSeq: pastedEvent.seq, messageId: pasted.id },
      { ...download, eventSeq: forgedEvent.seq, messageId: forged.id },
      { ...download, eventSeq: wrongOriginEvent.seq, messageId: wrongOrigin.id },
      { ...download, eventSeq: malformedEvent.seq, messageId: malformed.id },
      { ...download, sessionId: seeded.id },
    ]) {
      await expect(reopened.service[exportSent](address)).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    }
    const guest = reopened.ctx.extend({ invocation: artifactGuestInvocation(reopened.ctx, exportSent) })
    observe.mockClear()
    await expect(guest.artifactBranchResults[exportSent](download)).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    expect(observe).not.toHaveBeenCalled()
    expect(reopened.resolveAgent).not.toHaveBeenCalled()
    expect(reopened.forkObserved).not.toHaveBeenCalled()
    expect(reopened.parentSession.snapshotEvents()).toEqual(before)
    expect(reopened.childSession.snapshotEvents()).toEqual(childBefore)
    expect(reopened.parent.inject).not.toHaveBeenCalled()
    expect(reopened.parent.steer).not.toHaveBeenCalled()
  })

  it('locks the selected second function and exports its original readings after a source update', async () => {
    const fixture = await setup({}, undefined, true)
    const artifact = createScene(fixture, {
      kind: 'function-plot', style: 'editorial',
      functions: [{ id: 'line', label: 'Line', expression: 'x' }, { id: 'curve', label: 'Parabola', expression: 'a*x^2' }],
      parameters: { a: { value: 1, min: 0, max: 4, step: 0.25 } },
      viewport: { x: [-5, 5], y: [-10, 10] }, trace: { x: 0, derivative: true, integral: true },
    })
    if (artifact.spec.kind !== 'function-plot') throw new Error('Expected original function plot')
    const selected = { functionId: 'curve', parameters: { a: 1.25 }, x: 2 }
    const values = analyzeFunctionPlotSelection(artifact.spec, selected)
    expect(values?.value).toBe(5)
    expect(values?.derivative).toBeCloseTo(5, 8)
    expect(values?.integral).toBeCloseTo(10 / 3, 4)
    const facts = { kind: 'current-function-plot', artifact, ...selected, values }
    const { resolvePromptContext } = fixture
    if (resolvePromptContext === undefined) throw new Error('Expected a follow-up provider')
    const requestId = 'ask-about-the-parabola' as SessionRequestId
    const [reading] = resolvePromptContext(fixture.child.agent,
      { kind: facts.kind, artifactId: artifact.artifactId, revision: artifact.revision, ...selected }, requestId)
    if (reading === undefined) throw new Error('Expected the locked reading')
    expect(reading.text.startsWith(plotContextPrefix)).toBe(true)
    expect(JSON.parse(reading.text.slice(plotContextPrefix.length))).toEqual({
      kind: 'artifact-question-context', sessionId: fixture.childSession.id, facts,
    })
    const question = createUserMessage({ source: { kind: 'user', rpcId: requestId },
      content: [{ type: 'text', text: 'Explain the parabola.' }, reading] })
    const { seq: questionSeq } = fixture.childSession.append('user/message', question, { surfaceOp: 'append' })
    fixture.ctx.artifacts.commit(fixture.child.agent, fixture.ctx.artifacts.prepare(fixture.child.agent, {
      action: 'update', artifactId: artifact.artifactId, baseRevision: 1, title: 'Second revision', presentation: 'inline',
      format: 'scene', spec: { ...artifact.spec, functions: [artifact.spec.functions[0]!] },
    }))
    const selectedReturn = questionRequest(fixture, conclusion(fixture.childSession), questionSeq)
    const initial = await fixture.service.returnResult(selectedReturn)
    expect(returnedEvidence(fixture.parentSession)).toEqual({ kind: 'branch-result-artifact-evidence',
      branchSessionId: fixture.childSession.id, evidence: { kind: 'question', questionSeq, facts } })
    const restored = await setup({ maxActionBytes: 1 }, { parent: fixture.parentSession, child: fixture.childSession })
    expect(await restored.service.returnResult(selectedReturn)).toEqual(initial)
    expect(restored.parentSession.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'branch-result'))
      .toHaveLength(1)
    const html = new TextDecoder().decode(await restored.service.exportSentPlot({
      sessionId: fixture.childSession.id, eventSeq: questionSeq, messageId: question.id,
    }))
    const metadata = /id="artifact-export-origin-data">([^<]+)<\/script>/u.exec(html)?.[1]
    expect(JSON.parse(metadata ?? 'null')).toMatchObject({ revision: 1, functionPlotBaseline: { ...selected, values } })
  })

  it('validates a returned CSV reading against its original chart even after an update', async () => {
    const fixture = await setup()
    const { ctx, child, childSession, parentSession, service } = fixture
    const spec: CsvBarChartSpec = { kind: 'csv-bar-chart', attachmentId: `sha256:${'a'.repeat(64)}` as CsvBarChartSpec['attachmentId'],
      groupBy: 'Trial', valueColumn: 'LatencyMs', aggregate: 'mean', rowCount: 2, groups: [{ key: 'Warm', value: 30, count: 2 }] }
    const artifact = ctx.artifacts.prepareCsvBarChart(child.agent, { action: 'create', artifactId: 'csv-chart', title: 'Mean latency', spec })
    ctx.artifacts.commit(child.agent, artifact)
    const prefix = nativeContextPrefix + 'CSV readings come from the Host-computed group result stored in the selected chart revision.\n'
    const facts = { kind: 'current-csv-bar-chart', artifact, groupKey: 'Warm', values: { key: 'Warm', value: 30, count: 2 } }
    const forged = appendQuestion(childSession, prefix, { ...facts, values: { key: 'Warm', value: 60, count: 2 } })
    const original = appendQuestion(childSession, prefix, facts)
    const revision = ctx.artifacts.prepareCsvBarChart(child.agent, { action: 'update', artifactId: artifact.artifactId,
      baseRevision: 1, title: 'Total latency', spec: { ...spec, aggregate: 'sum', groups: [{ key: 'Warm', value: 60, count: 2 }] } })
    ctx.artifacts.commit(child.agent, revision)
    const resultSeq = conclusion(childSession)
    await expect(service.returnResult(questionRequest(fixture, resultSeq, forged))).rejects.toMatchObject({
      code: 'artifact-branch/evidence-unavailable', details: { reason: 'QUESTION_EVIDENCE_UNAVAILABLE' },
    })
    await service.returnResult(questionRequest(fixture, resultSeq, original))
    expect(returnedEvidence(parentSession)).toEqual({ kind: 'branch-result-artifact-evidence',
      branchSessionId: childSession.id, evidence: { kind: 'question', questionSeq: original, facts } })
  })

  it.each([
    { aggregate: 'sum', cells: ['1e16', '1', '-1e16'], minimum: -1e16, expected: 1 },
    { aggregate: 'mean', cells: ['1e308', '1e308'], minimum: 1e308, expected: 1e308 },
  ] as const)('locks and exports the corrected CSV $aggregate from an authorized attachment', async ({ aggregate, cells, minimum, expected }) => {
    const fixture = await setup()
    const { ctx, child, childSession, parent, parentSession, service } = fixture
    const data = Buffer.from(['Trial,Reading', ...cells.map(cell => `Sample,${cell}`)].join('\n'))
    const attachmentId = `sha256:${'a'.repeat(64)}` as CsvBarChartSpec['attachmentId']
    const ref = { attachmentId, name: 'readings.csv', bytes: data.byteLength }
    const read = vi.fn(async function* () { yield data })
    ctx.provide('attachments', { readFileStream: read } as never)
    childSession.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'file', attachment: ref }] }),
      { surfaceOp: 'append' })
    const groupKey = 'Sample'
    const count = cells.length
    const original = { key: groupKey, value: minimum, count }
    const spec: CsvBarChartSpec = { kind: 'csv-bar-chart', attachmentId, groupBy: 'Trial', valueColumn: 'Reading',
      aggregate: 'min', rowCount: count, groups: [original] }
    const artifact = ctx.artifacts.prepareCsvBarChart(child.agent, { action: 'create', artifactId: 'csv-chart', title: 'Trial readings', spec })
    if (artifact.format !== 'scene') throw new Error('Expected a CSV scene')
    ctx.artifacts.commit(child.agent, artifact)
    const prefix = nativeContextPrefix + 'CSV readings come from the Host-computed group result stored in the selected chart revision.\n'
    const questionSeq = appendQuestion(childSession, prefix, { kind: 'current-csv-bar-chart', artifact, groupKey, values: original })
    const returned = await service.returnResult(questionRequest(fixture, conclusion(childSession, 'Review the sample readings.'), questionSeq))
    const request = { sessionId: parentSession.id, eventSeq: returned.eventSeq, messageId: returned.messageId, groupKey, aggregate }
    let legacy: SceneArtifactSnapshot | undefined
    if (aggregate === 'sum') {
      const oldIdentity = createHash('sha256').update(JSON.stringify([
        request.sessionId, request.eventSeq, request.messageId, aggregate, groupKey,
      ])).digest('hex')
      legacy = { ...artifact, artifactId: `continued-csv-${oldIdentity.slice(0, 32)}` as ArtifactId,
        spec: { ...spec, aggregate, groups: [{ key: groupKey, value: 0, count }] }, csvContinuation: {
          source: { sessionId: parentSession.id, eventSeq: returned.eventSeq, messageId: returned.messageId,
            artifactId: artifact.artifactId, revision: artifact.revision }, groupKey,
        } }
      ctx.artifacts.commit(parent.agent, legacy)
    }
    const locked = await service.lockCsv(request)
    const expectedGroup = { key: groupKey, value: expected, count }
    expect(locked.artifact.spec).toEqual({ ...spec, aggregate, groups: [expectedGroup] })

    const reopened = await setup({}, { parent: parentSession, child: childSession, withFollowup: true })
    reopened.ctx.provide('attachments', ctx.attachments)
    const restoredEvents = reopened.parentSession.snapshotEvents()
    await expect(reopened.service.lockCsv(request)).resolves.toEqual(locked)
    expect(reopened.parentSession.snapshotEvents()).toEqual(restoredEvents)
    if (legacy !== undefined) {
      expect(locked.artifact.artifactId).not.toBe(legacy.artifactId)
      expect(reopened.ctx.artifacts.currentSnapshot(reopened.parent.agent, legacy.artifactId)).toEqual(legacy)
    }
    const { resolvePromptContext } = reopened
    if (resolvePromptContext === undefined) throw new Error('Expected a follow-up provider')
    const questionId = 'ask-about-locked-reading' as SessionRequestId
    const selection = { kind: 'current-csv-bar-chart', artifactId: locked.artifact.artifactId, revision: locked.artifact.revision, groupKey }
    const [reading] = resolvePromptContext(reopened.parent.agent, selection, questionId)
    if (reading === undefined) throw new Error('Expected the locked reading')
    expect(JSON.parse(reading.text.slice(CONTINUED_CSV_QUESTION_PREFIX.length))).toMatchObject({
      facts: { kind: selection.kind, artifact: locked.artifact, groupKey, values: expectedGroup },
    })
    const question = createUserMessage({ source: { kind: 'user', rpcId: questionId },
      content: [{ type: 'text', text: 'Explain the locked reading.' }, reading] })
    const sent = reopened.parentSession.append('user/message', question, { surfaceOp: 'append' })
    const { attachment, current } = await reopened.service.compareCsvQuestionToReturn({
      sessionId: parentSession.id, eventSeq: sent.seq, messageId: question.id,
    })
    expect(current).toMatchObject({ groupKey, aggregate, value: expected, count })
    if (attachment === undefined) throw new Error('Expected a confirmed comparison')
    const saved = await reopened.service.saveCsvComparisonDraft({ sessionId: parentSession.id, expectedReceiptId: null, attachment })
    const comparisonId = 'ask-about-the-comparison' as SessionRequestId
    await reopened.service.bindCsvComparisonDraftRequest({
      sessionId: parentSession.id, receiptId: saved.receiptId, requestId: comparisonId,
    })
    const blocks = resolvePromptContext(reopened.parent.agent, { kind: 'csv-comparison-draft', receiptId: saved.receiptId }, comparisonId)
    const comparison = createUserMessage({ source: { kind: 'user', rpcId: comparisonId },
      content: [{ type: 'text', text: 'Compare these readings.' }, ...blocks] })
    const compared = reopened.parentSession.append('user/message', comparison, { surfaceOp: 'append' })
    vi.spyOn(reopened.ctx.sessions, 'flush').mockResolvedValue(true)
    const address = { sessionId: parentSession.id, eventSeq: compared.seq, messageId: comparison.id }
    read.mockClear()
    const decoder = new TextDecoder()
    const html = decoder.decode(await reopened.service.exportSentCsvComparison(address))
    expect(html).toContain(`data-csv-reading="value">${expected}<`)
    const json = decoder.decode(await reopened.service.exportSentCsvComparisonJson(address))
    expect(JSON.parse(json)).toMatchObject({ comparison: { current } })
    expect(read).not.toHaveBeenCalled()
  })

  it('compares two chosen CSV returns from the same inquiry without re-evaluating either reading', async () => {
    const fixture = await setup()
    const { ctx, parentSession, service, resolveAgent } = fixture
    const answerSeq = conclusion(parentSession, 'Compare the Warm measurements.')
    const inherited = parentSession.snapshotEvents()
    const answer = inherited[answerSeq]
    if (answer?.type !== 'assistant/message') throw new Error('Missing inquiry source answer')
    const inquiry = { messageSeq: answerSeq, messageId: answer.data.message.id, start: 12, end: 16, excerpt: 'Warm' }
    const branchOf = (name: string, anchored: boolean) => {
      const childSession = ctx.sessions.create(SessionId(name), { seed: inherited, inheritedEventCount: SessionLogOffset(inherited.length),
        meta: { isSeeded: true, parentSession: parentSession.id, ...(anchored ? { inquiry } : {}) } })
      return { ...fixture, childSession, child: makeAgent(ctx, childSession) }
    }
    const branch = branchOf('inquiry-csv', true)
    const sibling = branchOf('other-inquiry-csv', true)
    const unanchored = branchOf('ordinary-csv', false)
    const data = Buffer.from('Trial,LatencyMs,Batch\nWarm,25,A\nWarm,35,B\nCold,40,A\nCold,60,B\n')
    const attachmentId = `sha256:${'b'.repeat(64)}` as CsvBarChartSpec['attachmentId']
    const ref = { attachmentId, name: 'shared-trials.csv', bytes: data.byteLength }
    const otherAttachmentId = `sha256:${'c'.repeat(64)}` as CsvBarChartSpec['attachmentId']
    const read = vi.fn(async function* () { yield data })
    const missing = new Error('CSV attachment is no longer available')
    ctx.provide('attachments', { readFileStream: read, isAttachmentError: (error: unknown) => error === missing } as never)
    const mean: CsvBarChartSpec = { kind: 'csv-bar-chart', attachmentId, groupBy: 'Trial', valueColumn: 'LatencyMs', aggregate: 'mean',
      rowCount: 4, groups: [{ key: 'Warm', value: 30, count: 2 }, { key: 'Cold', value: 50, count: 2 }] }
    const sum: CsvBarChartSpec = { ...mean, aggregate: 'sum', groups: [{ key: 'Warm', value: 60, count: 2 }, { key: 'Cold', value: 100, count: 2 }] }
    const count: CsvBarChartSpec = { kind: 'csv-bar-chart', attachmentId, groupBy: 'Trial', aggregate: 'count', rowCount: 4,
      groups: [{ key: 'Warm', value: 2, count: 2 }, { key: 'Cold', value: 2, count: 2 }] }
    const prefix = nativeContextPrefix + 'CSV readings come from the Host-computed group result stored in the selected chart revision.\n'

    async function returnReading(origin: typeof branch, chart: CsvBarChartSpec, revision: number, key = 'Warm') {
      const { child, childSession } = origin
      if (revision === 1 || chart.attachmentId !== ref.attachmentId) {
        childSession.append('user/message', createUserMessage({ source: { kind: 'user' },
          content: [{ type: 'file', attachment: { ...ref, attachmentId: chart.attachmentId } }] }), { surfaceOp: 'append' })
      }
      const artifact = ctx.artifacts.prepareCsvBarChart(child.agent, { artifactId: 'test-latency', title: 'Trial latency', spec: chart,
        ...(revision === 1 ? { action: 'create' } : { action: 'update', baseRevision: revision - 1 }) })
      ctx.artifacts.commit(child.agent, artifact)
      const values = chart.groups.find(group => group.key === key)
      if (values === undefined) throw new Error('Missing fixture group')
      const question = appendQuestion(childSession, prefix, { kind: 'current-csv-bar-chart', artifact, groupKey: key, values })
      const result = conclusion(childSession, `The ${key} ${chart.aggregate} is ${values.value}.`, revision + 1)
      const { eventSeq, messageId } = await service.returnResult(questionRequest(origin, result, question))
      return { eventSeq, messageId }
    }

    const first = await returnReading(branch, mean, 1)
    const second = await returnReading(branch, sum, 2)
    const countReturn = await returnReading(branch, count, 3)
    const cold = await returnReading(branch, sum, 4, 'Cold')
    const otherAttachment = await returnReading(branch, { ...sum, attachmentId: otherAttachmentId }, 5)
    const fromSibling = await returnReading(sibling, sum, 1)
    const withoutInquiry = await returnReading(unanchored, mean, 1)
    const request = { sessionId: parentSession.id, first, second }
    const before = [parentSession.snapshotEvents(), branch.childSession.snapshotEvents()]
    resolveAgent.mockClear()

    for (const invalid of [{ ...request, second: first }, { ...request, second: fromSibling }, { ...request, first: withoutInquiry },
      { ...request, sessionId: branch.childSession.id }, { ...request, second: { ...second, messageId: first.messageId } }]) {
      await expect(service.compareCsvReturns(invalid)).rejects.toMatchObject({
        code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'SOURCE_NOT_FOUND' },
      })
    }
    await expect(service.compareCsvReturns({ ...request, offset: -1 })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(service.compareCsvReturns({ ...request, second: cold })).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'GROUP_MISMATCH' },
    })
    await expect(service.compareCsvReturns({ ...request, second: otherAttachment })).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'RESULT_CONFLICT' },
    })
    expect(read).not.toHaveBeenCalled()

    await expect(service.compareCsvReturns(request)).resolves.toEqual({
      original: { groupKey: 'Warm', aggregate: 'mean', count: 2, value: 30, valueColumn: 'LatencyMs' },
      current: { groupKey: 'Warm', aggregate: 'sum', count: 2, value: 60, valueColumn: 'LatencyMs' },
      rows: [{ record: 2, status: 'kept', value: '25' }, { record: 3, status: 'kept', value: '35' }],
      kept: 2, excluded: 0, added: 0, total: 2, offset: 0,
    })
    expect(read).toHaveBeenCalledExactlyOnceWith(ref, expect.any(AbortSignal))
    await expect(service.compareCsvReturns({ ...request, first: countReturn, second: first, offset: 1 })).resolves.toEqual({
      original: { groupKey: 'Warm', aggregate: 'count', count: 2, value: 2 },
      current: { groupKey: 'Warm', aggregate: 'mean', count: 2, value: 30, valueColumn: 'LatencyMs' },
      rows: [{ record: 3, status: 'kept', value: '35' }], kept: 2, excluded: 0, added: 0, total: 2, offset: 1,
    })
    read.mockImplementationOnce(async function* () { yield Buffer.from('Trial,LatencyMs,Batch\nWarm,25,A\n') })
    await expect(service.compareCsvReturns(request)).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'RESULT_CONFLICT' },
    })
    read.mockImplementationOnce(async function* () { throw missing })
    await expect(service.compareCsvReturns(request)).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'ATTACHMENT_UNAVAILABLE' },
    })
    expect(resolveAgent).not.toHaveBeenCalled()
    expect([parentSession.snapshotEvents(), branch.childSession.snapshotEvents()]).toEqual(before)

    const replayed = await setup({}, { parent: parentSession, child: branch.childSession, withFollowup: true })
    replayed.ctx.provide('attachments', ctx.attachments)
    const protectedBefore = replayed.parentSession.snapshotEvents()
    const rowRead = await replayed.service.compareCsvReturns(request)
    const { attachment, ...page } = rowRead
    const branchSessionId = branch.childSession.id
    const artifactId = 'test-latency'
    const expectedReturns = {
      branchSessionId, first: { ...first, artifactId, revision: 1 }, second: { ...second, artifactId, revision: 2 },
    }
    const returnFacts = attachment?.facts
    if (attachment === undefined || returnFacts?.returns === undefined || replayed.resolvePromptContext === undefined) {
      throw new Error('Expected an owner review and the mounted prompt context provider')
    }
    expect(attachment.facts).toEqual({ kind: 'csv-question-comparison', sessionId: parentSession.id, comparison: page, returns: expectedReturns })
    expect(ArtifactFollowup.isComparisonFacts(attachment.facts)).toBe(true)
    expect(ArtifactFollowup.isComparisonFacts({ ...attachment.facts,
      returns: { ...expectedReturns, second: expectedReturns.first } })).toBe(false)
    const reverse = await replayed.service.compareCsvReturns({ ...request, first: second, second: first })
    expect(reverse).toEqual({ ...page, original: page.current, current: page.original })
    expect(ArtifactFollowup.isComparisonFacts({ ...attachment.facts,
      returns: { ...expectedReturns, first: expectedReturns.second, second: expectedReturns.first } })).toBe(false)
    const guest = replayed.ctx.extend({ invocation: artifactGuestInvocation(replayed.ctx, 'compareCsvReturns') })
    await expect(guest.artifactBranchResults.compareCsvReturns(request)).resolves.toEqual(page)
    await expect(replayed.service.readCsvComparisonDraft({ sessionId: parentSession.id })).resolves.toBeNull()
    expect(replayed.parentSession.snapshotEvents()).toEqual(protectedBefore)

    const save = { sessionId: parentSession.id, expectedReceiptId: null, attachment }
    const altered = { ...attachment, facts: { ...returnFacts,
      returns: { ...returnFacts.returns, second: { ...returnFacts.returns.second, revision: 3 } } } }
    await expect(replayed.service.saveCsvComparisonDraft({ ...save, attachment: altered }))
      .rejects.toMatchObject({ details: { reason: 'INVALID_REVIEW' } })
    const saved = await replayed.service.saveCsvComparisonDraft(save)
    const alternate = await replayed.service.compareCsvReturns({ ...request, second: countReturn })
    expect(alternate.attachment?.facts.returns).not.toEqual(saved.facts.returns)
    await expect(replayed.service.readCsvComparisonDraft({ sessionId: parentSession.id })).resolves.toEqual(saved)
    expect(replayed.parentSession.snapshotEvents()).toEqual(protectedBefore)

    read.mockClear()
    const requestId = 'send-locked-returns-comparison' as SessionRequestId
    expect(() => replayed.resolvePromptContext?.(replayed.parent.agent, { kind: 'csv-question-comparison', ...attachment,
      facts: { ...returnFacts, comparison: { ...page, rows: [...page.rows] } } }, requestId)).toThrow()
    const binding = { sessionId: parentSession.id, receiptId: saved.receiptId, requestId }
    await expect(replayed.service.bindCsvComparisonDraftRequest(binding)).resolves.toEqual({ bound: true })
    const blocks = replayed.resolvePromptContext(replayed.parent.agent, { kind: 'csv-comparison-draft', receiptId: saved.receiptId }, requestId)
    const frozen = ArtifactFollowup.csvComparisonQuestionBlock(attachment.facts)
    expect(blocks).toEqual([frozen, { type: 'text', text: csvComparisonChangesText(page) }])
    expect(ArtifactFollowup.readCsvComparisonQuestionBlock(frozen.text, parentSession.id)).toEqual(attachment.facts)
    const message = createUserMessage({ source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: 'Explain both returns.' }, ...blocks] })
    const sent = replayed.parentSession.append('user/message', message, { surfaceOp: 'append' })
    vi.spyOn(replayed.ctx.sessions, 'flush').mockResolvedValue(true)
    await expect(replayed.service.readCsvComparisonDraft({ sessionId: parentSession.id })).resolves.toBeNull()
    const address = { eventSeq: sent.seq, messageId: message.id }
    const history = { sessionId: parentSession.id, ...address }
    await expect(replayed.service.reviewSentCsvComparison(history)).resolves.toMatchObject({
      facts: { ...attachment.facts, reusedFrom: address },
    })
    const returnCards = {
      first: { title: 'Trial latency', revision: 1, conclusion: ['The Warm mean is 30.'], groupBy: 'Trial', groups: mean.groups },
      second: { title: 'Trial latency', revision: 2, conclusion: ['The Warm sum is 60.'], groupBy: 'Trial', groups: sum.groups },
    }
    const observe = vi.spyOn(replayed.ctx.sessionQuery, 'observeSession')
    const json = await replayed.service.exportSentCsvComparisonJson(history)
    expect(JSON.parse(new TextDecoder().decode(json))).toEqual({
      format: 'agentrans-csv-return-comparison', version: 1, comparison: page, returnCards,
    })
    const exported = await resolveSentCsvComparisonExport(replayed.ctx, history, new AbortController().signal)
    expect(exported).toEqual({ facts: returnFacts, returnCards })
    expect(observe.mock.calls.map(args => args[0])).toEqual([parentSession.id, parentSession.id])
    const html = new TextDecoder().decode(await replayed.service.exportSentCsvComparison(history))
    expect(html).toContain('The Warm mean is 30.')
    expect(html).toContain('The Warm sum is 60.')
    expect(html).not.toContain(branchSessionId)
    expect(html).not.toContain(first.messageId)
    expect(html).not.toContain(second.messageId)

    const wrongRef = ArtifactFollowup.sealCsvComparisonQuestion(replayed.ctx, altered.facts)
    if (wrongRef === undefined) throw new Error('Expected a witnessed comparison fixture with a mismatched original revision')
    const wrongDraft = await replayed.service.saveCsvComparisonDraft({ ...save, attachment: wrongRef })
    const wrongRequestId = 'send-returns-with-wrong-revision' as SessionRequestId
    await replayed.service.bindCsvComparisonDraftRequest({ ...binding, receiptId: wrongDraft.receiptId, requestId: wrongRequestId })
    const wrongBlocks = replayed.resolvePromptContext(replayed.parent.agent,
      { kind: 'csv-comparison-draft', receiptId: wrongDraft.receiptId }, wrongRequestId)
    const wrongMessage = createUserMessage({ source: { kind: 'user', rpcId: wrongRequestId }, content: [...wrongBlocks] })
    const wrongEvent = replayed.parentSession.append('user/message', wrongMessage, { surfaceOp: 'append' })
    const wrongHistory = { sessionId: parentSession.id, eventSeq: wrongEvent.seq, messageId: wrongMessage.id }
    await expect(replayed.service.exportSentCsvComparison(wrongHistory)).rejects.toMatchObject({ details: { reason: 'HISTORY_UNVERIFIED' } })
    await expect(replayed.service.exportSentCsvComparisonJson(wrongHistory)).rejects.toMatchObject({ details: { reason: 'HISTORY_UNVERIFIED' } })
    await expect(replayed.service.reviewCsvComparisonExplanation({ sessionId: parentSession.id, first: address, second: address }))
      .rejects.toMatchObject({ details: { reason: 'HISTORY_UNVERIFIED' } })
    const destination = replayed.ctx.sessions.create(SessionId('imported-returned-csv-comparison'))
    const destinationAgent = makeAgent(replayed.ctx, destination).agent
    const importRequest = { sessionId: destination.id, json: new TextDecoder().decode(json) }
    const beforeImport = destination.snapshotEvents()
    const imported = await replayed.service.importCsvComparison(importRequest)
    if (imported.facts.returnCards === undefined) throw new Error('Expected both imported return cards')
    expect(imported.facts).toEqual({ kind: 'csv-question-comparison', provenance: 'user-imported', sessionId: destination.id,
      comparison: page, returnCards })
    expect(destination.snapshotEvents()).toEqual(beforeImport)
    await expect(replayed.service.readCsvComparisonDraft({ sessionId: destination.id })).resolves.toBeNull()
    const destinationDraft = await replayed.service.saveCsvComparisonDraft({
      sessionId: destination.id, expectedReceiptId: null, attachment: imported,
    })
    const destinationRequestId = 'send-imported-returned-csv-comparison' as SessionRequestId
    await replayed.service.bindCsvComparisonDraftRequest({
      sessionId: destination.id, receiptId: destinationDraft.receiptId, requestId: destinationRequestId,
    })
    const importedBlocks = replayed.resolvePromptContext(destinationAgent,
      { kind: 'csv-comparison-draft', receiptId: destinationDraft.receiptId }, destinationRequestId)
    const importedBlock = {
      type: 'text', text: IMPORTED_CSV_COMPARISON_QUESTION_PREFIX + JSON.stringify({
        kind: 'artifact-question-context', sessionId: destination.id, facts: imported.facts,
      }),
    } as const
    const sourceBlock = { type: 'text', text: IMPORTED_CSV_RETURN_SOURCE_TEXT } as const
    const changesBlock = { type: 'text', text: csvComparisonChangesText(page) } as const
    expect(importedBlocks).toEqual([importedBlock, sourceBlock, changesBlock])
    // Older witnessed messages have the same canonical block and no separate return-source instructions.
    const importedMessage = createUserMessage({ source: { kind: 'user', rpcId: destinationRequestId },
      content: [importedBlock, changesBlock] })
    const importedEvent = destination.append('user/message', importedMessage, { surfaceOp: 'append' })
    const reusedFrom = { eventSeq: importedEvent.seq, messageId: importedMessage.id }
    const importedHistory = { sessionId: destination.id, ...reusedFrom }
    await expect(replayed.service.exportSentCsvComparisonJson(importedHistory)).resolves.toEqual(json)
    const importedHtml = new TextDecoder().decode(await replayed.service.exportSentCsvComparison(importedHistory))
    expect(importedHtml).toContain('User-imported readings and records')
    expect(importedHtml).toContain('<p data-csv-import-source="return-comparison">JSON comparison with two original return cards</p>')
    expect(importedHtml).toContain('The Warm mean is 30.')
    expect(importedHtml).toContain('The Warm sum is 60.')
    const reviewed = await replayed.service.reviewSentCsvComparison(importedHistory)
    const reusedFacts = { ...imported.facts, reusedFrom }
    expect(reviewed.facts).toEqual(reusedFacts)
    await expect(replayed.service.readCsvComparisonDraft({ sessionId: destination.id })).resolves.toBeNull()
    const reusedDraft = await replayed.service.saveCsvComparisonDraft({
      sessionId: destination.id, expectedReceiptId: null, attachment: reviewed,
    })
    const reusedRequestId = 'reuse-imported-returned-csv-comparison' as SessionRequestId
    await replayed.service.bindCsvComparisonDraftRequest({
      sessionId: destination.id, receiptId: reusedDraft.receiptId, requestId: reusedRequestId,
    })
    const reusedBlocks = replayed.resolvePromptContext(destinationAgent,
      { kind: 'csv-comparison-draft', receiptId: reusedDraft.receiptId }, reusedRequestId)
    const reusedBlock = ArtifactFollowup.csvComparisonQuestionBlock(reusedFacts)
    expect(reusedBlock.text.startsWith(IMPORTED_CSV_COMPARISON_QUESTION_PREFIX)).toBe(true)
    expect(reusedBlocks).toEqual([reusedBlock, sourceBlock, changesBlock])
    const reusedMessage = createUserMessage({ source: { kind: 'user', rpcId: reusedRequestId }, content: [...reusedBlocks] })
    const reusedEvent = destination.append('user/message', reusedMessage, { surfaceOp: 'append' })
    await expect(replayed.service.exportSentCsvComparisonJson({
      sessionId: destination.id, eventSeq: reusedEvent.seq, messageId: reusedMessage.id,
    })).resolves.toEqual(json)
    await expect(replayed.service.reviewCsvComparisonExplanation({ sessionId: destination.id, first: reusedFrom, second: reusedFrom }))
      .rejects.toMatchObject({ details: { reason: 'HISTORY_UNVERIFIED' } })
    expect(read).not.toHaveBeenCalled()
    expect(replayed.resolveAgent).not.toHaveBeenCalled()
  })

  it('recalculates the exact returned child CSV and locks each group idempotently in the parent', async () => {
    const fixture = await setup()
    const { ctx, child, childSession, parent, parentSession, service } = fixture
    const data = Buffer.from('Trial,LatencyMs,Batch\nWarm,25,A\nWarm,35,B\nCold,40,A\nCold,60,B\n')
    const attachmentId = `sha256:${'a'.repeat(64)}` as CsvBarChartSpec['attachmentId']
    const ref = { attachmentId, name: 'trials.csv', bytes: data.byteLength }
    const read = vi.fn(async function* () { yield data })
    const missing = new Error('Attachment was removed')
    ctx.provide('attachments', { readFileStream: read, isAttachmentError: (error: unknown) => error === missing } as never)
    childSession.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'file', attachment: ref }] }),
      { surfaceOp: 'append' })
    const spec: CsvBarChartSpec = { kind: 'csv-bar-chart', attachmentId, groupBy: 'Trial', valueColumn: 'LatencyMs', aggregate: 'mean',
      rowCount: 4, groups: [{ key: 'Warm', value: 30, count: 2 }, { key: 'Cold', value: 50, count: 2 }] }
    const artifact = ctx.artifacts.prepareCsvBarChart(child.agent, { action: 'create', artifactId: 'csv-chart', title: 'Latency', spec })
    ctx.artifacts.commit(child.agent, artifact)
    const prefix = nativeContextPrefix + 'CSV readings come from the Host-computed group result stored in the selected chart revision.\n'
    const facts = { kind: 'current-csv-bar-chart', artifact, groupKey: 'Warm', values: { key: 'Warm', value: 30, count: 2 } }
    const questionSeq = appendQuestion(childSession, prefix, facts)
    const resultSeq = conclusion(childSession)
    const returned = await service.returnResult(questionRequest(fixture, resultSeq, questionSeq))
    const returnedRows = { sessionId: parentSession.id, eventSeq: returned.eventSeq, messageId: returned.messageId }
    const select = { ...returnedRows, aggregate: 'sum' } as const
    const originalParent = parentSession.snapshotEvents()
    const originalChild = childSession.snapshotEvents()
    await expect(service.recalculateCsv({ ...select, messageId: MessageId('other-notice') })).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'SOURCE_NOT_FOUND' },
    })
    await expect(service.recalculateCsv({ ...select, sessionId: childSession.id })).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'SOURCE_NOT_FOUND' },
    })
    await expect(service.csvFilterOptions({ ...select, messageId: MessageId('other-notice') })).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'SOURCE_NOT_FOUND' },
    })
    await expect(service.csvParticipatingRows({ ...select, sessionId: childSession.id, groupKey: 'Warm' })).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'SOURCE_NOT_FOUND' },
    })
    await expect(service.csvParticipatingRows({ ...select, groupKey: 'Injected' })).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'INVALID_GROUP' },
    })
    await expect(service.csvParticipatingRows({ ...select, groupKey: 'Warm', offset: -1 })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(service.csvReturnedParticipatingRows({ ...returnedRows, sessionId: childSession.id })).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'SOURCE_NOT_FOUND' },
    })
    await expect(service.csvReturnedParticipatingRows({ ...returnedRows, messageId: MessageId('other-notice') })).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'SOURCE_NOT_FOUND' },
    })
    await expect(service.csvReturnedParticipatingRows({ ...returnedRows, offset: -1 })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(read).not.toHaveBeenCalled()
    const result = await service.recalculateCsv(select)
    expect(result).toEqual({ ...spec, aggregate: 'sum', groups: [{ key: 'Warm', value: 60, count: 2 }, { key: 'Cold', value: 100, count: 2 }] })
    expect(read).toHaveBeenCalledExactlyOnceWith(ref, expect.any(AbortSignal))
    const filter = { column: 'Batch', value: 'B' }
    await expect(service.csvFilterOptions({ ...select, column: 'Batch' })).resolves.toEqual({
      columns: ['Trial', 'LatencyMs', 'Batch'], values: ['A', 'B'], hasMore: false,
    })
    const filtered = await service.recalculateCsv({ ...select, filter })
    expect(filtered).toEqual({ ...result, filter, rowCount: 2,
      groups: [{ key: 'Warm', value: 35, count: 1 }, { key: 'Cold', value: 60, count: 1 }] })
    await expect(service.csvParticipatingRows({ ...select, filter, groupKey: 'Warm' })).resolves.toEqual({
      rows: [{ record: 3, filterValue: 'B', value: '35' }], offset: 0, total: 1,
    })
    await expect(service.csvParticipatingRows({ ...select, aggregate: 'count', filter, groupKey: 'Warm' })).resolves.toEqual({
      rows: [{ record: 3, filterValue: 'B', value: '35' }], offset: 0, total: 1,
    })
    await expect(service.csvParticipatingRows({ ...select, groupKey: 'Warm', offset: 1 })).resolves.toEqual({
      rows: [{ record: 3, value: '35' }], offset: 1, total: 2,
    })
    await expect(service.recalculateCsv({ ...select, filter: { ...filter, value: 'b' } }))
      .resolves.toMatchObject({ rowCount: 0, groups: [] })
    await expect(service.csvParticipatingRows({ ...select, filter: { ...filter, value: 'b' }, groupKey: 'Warm' })).resolves.toEqual({
      rows: [], offset: 0, total: 0,
    })
    expect(parentSession.snapshotEvents()).toEqual(originalParent)
    expect(childSession.snapshotEvents()).toEqual(originalChild)
    await expect(service.lockCsv({ ...select, groupKey: 'missing' })).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'INVALID_GROUP' },
    })
    const warmRequest = { ...select, groupKey: 'Warm' }
    const flushFailure = new Error('CSV lock acknowledgement lost')
    vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(flushFailure)
    await expect(service.lockCsv(warmRequest)).rejects.toBe(flushFailure)
    expect(parentSession.snapshotEvents().slice(originalParent.length)).toHaveLength(1)
    const [first, repeated] = await Promise.all([service.lockCsv(warmRequest), service.lockCsv(warmRequest)])
    expect(repeated).toEqual(first)
    expect(first).toMatchObject({ groupKey: 'Warm', artifact: { revision: 1, spec: result, csvContinuation: { groupKey: 'Warm',
      source: { sessionId: parentSession.id, eventSeq: returned.eventSeq, messageId: returned.messageId,
        artifactId: artifact.artifactId, revision: 1 },
    } } })
    expect(parentSession.snapshotEvents().slice(originalParent.length)).toMatchObject([{ type: 'artifact/upsert', data: first.artifact }])
    expect(childSession.snapshotEvents()).toEqual(originalChild)
    expect(parent.steer).not.toHaveBeenCalled()
    expect(parent.inject).not.toHaveBeenCalled()
    const cold = await service.lockCsv({ ...select, groupKey: 'Cold' })
    expect(cold.artifact.artifactId).not.toBe(first.artifact.artifactId)
    const filteredLock = await service.lockCsv({ ...warmRequest, filter })
    expect(filteredLock.artifact.artifactId).not.toBe(first.artifact.artifactId)
    expect(filteredLock.artifact.spec).toEqual(filtered)
    expect(await service.lockCsv({ ...warmRequest, filter: { value: 'B', column: 'Batch' } })).toEqual(filteredLock)
    expect(ctx.artifacts.currentSnapshot(parent.agent, first.artifact.artifactId)).toEqual(first.artifact)

    function compareRequest(locked: typeof filteredLock, values: CsvBarChartSpec['groups'][number]) {
      const eventSeq = appendQuestion(parentSession, CONTINUED_CSV_QUESTION_PREFIX,
        { ...facts, artifact: locked.artifact, groupKey: values.key, values })
      const event = parentSession.snapshotEvents()[eventSeq]
      if (event?.type !== 'user/message') throw new Error('Expected a sent question')
      return { sessionId: parentSession.id, eventSeq, messageId: event.data.id }
    }

    const lockedFacts = { ...facts, artifact: filteredLock.artifact, values: { key: 'Warm', value: 35, count: 1 } }
    const lockedQuestion = appendQuestion(parentSession, CONTINUED_CSV_QUESTION_PREFIX, lockedFacts)
    const question = parentSession.snapshotEvents()[lockedQuestion]
    if (question?.type !== 'user/message') throw new Error('Expected the confirmed question')
    const rowsRequest = { sessionId: parentSession.id, eventSeq: lockedQuestion, messageId: question.data.id }
    const fabricated = appendQuestion(parentSession, CONTINUED_CSV_QUESTION_PREFIX, { ...lockedFacts, groupKey: 'Cold',
      values: { key: 'Cold', value: 60, count: 1 } })
    const fabricatedQuestion = parentSession.snapshotEvents()[fabricated]
    if (fabricatedQuestion?.type !== 'user/message') throw new Error('Expected the fabricated question')
    const aggregateOnly = compareRequest(first, { key: 'Warm', value: 60, count: 2 })
    const differentGroup = compareRequest(cold, { key: 'Cold', value: 100, count: 2 })
    read.mockClear()
    await expect(service.csvQuestionParticipatingRows({ ...rowsRequest, messageId: MessageId('wrong-question') })).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'SOURCE_NOT_FOUND' },
    })
    await expect(service.csvQuestionParticipatingRows({ ...rowsRequest, eventSeq: fabricated, messageId: fabricatedQuestion.data.id }))
      .rejects.toMatchObject({ code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'SOURCE_NOT_FOUND' } })
    await expect(service.csvQuestionParticipatingRows({ ...rowsRequest, offset: -1 })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(service.compareCsvQuestionToReturn({ ...rowsRequest, messageId: MessageId('wrong-question') })).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'SOURCE_NOT_FOUND' },
    })
    await expect(service.compareCsvQuestionToReturn({ ...rowsRequest, eventSeq: fabricated, messageId: fabricatedQuestion.data.id }))
      .rejects.toMatchObject({ code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'SOURCE_NOT_FOUND' } })
    await expect(service.compareCsvQuestionToReturn(differentGroup)).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'GROUP_MISMATCH' },
    })
    await expect(service.compareCsvQuestionToReturn({ ...rowsRequest, offset: -1 })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(read).not.toHaveBeenCalled()
    const replayed = await setup({}, { parent: parentSession, child: childSession, withFollowup: true })
    replayed.ctx.provide('attachments', ctx.attachments)
    const beforeReplay = replayed.parentSession.snapshotEvents()
    const beforeChildReplay = replayed.childSession.snapshotEvents()
    await expect(replayed.service.csvReturnedParticipatingRows(returnedRows)).resolves.toEqual({
      rows: [{ record: 2, value: '25' }, { record: 3, value: '35' }], offset: 0, total: 2,
    })
    await expect(replayed.service.csvReturnedParticipatingRows({ ...returnedRows, offset: 1 })).resolves.toEqual({
      rows: [{ record: 3, value: '35' }], offset: 1, total: 2,
    })
    read.mockImplementationOnce(async function* () { throw missing })
    await expect(replayed.service.csvReturnedParticipatingRows(returnedRows)).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'ATTACHMENT_UNAVAILABLE' },
    })
    await expect(replayed.service.csvQuestionParticipatingRows(rowsRequest)).resolves.toEqual({
      rows: [{ record: 3, filterValue: 'B', value: '35' }], offset: 0, total: 1, valueColumn: 'LatencyMs',
    })
    await expect(replayed.service.csvQuestionParticipatingRows({ ...rowsRequest, offset: 1 })).resolves.toEqual({
      rows: [], offset: 1, total: 1, valueColumn: 'LatencyMs',
    })
    read.mockImplementationOnce(async function* () { throw missing })
    await expect(replayed.service.csvQuestionParticipatingRows(rowsRequest)).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'ATTACHMENT_UNAVAILABLE' },
    })
    read.mockClear()
    const comparison = await replayed.service.compareCsvQuestionToReturn(rowsRequest)
    const { attachment, ...page } = comparison
    expect(page).toEqual({
      original: { groupKey: 'Warm', aggregate: 'mean', value: 30, count: 2, valueColumn: 'LatencyMs' },
      current: { groupKey: 'Warm', aggregate: 'sum', value: 35, count: 1, valueColumn: 'LatencyMs', filter },
      rows: [{ record: 2, status: 'excluded', currentFilterValue: 'A', value: '25' },
        { record: 3, status: 'kept', currentFilterValue: 'B', value: '35' }],
      kept: 1, excluded: 1, added: 0, total: 2, offset: 0,
    })
    expect(read).toHaveBeenCalledExactlyOnceWith(ref, expect.any(AbortSignal))
    expect(attachment?.facts).toEqual({
      kind: 'csv-question-comparison', sessionId: parentSession.id,
      question: { eventSeq: rowsRequest.eventSeq, messageId: rowsRequest.messageId },
      source: { eventSeq: returned.eventSeq, messageId: returned.messageId, artifactId: artifact.artifactId, revision: artifact.revision },
      comparison: page,
    })
    const alternate = await replayed.service.compareCsvQuestionToReturn(aggregateOnly)
    expect(alternate).toMatchObject({
      original: { aggregate: 'mean', value: 30, count: 2 }, current: { aggregate: 'sum', value: 60, count: 2 },
      rows: [{ record: 2, status: 'kept', value: '25' }, { record: 3, status: 'kept', value: '35' }], kept: 2, excluded: 0, added: 0,
    })
    expect(alternate.attachment?.proof).not.toEqual(attachment?.proof)
    if (attachment === undefined || attachment.facts.explanation !== undefined || attachment.facts.returnCards !== undefined
      || replayed.resolvePromptContext === undefined) {
      throw new Error('Expected a single page and the confirmation provider')
    }
    read.mockClear()
    const input = { kind: 'csv-question-comparison', ...attachment,
      facts: { ...attachment.facts, comparison: { ...page, rows: [...page.rows] } } }
    const [frozen] = replayed.resolvePromptContext(replayed.parent.agent, input, 'legacy-signed-context' as SessionRequestId)
    expect(frozen?.text.startsWith(CSV_COMPARISON_QUESTION_PREFIX)).toBe(true)
    expect(JSON.parse(frozen!.text.slice(CSV_COMPARISON_QUESTION_PREFIX.length))).toEqual({
      kind: 'artifact-question-context', sessionId: parentSession.id, facts: attachment.facts,
    })
    expect(read).not.toHaveBeenCalled()
    read.mockImplementationOnce(async function* () { yield Buffer.from('Trial,LatencyMs,Batch\nWarm,25,A\n') })
    await expect(replayed.service.compareCsvQuestionToReturn(rowsRequest)).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'RESULT_CONFLICT' },
    })
    read.mockImplementationOnce(async function* () { throw missing })
    await expect(replayed.service.compareCsvQuestionToReturn(rowsRequest)).rejects.toMatchObject({
      code: 'artifact-branch/csv-analysis-unavailable', details: { reason: 'ATTACHMENT_UNAVAILABLE' },
    })
    expect(replayed.parentSession.snapshotEvents()).toEqual(beforeReplay)
    expect(replayed.childSession.snapshotEvents()).toEqual(beforeChildReplay)
    expect(replayed.resolveAgent).not.toHaveBeenCalled()

    const draftRequest = { sessionId: parentSession.id }
    await expect(replayed.service.readCsvComparisonDraft(draftRequest)).resolves.toBeNull()
    const saved = await replayed.service.saveCsvComparisonDraft({ ...draftRequest, expectedReceiptId: null, attachment })
    await expect(replayed.service.saveCsvComparisonDraft({ ...draftRequest, expectedReceiptId: null, attachment })).resolves.toEqual(saved)
    await expect(replayed.service.readCsvComparisonDraft(draftRequest)).resolves.toEqual(saved)
    expect(replayed.parentSession.snapshotEvents()).toEqual(beforeReplay)
    const firstAttempt = 'send-csv-never-admitted' as SessionRequestId
    const requestId = 'send-csv-comparison-draft' as SessionRequestId
    const clear = { ...draftRequest, receiptId: saved.receiptId, requestId }
    const check = { ...draftRequest, requestId }
    await expect(replayed.service.bindCsvComparisonDraftRequest({ ...clear, requestId: firstAttempt })).resolves.toEqual({ bound: true })
    await expect(replayed.service.checkCsvComparisonDraftRequest({ ...check, requestId: firstAttempt }))
      .resolves.toEqual({ accepted: false })
    await expect(replayed.service.readCsvComparisonDraft(draftRequest)).resolves.toEqual(saved)
    const pending = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    replayed.ctx.provide('sessionInputs', { hasPendingPrompt: pending } as never)
    await expect(replayed.service.bindCsvComparisonDraftRequest(clear)).rejects.toMatchObject({ details: { reason: 'PROMPT_IN_FLIGHT' } })
    expect(pending).toHaveBeenCalledWith(parentSession.id, firstAttempt)
    const firstCheck = { ...check, requestId: firstAttempt }
    // Reservation may disappear while taking the fixed observation, before any durable comparison is visible.
    pending.mockReturnValueOnce(true)
    await expect(replayed.service.checkCsvComparisonDraftRequest(firstCheck)).resolves.toEqual({ accepted: false, pending: true })
    pending.mockReturnValueOnce(false).mockReturnValueOnce(true)
    await expect(replayed.service.checkCsvComparisonDraftRequest(firstCheck)).resolves.toEqual({ accepted: false, pending: true })
    pending.mockReturnValueOnce(true)
    await expect(replayed.service.readCsvComparisonDraft(draftRequest)).resolves.toEqual({ ...saved, pendingRequestId: firstAttempt })
    await expect(replayed.service.checkCsvComparisonDraftRequest(firstCheck)).resolves.toEqual({ accepted: false })
    await expect(replayed.service.readCsvComparisonDraft(draftRequest)).resolves.toEqual(saved)
    await expect(replayed.service.bindCsvComparisonDraftRequest(clear)).resolves.toEqual({ bound: true })
    await expect(replayed.service.bindCsvComparisonDraftRequest(clear)).resolves.toEqual({ bound: true })
    await expect(replayed.service.bindCsvComparisonDraftRequest({ ...clear, receiptId: 'stale' })).rejects.toMatchObject({
      details: { reason: 'DRAFT_CHANGED' },
    })
    await expect(replayed.service.clearCsvComparisonDraft(clear)).rejects.toMatchObject({ details: { reason: 'PROMPT_NOT_DURABLE' } })
    const selection = { kind: 'csv-comparison-draft', receiptId: saved.receiptId }
    expect(() => replayed.resolvePromptContext?.(replayed.parent.agent, selection, firstAttempt)).toThrow()
    const [accepted] = replayed.resolvePromptContext(replayed.parent.agent, selection, requestId)
    if (accepted === undefined) throw new Error('Expected the restored bounded block')
    const edited = createUserMessage({ source: { kind: 'user', rpcId: firstAttempt }, content: [{ type: 'text', text: 'No comparison' }] })
    replayed.parentSession.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [edited] })
    replayed.parentSession.append('user/message', createUserMessage({ source: { kind: 'user', rpcId: firstAttempt }, content: [accepted] }),
      { surfaceOp: 'append' })
    await expect(replayed.service.readCsvComparisonDraft(draftRequest)).resolves.toEqual(saved)
    await expect(replayed.service.checkCsvComparisonDraftRequest(check)).resolves.toEqual({ accepted: false })
    await expect(replayed.service.checkCsvComparisonDraftRequest({ ...check, requestId: firstAttempt }))
      .resolves.toEqual({ accepted: false })
    const message = createUserMessage({ source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: 'Explain the change' }, accepted] })
    replayed.parentSession.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
    await expect(replayed.service.bindCsvComparisonDraftRequest({ ...clear, requestId: firstAttempt })).rejects.toMatchObject({
      details: { reason: 'PROMPT_ALREADY_ACCEPTED' },
    })
    const unavailable = new Error('Durability barrier did not complete')
    const flush = vi.spyOn(replayed.ctx.sessions, 'flush').mockRejectedValueOnce(unavailable)
      .mockRejectedValueOnce(unavailable).mockRejectedValueOnce(unavailable).mockResolvedValueOnce(false).mockResolvedValue(true)
    await expect(replayed.service.clearCsvComparisonDraft(clear)).rejects.toBe(unavailable)
    await expect(replayed.service.readCsvComparisonDraft(draftRequest)).resolves.toEqual({ ...saved, pendingRequestId: requestId })
    await expect(replayed.service.checkCsvComparisonDraftRequest(check)).resolves.toEqual({ accepted: false, pending: true })
    await expect(replayed.service.checkCsvComparisonDraftRequest(check)).resolves.toEqual({ accepted: false, pending: true })
    await expect(replayed.service.readCsvComparisonDraft(draftRequest)).resolves.toBeNull()
    await expect(replayed.service.clearCsvComparisonDraft(clear)).resolves.toEqual({ cleared: false })
    await expect(replayed.service.checkCsvComparisonDraftRequest(check)).resolves.toEqual({ accepted: true, queuedMessageId: message.id })

    const otherWithComparison = createUserMessage({ source: { kind: 'user', rpcId: requestId }, content: [accepted] })
    const otherSent = replayed.parentSession.append('user/message', otherWithComparison, { surfaceOp: 'append' })
    await expect(replayed.service.checkCsvComparisonDraftRequest(check)).resolves.toEqual({ accepted: true, queuedMessageId: message.id })

    const sent = replayed.parentSession.append('user/message', message, { surfaceOp: 'append' })
    await expect(replayed.service.checkCsvComparisonDraftRequest(check)).resolves.toEqual({
      accepted: true, message: { eventSeq: sent.seq, messageId: message.id },
    })

    const editedRequestId = 'draft-queue-edited' as SessionRequestId
    const editedDraft = createUserMessage({ source: { kind: 'user', rpcId: editedRequestId }, content: [accepted] })
    replayed.parentSession.append('agent/inbox/spliced', { target: 'next-turn', start: 1, inserted: [editedDraft] })
    replayed.parentSession.append('user/message', { ...editedDraft, content: [{ type: 'text', text: 'Edited before sending' }] },
      { surfaceOp: 'append' })
    await expect(replayed.service.checkCsvComparisonDraftRequest({ ...check, requestId: editedRequestId }))
      .resolves.toEqual({ accepted: true })
    expect(flush).toHaveBeenCalledTimes(9)

    read.mockClear()
    const witnesslessRequestId = 'raw-archived-comparison' as SessionRequestId
    const lookalike = createUserMessage({ source: { kind: 'user', rpcId: witnesslessRequestId }, content: [accepted] })
    const pasted = replayed.parentSession.append('user/message', lookalike, { surfaceOp: 'append' })
    const history = { ...draftRequest, eventSeq: sent.seq, messageId: message.id }
    const unverified = { code: 'artifact-followup/csv-draft-unavailable', details: { reason: 'HISTORY_UNVERIFIED' } }
    await expect(replayed.service.reviewSentCsvComparison({ ...history, messageId: otherWithComparison.id }))
      .rejects.toMatchObject(unverified)
    await expect(replayed.service.reviewSentCsvComparison({ ...history, eventSeq: otherSent.seq, messageId: otherWithComparison.id }))
      .rejects.toMatchObject(unverified)
    await expect(replayed.service.reviewSentCsvComparison({ ...history, eventSeq: pasted.seq, messageId: lookalike.id }))
      .rejects.toMatchObject(unverified)
    await expect(replayed.service.reviewSentCsvComparison({ ...history, sessionId: childSession.id })).rejects.toMatchObject(unverified)
    await expect(replayed.service.exportSentCsvComparison({ ...history, messageId: otherWithComparison.id }))
      .rejects.toMatchObject(unverified)
    await expect(replayed.service.exportSentCsvComparison({ ...history, eventSeq: otherSent.seq, messageId: otherWithComparison.id }))
      .rejects.toMatchObject(unverified)
    await expect(replayed.service.exportSentCsvComparison({ ...history, eventSeq: pasted.seq, messageId: lookalike.id }))
      .rejects.toMatchObject(unverified)
    await expect(replayed.service.exportSentCsvComparison({ ...history, sessionId: childSession.id })).rejects.toMatchObject(unverified)
    read.mockImplementation(async function* () { throw missing })
    const beforeReuse = replayed.parentSession.snapshotEvents()
    const exported = new TextDecoder().decode(await replayed.service.exportSentCsvComparison(history))
    expect(exported).toContain('<h1>Locked CSV comparison</h1>')
    expect(exported).toContain('<p data-csv-compare-range>Records 1–2 of 2</p>')
    expect(exported).toContain('data-csv-reading="value">30<')
    expect(exported).toContain('data-csv-reading="value">35<')
    expect(exported).toContain('data-csv-compare-record="2" data-csv-compare-status="excluded"')
    expect(exported).toContain('data-csv-compare-record="3" data-csv-compare-status="kept"')
    expect(exported).not.toContain(replayed.parentSession.id)
    expect(exported).not.toContain('Explain the change')
    expect(replayed.parentSession.snapshotEvents()).toEqual(beforeReuse)
    expect(replayed.childSession.snapshotEvents()).toEqual(beforeChildReplay)
    await expect(replayed.service.readCsvComparisonDraft(draftRequest)).resolves.toBeNull()
    const reuse = await replayed.service.reviewSentCsvComparison(history)
    if (reuse.facts.explanation !== undefined) throw new Error('Expected to reuse one saved page')
    const reusedFrom = { eventSeq: history.eventSeq, messageId: history.messageId }
    expect(reuse.facts).toEqual({ ...saved.facts, reusedFrom })
    const altered = { ...reuse, facts: { ...reuse.facts, reusedFrom: { ...reusedFrom, messageId: lookalike.id } } }
    await expect(replayed.service.saveCsvComparisonDraft({ ...draftRequest, expectedReceiptId: null, attachment: altered }))
      .rejects.toMatchObject({ code: 'artifact-followup/csv-draft-unavailable', details: { reason: 'INVALID_REVIEW' } })
    const reused = await replayed.service.saveCsvComparisonDraft({ ...draftRequest, expectedReceiptId: null, attachment: reuse })
    expect(reused.facts).toEqual(reuse.facts)
    expect(reused.receiptId).not.toEqual(saved.receiptId)
    expect(replayed.parentSession.snapshotEvents()).toEqual(beforeReuse)

    const reuseRequestId = 'send-reused-csv-comparison' as SessionRequestId
    const reuseRequest = { ...draftRequest, receiptId: reused.receiptId, requestId: reuseRequestId }
    await expect(replayed.service.bindCsvComparisonDraftRequest(reuseRequest)).resolves.toEqual({ bound: true })
    const [reusedBlock] = replayed.resolvePromptContext(replayed.parent.agent,
      { kind: 'csv-comparison-draft', receiptId: reused.receiptId }, reuseRequestId)
    if (reusedBlock === undefined) throw new Error('Expected the comparison and immediate source to be attached')
    expect(JSON.parse(reusedBlock.text.slice(CSV_COMPARISON_QUESTION_PREFIX.length))).toEqual({
      kind: 'artifact-question-context', sessionId: parentSession.id, facts: reused.facts,
    })
    const reusedMessage = createUserMessage({ source: { kind: 'user', rpcId: reuseRequestId }, content: [reusedBlock] })
    const reusedEvent = replayed.parentSession.append('user/message', reusedMessage, { surfaceOp: 'append' })
    await expect(replayed.service.clearCsvComparisonDraft(reuseRequest)).resolves.toEqual({ cleared: true })
    const nextSource = { eventSeq: reusedEvent.seq, messageId: reusedMessage.id }
    const twiceReused = await replayed.service.reviewSentCsvComparison({ ...draftRequest, ...nextSource })
    expect(twiceReused.facts).toEqual({ ...saved.facts, reusedFrom: nextSource })
    expect(twiceReused.facts.reusedFrom).not.toEqual(reusedFrom)

    await expect(replayed.service.exportSentCsvComparisonJson({ ...history, eventSeq: pasted.seq, messageId: lookalike.id }))
      .rejects.toMatchObject(unverified)
    const json = new TextDecoder().decode(await replayed.service.exportSentCsvComparisonJson(history))
    const snapshot = { format: 'agentrans-csv-comparison', version: 1, comparison: saved.facts.comparison }
    expect(JSON.parse(json)).toEqual(snapshot)
    const destination = replayed.ctx.sessions.create(SessionId('imported-csv-comparison'))
    const importedAgent = makeAgent(replayed.ctx, destination).agent
    const importRequest = { sessionId: destination.id, json }
    const beforeImport = destination.snapshotEvents()
    const imported = await replayed.service.importCsvComparison(importRequest)
    if (imported.facts.provenance !== 'user-imported' || imported.facts.explanation !== undefined || imported.facts.returnCards !== undefined) {
      throw new Error('Expected a user-imported page')
    }
    expect(imported.facts).toEqual({
      kind: 'csv-question-comparison', sessionId: destination.id, provenance: 'user-imported', comparison: saved.facts.comparison,
    })
    expect(destination.snapshotEvents()).toEqual(beforeImport)
    await expect(replayed.service.readCsvComparisonDraft({ sessionId: destination.id })).resolves.toBeNull()
    await expect(replayed.service.saveCsvComparisonDraft({ ...draftRequest, expectedReceiptId: null, attachment: imported }))
      .rejects.toMatchObject({ details: { reason: 'INVALID_REVIEW' } })
    const tooLarge = { ...snapshot, comparison: {
      ...snapshot.comparison, rows: snapshot.comparison.rows.map(row => ({ ...row, value: '"'.repeat(4096) })),
    } }
    await expect(replayed.service.importCsvComparison({ ...importRequest, json: JSON.stringify(tooLarge) })).rejects.toMatchObject({
      code: 'artifact-branch/csv-comparison-import-invalid', details: { reason: 'PROMPT_LIMIT' },
    })
    const importedRequestId = 'send-imported-comparison' as SessionRequestId
    const directContext = { kind: 'csv-question-comparison', proof: imported.proof, facts: {
      ...imported.facts, comparison: { ...imported.facts.comparison, rows: [...imported.facts.comparison.rows] },
    } }
    expect(() => replayed.resolvePromptContext?.(importedAgent, directContext, importedRequestId)).toThrow()
    const importedDraft = await replayed.service.saveCsvComparisonDraft({
      sessionId: destination.id, expectedReceiptId: null, attachment: imported,
    })
    const binding = { sessionId: destination.id, receiptId: importedDraft.receiptId, requestId: importedRequestId }
    await expect(replayed.service.bindCsvComparisonDraftRequest(binding)).resolves.toEqual({ bound: true })
    const importedBlocks = replayed.resolvePromptContext(importedAgent,
      { kind: 'csv-comparison-draft', receiptId: importedDraft.receiptId }, importedRequestId)
    const [importedBlock] = importedBlocks
    if (importedBlock === undefined) throw new Error('Expected the imported page after confirmation')
    expect(importedBlock.text.startsWith(IMPORTED_CSV_COMPARISON_QUESTION_PREFIX)).toBe(true)
    expect(JSON.parse(importedBlock.text.slice(IMPORTED_CSV_COMPARISON_QUESTION_PREFIX.length))).toEqual({
      kind: 'artifact-question-context', sessionId: destination.id, facts: imported.facts,
    })
    const singleSourceBlock = { type: 'text', text: IMPORTED_CSV_SINGLE_SOURCE_TEXT } as const
    const singleChangesBlock = { type: 'text', text: csvComparisonChangesText(imported.facts.comparison) } as const
    expect(importedBlocks).toEqual([importedBlock, singleSourceBlock, singleChangesBlock])
    // Older witnessed single-page comparisons could carry the changes block without the source instruction.
    const importedMessage = createUserMessage({
      source: { kind: 'user', rpcId: importedRequestId }, content: [importedBlock, singleChangesBlock],
    })
    const importedEvent = destination.append('user/message', importedMessage, { surfaceOp: 'append' })
    const importedHistory = { sessionId: destination.id, eventSeq: importedEvent.seq, messageId: importedMessage.id }
    await expect(replayed.service.clearCsvComparisonDraft(binding)).resolves.toEqual({ cleared: true })
    const reexported = await replayed.service.exportSentCsvComparisonJson(importedHistory)
    expect(JSON.parse(new TextDecoder().decode(reexported))).toEqual(snapshot)
    const importedHtml = new TextDecoder().decode(await replayed.service.exportSentCsvComparison(importedHistory))
    expect(importedHtml).toContain('<p data-csv-compare-provenance>User-imported readings and records</p>')
    expect(importedHtml).toContain('<p data-csv-import-source="single-page">JSON comparison with one locked page</p>')
    const localizedHtml = new TextDecoder().decode(await replayed.service.exportSentCsvComparison({ ...importedHistory, locale: 'zh' }))
    expect(localizedHtml).toContain('<html lang="zh-CN">')
    expect(localizedHtml).toContain('<p data-csv-import-source="single-page">含一页已锁定结果的 JSON 对照</p>')
    expect(localizedHtml).toContain(`data-csv-reading="value">${snapshot.comparison.current.value}<`)
    await expect(replayed.service.exportSentCsvComparisonJson(importedHistory)).resolves.toEqual(reexported)
    const reviewedImport = await replayed.service.reviewSentCsvComparison(importedHistory)
    expect(reviewedImport.facts).toEqual({ ...imported.facts, reusedFrom: { eventSeq: importedEvent.seq, messageId: importedMessage.id } })

    async function sendComparison(
      selection: ArtifactCsvComparisonAttachment, label: string, blockCount = 2, target = replayed.parent.agent,
      archiveCanonicalOnly = false,
    ) {
      const targetRequest = { sessionId: target.session.id }
      const requestId = label as SessionRequestId
      const draft = await replayed.service.saveCsvComparisonDraft({ ...targetRequest, expectedReceiptId: null, attachment: selection })
      await expect(replayed.service.readCsvComparisonDraft(targetRequest)).resolves.toEqual(draft)
      const binding = { ...targetRequest, receiptId: draft.receiptId, requestId }
      await expect(replayed.service.bindCsvComparisonDraftRequest(binding)).resolves.toEqual({ bound: true })
      const content = replayed.resolvePromptContext?.(target, { kind: 'csv-comparison-draft', receiptId: draft.receiptId }, requestId)
      if (content?.length !== blockCount) throw new Error(`Expected ${blockCount} comparison context blocks`)
      const sent = createUserMessage({ source: { kind: 'user', rpcId: requestId },
        content: archiveCanonicalOnly ? content.slice(0, 1) : [...content] })
      const event = target.session.append('user/message', sent, { surfaceOp: 'append' })
      await expect(replayed.service.clearCsvComparisonDraft(binding)).resolves.toEqual({ cleared: true })
      return { address: { eventSeq: event.seq, messageId: sent.id }, content }
    }

    const sentReusedImport = await sendComparison(reviewedImport, 'send-reused-imported-page', 3, importedAgent)
    expect(sentReusedImport.content).toEqual([
      ArtifactFollowup.csvComparisonQuestionBlock(reviewedImport.facts), singleSourceBlock, singleChangesBlock,
    ])
    await expect(replayed.service.exportSentCsvComparisonJson({ sessionId: destination.id, ...sentReusedImport.address }))
      .resolves.toEqual(reexported)

    if (alternate.attachment === undefined) throw new Error('Expected the witnessed unfiltered comparison')
    const aggregation = await sendComparison(alternate.attachment, 'send-ordered-aggregation')
    const filtering = { eventSeq: sent.seq, messageId: message.id }
    const pairInput = { ...draftRequest, first: filtering, second: aggregation.address }
    const beforePair = replayed.parentSession.snapshotEvents()
    const pair = await replayed.service.reviewCsvComparisonExplanation(pairInput)
    expect(pair.facts).toEqual({
      ...saved.facts,
      explanation: { aggregation: { message: aggregation.address, comparison: alternate.attachment.facts.comparison }, filtering },
    })
    await expect(replayed.service.reviewCsvComparisonExplanation({ ...pairInput, first: aggregation.address, second: filtering }))
      .resolves.toEqual(pair)
    expect(replayed.parentSession.snapshotEvents()).toEqual(beforePair)
    await expect(replayed.service.readCsvComparisonDraft(draftRequest)).resolves.toBeNull()
    await expect(replayed.service.reviewCsvComparisonExplanation({ ...pairInput, second: filtering }))
      .rejects.toMatchObject({ details: { reason: 'INCOMPATIBLE_PAIR' } })
    await expect(replayed.service.reviewCsvComparisonExplanation({
      ...pairInput, second: { ...aggregation.address, messageId: filtering.messageId },
    })).rejects.toMatchObject(unverified)
    await expect(replayed.service.reviewCsvComparisonExplanation({ ...pairInput, sessionId: childSession.id }))
      .rejects.toMatchObject(unverified)
    const localImport = await replayed.service.importCsvComparison({ ...draftRequest, json })
    const sentLocalImport = await sendComparison(localImport, 'send-incompatible-import', 3)
    await expect(replayed.service.reviewCsvComparisonExplanation({ ...pairInput, first: sentLocalImport.address }))
      .rejects.toMatchObject({ details: { reason: 'INCOMPATIBLE_PAIR' } })

    const sumFacts = alternate.attachment.facts
    if (sumFacts.provenance !== undefined || sumFacts.explanation !== undefined || sumFacts.returns !== undefined) {
      throw new Error('Expected a local single page')
    }
    const differentRevision = ArtifactFollowup.sealCsvComparisonQuestion(replayed.ctx,
      { ...sumFacts, source: { ...sumFacts.source, revision: sumFacts.source.revision + 1 } })
    if (differentRevision === undefined) throw new Error('Expected matching test budget for another revision')
    const sentDifferentRevision = await sendComparison(differentRevision, 'send-incompatible-revision')
    await expect(replayed.service.reviewCsvComparisonExplanation({ ...pairInput, second: sentDifferentRevision.address }))
      .rejects.toMatchObject({ details: { reason: 'INCOMPATIBLE_PAIR' } })
    const differentBaseline = ArtifactFollowup.sealCsvComparisonQuestion(replayed.ctx, { ...sumFacts,
      comparison: { ...sumFacts.comparison, original: { ...sumFacts.comparison.original, value: 31 } },
    })
    if (differentBaseline === undefined) throw new Error('Expected matching test budget for a different baseline')
    const sentDifferentBaseline = await sendComparison(differentBaseline, 'send-incompatible-baseline')
    await expect(replayed.service.reviewCsvComparisonExplanation({ ...pairInput, second: sentDifferentBaseline.address }))
      .rejects.toMatchObject({ details: { reason: 'INCOMPATIBLE_PAIR' } })

    const withLargeCells = (facts: ArtifactCsvComparisonAttachment['facts']) => ArtifactFollowup.sealCsvComparisonQuestion(replayed.ctx, {
      ...facts, comparison: { ...facts.comparison, rows: facts.comparison.rows.map(row => ({ ...row, value: '0'.repeat(4096) })) },
    })
    const largeSum = withLargeCells(sumFacts)
    const largeFilter = withLargeCells(saved.facts)
    if (largeSum === undefined || largeFilter === undefined) throw new Error('Expected individual pages to fit')
    const sentLargeSum = await sendComparison(largeSum, 'send-large-aggregation')
    const sentLargeFilter = await sendComparison(largeFilter, 'send-large-filter')
    await expect(replayed.service.reviewCsvComparisonExplanation({
      ...pairInput, first: sentLargeSum.address, second: sentLargeFilter.address,
    })).rejects.toMatchObject({ details: { reason: 'EXPLANATION_TOO_LARGE' } })
    await expect(replayed.service.readCsvComparisonDraft(draftRequest)).resolves.toBeNull()

    const { address: pairedAddress, content: [pairBlock] } = await sendComparison(pair, 'send-ordered-explanation', 1)
    expect(pairBlock?.text.startsWith(CSV_COMPARISON_EXPLANATION_PREFIX)).toBe(true)
    expect(JSON.parse(pairBlock!.text.slice(CSV_COMPARISON_EXPLANATION_PREFIX.length))).toEqual({
      kind: 'artifact-question-context', sessionId: draftRequest.sessionId, facts: pair.facts,
    })
    const pairedExportRequest = { ...draftRequest, ...pairedAddress }
    const beforeExplanationExport = replayed.parentSession.snapshotEvents()
    const explanationHtml = new TextDecoder().decode(await replayed.service.exportSentCsvComparison(pairedExportRequest))
    expect(explanationHtml).toContain('<h1>CSV comparison explanation</h1>')
    expect(explanationHtml).toContain('<details data-csv-explanation-locked-page="aggregation">')
    expect(explanationHtml).toContain('<details data-csv-explanation-locked-page="filtering">')
    expect(explanationHtml).toContain('data-csv-reading="value">60<')
    expect(explanationHtml).toContain('data-csv-reading="value">35<')
    expect(explanationHtml).toContain('data-csv-compare-record="2" data-csv-compare-status="excluded"')
    expect(explanationHtml).not.toContain(pairedAddress.messageId)
    expect(replayed.parentSession.snapshotEvents()).toEqual(beforeExplanationExport)
    await expect(replayed.service.exportSentCsvComparison({ ...pairedExportRequest, messageId: filtering.messageId }))
      .rejects.toMatchObject(unverified)
    await expect(replayed.service.exportSentCsvComparison({ ...pairedExportRequest, sessionId: childSession.id }))
      .rejects.toMatchObject(unverified)
    if (pair.facts.explanation === undefined || pair.facts.provenance !== undefined) {
      throw new Error('Expected the exact local pair in the reviewed explanation')
    }
    const wrongPage = ArtifactFollowup.sealCsvComparisonQuestion(replayed.ctx, {
      ...pair.facts, comparison: { ...pair.facts.comparison, current: { ...pair.facts.comparison.current, value: 36 } },
    })
    if (wrongPage === undefined) throw new Error('Expected the test explanation to fit')
    const { address: wrongPageAddress } = await sendComparison(wrongPage, 'send-pair-with-different-page', 1)
    await expect(replayed.service.exportSentCsvComparison({ ...draftRequest, ...wrongPageAddress })).rejects.toMatchObject(unverified)
    const wrongSource = ArtifactFollowup.sealCsvComparisonQuestion(replayed.ctx, {
      ...pair.facts, explanation: { ...pair.facts.explanation, filtering: sentLocalImport.address },
    })
    if (wrongSource === undefined) throw new Error('Expected the test explanation with different source to fit')
    const { address: wrongSourceAddress } = await sendComparison(wrongSource, 'send-pair-with-different-source', 1)
    await expect(replayed.service.exportSentCsvComparison({ ...draftRequest, ...wrongSourceAddress })).rejects.toMatchObject(unverified)
    await expect(replayed.service.exportSentCsvComparisonJson({ ...draftRequest, ...wrongPageAddress })).rejects.toMatchObject(unverified)
    const pairBytes = await replayed.service.exportSentCsvComparisonJson(pairedExportRequest)
    const pairJson = new TextDecoder().decode(pairBytes)
    expect(JSON.parse(pairJson)).toEqual({
      format: 'agentrans-csv-comparison-explanation', version: 1, aggregation: sumFacts.comparison, filtering: page,
    })
    const beforeImportPair = destination.snapshotEvents()
    const importedPair = await replayed.service.importCsvComparison({ ...importRequest, json: pairJson })
    expect(importedPair.facts).toEqual({
      kind: 'csv-question-comparison', sessionId: destination.id, provenance: 'user-imported', comparison: page,
      explanation: { aggregation: { comparison: sumFacts.comparison } },
    })
    expect(destination.snapshotEvents()).toEqual(beforeImportPair)
    await expect(replayed.service.readCsvComparisonDraft({ sessionId: destination.id })).resolves.toBeNull()
    await expect(replayed.service.saveCsvComparisonDraft({ ...draftRequest, expectedReceiptId: null, attachment: importedPair }))
      .rejects.toMatchObject({ details: { reason: 'INVALID_REVIEW' } })
    const oversizedPair = {
      format: 'agentrans-csv-comparison-explanation', version: 1, aggregation: largeSum.facts.comparison, filtering: largeFilter.facts.comparison,
    }
    await expect(replayed.service.importCsvComparison({ ...importRequest, json: JSON.stringify(oversizedPair) })).rejects.toMatchObject({
      code: 'artifact-branch/csv-comparison-import-invalid', details: { reason: 'PROMPT_LIMIT' },
    })
    // Older witnessed explanations stored the same canonical facts as a single block.
    const sentImportedPair = await sendComparison(importedPair, 'send-imported-pair', 2, importedAgent, true)
    const explanationSourceBlock = { type: 'text', text: IMPORTED_CSV_EXPLANATION_SOURCE_TEXT }
    expect(sentImportedPair.content).toEqual([{
      type: 'text', text: IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX + JSON.stringify({
        kind: 'artifact-question-context', sessionId: destination.id, facts: importedPair.facts,
      }),
    }, explanationSourceBlock])
    const importedPairRequest = { sessionId: destination.id, ...sentImportedPair.address }
    await expect(replayed.service.exportSentCsvComparisonJson(importedPairRequest)).resolves.toEqual(pairBytes)
    const importedPairHtml = new TextDecoder().decode(await replayed.service.exportSentCsvComparison(importedPairRequest))
    expect(importedPairHtml).toContain('<p data-csv-compare-provenance>User-imported readings and records</p>')
    expect(importedPairHtml).toContain('<p data-csv-import-source="two-step-explanation">'
      + 'JSON two-step explanation with two original locked pages</p>')
    const beforePairReview = destination.snapshotEvents()
    const reviewedPair = await replayed.service.reviewSentCsvComparison(importedPairRequest)
    expect(reviewedPair.facts).toEqual({ ...importedPair.facts, reusedFrom: sentImportedPair.address })
    expect(ArtifactFollowup.isComparisonFacts(importedPair.facts)).toBe(true)
    expect(ArtifactFollowup.isComparisonFacts({
      ...reviewedPair.facts, reusedFrom: { ...sentImportedPair.address, sessionId: destination.id },
    })).toBe(false)
    expect(ArtifactFollowup.isComparisonFacts({
      ...reviewedPair.facts, reusedFrom: { ...sentImportedPair.address, eventSeq: -1 },
    })).toBe(false)
    expect(destination.snapshotEvents()).toEqual(beforePairReview)
    await expect(replayed.service.readCsvComparisonDraft({ sessionId: destination.id })).resolves.toBeNull()
    await expect(replayed.service.reviewSentCsvComparison({ ...importedPairRequest, messageId: importedMessage.id }))
      .rejects.toMatchObject(unverified)
    await expect(replayed.service.reviewSentCsvComparison({ ...importedPairRequest, sessionId: parentSession.id }))
      .rejects.toMatchObject(unverified)
    const guest = replayed.ctx.extend({ invocation: artifactGuestInvocation(replayed.ctx, 'reviewSentCsvComparison') })
    await expect(guest.artifactBranchResults.reviewSentCsvComparison(importedPairRequest))
      .rejects.toMatchObject({ details: { reason: 'UNAVAILABLE' } })
    const rawPair = createUserMessage({
      source: { kind: 'user', rpcId: 'pasted-imported-pair' as SessionRequestId }, content: [...sentImportedPair.content],
    })
    const rawPairEvent = destination.append('user/message', rawPair, { surfaceOp: 'append' })
    await expect(replayed.service.reviewSentCsvComparison({ ...importedPairRequest, eventSeq: rawPairEvent.seq, messageId: rawPair.id }))
      .rejects.toMatchObject(unverified)
    const alteredPair = { ...reviewedPair, facts: { ...reviewedPair.facts, comparison: {
      ...reviewedPair.facts.comparison, current: { ...reviewedPair.facts.comparison.current, value: 36 },
    } } }
    await expect(replayed.service.saveCsvComparisonDraft({
      sessionId: destination.id, expectedReceiptId: null, attachment: alteredPair,
    })).rejects.toMatchObject({ details: { reason: 'INVALID_REVIEW' } })
    const sentReusedPair = await sendComparison(reviewedPair, 'send-reused-imported-pair', 2, importedAgent)
    expect(sentReusedPair.content).toEqual([ArtifactFollowup.csvComparisonQuestionBlock(reviewedPair.facts), explanationSourceBlock])
    const reusedPairRequest = { sessionId: destination.id, ...sentReusedPair.address }
    const reexportedPair = await replayed.service.exportSentCsvComparisonJson(reusedPairRequest)
    expect(reexportedPair).toEqual(pairBytes)
    const portableAgain = await replayed.service.importCsvComparison({
      sessionId: destination.id, json: new TextDecoder().decode(reexportedPair),
    })
    expect(portableAgain.facts).toEqual(importedPair.facts)
    const reviewedAgain = await replayed.service.reviewSentCsvComparison(reusedPairRequest)
    expect(reviewedAgain.facts).toEqual({ ...importedPair.facts, reusedFrom: sentReusedPair.address })
    const sentAgain = await sendComparison(reviewedAgain, 'send-imported-pair-again', 2, importedAgent)
    expect(sentAgain.content).toEqual([ArtifactFollowup.csvComparisonQuestionBlock(reviewedAgain.facts), explanationSourceBlock])
    await expect(replayed.service.reviewSentCsvComparison({ ...draftRequest, ...pairedAddress })).rejects.toMatchObject(unverified)
    await expect(replayed.service.reviewCsvComparisonExplanation({ ...pairInput, second: pairedAddress })).rejects.toMatchObject(unverified)
    expect(read).not.toHaveBeenCalled()
    expect(replayed.resolveAgent).not.toHaveBeenCalled()
  })

  it('continues the exact returned plot in a new child, with a durable baseline and stable retries', async () => {
    const fixture = await setup()
    const artifact = createScene(fixture, {
      kind: 'function-plot', functions: [{ id: 'scaled', label: 'Scaled', expression: 'a*x' }],
      parameters: { a: { value: 1, min: 0, max: 4, step: 0.25 } },
      viewport: { x: [-0.5, 0.5], y: [-10, 10] }, trace: { x: 0, derivative: true, integral: true },
    })
    if (artifact.spec.kind !== 'function-plot') throw new Error('Expected original function plot')
    const settings = { functionId: 'scaled', parameters: { a: 1.25 }, x: 1 }
    const values = analyzeFunctionPlotSelection(artifact.spec, settings)
    expect(values?.integral).toBeCloseTo(0.625, 12)
    const questionSeq = appendQuestion(fixture.childSession, plotContextPrefix, { kind: 'current-function-plot', artifact, ...settings, values })
    const returned = await fixture.service.returnResult(questionRequest(fixture, conclusion(fixture.childSession), questionSeq))
    const request: ArtifactBranchContinuePlotRequest = {
      sessionId: fixture.parentSession.id, eventSeq: returned.eventSeq, messageId: returned.messageId,
      requestId: '7b542fa3-7f41-4fe4-9331-b38102c40ef1' as ArtifactBranchContinuePlotRequestId,
    }
    const parentBefore = fixture.parentSession.snapshotEvents()
    const childBefore = fixture.childSession.snapshotEvents()
    await expect(fixture.service.continuePlot({ ...request, messageId: MessageId('different-message') }))
      .rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    expect(fixture.forkObserved).not.toHaveBeenCalled()
    const [first, duplicate] = await Promise.all([fixture.service.continuePlot(request), fixture.service.continuePlot(request)])
    expect(duplicate).toEqual(first)
    expect(first.artifactId).not.toBe(artifact.artifactId)
    expect(fixture.forkObserved).toHaveBeenCalledOnce()
    const continued = fixture.ctx.sessions.get(first.sessionId)
    if (continued === undefined) throw new Error('Continuation did not create a branch')
    const own = continued.snapshotEvents().slice(continued.inheritedEventCount)
    expect(own.map(event => event.type)).toEqual(['session/end-seed', 'artifact/upsert'])
    expect(own[1]).toMatchObject({ type: 'artifact/upsert', data: {
      artifactId: first.artifactId, revision: 1, spec: artifact.spec,
      continuation: { source: {
        sessionId: request.sessionId, eventSeq: request.eventSeq, messageId: request.messageId,
        artifactId: artifact.artifactId, revision: artifact.revision,
      }, baseline: { ...settings, values } },
    } })
    expect(fixture.parentSession.snapshotEvents()).toEqual(parentBefore)
    expect(fixture.childSession.snapshotEvents()).toEqual(childBefore)
    const reopened = await setup({}, { parent: fixture.parentSession, child: fixture.childSession, continued })
    expect(await reopened.service.continuePlot(request)).toEqual(first)
    expect(reopened.ctx.sessions.get(first.sessionId)?.snapshotEvents()).toEqual(continued.snapshotEvents())
  })

  it('downloads the original locked plot from an exact own return without opening another branch', async () => {
    const fixture = await setup()
    const artifact = createScene(fixture, {
      kind: 'function-plot', functions: [
        { id: 'reference', label: 'Reference line', expression: 'x' },
        { id: 'scaled', label: 'Locked plot', expression: 'a*x' },
      ],
      parameters: { a: { value: 1, min: 0, max: 4, step: 0.25 } },
      viewport: { x: [-0.5, 0.5], y: [-10, 10] }, trace: { x: 0, derivative: true, integral: true },
    })
    if (artifact.spec.kind !== 'function-plot') throw new Error('Expected original function plot')
    const settings = { functionId: 'scaled', parameters: { a: 1.25 }, x: 1 }
    const values = analyzeFunctionPlotSelection(artifact.spec, settings)
    const questionSeq = appendQuestion(fixture.childSession, plotContextPrefix, { kind: 'current-function-plot', artifact, ...settings, values })
    const returned = await fixture.service.returnResult(questionRequest(fixture, conclusion(fixture.childSession), questionSeq))
    const { eventSeq, messageId } = returned
    const request = { sessionId: fixture.parentSession.id, eventSeq, messageId }
    const returnedMessage = fixture.parentSession.snapshotEvents()[eventSeq]
    if (returnedMessage?.type !== 'user/message') throw new Error('Expected the original branch return notice')
    const pasted = createUserMessage({ source: { kind: 'user' }, content: [...returnedMessage.data.content] })
    const ordinary = fixture.parentSession.append('user/message', pasted, { surfaceOp: 'append' })
    fixture.ctx.artifacts.commit(fixture.child.agent, fixture.ctx.artifacts.prepare(fixture.child.agent, {
      action: 'update', artifactId: artifact.artifactId, title: 'Evolved plot', format: 'scene', presentation: 'inline', baseRevision: 1,
      spec: { ...artifact.spec, trace: { ...artifact.spec.trace, x: 0.25 } },
    }))
    const reopened = await setup({}, { parent: fixture.parentSession, child: fixture.childSession })
    const parentBefore = reopened.parentSession.snapshotEvents()
    const childBefore = reopened.childSession.snapshotEvents()
    const observe = vi.spyOn(reopened.ctx.sessionQuery, 'observeSession')
    const bytes = await reopened.service.exportReturnedPlot(request)
    const html = new TextDecoder().decode(bytes)
    expect(sceneExportOrigin(html)).toEqual({
      exportId: `return-${eventSeq}`, sessionId: request.sessionId, artifactId: artifact.artifactId, revision: artifact.revision,
      returnedEvidence: { eventSeq, messageId }, exporterVersion: 2, functionPlotBaseline: { ...settings, values },
    })
    expect(html).toContain(`const spec = ${JSON.stringify(artifact.spec)}`)
    expect(html).not.toContain('Evolved plot')
    expect(observe).toHaveBeenCalledExactlyOnceWith(request.sessionId, expect.objectContaining({ projectionMode: 'none' }))
    await expect(reopened.service.exportReturnedPlot(request)).resolves.toEqual(bytes)
    await expect(reopened.service.exportReturnedParticle(request)).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    await expect(reopened.service.exportReturnedBfs(request)).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    await expect(reopened.service.exportReturnedPlot({ ...request, messageId: pasted.id }))
      .rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    await expect(reopened.service.exportReturnedPlot({ ...request, eventSeq: ordinary.seq, messageId: pasted.id }))
      .rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    const inherited = reopened.ctx.sessions.create(SessionId('inherited-plot-return'), {
      seed: parentBefore, meta: { isSeeded: true, parentSession: request.sessionId },
      inheritedEventCount: SessionLogOffset(parentBefore.length),
    })
    await expect(reopened.service.exportReturnedPlot({ ...request, sessionId: inherited.id }))
      .rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    const guest = reopened.ctx.extend({ invocation: artifactGuestInvocation(reopened.ctx, 'exportReturnedPlot') })
    observe.mockClear()
    await expect(guest.artifactBranchResults.exportReturnedPlot(request)).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    expect(observe).not.toHaveBeenCalled()
    expect(reopened.resolveAgent).not.toHaveBeenCalled()
    expect(reopened.forkObserved).not.toHaveBeenCalled()
    expect(reopened.parentSession.snapshotEvents()).toEqual(parentBefore)
    expect(reopened.childSession.snapshotEvents()).toEqual(childBefore)
  })

  it('downloads an owned sent plot question with its inherited source revision without activating either Agent', async () => {
    const fixture = await setup()
    const { ctx, parent, parentSession } = fixture
    const artifact = ctx.artifacts.prepare(parent.agent, {
      action: 'create', artifactId: control.artifactId, title: 'Original plot', format: 'scene', presentation: 'inline',
      spec: {
        kind: 'function-plot', functions: [
          { id: 'reference', label: 'Reference line', expression: 'x' },
          { id: 'scaled', label: 'Locked plot', expression: 'a*x' },
        ],
        parameters: { a: { value: 1, min: 0, max: 4, step: 0.25 } },
        viewport: { x: [-0.5, 0.5], y: [-10, 10] }, trace: { x: 0, derivative: true, integral: true },
      },
    })
    if (artifact.format !== 'scene' || artifact.spec.kind !== 'function-plot') throw new Error('Expected the inherited function plot')
    ctx.artifacts.commit(parent.agent, artifact)
    const childSession = ctx.sessions.create(SessionId(`sent-plot-branch-${sequence}`), {
      seed: parentSession.snapshotEvents(), meta: { isSeeded: true, parentSession: parentSession.id },
      inheritedEventCount: SessionLogOffset(parentSession.seq),
    })
    const child = makeAgent(ctx, childSession)
    const settings = { functionId: 'scaled', parameters: { a: 1.25 }, x: 1 }
    const values = analyzeFunctionPlotSelection(artifact.spec, settings)
    if (values === undefined) throw new Error('Expected valid locked plot readings')
    const attachment = { kind: 'artifact-question-context', sessionId: childSession.id,
      facts: { kind: 'current-function-plot', artifact, ...settings, values } }
    const block = { type: 'text', text: plotContextPrefix + JSON.stringify(attachment) } as const
    const followup = { type: 'text', text: 'Explain my locked function-plot reading.' } as const
    const appendSent = (rpcId: string, content: UserMessage['content']) => childSession.append('user/message', createUserMessage({
      source: { kind: 'user', rpcId: rpcId as SessionRequestId }, content,
    }), { surfaceOp: 'append' })
    const sent = appendSent('sent-plot', [followup, block])
    const pasted = appendSent('pasted-plot', [block])
    const duplicate = appendSent('duplicated-plot', [followup, block, block])
    const forged = appendSent('forged-plot', [followup, { ...block, text: block.text.replace('Original plot', 'Forged plot') }])
    const malformed = appendSent('malformed-plot', [followup, { ...block, text: plotContextPrefix + JSON.stringify({
      ...attachment, facts: { ...attachment.facts, values: { ...values, derivative: 999 } },
    }) }])
    ctx.artifacts.commit(child.agent, ctx.artifacts.prepare(child.agent, {
      action: 'update', artifactId: artifact.artifactId, title: 'Evolved plot', format: 'scene', presentation: 'inline', baseRevision: 1,
      spec: { ...artifact.spec, trace: { ...artifact.spec.trace, x: 0.25 } },
    }))
    const reopened = await setup({}, { parent: parentSession, child: childSession })
    const parentBefore = reopened.parentSession.snapshotEvents()
    const childBefore = reopened.childSession.snapshotEvents()
    const request = { sessionId: childSession.id, eventSeq: sent.seq, messageId: sent.data.id }
    const observe = vi.spyOn(reopened.ctx.sessionQuery, 'observeSession')
    const bytes = await reopened.service.exportSentPlot(request)
    expect(observe).toHaveBeenCalledExactlyOnceWith(request.sessionId, expect.objectContaining({ projectionMode: 'none' }))
    const html = new TextDecoder().decode(bytes)
    expect(sceneExportOrigin(html)).toEqual({
      exportId: `sent-${sent.seq}`, sessionId: childSession.id, artifactId: artifact.artifactId, revision: artifact.revision,
      sentQuestion: { eventSeq: sent.seq, messageId: sent.data.id }, exporterVersion: 2, functionPlotBaseline: { ...settings, values },
    })
    expect(html).toContain(`const spec = ${JSON.stringify(artifact.spec)}`)
    expect(html).not.toContain('Evolved plot')
    await expect(reopened.service.exportSentPlot(request)).resolves.toEqual(bytes)
    await expect(reopened.service.exportReturnedPlot(request)).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    for (const invalid of [pasted, duplicate, forged, malformed]) {
      await expect(reopened.service.exportSentPlot({ ...request, eventSeq: invalid.seq, messageId: invalid.data.id }))
        .rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    }
    await expect(reopened.service.exportSentPlot({ ...request, messageId: pasted.data.id }))
      .rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    const inherited = reopened.ctx.sessions.create(SessionId(`inherited-plot-question-${sequence}`), {
      seed: buildForkSeed(childBefore, sent.seq), meta: { isSeeded: true, parentSession: childSession.id },
      inheritedEventCount: SessionLogOffset(sent.seq + 1),
    })
    await expect(reopened.service.exportSentPlot({ ...request, sessionId: inherited.id }))
      .rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    const guest = reopened.ctx.extend({ invocation: artifactGuestInvocation(reopened.ctx, 'exportSentPlot') })
    observe.mockClear()
    await expect(guest.artifactBranchResults.exportSentPlot(request)).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    expect(observe).not.toHaveBeenCalled()
    expect(reopened.resolveAgent).not.toHaveBeenCalled()
    expect(reopened.forkObserved).not.toHaveBeenCalled()
    expect(reopened.parentSession.snapshotEvents()).toEqual(parentBefore)
    expect(reopened.childSession.snapshotEvents()).toEqual(childBefore)
  })

  it('returns a particle checkpoint without saving an observation', async () => {
    const fixture = await setup()
    const artifact = createScene(fixture, spec)
    const checkpoint = { runtimeVersion: 1, stepCount: 6 }
    const facts = { kind: 'current-particle', artifact, checkpoint, values: observeParticleState(restoreParticleCheckpoint(spec, checkpoint)) }
    const questionSeq = appendQuestion(fixture.childSession, particleContextPrefix, facts)
    const returned = await fixture.service.returnResult(questionRequest(fixture, conclusion(fixture.childSession), questionSeq))
    const { eventSeq, messageId } = returned
    const download = { sessionId: fixture.parentSession.id, eventSeq, messageId }
    const html = new TextDecoder().decode(await fixture.service.exportReturnedParticle(download))
    expect(sceneExportOrigin(html)).toMatchObject({ exporterVersion: 1, exportId: `return-${eventSeq}`, sessionId: download.sessionId,
      artifactId: artifact.artifactId, revision: artifact.revision, returnedEvidence: { eventSeq, messageId }, checkpoint })
    expect(html).toContain(`const spec = ${JSON.stringify(artifact.spec)}`)
    await expect(fixture.service.exportReturnedPlot(download))
      .rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    const guest = fixture.ctx.extend({ invocation: artifactGuestInvocation(fixture.ctx, 'exportReturnedParticle') })
    await expect(guest.artifactBranchResults.exportReturnedParticle(download)).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    expect(returnedEvidence(fixture.parentSession)).toEqual({ kind: 'branch-result-artifact-evidence',
      branchSessionId: fixture.childSession.id, evidence: { kind: 'question', questionSeq, facts } })
    expect(fixture.childSession.snapshotEvents().some(event => event.type === 'artifact/observations')).toBe(false)
  })

  it('downloads each sent particle checkpoint with its original revision and confirmed gravity', async () => {
    const fixture = await setup()
    const { ctx, parentSession, childSession } = fixture
    const artifact = createScene(fixture, spec)
    const checkpoint = { runtimeVersion: 1, stepCount: 6 }
    const facts = { kind: 'current-particle', artifact, checkpoint, values: observeParticleState(restoreParticleCheckpoint(spec, checkpoint)) }
    const attachment = (session: Session, prefix: string, evidence: object) => ({
      type: 'text', text: prefix + JSON.stringify({ kind: 'artifact-question-context', sessionId: session.id, facts: evidence }),
    }) as const
    const appendSent = (session: Session, id: string, ...attachments: UserMessage['content']) => session.append('user/message', createUserMessage({
      source: { kind: 'user', rpcId: id as SessionRequestId }, content: [{ type: 'text', text: 'Explain the locked particle readings.' }, ...attachments],
    }), { surfaceOp: 'append' })
    const original = appendSent(childSession, 'sent-original-particle', attachment(childSession, particleContextPrefix, facts))
    const returned = await fixture.service.returnResult(questionRequest(fixture, conclusion(childSession), original.seq))
    const result = await fixture.service.continueParticle({
      sessionId: parentSession.id, eventSeq: returned.eventSeq, messageId: returned.messageId,
      requestId: 'b6f8b8f6-4884-4ddb-922d-83cc70069588' as ArtifactBranchContinuePlotRequestId,
    })
    const nextAgent = ctx.agents.get(result.sessionId)
    if (nextAgent === undefined) throw new Error('Expected the continued particle Agent')
    const continued = nextAgent.session
    const source = ctx.artifacts.currentSnapshot(nextAgent, result.artifactId)
    if (source?.format !== 'scene' || source.spec.kind !== 'particle-system') throw new Error('Expected the continued particle source')
    const adjustedSpec = { ...source.spec, gravity: { ...source.spec.gravity, y: -5 } }
    const adjusted = { ...facts, artifact: source, gravityY: adjustedSpec.gravity.y,
      values: observeParticleState(restoreParticleCheckpoint(adjustedSpec, checkpoint)) }
    const adjustedAttachment = attachment(continued, adjustedParticleContextPrefix, adjusted)
    const sent = appendSent(continued, 'sent-adjusted-particle', adjustedAttachment)
    const ambiguous = appendSent(continued, 'mixed-particle-attachments', adjustedAttachment,
      attachment(continued, particleContextPrefix, { ...facts, artifact: source }))
    const forged = appendSent(continued, 'forged-particle-reading', attachment(continued, adjustedParticleContextPrefix,
      { ...adjusted, values: { ...adjusted.values, time: 999 } }))
    const laterCheckpoint = { ...checkpoint, stepCount: checkpoint.stepCount + 1 }
    const wrongCheckpoint = appendSent(continued, 'particle-override-at-another-step', attachment(continued, adjustedParticleContextPrefix,
      { ...adjusted, checkpoint: laterCheckpoint, values: observeParticleState(restoreParticleCheckpoint(adjustedSpec, laterCheckpoint)) }))
    ctx.artifacts.commit(nextAgent, ctx.artifacts.prepare(nextAgent, {
      action: 'update', artifactId: source.artifactId, baseRevision: source.revision, title: 'Updated particle experiment',
      presentation: 'inline', format: 'scene', spec: { ...source.spec, gravity: { x: 0, y: 0 } },
    }))

    const reopened = await setup({}, { parent: parentSession, child: childSession, continued })
    const logs = () => [parentSession, childSession, continued].map(session => reopened.ctx.sessions.get(session.id)?.snapshotEvents())
    const before = logs()
    const observe = vi.spyOn(reopened.ctx.sessionQuery, 'observeSession')
    const originalRequest = { sessionId: childSession.id, eventSeq: original.seq, messageId: original.data.id }
    const request = { sessionId: continued.id, eventSeq: sent.seq, messageId: sent.data.id }
    for (const [address, snapshot, exportSpec] of [[originalRequest, artifact, artifact.spec], [request, source, adjustedSpec]] as const) {
      const bytes = await reopened.service.exportSentParticle(address)
      const html = new TextDecoder().decode(bytes)
      expect(sceneExportOrigin(html)).toEqual({ exporterVersion: 1, exportId: `sent-${address.eventSeq}`, sessionId: address.sessionId,
        artifactId: snapshot.artifactId, revision: snapshot.revision, checkpoint,
        sentQuestion: { eventSeq: address.eventSeq, messageId: address.messageId } })
      expect(html).toContain(`const spec = ${JSON.stringify(exportSpec)}`)
      expect(html).toContain('<table id="particle-readings">')
      expect(html).not.toContain('Updated particle experiment')
      expect(observe).toHaveBeenLastCalledWith(address.sessionId, expect.objectContaining({ projectionMode: 'none' }))
    }
    const unavailable = { code: 'artifact-branch/evidence-unavailable' }
    await expect(reopened.service.exportSentPlot(request)).rejects.toMatchObject(unavailable)
    await expect(reopened.service.exportSentParticle({ ...request, messageId: original.data.id })).rejects.toMatchObject(unavailable)
    for (const invalid of [ambiguous, forged, wrongCheckpoint]) {
      await expect(reopened.service.exportSentParticle({ ...request, eventSeq: invalid.seq, messageId: invalid.data.id }))
        .rejects.toMatchObject(unavailable)
    }
    const guest = reopened.ctx.extend({ invocation: artifactGuestInvocation(reopened.ctx, 'exportSentParticle') })
    observe.mockClear()
    await expect(guest.artifactBranchResults.exportSentParticle(request)).rejects.toMatchObject(unavailable)
    expect(observe).not.toHaveBeenCalled()
    expect(reopened.resolveAgent).not.toHaveBeenCalled()
    expect(reopened.forkObserved).not.toHaveBeenCalled()
    expect(logs()).toEqual(before)
  })

  it('continues an original particle checkpoint and reuses a confirmed gravity change on the next branch', async () => {
    const fixture = await setup()
    const artifact = createScene(fixture, spec)
    const checkpoint = { runtimeVersion: 1, stepCount: 6 }
    const values = observeParticleState(restoreParticleCheckpoint(spec, checkpoint))
    const questionSeq = appendQuestion(fixture.childSession, particleContextPrefix, { kind: 'current-particle', artifact, checkpoint, values })
    fixture.ctx.artifacts.commit(fixture.child.agent, fixture.ctx.artifacts.prepare(fixture.child.agent, {
      action: 'update', artifactId: artifact.artifactId, baseRevision: 1, title: 'Second revision', presentation: 'inline',
      format: 'scene', spec: { ...spec, gravity: { x: 0, y: 0 } },
    }))
    const returned = await fixture.service.returnResult(questionRequest(fixture, conclusion(fixture.childSession), questionSeq))
    const request: ArtifactBranchContinueParticleRequest = {
      sessionId: fixture.parentSession.id, eventSeq: returned.eventSeq, messageId: returned.messageId,
      requestId: '7b542fa3-7f41-4fe4-9331-b38102c40ef1' as ArtifactBranchContinuePlotRequestId,
    }
    const parentBefore = fixture.parentSession.snapshotEvents()
    const childBefore = fixture.childSession.snapshotEvents()
    await expect(fixture.service.continuePlot(request)).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    await expect(fixture.service.continueParticle({ ...request, messageId: MessageId('different-message') }))
      .rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    expect(fixture.forkObserved).not.toHaveBeenCalled()

    const [first, duplicate] = await Promise.all([fixture.service.continueParticle(request), fixture.service.continueParticle(request)])
    expect(duplicate).toEqual(first)
    expect(first.artifactId).not.toBe(artifact.artifactId)
    expect(fixture.forkObserved).toHaveBeenCalledOnce()
    const continued = fixture.ctx.sessions.get(first.sessionId)
    if (continued === undefined) throw new Error('Continuation did not create a branch')
    const own = continued.snapshotEvents().slice(continued.inheritedEventCount)
    expect(own.map(event => event.type)).toEqual(['session/end-seed', 'artifact/upsert'])
    expect(own[1]).toMatchObject({ type: 'artifact/upsert', data: {
      artifactId: first.artifactId, revision: 1, spec: artifact.spec,
      particleContinuation: { source: {
        sessionId: request.sessionId, eventSeq: request.eventSeq, messageId: request.messageId,
        artifactId: artifact.artifactId, revision: artifact.revision,
      }, baseline: { checkpoint } },
    } })
    expect(fixture.parentSession.snapshotEvents()).toEqual(parentBefore)
    expect(fixture.childSession.snapshotEvents()).toEqual(childBefore)
    const reopened = await setup({}, { parent: fixture.parentSession, child: fixture.childSession, continued })
    expect(await reopened.service.continueParticle(request)).toEqual(first)
    expect(reopened.ctx.sessions.get(first.sessionId)?.snapshotEvents()).toEqual(continued.snapshotEvents())

    const firstEvent = own[1]
    if (firstEvent?.type !== 'artifact/upsert' || firstEvent.data.format !== 'scene') throw new Error('Expected first child Artifact')
    const variantSpec = { ...spec, gravity: { x: 0, y: -5 } }
    const factsAt = (stepCount: number) => ({ kind: 'current-particle', artifact: firstEvent.data, gravityY: variantSpec.gravity.y,
      checkpoint: { runtimeVersion: 1, stepCount },
      values: observeParticleState(restoreParticleCheckpoint(variantSpec, { runtimeVersion: 1, stepCount })) })
    const mismatchedStep = appendQuestion(continued, particleContextPrefix, factsAt(checkpoint.stepCount + 1))
    const reviewed = factsAt(checkpoint.stepCount)
    const matchingStep = appendQuestion(continued, particleContextPrefix, reviewed)
    const nextResult = { sessionId: request.sessionId, branchSessionId: first.sessionId, resultSeq: conclusion(continued) }
    await expect(fixture.service.returnResult({ ...nextResult, evidence: { kind: 'question', questionSeq: mismatchedStep, blockIndex: 1 } }))
      .rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable' })
    const secondNotice = await fixture.service.returnResult({ ...nextResult, evidence: { kind: 'question', questionSeq: matchingStep, blockIndex: 1 } })
    expect(returnedEvidence(fixture.parentSession)).toMatchObject({ evidence: { kind: 'question', facts: reviewed } })

    const parentBeforeDownload = fixture.parentSession.snapshotEvents()
    const childBeforeDownload = continued.snapshotEvents()
    const { eventSeq, messageId } = secondNotice
    const download = { sessionId: request.sessionId, eventSeq, messageId }
    fixture.resolveAgent.mockClear()
    const html = new TextDecoder().decode(await fixture.service.exportReturnedParticle(download))
    expect(sceneExportOrigin(html)).toMatchObject({ exporterVersion: 1, sessionId: request.sessionId, artifactId: first.artifactId,
      revision: 1, returnedEvidence: { eventSeq, messageId }, checkpoint })
    expect(html).toContain(`const spec = ${JSON.stringify({ ...firstEvent.data.spec, gravity: variantSpec.gravity })}`)
    expect(fixture.parentSession.snapshotEvents()).toEqual(parentBeforeDownload)
    expect(continued.snapshotEvents()).toEqual(childBeforeDownload)
    expect(fixture.resolveAgent).not.toHaveBeenCalled()
    expect(fixture.forkObserved).toHaveBeenCalledOnce()

    const second = await fixture.service.continueParticle({
      sessionId: request.sessionId, eventSeq: secondNotice.eventSeq, messageId: secondNotice.messageId,
      requestId: 'b058a780-b6e5-4f67-8731-51637cb74498' as ArtifactBranchContinuePlotRequestId,
    })
    expect(fixture.ctx.sessions.get(second.sessionId)?.snapshotEvents().at(-1)).toMatchObject({ type: 'artifact/upsert', data: {
      artifactId: second.artifactId, revision: 1, spec: { ...artifact.spec, gravity: variantSpec.gravity },
      particleContinuation: { source: { artifactId: first.artifactId }, baseline: { checkpoint } },
    } })
  })

  it('refuses substituted question snapshots, altered readings, mismatched Sessions and an attachment after the conclusion', async () => {
    const fixture = await setup()
    const artifact = createScene(fixture, spec)
    const checkpoint = { runtimeVersion: 1, stepCount: 6 }
    const values = observeParticleState(restoreParticleCheckpoint(spec, checkpoint))
    const facts = { kind: 'current-particle', artifact, checkpoint, values }
    const wrongSource = appendQuestion(fixture.childSession, particleContextPrefix, {
      ...facts, artifact: { ...artifact, spec: { ...spec, gravity: { x: 0, y: -4 } } },
    })
    const wrongValues = appendQuestion(fixture.childSession, particleContextPrefix, { ...facts, values: { ...values, time: 1 } })
    const wrongSession = appendQuestion(fixture.childSession, particleContextPrefix, facts, fixture.parentSession.id)
    const resultSeq = conclusion(fixture.childSession)
    const laterQuestion = appendQuestion(fixture.childSession, particleContextPrefix, facts)
    for (const seq of [wrongSource, wrongValues, wrongSession, laterQuestion, 0]) {
      await expect(fixture.service.returnResult(questionRequest(fixture, resultSeq, seq))).rejects.toMatchObject({
        code: 'artifact-branch/evidence-unavailable', details: { reason: 'QUESTION_EVIDENCE_UNAVAILABLE' },
      })
    }
    expect(fixture.resolveAgent).not.toHaveBeenCalled()
    expect(fixture.parentSession.snapshotEvents()).toHaveLength(1)
  })

  it('returns a fixed old pair with complete sources without changing parent Artifacts or waking either Agent', async () => {
    const fixture = await setup()
    const resultSeq = conclusion(fixture.childSession)
    savePair(fixture, { ...spec, gravity: { x: 0, y: -4 } })
    for (const ref of [control, variant]) {
      fixture.ctx.artifacts.commit(fixture.child.agent, fixture.ctx.artifacts.prepare(fixture.child.agent, {
        action: 'update', artifactId: ref.artifactId, baseRevision: 1, title: 'Current HTML', presentation: 'inline',
        source: '<p>Current source is unrelated</p>', format: 'html',
      }))
    }
    fixture.ctx.artifacts.commit(fixture.parent.agent, fixture.ctx.artifacts.prepare(fixture.parent.agent, {
      action: 'create', artifactId: control.artifactId, title: 'Independent parent experiment', presentation: 'inline',
      format: 'scene', spec: { ...spec, particles: [{ ...spec.particles[0]!, x: 100 }] },
    }))
    const parentBefore = fixture.parentSession.snapshotEvents()
    const childBefore = fixture.childSession.snapshotEvents()
    const response = await fixture.service.returnResult(request(fixture, resultSeq))
    expect(response).toMatchObject({ parentSessionId: fixture.parentSession.id })
    expect(fixture.parentSession.snapshotEvents().slice(0, -1)).toEqual(parentBefore)
    expect(fixture.childSession.snapshotEvents()).toEqual(childBefore)
    const returned = fixture.parentSession.snapshotEvents().at(-1)
    expect(returned).toMatchObject({ type: 'user/message', data: {
      id: response.messageId, source: { kind: 'branch-result', branchSessionId: fixture.childSession.id, resultSeq, form: 'notice' },
    } })
    if (returned?.type !== 'user/message') throw new Error('Expected returned parent input')
    expect(returned.data.content).toHaveLength(2)
    const evidence = returned.data.content[1]
    if (evidence?.type !== 'text') throw new Error('Expected evidence text')
    expect(evidence.text).toContain('This does not state that the assistant used it')
    expect(JSON.parse(evidence.text.slice(evidence.text.indexOf('\n') + 1))).toMatchObject({
      kind: 'branch-result-artifact-evidence', branchSessionId: fixture.childSession.id, evidence: {
        kind: 'comparison', group: 'gravity', conditions: { runtimeVersion: 1, stepCount: 6, timeStep: 1 / 30, time: 0.2 },
        control: { artifact: { artifactId: control.artifactId, revision: 1, spec }, checkpoint: { stepCount: 6 }, values: { time: 0.2 } },
        variant: { artifact: { artifactId: variant.artifactId, revision: 1, spec: { gravity: { y: -4 } } } },
      },
    })
    expect(evidence.text).not.toContain('Independent parent experiment')
    expect(JSON.stringify(returned)).not.toContain('Private reasoning')
    expect(returned.sourceEventSeqs).toBeUndefined()
    for (const agent of [fixture.parent, fixture.child]) {
      expect(agent.steer).not.toHaveBeenCalled()
      expect(agent.inject).not.toHaveBeenCalled()
    }
    expect(fixture.resolveAgent).toHaveBeenCalledExactlyOnceWith(fixture.parentSession.id)
  })

  it('returns one saved observation and keeps identical retries stable after child progress and service recreation', async () => {
    const first = await setup()
    savePair(first)
    const resultSeq = conclusion(first.childSession)
    const selected: ArtifactBranchResultRequest = { ...request(first, resultSeq), evidence: { kind: 'observation', observation: control } }
    const initial = await first.service.returnResult(selected)
    first.childSession.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Later work must not affect the frozen return' }] }), { surfaceOp: 'append' })
    expect(await first.service.returnResult(selected)).toEqual(initial)
    const second = await setup({}, { parent: first.parentSession, child: first.childSession })
    expect(await second.service.returnResult(selected)).toEqual(initial)
    expect(second.parentSession.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'branch-result'))
      .toHaveLength(1)
  })

  it('rejects adding evidence to a conclusion already returned through plain admission', async () => {
    const fixture = await setup()
    savePair(fixture)
    const resultSeq = conclusion(fixture.childSession)
    await returnPlain(fixture, resultSeq)
    await expect(fixture.service.returnResult(request(fixture, resultSeq))).rejects.toMatchObject({ code: 'session/branch-result-conflict' })
    expect(fixture.parentSession.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'branch-result'))
      .toHaveLength(1)
  })

  it('rejects replacing evidence and allows retrying the original request', async () => {
    const fixture = await setup()
    savePair(fixture)
    const resultSeq = conclusion(fixture.childSession)
    const selected = request(fixture, resultSeq)
    const initial = await fixture.service.returnResult(selected)
    await expect(fixture.service.returnResult({ ...selected, evidence: { kind: 'observation', observation: control } }))
      .rejects.toMatchObject({ code: 'session/branch-result-conflict' })
    await expect(returnPlain(fixture, resultSeq)).rejects.toThrow('different content')
    expect(await fixture.service.returnResult(selected)).toEqual(initial)
  })

  it('preserves an unknown flush outcome after append and recovers the original receipt', async () => {
    const fixture = await setup()
    savePair(fixture)
    const selected = request(fixture, conclusion(fixture.childSession))
    const failure = new Error('Acknowledgement lost after append')
    const flush = vi.spyOn(fixture.ctx.sessions, 'flush').mockRejectedValueOnce(failure)
    await expect(fixture.service.returnResult(selected)).rejects.toBe(failure)
    const returned = fixture.parentSession.snapshotEvents().at(-1)
    const response = await fixture.service.returnResult(selected)
    expect(response.eventSeq).toBe(returned?.seq)
    expect(flush).toHaveBeenCalledTimes(2)
    expect(fixture.parentSession.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'branch-result'))
      .toHaveLength(1)
  })

  it('reports busy before starting a parent transaction', async () => {
    const fixture = await setup()
    savePair(fixture)
    const selected = request(fixture, conclusion(fixture.childSession))
    fixture.parent.setBusy(true)
    await expect(fixture.service.returnResult(selected)).rejects.toMatchObject({ code: 'session/agent-busy' })
    expect(fixture.parentSession.snapshotEvents()).toHaveLength(1)
  })

  it('rejects evidence available only in the parent after the fork and incompatible fixed conditions', async () => {
    const fixture = await setup()
    savePair(fixture, { ...spec, timeStep: 1 / 60 })
    const selected = request(fixture, conclusion(fixture.childSession))
    await expect(fixture.service.returnResult(selected)).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable',
      details: { reason: 'TIME_STEP_MISMATCH' } })
    fixture.ctx.artifacts.commit(fixture.parent.agent, fixture.ctx.artifacts.prepare(fixture.parent.agent, {
      action: 'create', artifactId: control.artifactId, title: 'Parent-only observation', presentation: 'inline', format: 'scene', spec,
    }))
    fixture.ctx.artifacts.saveObservation(fixture.parent.agent, control.artifactId, 1,
      'parent-only' as ArtifactObservationId, 'Saved after the fork', { runtimeVersion: 1, stepCount: 6 })
    await expect(fixture.service.returnResult({ ...selected,
      evidence: { kind: 'observation', observation: { ...control, observationId: 'parent-only' as ArtifactObservationId } },
    })).rejects.toMatchObject({ code: 'artifact-branch/evidence-unavailable', details: { reason: 'OBSERVATION_NOT_FOUND' } })
    expect(fixture.resolveAgent).not.toHaveBeenCalled()
  })

  it('accepts saved evidence inherited in the selected branch prefix', async () => {
    const fixture = await setup()
    fixture.ctx.artifacts.commit(fixture.parent.agent, fixture.ctx.artifacts.prepare(fixture.parent.agent, {
      action: 'create', artifactId: control.artifactId, title: 'Inherited experiment', presentation: 'inline', format: 'scene', spec,
    }))
    fixture.ctx.artifacts.saveObservation(fixture.parent.agent, control.artifactId, 1, control.observationId,
      'Saved before the fork', { runtimeVersion: 1, stepCount: 6 })
    const inherited = fixture.ctx.sessions.create(SessionId('inheriting-child'), {
      seed: fixture.parentSession.snapshotEvents(),
      meta: { isSeeded: true, parentSession: fixture.parentSession.id },
      inheritedEventCount: SessionLogOffset(fixture.parentSession.seq),
    })
    const response = await fixture.service.returnResult({ ...request(fixture, conclusion(inherited)), branchSessionId: inherited.id,
      evidence: { kind: 'observation', observation: control } })
    expect(response.parentSessionId).toBe(fixture.parentSession.id)
    expect(JSON.stringify(fixture.parentSession.snapshotEvents().at(-1))).toContain('Saved before the fork')
  })

  it('rejects the wrong parent, inherited conclusions and missing child Sessions before activation', async () => {
    const fixture = await setup()
    savePair(fixture)
    const selected = request(fixture, conclusion(fixture.childSession))
    await expect(fixture.service.returnResult({ ...selected, sessionId: SessionId('other-parent') }))
      .rejects.toMatchObject({ code: 'session/branch-result-unavailable', details: { reason: 'wrong-parent' } })
    await expect(fixture.service.returnResult({ ...selected, resultSeq: 0 }))
      .rejects.toMatchObject({ code: 'session/branch-result-unavailable', details: { reason: 'inherited-result' } })
    await expect(fixture.service.returnResult({ ...selected, branchSessionId: SessionId('missing') }))
      .rejects.toMatchObject({ code: 'session/not-found' })
    expect(fixture.resolveAgent).not.toHaveBeenCalled()
  })

  it('bounds the complete parent message before append with a typed terminal error', async () => {
    const fixture = await setup({ maxActionBytes: 1 })
    savePair(fixture)
    let failure: unknown
    try { await fixture.service.returnResult(request(fixture, conclusion(fixture.childSession))) } catch (error) { failure = error }
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'artifact-branch/result-too-large', details: { limit: 1 } })
    expect(fixture.parentSession.snapshotEvents()).toHaveLength(1)
  })

  it('withdraws the optional Host capability when its plugin is disposed', async () => {
    const fixture = await setup()
    expect(fixture.ctx.get('artifactBranchResults')).toBeDefined()
    await fixture.fiber.dispose()
    expect(fixture.ctx.get('artifactBranchResults')).toBeUndefined()
    expect(fixture.ctx.get('artifacts')).toBeDefined()
  })
})
