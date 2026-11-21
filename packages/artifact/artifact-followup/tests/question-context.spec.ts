import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@agentrans/cordis'
import AgentRegistry, { type Agent } from '@agentrans/agent'
import type { SessionController } from '@agentrans/api-session-controller'
import type { SessionRequestId } from '@agentrans/api-session-controller/types'
import ArtifactService from '@agentrans/artifact'
import ArtifactRuntime from '@agentrans/artifact-runtime'
import type { ArtifactRuntimeId } from '@agentrans/artifact-runtime/types'
import {
  ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES, ARTIFACT_RUNTIME_FAILURE_MAX_BYTES, CONTINUED_CSV_QUESTION_PREFIX,
  CSV_COMPARISON_CHANGES_PREFIX, CSV_COMPARISON_QUESTION_PREFIX, IMPORTED_CSV_EXPLANATION_SOURCE_TEXT, IMPORTED_CSV_RETURN_SOURCE_TEXT,
  IMPORTED_CSV_SINGLE_SOURCE_TEXT, csvComparisonChanges, csvComparisonChangesText,
  type ArtifactHalfAdderCheckpoint, type ArtifactHtmlCheckpointKind,
} from '@agentrans/artifact/runtime-values'
import type { ArtifactId, ArtifactObservationId, HtmlArtifactSnapshot, SavedParticleObservationRef } from '@agentrans/artifact/types'
import type { CsvBarChartSpec, FunctionPlotSpec, ParticleSystemSpec, SceneSpec } from '@agentrans/artifact/scene'
import { createUserMessage, MessageId, type TextBlock } from '@agentrans/llm'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq, type Session } from '@agentrans/session'
import SessionProjectionRegistry from '@agentrans/session-projection'
import Storage from '@agentrans/storage'
import * as StorageDomain from '@agentrans/storage-domain'
import * as StorageJson from '@agentrans/storage-json'
import { remoteErrorOf } from '@agentrans/typert-protocol'
import type { JsonValue } from '@agentrans/util-values'
import * as plugin from '../src/index.ts'
import type {
  ArtifactCsvComparisonQuestionFacts, ArtifactProgramQuestionCapture,
  ArtifactPromptContextRejectionReason, ArtifactPromptContextSelection, ArtifactQuestionContext,
} from '../src/types.ts'

const contexts: Context[] = []
const roots: string[] = []
let sequence = 0
const id = 'experiment' as ArtifactId
const savedId = 'saved-a' as ArtifactObservationId
const checkpoint = { runtimeVersion: 1 as const, stepCount: 6 }
const source: ParticleSystemSpec = {
  kind: 'particle-system', particles: [{ id: 'p', x: 0, y: 1, vx: 3, vy: 8, mass: 1 }],
  gravity: { x: 0, y: -9.8 }, timeStep: 1 / 30, trails: true,
}
const plot: FunctionPlotSpec = {
  kind: 'function-plot',
  functions: [{ id: 'linear', label: 'Line', expression: 'a*x' }, { id: 'root', label: 'Square root', expression: 'sqrt(x)' }],
  parameters: { a: { value: 1, min: 0, max: 2, step: 0.25 } },
  viewport: { x: [-2, 2], y: [-2, 2] }, trace: { x: 0, derivative: true, integral: true },
}
const plotSelection: Extract<ArtifactPromptContextSelection, { kind: 'current-function-plot' }> = {
  kind: 'current-function-plot', artifactId: id, revision: 1, functionId: 'linear', x: 3, parameters: { a: 1.25 },
}
type Resolver = Parameters<SessionController['registerPromptContext']>[1]

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
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

async function setup(config: plugin.Config = {}, explicitSessionId?: string, storageRoot?: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ArtifactService)
  if (storageRoot !== undefined) {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: storageRoot })
    await ctx.plugin(StorageDomain, { backend: 'json' })
  }
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
  const resolve = (value: JsonValue, target = agent, requestId = 'context-test' as SessionRequestId): readonly TextBlock[] => {
    const provider = providers.get('artifact')
    if (provider === undefined) throw new Error('No Artifact prompt context provider')
    return provider(target, value, requestId)
  }
  const select = (value: ArtifactPromptContextSelection, target = agent) => {
    if (value.kind === 'csv-question-comparison') {
      const { facts } = value
      if (facts.explanation !== undefined || facts.returnCards !== undefined) {
        throw new Error('Expected a single page for the stateless test selection')
      }
      const comparison = { ...facts.comparison, rows: [...facts.comparison.rows] }
      return resolve({ ...value, facts: { ...facts, comparison } }, target)
    }
    return resolve(value, target)
  }
  return { ctx, session, agent, providers, fiber, resolve, select }
}

function create(ctx: Context, agent: Agent, artifactId = id, spec: SceneSpec = source, role?: 'control' | 'variant', title = 'Experiment') {
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

it('admits the sealed CSV comparison page and its derived changes without persisting the proof', async () => {
  const { ctx, session, select, fiber } = await setup()
  const comparison: ArtifactCsvComparisonQuestionFacts['comparison'] = {
    original: { groupKey: 'Warm', aggregate: 'mean', value: 30, count: 2, valueColumn: 'LatencyMs' },
    current: { groupKey: 'Warm', aggregate: 'sum', value: 35, count: 1, valueColumn: 'LatencyMs', filter: { column: 'Batch', value: 'B' } },
    rows: [{ record: 2, status: 'excluded', currentFilterValue: 'A', value: '25' }],
    kept: 1, excluded: 1, added: 0, total: 2, offset: 0, nextOffset: 1,
  }
  const facts: ArtifactCsvComparisonQuestionFacts = {
    kind: 'csv-question-comparison', sessionId: session.id, question: { eventSeq: 3, messageId: MessageId('sent-question') },
    source: { eventSeq: 1, messageId: MessageId('branch-notice'), artifactId: id, revision: 1 }, comparison,
  }
  const attachment = plugin.sealCsvComparisonQuestion(ctx, facts)
  if (attachment === undefined) throw new Error('Expected the reviewed page to fit')
  const selection = { kind: 'csv-question-comparison', ...attachment } as const
  const transported = JSON.parse(JSON.stringify(selection, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(Object.entries(value).reverse())
  })) as typeof selection
  const [block, changes] = select(transported)
  expect(block?.text.startsWith(CSV_COMPARISON_QUESTION_PREFIX)).toBe(true)
  expect(block?.text).not.toContain(attachment.proof)
  expect(JSON.parse(block!.text.slice(CSV_COMPARISON_QUESTION_PREFIX.length))).toEqual({
    kind: 'artifact-question-context', sessionId: session.id, facts,
  })
  expect(changes?.text).toContain('Use increase or decrease only when comparing the same aggregation.')
  expect(changes?.text.startsWith(CSV_COMPARISON_CHANGES_PREFIX)).toBe(true)
  expect(JSON.parse(changes!.text.slice(CSV_COMPARISON_CHANGES_PREFIX.length))).toEqual({
    aggregation: { original: 'mean', current: 'sum', changed: true },
    filterChanged: true,
    membership: { changed: true, kept: 1, excluded: 1, added: 0, reviewedRows: [{ record: 2, status: 'excluded' }] },
  })
  const blocks = select(selection)
  expect(blocks).toEqual([plugin.csvComparisonQuestionBlock(facts), { type: 'text', text: csvComparisonChangesText(comparison) }])
  const augmentedBytes = Buffer.byteLength(JSON.stringify(blocks), 'utf8')
  const canonicalBytes = Buffer.byteLength(JSON.stringify(blocks.slice(0, 1)), 'utf8')
  for (const maxContextBytes of [augmentedBytes, augmentedBytes - 1, canonicalBytes]) {
    const bounded = await setup({ maxContextBytes }, session.id)
    const proof = plugin.sealCsvComparisonQuestion(bounded.ctx, facts)
    if (proof === undefined) throw new Error('The original canonical attachment still fits')
    const boundedBlocks = bounded.select({ kind: 'csv-question-comparison', ...proof })
    expect(boundedBlocks).toEqual(maxContextBytes === augmentedBytes ? blocks : blocks.slice(0, 1))
  }
  const other = makeAgent(ctx, ctx.sessions.create(SessionId('different-comparison-session')))
  rejects(() => select(selection, other), 'SESSION_MISMATCH')
  rejects(() => select({ ...selection, facts: { ...facts, sessionId: other.session.id } }, other), 'INVALID_SELECTION')
  rejects(() => select({ ...selection, facts: { ...facts, question: { ...facts.question, eventSeq: 8 } } }), 'INVALID_SELECTION')
  rejects(() => select({ ...selection, facts: { ...facts, comparison: { ...comparison, kept: 9 } } }), 'INVALID_SELECTION')
  rejects(() => select({ ...selection, facts: { ...facts, comparison: { ...comparison, rows: [] } } }), 'INVALID_SELECTION')
  const restarted = await setup({}, session.id)
  rejects(() => restarted.select(selection), 'INVALID_SELECTION')
  const small = await setup({ maxContextBytes: 200 }, session.id)
  expect(plugin.sealCsvComparisonQuestion(small.ctx, facts)).toBeUndefined()
  await fiber.dispose()
  expect(plugin.sealCsvComparisonQuestion(ctx, facts)).toBeUndefined()
})

it.each(['return cards', 'two-step explanation', 'single page'] as const)('reserves space for the JSON source of imported %s', async (kind) => {
  const sessionId = SessionId('imported-context-budget')
  const original = { groupKey: 'Warm', aggregate: 'mean', value: 30, count: 2, valueColumn: 'LatencyMs' } as const
  const current = { ...original, aggregate: 'sum', value: 60 } as const
  const comparison: ArtifactCsvComparisonQuestionFacts['comparison'] = {
    original, current, kept: 2, excluded: 0, added: 0, total: 2, offset: 0,
    rows: [{ record: 4, status: 'kept', value: '25' }, { record: 5, status: 'kept', value: '35' }],
  }
  const filtered: ArtifactCsvComparisonQuestionFacts['comparison'] = {
    ...comparison, current: { ...current, value: 35, count: 1, filter: { column: 'Batch', value: 'B' } },
    kept: 1, excluded: 1, rows: [
      { record: 4, status: 'excluded', value: '25', currentFilterValue: 'A' },
      { record: 5, status: 'kept', value: '35', currentFilterValue: 'B' },
    ],
  }
  const imported = { kind: 'csv-question-comparison', attribution: 'user-imported', sessionId } as const
  const facts: ArtifactCsvComparisonQuestionFacts = kind === 'return cards' ? {
    ...imported, comparison,
    returnCards: {
      first: { title: '延迟均值', revision: 1, conclusion: ['The mean was 30 ms.'], groupBy: 'Trial',
        groups: [{ key: 'Warm', value: 30, count: 2 }] },
      second: { title: '延迟总和', revision: 2, conclusion: ['The sum was 60 ms.'], groupBy: 'Trial',
        groups: [{ key: 'Warm', value: 60, count: 2 }] },
    },
  } : kind === 'two-step explanation' ? {
    ...imported, comparison: filtered, explanation: { aggregation: { comparison } },
  } : { ...imported, comparison: filtered }
  const source = kind === 'return cards' ? IMPORTED_CSV_RETURN_SOURCE_TEXT
    : kind === 'two-step explanation' ? IMPORTED_CSV_EXPLANATION_SOURCE_TEXT : IMPORTED_CSV_SINGLE_SOURCE_TEXT
  const required = [plugin.csvComparisonQuestionBlock(facts), { type: 'text', text: source }]
  const limit = Buffer.byteLength(JSON.stringify(required), 'utf8')
  const storageRoot = await mkdtemp(join(tmpdir(), 'artifact-imported-context-budget-'))
  roots.push(storageRoot)
  const exact = await setup({ maxContextBytes: limit }, sessionId, storageRoot)
  const attachment = plugin.sealCsvComparisonQuestion(exact.ctx, facts)
  if (attachment === undefined) throw new Error('The comparison and its source fit at the exact byte limit')
  const store = plugin.csvComparisonDrafts(exact.ctx)
  if (store === undefined) throw new Error('Expected the mounted draft storage')
  const draft = await store.save(sessionId, null, attachment, 0)
  const requestId = 'imported-context-budget-request' as SessionRequestId
  await store.bind(sessionId, draft.receiptId, requestId, async () => {})
  expect(exact.resolve({ kind: 'csv-comparison-draft', receiptId: draft.receiptId }, exact.agent, requestId)).toEqual(required)
  const tooSmall = await setup({ maxContextBytes: limit - 1 }, sessionId)
  expect(plugin.sealCsvComparisonQuestion(tooSmall.ctx, facts)).toBeUndefined()
})

it('skips a stored imported draft that fails the current facts schema instead of refusing to open', async () => {
  const sessionId = SessionId('retired-imported-draft')
  const storageRoot = await mkdtemp(join(tmpdir(), 'artifact-retired-draft-'))
  roots.push(storageRoot)
  const initial = await setup({}, sessionId, storageRoot)
  const facts: ArtifactCsvComparisonQuestionFacts = {
    kind: 'csv-question-comparison', attribution: 'user-imported', sessionId,
    comparison: { original: { groupKey: 'Warm', aggregate: 'mean', value: 30, count: 2, valueColumn: 'LatencyMs' },
      current: { groupKey: 'Warm', aggregate: 'sum', value: 60, count: 2, valueColumn: 'LatencyMs' },
      rows: [{ record: 4, status: 'kept', value: '25' }, { record: 5, status: 'kept', value: '35' }],
      kept: 2, excluded: 0, added: 0, total: 2, offset: 0 },
  }
  const attachment = plugin.sealCsvComparisonQuestion(initial.ctx, facts)
  if (attachment === undefined) throw new Error('Expected a sealed comparison')
  await plugin.csvComparisonDrafts(initial.ctx)?.save(sessionId, null, attachment, 0)
  await initial.ctx.fiber.dispose()
  const stored = await recordFilesContaining(storageRoot, '"attribution": "user-imported"')
  expect(stored).toHaveLength(1)
  // The build before the rename wrote the attribution under this field name.
  const retiredField = 'prove' + 'nance'
  await writeFile(stored[0]!, (await readFile(stored[0]!, 'utf8')).replace('"attribution": "user-imported"', `"${retiredField}": "user-imported"`))

  const restarted = await setup({}, sessionId, storageRoot)
  const reopened = plugin.csvComparisonDrafts(restarted.ctx)
  if (reopened === undefined) throw new Error('Expected the reopened draft storage')
  expect(reopened.read(sessionId)).toBeNull()
})

async function recordFilesContaining(root: string, text: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
  const matches = await Promise.all(files.map(async file => (await readFile(file, 'utf8')).includes(text) ? [file] : []))
  return matches.flat()
}

it('separates different aggregations and filter recipes from unchanged record membership', () => {
  const filter = { column: 'Batch', value: 'B' }
  const page: ArtifactCsvComparisonQuestionFacts['comparison'] = {
    original: { groupKey: 'Warm', aggregate: 'mean', value: 30, count: 2, valueColumn: 'LatencyMs', filter },
    current: { groupKey: 'Warm', aggregate: 'sum', value: 60, count: 2, valueColumn: 'LatencyMs', filter: { ...filter } },
    kept: 2, excluded: 0, added: 0, total: 2, offset: 0,
    rows: [
      { record: 4, status: 'kept', value: '25', originalFilterValue: 'B', currentFilterValue: 'B' },
      { record: 5, status: 'kept', value: '35', originalFilterValue: 'B', currentFilterValue: 'B' },
    ],
  }
  const unchanged = csvComparisonChanges(page)
  expect(unchanged).toEqual({
    aggregation: { original: 'mean', current: 'sum', changed: true },
    filterChanged: false,
    membership: { changed: false, kept: 2, excluded: 0, added: 0, reviewedRows: [{ record: 4, status: 'kept' }, { record: 5, status: 'kept' }] },
  })
  expect(csvComparisonChanges({ ...page, current: { ...page.current, filter: { column: 'Trial', value: 'B' } } }))
    .toEqual({ ...unchanged, filterChanged: true })
  expect(csvComparisonChanges({ ...page, current: { ...page.current, filter: { column: 'Batch', value: 'b' } } }))
    .toEqual({ ...unchanged, filterChanged: true })
})

it('reopens the private CSV draft binding across Hosts and admits only its exact request', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'artifact-csv-draft-'))
  roots.push(storageRoot)
  const initial = await setup({}, undefined, storageRoot)
  const facts: ArtifactCsvComparisonQuestionFacts = {
    kind: 'csv-question-comparison', sessionId: initial.session.id, question: { eventSeq: 3, messageId: MessageId('sent-question') },
    source: { eventSeq: 1, messageId: MessageId('branch-notice'), artifactId: id, revision: 1 },
    reusedFrom: { eventSeq: 4, messageId: MessageId('reused-source') },
    comparison: { original: { groupKey: 'Warm', aggregate: 'mean', value: 30, count: 2, valueColumn: 'LatencyMs' },
      current: { groupKey: 'Warm', aggregate: 'sum', value: 35, count: 1, valueColumn: 'LatencyMs', filter: { column: 'Batch', value: 'B' } },
      rows: [{ record: 2, status: 'excluded', currentFilterValue: 'A', value: '25' },
        { record: 3, status: 'kept', currentFilterValue: 'B', value: '35' }],
      kept: 1, excluded: 1, added: 0, total: 2, offset: 0 },
  }
  const attachment = plugin.sealCsvComparisonQuestion(initial.ctx, facts)
  if (attachment === undefined) throw new Error('Expected a sealed comparison')
  const store = plugin.csvComparisonDrafts(initial.ctx)
  if (store === undefined) throw new Error('Expected the mounted draft storage')
  const draft = await store.save(initial.session.id, null, attachment, 4)
  expect(await store.save(initial.session.id, null, attachment, 4)).toEqual(draft)
  const requestId = 'csv-reopened-request' as SessionRequestId
  const input = { kind: 'csv-comparison-draft', receiptId: draft.receiptId } as const
  rejects(() => initial.resolve(input, initial.agent, requestId), 'SOURCE_NOT_FOUND')
  await store.bind(initial.session.id, draft.receiptId, requestId, async () => {})
  await initial.ctx.fiber.dispose()

  const restarted = await setup({}, initial.session.id, storageRoot)
  const reopened = plugin.csvComparisonDrafts(restarted.ctx)
  if (reopened === undefined) throw new Error('Expected the reopened draft storage')
  expect(reopened.read(restarted.session.id)).toEqual(draft)
  rejects(() => restarted.resolve(input), 'SOURCE_NOT_FOUND')
  const [block, changes] = restarted.resolve(input, restarted.agent, requestId)
  expect(block?.text).toContain(CSV_COMPARISON_QUESTION_PREFIX)
  expect(block?.text).not.toContain(draft.receiptId)
  expect(block?.text).not.toContain(attachment.proof)
  expect(JSON.parse(block!.text.slice(CSV_COMPARISON_QUESTION_PREFIX.length))).toEqual({
    kind: 'artifact-question-context', sessionId: restarted.session.id, facts,
  })
  expect(reopened.verifiesHistory(restarted.session.id, requestId, block!.text)).toBe(true)
  expect(changes?.text).toBe(csvComparisonChangesText(facts.comparison))
  expect(reopened.verifiesHistory(restarted.session.id, requestId, changes!.text)).toBe(false)
  expect(reopened.verifiesHistory(restarted.session.id, requestId, block!.text.replace('"value":35', '"value":60'))).toBe(false)
  expect(reopened.verifiesHistory(restarted.session.id, requestId, block!.text.replace('reused-source', 'other-source'))).toBe(false)
  const other = makeAgent(restarted.ctx, restarted.ctx.sessions.create(SessionId('different-csv-draft-session')))
  rejects(() => restarted.resolve(input, other, requestId), 'SOURCE_NOT_FOUND')
  const revised = plugin.sealCsvComparisonQuestion(restarted.ctx, { ...facts, question: { ...facts.question, eventSeq: 6 } })
  if (revised === undefined) throw new Error('Expected a second sealed comparison')
  expect(() => reopened.save(restarted.session.id, draft.receiptId, attachment, 4)).toThrow()
  await expect(reopened.save(restarted.session.id, null, revised, 6)).rejects.toMatchObject({ details: { reason: 'DRAFT_CHANGED' } })
  const replacement = await reopened.save(restarted.session.id, draft.receiptId, revised, 6)
  expect(replacement.receiptId).not.toBe(draft.receiptId)
  await expect(reopened.bind(restarted.session.id, replacement.receiptId, requestId, async () => {}))
    .rejects.toMatchObject({ details: { reason: 'DRAFT_CHANGED' } })
  expect(await reopened.clear(restarted.session.id, draft.receiptId)).toBe(false)
  expect(reopened.read(restarted.session.id)).toEqual(replacement)
  expect(await reopened.clear(restarted.session.id, replacement.receiptId)).toBe(true)
  expect(reopened.read(restarted.session.id)).toBeNull()
  expect(reopened.verifiesHistory(restarted.session.id, requestId, block!.text)).toBe(true)
  expect(restarted.session.snapshotEvents()).toHaveLength(0)
})

it('admits only the group confirmed on a parent-local CSV analysis', async () => {
  const { ctx, agent, select, resolve } = await setup()
  const artifactId = `continued-csv-${'a'.repeat(32)}` as ArtifactId
  const spec: CsvBarChartSpec = { kind: 'csv-bar-chart', attachmentId: `sha256:${'b'.repeat(64)}` as CsvBarChartSpec['attachmentId'],
    groupBy: 'Trial', valueColumn: 'LatencyMs', aggregate: 'sum', rowCount: 4,
    groups: [{ key: 'Warm', value: 60, count: 2 }, { key: 'Cold', value: 100, count: 2 }] }
  const artifact = {
    artifactId, revision: 1, title: 'Latency', format: 'scene', presentation: 'inline', spec,
    csvContinuation: { source: { sessionId: agent.session.id, eventSeq: SessionSeq(0),
      messageId: MessageId('returned'), artifactId: id, revision: 1 }, groupKey: 'Warm' },
  } as const
  expect(() => ctx.artifacts.prepareCsvBarChart(agent, { action: 'create', artifactId, title: 'Latency', spec })).toThrow(/reserved/u)
  ctx.artifacts.commit(agent, artifact)
  const selection = { kind: 'current-csv-bar-chart', artifactId, revision: 1, groupKey: 'Warm' } as const
  const [block] = select(selection)
  expect(block?.text.startsWith(CONTINUED_CSV_QUESTION_PREFIX)).toBe(true)
  expect(block?.text).toContain('"values":{"key":"Warm","value":60,"count":2}')
  expect(block?.text).toContain('"csvContinuation"')
  rejects(() => select({ ...selection, groupKey: 'Cold' }), 'INVALID_SELECTION')
  rejects(() => resolve({ ...selection, values: { key: 'Warm', value: 100, count: 2 } }), 'INVALID_SELECTION')
  expect(() => { ctx.artifacts.commit(agent, { ...artifact, revision: 2 }) }).toThrow(/immutable/u)
})

it('admits CSV chart readings only from the selected durable group and revision', async () => {
  const { ctx, agent, resolve, select, session } = await setup()
  const spec: CsvBarChartSpec = { kind: 'csv-bar-chart', attachmentId: `sha256:${'a'.repeat(64)}` as CsvBarChartSpec['attachmentId'],
    aggregate: 'mean', groupBy: 'Trial', valueColumn: 'LatencyMs', rowCount: 4,
    groups: [{ key: 'Warm', value: 30, count: 2 }, { key: 'Cold', value: 50, count: 2 }] }
  const artifact = ctx.artifacts.prepareCsvBarChart(agent, { action: 'create', artifactId: id, title: 'Mean latency', spec })
  ctx.artifacts.commit(agent, artifact)
  const selection = { kind: 'current-csv-bar-chart', artifactId: id, revision: 1, groupKey: 'Warm' } as const
  const [block] = select(selection)
  expect(block?.text).toContain('CSV readings come from the Host-computed group result')
  const facts = { kind: selection.kind, artifact, groupKey: 'Warm', values: { key: 'Warm', value: 30, count: 2 } }
  expect(JSON.parse(block!.text.slice(block!.text.indexOf('\n') + 1))).toEqual({
    kind: 'artifact-question-context', sessionId: session.id, facts,
  })
  rejects(() => resolve({ ...selection, value: 900 }), 'INVALID_SELECTION')
  rejects(() => select({ ...selection, groupKey: 'Missing' }), 'INVALID_SELECTION')
  const revision = ctx.artifacts.prepareCsvBarChart(agent, { action: 'update', artifactId: id, baseRevision: 1, title: 'Total latency',
    spec: { ...spec, aggregate: 'sum', groups: [{ key: 'Warm', value: 60, count: 2 }, { key: 'Cold', value: 100, count: 2 }] } })
  ctx.artifacts.commit(agent, revision)
  rejects(() => select(selection), 'STALE_REVISION')
  const returned = branchNotice(session, facts)
  const result = select(returned.selection)
  expect(result[0]?.text).toContain('"value":30,"count":2')
  const tampered = branchNotice(session, { ...facts, values: { key: 'Warm', value: 60, count: 2 } })
  rejects(() => select(tampered.selection), 'INVALID_SELECTION')
})

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

function parsedPlot(blocks: readonly TextBlock[]): ArtifactQuestionContext {
  expect(blocks).toHaveLength(1)
  const prefix = 'The user selected the following experiment context for this question. '
    + 'Function-plot values are recomputed by the Host from the recorded source, selected function, parameters and trace position. '
    + 'Derivative and integral readings are numerical approximations.\n'
  expect(blocks[0]!.text.startsWith(prefix)).toBe(true)
  return JSON.parse(blocks[0]!.text.slice(prefix.length)) as ArtifactQuestionContext
}

const returnedReadingsPrefix = 'The user selected the following Artifact readings from a branch question to accompany this conclusion. '
  + 'This does not state that the assistant used them when producing the conclusion.\n'
const attachedReadingsPrefix = 'The user selected the following returned branch evidence for this question. '
  + 'The readings come from the original source revision recorded on the selected branch result.\n'
const restoredBfsPrefix = 'The user selected the following program-reported BFS checkpoint for this question. '
  + 'Use facts.state for the selected current node, queue and visited nodes. '
  + 'The HTML source and revision come from the verified returned branch notice.\n'

function branchNotice(session: Session, facts: unknown, options: {
  readonly ordinary?: boolean
  readonly branchId?: string
  readonly artifactEvidence?: ArtifactHtmlCheckpointKind
} = {}) {
  const branchSessionId = SessionId('experiment-branch')
  const resultSeq = SessionSeq(13)
  const questionSeq = SessionSeq(9)
  const block = {
    kind: 'branch-result-artifact-evidence', branchSessionId: options.branchId ?? branchSessionId,
    evidence: { kind: 'question', questionSeq, facts },
  }
  const event = session.append('user/message', createUserMessage({
    source: options.ordinary === true ? { kind: 'user' } : {
      kind: 'branch-result', form: 'notice', branchSessionId, resultSeq, resultMessageId: MessageId('branch-conclusion'),
      ...(options.artifactEvidence === undefined ? {} : { artifactEvidence: options.artifactEvidence }),
    },
    content: [{ type: 'text', text: 'The selected trace supports the expected slope.' },
      { type: 'text', text: returnedReadingsPrefix + JSON.stringify(block) }],
  }), { surfaceOp: 'append' })
  const selection: Extract<ArtifactPromptContextSelection, { kind: 'branch-evidence' }> = {
    kind: 'branch-evidence', capturedSessionId: session.id, eventSeq: event.seq, messageId: event.data.id,
  }
  const branchResult = { eventSeq: event.seq, messageId: event.data.id, branchSessionId, resultSeq, questionSeq }
  return { selection, branchResult }
}

function parsedBranchReadings(blocks: readonly TextBlock[]): ArtifactQuestionContext {
  expect(blocks).toHaveLength(1)
  const text = blocks[0]!.text
  expect(text.startsWith(attachedReadingsPrefix)).toBe(true)
  return JSON.parse(text.slice(attachedReadingsPrefix.length)) as ArtifactQuestionContext
}

describe('returned branch evidence ordinary-question context', () => {
  it('uses only the selected returned revision and readings even when the live Artifact changed', async () => {
    const { ctx, agent, session, select } = await setup()
    create(ctx, agent, id, plot)
    const selected = { ...plotSelection, x: 1 }
    const readings = parsedPlot(select(selected)).facts
    const { selection, branchResult } = branchNotice(session, readings)
    ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
      action: 'update', artifactId: id, baseRevision: 1, title: 'Current revision', source: '<p>Live artifact</p>', presentation: 'inline',
    }))
    const before = session.snapshotEvents()
    const current = vi.spyOn(ctx.artifacts, 'currentSnapshot')
    expect(parsedBranchReadings(select(selection))).toEqual({
      kind: 'artifact-question-context', sessionId: session.id, facts: { kind: 'branch-evidence', branchResult, readings },
    })
    expect(current).not.toHaveBeenCalled()
    expect(session.snapshotEvents()).toEqual(before)
  })

  it('allows exact inherited particle notices selected in the receiving Session', async () => {
    const { ctx, agent, session, select } = await setup()
    create(ctx, agent)
    const readings = parsed(select({ kind: 'current-particle', artifactId: id, revision: 1, checkpoint })).facts
    const { selection, branchResult } = branchNotice(session, readings)
    const prefix = session.snapshotEvents()
    const child = makeAgent(ctx, ctx.sessions.create(SessionId('receiving-branch'), { seed: prefix,
      meta: { isSeeded: true, parentSession: session.id }, inheritedEventCount: SessionLogOffset(prefix.length) }))
    rejects(() => select(selection, child), 'SESSION_MISMATCH')
    expect(parsedBranchReadings(select({ ...selection, capturedSessionId: child.session.id }, child)).facts).toEqual({
      kind: 'branch-evidence', branchResult, readings,
    })
    const sibling = makeAgent(ctx, ctx.sessions.create(SessionId('different-branch')))
    rejects(() => select({ ...selection, capturedSessionId: sibling.session.id }, sibling), 'SOURCE_NOT_FOUND')
  })

  it('refuses caller facts, ordinary text lookalikes, and inconsistent notice identity or values', async () => {
    const { ctx, agent, session, select, resolve } = await setup()
    create(ctx, agent, id, plot)
    const readings = parsedPlot(select(plotSelection)).facts
    if (readings.kind !== 'current-function-plot') throw new Error('Expected plot readings')
    const { selection } = branchNotice(session, readings)
    rejects(() => resolve({ ...selection, readings: { integral: 999 } }), 'INVALID_SELECTION')
    rejects(() => select({ ...selection, messageId: MessageId('substituted') }), 'SOURCE_NOT_FOUND')
    rejects(() => select(branchNotice(session, readings, { ordinary: true }).selection), 'SOURCE_NOT_FOUND')
    rejects(() => select(branchNotice(session, readings, { branchId: 'another-branch' }).selection), 'INVALID_SELECTION')
    const changed = { ...readings, values: { ...readings.values, integral: 42 } }
    rejects(() => select(branchNotice(session, changed).selection), 'INVALID_SELECTION')
  })

  it('applies the complete UTF-8 context budget to replayable branch evidence', async () => {
    const original = await setup()
    create(original.ctx, original.agent, id, plot, undefined, '分支函数图')
    const readings = parsedPlot(original.select(plotSelection)).facts
    const { selection } = branchNotice(original.session, readings)
    const byteLength = Buffer.byteLength(JSON.stringify(original.select(selection)), 'utf8')
    const limited = await setup({ maxContextBytes: byteLength - 1 })
    rejects(() => limited.select(branchNotice(limited.session, readings).selection), 'CONTEXT_TOO_LARGE')
  })
})

describe('restored BFS ordinary-question context', () => {
  const artifact = { format: 'html', artifactId: id, revision: 2, title: 'Breadth-first search', presentation: 'inline',
    source: '<p>Source from the child only</p>' } satisfies HtmlArtifactSnapshot
  const returned = {
    kind: 'html-runtime', artifact, runtimeId: 'original-bfs-run', attribution: 'program-reported',
    capture: { status: 'ready', restore: 'bfs-checkpoint', state: { kind: 'bfs-checkpoint', current: 'B', queue: ['C', 'D'], visited: ['A', 'B'] } },
  }
  const state = { kind: 'bfs-checkpoint' as const, current: 'C', queue: ['D', 'E'], visited: ['A', 'B', 'C'] }
  function fromNotice(session: Session, facts: unknown, options: Parameters<typeof branchNotice>[2]) {
    const { selection: reference, branchResult } = branchNotice(session, facts, options)
    return { selection: { ...reference, kind: 'branch-bfs-checkpoint', state } as const, branchResult }
  }

  it('uses the selected new checkpoint and restores the exact returned source without a parent Artifact or runtime', async () => {
    const { ctx, agent, session, select } = await setup()
    const { selection, branchResult } = fromNotice(session, returned, { artifactEvidence: 'bfs-checkpoint' })
    const before = session.snapshotEvents()
    expect(ctx.get('artifactRuntime')).toBeUndefined()
    expect(ctx.artifacts.currentSnapshot(agent, id)).toBeUndefined()
    const blocks = select(selection)
    const text = blocks[0]?.text ?? ''
    expect(text.startsWith(restoredBfsPrefix)).toBe(true)
    expect(JSON.parse(text.slice(restoredBfsPrefix.length))).toEqual({ kind: 'artifact-question-context', sessionId: session.id, facts: {
      kind: selection.kind, branchResult, artifact, attribution: 'program-reported', state,
    } })
    expect(session.snapshotEvents()).toEqual(before)

    const reopened = await setup()
    const restoredSession = reopened.ctx.sessions.create(session.id, {
      seed: before, meta: session.header, inheritedEventCount: session.inheritedEventCount,
    })
    const restored = makeAgent(reopened.ctx, restoredSession)
    expect(reopened.select(selection, restored)).toEqual(blocks)
  })

  it('requires the exact receiving notice and validates both the original and new checkpoints', async () => {
    const { session, select, resolve } = await setup()
    const { selection } = fromNotice(session, returned, { artifactEvidence: 'bfs-checkpoint' })
    const unmarked = fromNotice(session, returned, {}).selection
    const ordinary = fromNotice(session, returned, { ordinary: true }).selection
    const mismatchedBranch = fromNotice(session, returned, { artifactEvidence: 'bfs-checkpoint', branchId: 'another-branch' }).selection
    const malformedOriginal = fromNotice(session, { ...returned, capture: { ...returned.capture, state: null } },
      { artifactEvidence: 'bfs-checkpoint' }).selection
    rejects(() => select(unmarked), 'INVALID_SELECTION')
    rejects(() => select(ordinary), 'SOURCE_NOT_FOUND')
    rejects(() => select(mismatchedBranch), 'INVALID_SELECTION')
    rejects(() => select(malformedOriginal), 'INVALID_SELECTION')
    rejects(() => select({ ...selection, capturedSessionId: SessionId('wrong-receiver') }), 'SESSION_MISMATCH')
    rejects(() => select({ ...selection, messageId: MessageId('wrong-message') }), 'SOURCE_NOT_FOUND')
    rejects(() => select({ ...selection, eventSeq: ordinary.eventSeq }), 'SOURCE_NOT_FOUND')
    rejects(() => select({ ...selection, state: { ...state, queue: ['D', 'D'] } }), 'INVALID_SELECTION')
    rejects(() => resolve({ ...selection, artifact }), 'INVALID_SELECTION')
    rejects(() => select({ kind: 'branch-evidence', capturedSessionId: session.id,
      eventSeq: selection.eventSeq, messageId: selection.messageId }), 'INVALID_SELECTION')
  })
})

it('attaches a confirmed half-adder setting from live HTML or exact returned HTML and rejects inconsistent reports', async () => {
  const { ctx, agent, session, select } = await setup()
  const source = '<p>Half-adder</p>'
  createHtml(ctx, agent, source)
  const original: ArtifactHalfAdderCheckpoint = { kind: 'half-adder-checkpoint', a: 0, b: 1, sum: 1, carry: 0 }
  const state: ArtifactHalfAdderCheckpoint = { kind: 'half-adder-checkpoint', a: 1, b: 1, sum: 0, carry: 1 }
  const capture = { status: 'ready', restore: original.kind, state: original } as const
  const live = programSelection(agent, capture)
  const text = select(live)[0]?.text ?? ''
  const [prefix, json] = text.split('\n', 2)
  expect(prefix).toContain('Use facts.capture.state for the selected input bits a and b and output bits sum and carry.')
  const recorded = JSON.parse(json ?? '') as ArtifactQuestionContext
  expect(recorded.facts).toMatchObject({ kind: 'html-runtime', artifact: { source }, capture })
  rejects(() => select(programSelection(agent, { ...capture, state: { ...original, carry: 1 } })), 'INVALID_SELECTION')

  const checkpointFrom = (facts: unknown, artifactEvidence: ArtifactHtmlCheckpointKind) => {
    const { selection: reference, branchResult } = branchNotice(session, facts, { artifactEvidence })
    return { selection: { ...reference, kind: 'branch-half-adder-checkpoint', state } as const, branchResult }
  }
  const { selection, branchResult } = checkpointFrom(recorded.facts, state.kind)
  const [returnedPrefix, returnedJson] = (select(selection)[0]?.text ?? '').split('\n', 2)
  expect(returnedPrefix).toContain('Use facts.state for the selected input bits a and b and output bits sum and carry.')
  expect(JSON.parse(returnedJson ?? '')).toMatchObject({ facts: { kind: selection.kind, artifact: { source }, branchResult, state } })
  rejects(() => select(checkpointFrom(recorded.facts, 'bfs-checkpoint').selection), 'INVALID_SELECTION')
  rejects(() => select({ ...selection, state: { ...state, sum: 1 } }), 'INVALID_SELECTION')
})

describe('function-plot ordinary-question context', () => {
  it('recomputes the selected trace using captured parameters, including points outside the default viewport', async () => {
    const { ctx, agent, session, select } = await setup()
    create(ctx, agent, id, plot)
    const before = session.snapshotEvents()
    const facts = parsedPlot(select(plotSelection)).facts
    expect(facts).toMatchObject({ kind: 'current-function-plot', artifact: { artifactId: id, revision: 1, spec: plot },
      functionId: 'linear', x: 3, parameters: { a: 1.25 }, values: { value: 3.75 } })
    if (facts.kind !== 'current-function-plot') throw new Error('Expected function-plot facts')
    expect(facts.values.derivative).toBeCloseTo(1.25, 10)
    expect(facts.values.integral).toBeCloseTo(5.625, 10)
    expect(session.snapshotEvents()).toEqual(before)
  })

  it('keeps undefined domain readings when another function in the same plot is selected', async () => {
    const { ctx, agent, select } = await setup()
    create(ctx, agent, id, plot)
    const facts = parsedPlot(select({ ...plotSelection, functionId: 'root', x: 0 })).facts
    expect(facts).toMatchObject({ functionId: 'root', x: 0, values: { value: 0, derivative: null, integral: 0 } })
  })

  it('rejects stale revisions, missing or unsupported sources, and caller-supplied readings', async () => {
    const { ctx, agent, select, resolve } = await setup()
    rejects(() => select(plotSelection), 'SOURCE_NOT_FOUND')
    create(ctx, agent, id, plot)
    rejects(() => resolve({ ...plotSelection, values: { value: 99 } }), 'INVALID_SELECTION')
    ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
      action: 'update', artifactId: id, baseRevision: 1, title: 'Revised source', source: '<p>Different source</p>', presentation: 'inline',
    }))
    rejects(() => select(plotSelection), 'STALE_REVISION')
    rejects(() => select({ ...plotSelection, revision: 2 }), 'UNSUPPORTED_SOURCE')
  })

  it('rejects unknown functions, mismatched parameter keys or bounds, and non-finite coordinates', async () => {
    const { ctx, agent, select } = await setup()
    create(ctx, agent, id, plot)
    const inputs: readonly (typeof plotSelection)[] = [
      { ...plotSelection, functionId: 'missing' },
      { ...plotSelection, parameters: {} },
      { ...plotSelection, parameters: { unknown: 1 } },
      { ...plotSelection, parameters: { a: 1, unknown: 1 } },
      { ...plotSelection, parameters: { a: 1, ['__proto__']: 1 } },
      { ...plotSelection, parameters: { a: -1 } },
      { ...plotSelection, parameters: { a: 3 } },
      { ...plotSelection, parameters: { a: Infinity } },
      { ...plotSelection, x: Infinity },
    ]
    for (const input of inputs) rejects(() => select(input), 'INVALID_SELECTION')
  })
})

describe('program-reported ordinary-question context', () => {
  it('binds an opted-in BFS checkpoint to the exact Host source and model-visible selected fields', async () => {
    const { ctx, agent, select } = await setup()
    const html = '<p>Interactive BFS</p>'
    createHtml(ctx, agent, html)
    const state = { kind: 'bfs-checkpoint' as const, current: 'B', queue: ['C', 'D', 'E'], visited: ['A', 'B'] }
    const selection = programSelection(agent, { status: 'ready', state, restore: 'bfs-checkpoint' })
    const text = select(selection)[0]?.text ?? ''
    const [prefix, json] = text.split('\n', 2)
    expect(prefix).toContain('Use facts.capture.state for the selected current node, queue and visited nodes.')
    expect(JSON.parse(json ?? '')).toMatchObject({ kind: 'artifact-question-context', sessionId: agent.session.id, facts: {
      kind: 'html-runtime', attribution: 'program-reported', artifact: { artifactId: id, revision: 1, source: html },
      capture: { status: 'ready', restore: 'bfs-checkpoint', state },
    } })
    expect(parsedProgram(select(programSelection(agent, { status: 'ready', state }))).facts)
      .toMatchObject({ capture: { status: 'ready', state } })
    ctx.artifacts.commit(agent, ctx.artifacts.prepare(agent, {
      action: 'update', artifactId: id, baseRevision: 1, title: 'Revised BFS', source: '<p>BFS B</p>', presentation: 'inline',
    }))
    rejects(() => select(selection), 'STALE_REVISION')
  })

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
    if (capture.status !== 'ready' || capture.restore !== undefined
      || capture.state === null || typeof capture.state !== 'object' || Array.isArray(capture.state)) {
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
    { status: 'ready', restore: 'bfs-checkpoint', state: null },
    { status: 'ready', restore: 'bfs-checkpoint', state: { kind: 'bfs-checkpoint', current: 'C', queue: ['C'], visited: ['A'] } },
    { status: 'ready', restore: 'unknown-checkpoint', state: { kind: 'bfs-checkpoint', current: null, queue: [], visited: [] } },
    { status: 'error', restore: 'bfs-checkpoint', error: { code: 'SCRIPT_ERROR', message: 'A' } },
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

  it('admits changed vertical gravity at the particle continuation checkpoint and reuses it from the notice', async () => {
    const { ctx, session, agent, select } = await setup()
    const choice = { kind: 'current-particle', artifactId: id, revision: 1, checkpoint, gravityY: -4 } as const
    const ordinary = 'ordinary' as ArtifactId
    create(ctx, agent, ordinary)
    rejects(() => select({ ...choice, artifactId: ordinary }), 'INVALID_SELECTION')
    const prepared = ctx.artifacts.prepare(agent, { action: 'create', artifactId: id, format: 'scene',
      title: 'Experiment', presentation: 'inline', spec: source })
    if (prepared.format !== 'scene') throw new Error('Expected a particle source')
    ctx.artifacts.commit(agent, { ...prepared, particleContinuation: {
      source: { sessionId: SessionId('parent'), eventSeq: SessionSeq(12), messageId: MessageId('returned'),
        artifactId: 'original' as ArtifactId, revision: 3 },
      baseline: { checkpoint },
    } })
    rejects(() => select({ ...choice, checkpoint: { ...checkpoint, stepCount: 5 } }), 'INVALID_SELECTION')
    const adjusted = select(choice)[0]!.text
    const [description, json] = adjusted.split('\n')
    expect(description).toContain('Use facts.gravityY for the selected vertical gravity and facts.values for the readings')
    const { facts } = JSON.parse(json!) as ArtifactQuestionContext
    expect(facts).toMatchObject({ checkpoint, gravityY: -4, artifact: { spec: source },
      values: { particles: [{ id: 'p', vy: 7.2 }] } })
    const { selection } = branchNotice(session, facts)
    const text = select(selection)[0]!.text
    expect(text.startsWith(attachedReadingsPrefix)).toBe(true)
    expect(JSON.parse(text.slice(attachedReadingsPrefix.length))).toMatchObject({ facts: { readings: {
      checkpoint, gravityY: -4, artifact: { spec: source }, values: { particles: [{ id: 'p', vy: 7.2 }] },
    } } })
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
