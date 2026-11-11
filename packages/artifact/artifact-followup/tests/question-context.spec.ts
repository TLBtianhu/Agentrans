import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@agentrans/cordis'
import AgentRegistry, { type Agent } from '@agentrans/agent'
import type { SessionController } from '@agentrans/api-session-controller'
import ArtifactService from '@agentrans/artifact'
import ArtifactRuntime from '@agentrans/artifact-runtime'
import type { ArtifactRuntimeId } from '@agentrans/artifact-runtime/types'
import { ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES, ARTIFACT_RUNTIME_FAILURE_MAX_BYTES } from '@agentrans/artifact/runtime-values'
import type { ArtifactId, ArtifactObservationId, SavedParticleObservationRef } from '@agentrans/artifact/types'
import type { ParticleSystemSpec } from '@agentrans/artifact/scene'
import type { TextBlock } from '@agentrans/llm'
import SessionStore, { SessionId, SessionLogOffset, type Session } from '@agentrans/session'
import SessionProjectionRegistry from '@agentrans/session-projection'
import { remoteErrorOf } from '@agentrans/typert-protocol'
import type { JsonValue } from '@agentrans/util-values'
import * as plugin from '../src/index.ts'
import type { ArtifactProgramQuestionCapture, ArtifactPromptContextRejectionReason, ArtifactPromptContextSelection, ArtifactQuestionContext } from '../src/types.ts'

const contexts: Context[] = []
let sequence = 0
const id = 'experiment' as ArtifactId
const savedId = 'saved-a' as ArtifactObservationId
const checkpoint = { runtimeVersion: 1 as const, stepCount: 6 }
const source: ParticleSystemSpec = {
  kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 1, vx: 3, vy: 8, mass: 1 }],
  gravity: { x: 0, y: -9.8 }, timeStep: 1 / 30, trails: true,
}
type Resolver = Parameters<SessionController['registerPromptContext']>[1]

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

function makeAgent(ctx: Context, session: Session): Agent {
  const agent = {
    id: session.id, session, ctx,
    steer: (..._args: Parameters<Agent['steer']>): void => { throw new Error('Context resolution must not steer') },
    inject: (..._args: Parameters<Agent['inject']>): void => { throw new Error('Context resolution must not inject') },
  } as Agent
  ctx.agents.enter(agent, undefined)
  return agent
}

async function setup(config: plugin.Config = {}, explicitSessionId?: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ArtifactService)
  const providers = new Map<string, Resolver>()
  const registration: Pick<SessionController, 'registerPromptContext'> = {
    registerPromptContext: (kind, resolve) => {
      if (providers.has(kind)) throw new Error('Duplicate prompt context kind')
      providers.set(kind, resolve)
      return () => { providers.delete(kind) }
    },
  }
  ctx.provide('sessionController', registration)
  const fiber = ctx.plugin(plugin, config)
  await fiber
  const session = ctx.sessions.create(SessionId(explicitSessionId ?? `question-${String(++sequence).padStart(6, '0')}`))
  const agent = makeAgent(ctx, session)
  const resolve = (value: JsonValue, target = agent): readonly TextBlock[] => {
    const provider = providers.get('artifact')
    if (provider === undefined) throw new Error('No Artifact prompt context provider')
    return provider(target, value)
  }
  const select = (value: ArtifactPromptContextSelection, target = agent) => {
    const input: JsonValue = value
    return resolve(input, target)
  }
  return { ctx, session, agent, providers, fiber, resolve, select }
}

function create(ctx: Context, agent: Agent, artifactId = id, spec = source, role?: 'control' | 'variant', title = 'Experiment') {
  ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
    action: 'create', artifactId, format: 'scene', title, presentation: 'inline', spec,
    ...(role === undefined ? {} : { comparison: { group: 'gravity', role } }),
  }))
}

function update(ctx: Context, agent: Agent, artifactId = id, x = 100) {
  ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
    action: 'update', artifactId, baseRevision: 1, format: 'scene', title: 'Changed B', presentation: 'inline',
    spec: { ...source, particles: [{ ...source.particles[0]!, x }] },
  }))
}

function parsed(blocks: readonly TextBlock[]): ArtifactQuestionContext {
  expect(blocks).toHaveLength(1)
  const text = blocks[0]!.text
  const prefix = 'The user selected the following experiment context for this question. '
    + 'Particle values are recomputed by the Host from the recorded source and checkpoint; no causal conclusion is inferred.\n'
  expect(text.startsWith(prefix)).toBe(true)
  return JSON.parse(text.slice(prefix.length)) as ArtifactQuestionContext
}

function rejects(action: () => void, reason: ArtifactPromptContextRejectionReason): void {
  try { action() } catch (error) {
    expect(remoteErrorOf(error)).toMatchObject({ code: 'artifact-followup/context-rejected', details: { reason } })
    return
  }
  throw new Error(`Expected context rejection: ${reason}`)
}

function createHtml(ctx: Context, agent: Agent, html = '<p>Reported program</p>', title = 'HTML program') {
  ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, { action: 'create', artifactId: id, title, source: html, presentation: 'inline' }))
}

function programSelection(agent: Agent, capture: ArtifactProgramQuestionCapture): Extract<ArtifactPromptContextSelection, { kind: 'html-runtime' }> {
  return { kind: 'html-runtime', capturedSessionId: agent.session.id, artifactId: id, revision: 1,
    runtimeId: 'html-run-a' as ArtifactRuntimeId, capture }
}

function parsedProgram(blocks: readonly TextBlock[]): ArtifactQuestionContext {
  expect(blocks).toHaveLength(1)
  const prefix = 'The user selected the following program-reported context for this question. '
    + 'The Host checked the source identity and revision; the runtime identity, status, state and error are Client/program reports, '
    + 'not independently verified or recomputed. This does not establish replayability or a causal conclusion.\n'
  expect(blocks[0]!.text.startsWith(prefix)).toBe(true)
  return JSON.parse(blocks[0]!.text.slice(prefix.length)) as ArtifactQuestionContext
}

describe('program-reported ordinary-question context', () => {
  it.each(['program-state-message.json', 'program-error-message.json'])(
    'matches the canonical ordinary-message reader/SDK fixture %s', async (file) => {
      const fixture = JSON.parse(await readFile(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')) as {
        content: readonly TextBlock[]
      }
      const expected = parsedProgram(fixture.content.slice(1))
      if (expected.facts.kind !== 'html-runtime') throw new Error('Expected a program-reported fixture')
      const { artifact, runtimeId, capture } = expected.facts
      const { ctx, agent, select } = await setup({}, expected.sessionId)
      ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
        action: 'create', artifactId: artifact.artifactId, title: artifact.title, source: artifact.source,
        presentation: artifact.presentation, ...artifact.comparison === undefined ? {} : { comparison: artifact.comparison },
      }))
      const blocks = select({ kind: 'html-runtime', capturedSessionId: agent.session.id, artifactId: artifact.artifactId,
        revision: artifact.revision, runtimeId, capture })
      expect(parsedProgram(blocks)).toEqual(expected)
    },
  )

  it.each([false, 0, '', null] as const)('keeps a legitimate ready state exactly, including %j', async (state) => {
    const { ctx, session, agent, select } = await setup()
    createHtml(ctx, agent)
    const before = session.snapshotEvents()
    expect(parsedProgram(select(programSelection(agent, { status: 'ready', state })))).toMatchObject({
      kind: 'artifact-question-context', sessionId: session.id, facts: { kind: 'html-runtime', artifact: {
        artifactId: id, revision: 1, format: 'html', source: '<p>Reported program</p>',
      }, runtimeId: 'html-run-a', attribution: 'program-reported', capture: { status: 'ready', state } },
    })
    expect(session.snapshotEvents()).toEqual(before)
  })

  it('keeps a captured diagnostic with no state or live registration, even after runtime service teardown', async () => {
    const { ctx, agent, session, select } = await setup()
    createHtml(ctx, agent, '<script>throw new Error("Broken A")</script>')
    const runtimeFiber = ctx.plugin(ArtifactRuntime)
    await runtimeFiber
    const selection = programSelection(agent, { status: 'error', error: { code: 'SCRIPT_ERROR', message: 'Broken A' } })
    await runtimeFiber.dispose()
    expect(ctx.get('artifactRuntime')).toBeUndefined()
    const before = session.snapshotEvents()
    const result = parsedProgram(select(selection))
    expect(result.facts).toMatchObject({ kind: 'html-runtime', attribution: 'program-reported', capture: {
      status: 'error', error: { code: 'SCRIPT_ERROR', message: 'Broken A' },
    } })
    if (result.facts.kind !== 'html-runtime') throw new Error('Expected HTML program report')
    expect(result.facts.capture).not.toHaveProperty('state')
    expect(session.snapshotEvents()).toEqual(before)
  })

  it('uses only the frozen submitted capture and Host source without mutating either or reading history', async () => {
    const { ctx, agent, session, select } = await setup()
    const html = '<p id="experiment">Source A</p>'
    createHtml(ctx, agent, html)
    const selection = programSelection(agent, { status: 'ready', state: { nested: { value: 6 }, selected: ['a'] } })
    const original = structuredClone(selection)
    const before = session.snapshotEvents()
    const logRead = vi.spyOn(session, 'snapshotEvents').mockImplementation(() => { throw new Error('Unexpected full history read') })
    const blocks = select(selection)
    expect(selection).toEqual(original)
    const capture = selection.capture
    if (capture.status !== 'ready' || capture.state === null || typeof capture.state !== 'object' || Array.isArray(capture.state)) {
      throw new Error('Expected object state')
    }
    capture.state.nested = { value: 7 }
    expect(parsedProgram(blocks).facts).toMatchObject({ artifact: { source: html }, capture: {
      status: 'ready', state: { nested: { value: 6 }, selected: ['a'] },
    } })
    expect(logRead).not.toHaveBeenCalled()
    logRead.mockRestore()
    expect(session.snapshotEvents()).toEqual(before)
  })

  it('rejects stale, missing and non-HTML sources without substituting source or report values', async () => {
    const { ctx, agent, select } = await setup()
    createHtml(ctx, agent, '<p>Original A</p>')
    const selection = programSelection(agent, { status: 'ready', state: { value: 'A' } })
    ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
      action: 'update', artifactId: id, baseRevision: 1, title: 'Revised B', source: '<p>Different B</p>', presentation: 'inline',
    }))
    rejects(() => select(selection), 'STALE_REVISION')
    rejects(() => select({ ...selection, artifactId: 'missing' as ArtifactId }), 'SOURCE_NOT_FOUND')
    ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
      action: 'update', artifactId: id, baseRevision: 2, format: 'scene', title: 'Native C', spec: source, presentation: 'inline',
    }))
    rejects(() => select({ ...selection, revision: 3 }), 'UNSUPPORTED_SOURCE')
  })

  it('requires the captured Session while allowing that Session\'s inherited source cut', async () => {
    const { ctx, agent, session, select } = await setup()
    createHtml(ctx, agent, '<p>Inherited A</p>')
    const parentSelection = programSelection(agent, { status: 'ready', state: { value: 'A' } })
    const prefix = session.snapshotEvents()
    const child = makeAgent(ctx, ctx.sessions.create(SessionId('html-question-child'), { seed: prefix,
      meta: { isSeeded: true, parentSession: session.id }, inheritedEventCount: SessionLogOffset(prefix.length) }))
    rejects(() => select(parentSelection, child), 'SESSION_MISMATCH')
    ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
      action: 'update', artifactId: id, baseRevision: 1, title: 'Parent B', source: '<p>Parent B</p>', presentation: 'inline',
    }))
    expect(parsedProgram(select({ ...parentSelection, capturedSessionId: child.session.id }, child)).facts)
      .toMatchObject({ artifact: { revision: 1, source: '<p>Inherited A</p>' }, capture: { state: { value: 'A' } } })
    const sibling = makeAgent(ctx, ctx.sessions.create(SessionId('html-question-sibling')))
    createHtml(ctx, sibling, '<p>Sibling with the same id and revision</p>')
    rejects(() => select(parentSelection, sibling), 'SESSION_MISMATCH')
  })

  const invalidCaptures: JsonValue[] = [
    { status: 'starting' }, { status: 'ready' }, { status: 'ready', capabilities: { state: true }, state: {} },
    { status: 'error', error: { code: 'SCRIPT_ERROR', message: 'A' }, state: { old: true } },
    { status: 'error', error: { code: 'invalid code', message: 'A' } },
    { status: 'error', error: { code: 'SCRIPT_ERROR' } },
  ]
  it.each(invalidCaptures)('rejects malformed or ambiguous captured report %#', async (capture) => {
    const { ctx, agent, session, resolve } = await setup()
    createHtml(ctx, agent)
    const before = session.snapshotEvents()
    rejects(() => resolve({ ...programSelection(agent, { status: 'ready', state: null }), capture }), 'INVALID_SELECTION')
    expect(session.snapshotEvents()).toEqual(before)
  })

  it('rejects non-lossless JSON and excessive depth or nodes before serializing the selected state', async () => {
    const { ctx, agent, select } = await setup()
    createHtml(ctx, agent)
    const sparse = new Array<JsonValue>(1)
    let accessorReads = 0
    const accessor = { get value() { accessorReads += 1; return 'do not read' } }
    let deep: JsonValue = null
    for (let depth = 0; depth < ARTIFACT_JSON_MAX_DEPTH; depth++) deep = { next: deep }
    for (const state of [-0, NaN, Infinity, sparse, accessor, deep, Array<JsonValue>(ARTIFACT_JSON_MAX_NODES).fill(null)]) {
      rejects(() => select(programSelection(agent, { status: 'ready', state })), 'INVALID_SELECTION')
    }
    expect(accessorReads).toBe(0)
  })

  it('uses the complete encoded diagnostic byte limit rather than truncating its message', async () => {
    const { ctx, agent, select } = await setup()
    createHtml(ctx, agent)
    const code = 'SCRIPT_ERROR'
    const overhead = Buffer.byteLength(JSON.stringify({ code, message: '' }), 'utf8')
    const message = 'x'.repeat(ARTIFACT_RUNTIME_FAILURE_MAX_BYTES - overhead)
    expect(parsedProgram(select(programSelection(agent, { status: 'error', error: { code, message } }))).facts)
      .toMatchObject({ capture: { error: { code, message } } })
    rejects(() => select(programSelection(agent, { status: 'error', error: { code, message: `${message}x` } })), 'INVALID_SELECTION')
  })

  it('budgets the complete program context, including original source and attribution, at the exact UTF-8 boundary', async () => {
    const { ctx, agent, select, resolve, fiber } = await setup()
    createHtml(ctx, agent, '<p>原始源码 😀</p>', '程序实验 😀')
    const selection = programSelection(agent, { status: 'ready', state: { caption: '实验状态 😀', count: 6 } })
    const original = structuredClone(selection)
    const blocks = select(selection)
    const bytes = Buffer.byteLength(JSON.stringify(blocks), 'utf8')
    expect(bytes).toBeGreaterThan(JSON.stringify(blocks).length)
    await fiber.dispose()
    const exact = ctx.plugin(plugin, { maxContextBytes: bytes })
    await exact
    expect(resolve(selection)).toEqual(blocks)
    await exact.dispose()
    await ctx.plugin(plugin, { maxContextBytes: bytes - 1 })
    rejects(() => resolve(selection), 'CONTEXT_TOO_LARGE')
    expect(selection).toEqual(original)
  })
})

describe('ordinary-question Artifact context', () => {
  it('recomputes current particle facts without saving or admitting a separate input', async () => {
    const { ctx, session, agent, select } = await setup()
    create(ctx, agent)
    const before = session.snapshotEvents()
    const blocks = select({ kind: 'current-particle', artifactId: id, revision: 1, checkpoint })
    const result = parsed(blocks)
    expect(result).toMatchObject({ kind: 'artifact-question-context', sessionId: session.id,
      facts: { kind: 'current-particle', artifact: { artifactId: id, revision: 1, spec: source }, checkpoint,
        values: { time: 0.2, particles: [{ id: 'p', vy: 6.04 }] } } })
    if (result.facts.kind !== 'current-particle') throw new Error('Expected current particle facts')
    expect(result.facts.values.particles[0]?.x).toBeCloseTo(0.6, 12)
    update(ctx, agent)
    expect(parsed(blocks).facts).toMatchObject({ artifact: { revision: 1, spec: source } })
    expect(session.snapshotEvents()).toHaveLength(before.length + 1)
    expect(session.snapshotEvents().some(event => event.type === 'user/message' || event.type === 'agent/inbox/spliced')).toBe(false)
  })

  it('matches the self-contained SDK and released-reader fixture', async () => {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/question-message.json', import.meta.url), 'utf8')) as {
      content: readonly TextBlock[]
    }
    const expected = parsed(fixture.content.slice(1))
    if (expected.facts.kind !== 'current-particle') {
      throw new Error('Expected a current particle fixture')
    }
    const artifact = expected.facts.artifact
    if (artifact.spec.kind !== 'particle-system') throw new Error('Expected a particle source')
    const { ctx, agent, select } = await setup({}, expected.sessionId)
    create(ctx, agent, artifact.artifactId, artifact.spec, undefined, artifact.title)
    const actual = select({ kind: 'current-particle', artifactId: artifact.artifactId, revision: 1,
      checkpoint: expected.facts.checkpoint })
    expect(parsed(actual)).toEqual(expected)
  })

  it('refuses a source revision changed before Host admission instead of substituting it', async () => {
    const { ctx, agent, select } = await setup()
    create(ctx, agent)
    update(ctx, agent)
    rejects(() => select({ kind: 'current-particle', artifactId: id, revision: 1, checkpoint }), 'STALE_REVISION')
  })

  it('resolves an old saved observation after its current source changes to HTML', async () => {
    const { ctx, agent, select } = await setup()
    create(ctx, agent)
    ctx.artifacts.saveObservation(agent, id, 1, savedId, 'Saved A', checkpoint)
    ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
      action: 'update', artifactId: id, baseRevision: 1, title: 'New HTML', presentation: 'inline', source: '<p>B</p>',
    }))
    const result = parsed(select({ kind: 'observation', ref: { artifactId: id, observationId: savedId } }))
    expect(result.facts)
      .toMatchObject({ kind: 'observation', observation: { label: 'Saved A', artifact: { revision: 1, spec: source }, checkpoint,
        values: { particles: [{ id: 'p' }] } } })
    if (result.facts.kind !== 'observation') throw new Error('Expected saved particle facts')
    expect(result.facts.observation.values.particles[0]?.x).toBeCloseTo(0.6, 12)
  })

  it('keeps compatible saved comparison conditions after current sources advance', async () => {
    const { ctx, agent, select } = await setup()
    const control: SavedParticleObservationRef = { artifactId: 'control' as ArtifactId, observationId: savedId }
    const variant: SavedParticleObservationRef = { artifactId: 'variant' as ArtifactId, observationId: savedId }
    create(ctx, agent, control.artifactId, source, 'control')
    create(ctx, agent, variant.artifactId, { ...source, gravity: { x: 0, y: -4 } }, 'variant')
    for (const ref of [control, variant]) {
      ctx.artifacts.saveObservation(agent, ref.artifactId, 1, ref.observationId, ref.artifactId, checkpoint)
    }
    update(ctx, agent, control.artifactId)
    update(ctx, agent, variant.artifactId)
    const selection = { kind: 'comparison' as const, group: 'gravity', control, variant }
    expect(parsed(select(selection)).facts).toMatchObject({ kind: 'comparison', group: 'gravity',
      conditions: { runtimeVersion: 1, stepCount: 6, timeStep: 1 / 30, time: 0.2 },
      control: { artifact: { revision: 1 }, values: { particles: [{ vy: 6.04 }] } },
      variant: { artifact: { revision: 1 }, values: { particles: [{ vy: 7.2 }] } } })
    rejects(() => select({ ...selection, group: 'other' }), 'GROUP_MISMATCH')
    rejects(() => select({ ...selection, variant: control }), 'ROLE_MISMATCH')
  })

  it('refuses a comparison with unequal saved step counts', async () => {
    const { ctx, agent, select } = await setup()
    const control = { artifactId: 'control' as ArtifactId, observationId: savedId }
    const variant = { artifactId: 'variant' as ArtifactId, observationId: savedId }
    create(ctx, agent, control.artifactId, source, 'control')
    create(ctx, agent, variant.artifactId, source, 'variant')
    ctx.artifacts.saveObservation(agent, control.artifactId, 1, savedId, 'A', checkpoint)
    ctx.artifacts.saveObservation(agent, variant.artifactId, 1, savedId, 'B', { ...checkpoint, stepCount: 7 })
    rejects(() => select({ kind: 'comparison', group: 'gravity', control, variant }), 'STEP_COUNT_MISMATCH')
  })

  it('uses only the addressed Session, including its inherited saved baseline', async () => {
    const { ctx, agent, session, select } = await setup()
    create(ctx, agent)
    ctx.artifacts.saveObservation(agent, id, 1, savedId, 'Inherited A', checkpoint)
    const prefix = session.snapshotEvents()
    const childSession = ctx.sessions.create(SessionId('question-child'), { seed: prefix,
      meta: { isSeeded: true, parentSession: session.id }, inheritedEventCount: SessionLogOffset(prefix.length) })
    const child = makeAgent(ctx, childSession)
    const laterId = 'parent-later' as ArtifactObservationId
    ctx.artifacts.saveObservation(agent, id, 1, laterId, 'Parent later', checkpoint)
    expect(parsed(select({ kind: 'observation', ref: { artifactId: id, observationId: savedId } }, child)).facts)
      .toMatchObject({ observation: { label: 'Inherited A' } })
    rejects(() => select({ kind: 'observation', ref: { artifactId: id, observationId: laterId } }, child), 'SOURCE_NOT_FOUND')
    const other = makeAgent(ctx, ctx.sessions.create(SessionId('question-other')))
    create(ctx, other, id, { ...source, particles: [{ ...source.particles[0]!, x: 100 }] })
    rejects(() => select({ kind: 'observation', ref: { artifactId: id, observationId: savedId } }, other), 'SOURCE_NOT_FOUND')
    expect(parsed(select({ kind: 'current-particle', artifactId: id, revision: 1, checkpoint }, other)).facts)
      .toMatchObject({ values: { particles: [{ x: 100.6 }] } })
  })

  const malformedSelections: readonly JsonValue[] = [
    null, { kind: 'observation', ref: { artifactId: 'experiment', observationId: 'missing' }, values: { x: 100 } },
    { kind: 'current-particle', artifactId: 'experiment', revision: 1, checkpoint: { runtimeVersion: 2, stepCount: 6 } },
    { kind: 'current-particle', artifactId: 'experiment', revision: 1, checkpoint: { runtimeVersion: 1, stepCount: -1 } },
  ]
  it.each(malformedSelections)('refuses malformed wire selection %# before touching the Session', async (value) => {
    const { ctx, agent, session, resolve } = await setup()
    create(ctx, agent)
    const before = session.snapshotEvents()
    rejects(() => resolve(value), 'INVALID_SELECTION')
    expect(session.snapshotEvents()).toEqual(before)
  })

  it('rejects unsupported current Scene formats and non-finite checkpoint results', async () => {
    const { ctx, agent, select } = await setup()
    ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
      action: 'create', artifactId: id, title: 'HTML', presentation: 'inline', source: '<p>A</p>',
    }))
    rejects(() => select({ kind: 'current-particle', artifactId: id, revision: 1, checkpoint }), 'UNSUPPORTED_SOURCE')
    const otherId = 'overflow' as ArtifactId
    create(ctx, agent, otherId, { ...source, particles: [{ ...source.particles[0]!, vx: Number.MAX_VALUE }], timeStep: 1 })
    rejects(() => select({ kind: 'current-particle', artifactId: otherId, revision: 1, checkpoint }), 'INVALID_CHECKPOINT')
  })

  it('budgets the complete serialized blocks in UTF-8 at the exact boundary', async () => {
    const { ctx, agent, select, resolve, fiber } = await setup()
    create(ctx, agent, id, source, undefined, '实验 😀')
    const selection = { kind: 'current-particle' as const, artifactId: id, revision: 1, checkpoint }
    const blocks = select(selection)
    const bytes = Buffer.byteLength(JSON.stringify(blocks), 'utf8')
    expect(bytes).toBeGreaterThan(JSON.stringify(blocks).length)
    await fiber.dispose()
    const exactFiber = ctx.plugin(plugin, { maxContextBytes: bytes })
    await exactFiber
    expect(resolve(selection)).toEqual(blocks)
    await exactFiber.dispose()
    await ctx.plugin(plugin, { maxContextBytes: bytes - 1 })
    rejects(() => resolve(selection), 'CONTEXT_TOO_LARGE')
  })

  it('withdraws its registry contribution on disposal and permits a fresh registration', async () => {
    const { ctx, providers, fiber } = await setup()
    expect([...providers.keys()]).toEqual(['artifact'])
    await fiber.dispose()
    expect([...providers.keys()]).toEqual([])
    await ctx.plugin(plugin)
    expect([...providers.keys()]).toEqual(['artifact'])
  })
})
