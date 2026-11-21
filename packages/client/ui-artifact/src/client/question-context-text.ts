/** Display-only recognition of exact experiment-context text; this grants no authority. */
import type { UserTextRule } from '@agentrans/client-ui-conversation/client'
import type {
  ArtifactCsvComparisonPage, ArtifactCsvComparisonQuestionFacts, ArtifactCsvComparisonReading, ArtifactCsvComparisonRow,
  ArtifactCsvComparisonReturnCard, ArtifactCsvComparisonReturnCards,
} from '@agentrans/artifact-followup/types'
import { PARTICLE_RUNTIME_VERSION, type ParticleCheckpoint, type ParticleObservation } from '@agentrans/artifact/particle-runtime'
import {
  ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES, CONTINUED_CSV_QUESTION_PREFIX,
  CSV_COMPARISON_CHANGES_PREFIX, CSV_COMPARISON_EXPLANATION_PREFIX, CSV_COMPARISON_QUESTION_PREFIX, csvComparisonChangesText,
  IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX, IMPORTED_CSV_COMPARISON_QUESTION_PREFIX,
  IMPORTED_CSV_EXPLANATION_SOURCE_TEXT, IMPORTED_CSV_RETURN_SOURCE_TEXT, IMPORTED_CSV_SINGLE_SOURCE_TEXT,
  isArtifactHtmlCheckpoint, isBoundedArtifactJson, type ArtifactHtmlCheckpoint,
} from '@agentrans/artifact/runtime-values'
import { CSV_AGGREGATES, normalizeSceneSpec, type CsvBarChartSpec, type FunctionPlotSpec } from '@agentrans/artifact/scene'
import type { FunctionAnalysis } from '@agentrans/artifact/scene-renderers'
import type { ArtifactComparison, ArtifactId, HtmlArtifactSnapshot, SceneArtifactSnapshot } from '@agentrans/artifact/types'
import { SessionId, SessionSeq } from '@agentrans/session/types'
import type { CsvComparisonExplanation } from './csv-comparison-explanation.ts'

const SELECTED_CONTEXT_START = 'The user selected the following '
const EXPERIMENT_CONTEXT_START = SELECTED_CONTEXT_START + 'experiment context for this question. '
/** Maximum text length considered for native replay. Larger original attachments stay readable. */
export const MAX_REPLAY_CONTEXT_LENGTH = 64 * 1024
const ARTIFACT_ID = /^[a-z][a-z0-9-]{0,63}$/

/** Exact version-one particle text spelling emitted by the Host question-context provider. */
export const QUESTION_CONTEXT_PREFIX = EXPERIMENT_CONTEXT_START
  + 'Particle values are recomputed by the Host from the recorded source and checkpoint; no causal conclusion is inferred.\n'

const ADJUSTED_PARTICLE_CONTEXT_PREFIX = EXPERIMENT_CONTEXT_START
  + 'This question uses the adjusted particle experiment. Use facts.gravityY for the selected vertical gravity '
  + 'and facts.values for the readings the Host recomputed at the confirmed checkpoint. The source spec records the baseline gravity.\n'

const PLOT_CONTEXT_PREFIX = EXPERIMENT_CONTEXT_START
  + 'Function-plot values are recomputed by the Host from the recorded source, selected function, parameters and trace position. '
  + 'Derivative and integral readings are numerical approximations.\n'

const CSV_CONTEXT_PREFIX = EXPERIMENT_CONTEXT_START
  + 'CSV readings come from the Host-computed group result stored in the selected chart revision.\n'

const BRANCH_CONTEXT_PREFIX = SELECTED_CONTEXT_START + 'returned branch evidence for this question. '
  + 'The readings come from the original source revision recorded on the selected branch result.\n'

const NATIVE_CONTEXT_PREFIXES = [PLOT_CONTEXT_PREFIX, QUESTION_CONTEXT_PREFIX, ADJUSTED_PARTICLE_CONTEXT_PREFIX,
  CSV_CONTEXT_PREFIX, CONTINUED_CSV_QUESTION_PREFIX]
const QUESTION_CONTEXT_PREFIXES = [...NATIVE_CONTEXT_PREFIXES, BRANCH_CONTEXT_PREFIX]

/** Exact program-report spelling; display recognition does not authenticate its claims. */
export const PROGRAM_CONTEXT_PREFIX = 'The user selected the following program-reported context for this question. '
  + 'The Host checked the source identity and revision; the runtime identity, status, state and error are Client/program reports, '
  + 'not independently verified or recomputed. This does not establish replayability or a causal conclusion.\n'

const BFS_CONTEXT_PREFIX = 'The user selected the following program-reported context for this question. '
  + 'The Host checked the source identity and revision and validated the BFS checkpoint shape. '
  + 'Use facts.capture.state for the selected current node, queue and visited nodes. '
  + 'This program-reported checkpoint can be reopened with the recorded HTML revision.\n'

const HALF_ADDER_CONTEXT_PREFIX = 'The user selected the following program-reported context for this question. '
  + 'The Host checked the source identity and revision and validated the half-adder checkpoint. '
  + 'Use facts.capture.state for the selected input bits a and b and output bits sum and carry. '
  + 'This program-reported checkpoint can be reopened with the recorded HTML revision.\n'

const PROGRAM_CONTEXT_START = 'The user selected the following program-reported '
const BRANCH_BFS_CONTEXT_PREFIX = PROGRAM_CONTEXT_START
  + 'BFS checkpoint for this question. Use facts.state for the selected current node, queue and visited nodes. '
  + 'The HTML source and revision come from the verified returned branch notice.\n'
const BRANCH_HALF_ADDER_CONTEXT_PREFIX = PROGRAM_CONTEXT_START
  + 'half-adder checkpoint for this question. Use facts.state for the selected input bits a and b and output bits sum and carry. '
  + 'The HTML source and revision come from the verified returned branch notice.\n'

const HTML_CHECKPOINT_PREFIXES = [
  [BFS_CONTEXT_PREFIX, 'bfs-checkpoint'], [HALF_ADDER_CONTEXT_PREFIX, 'half-adder-checkpoint'],
] as const
const PROGRAM_CONTEXT_PREFIXES = [
  PROGRAM_CONTEXT_PREFIX, BFS_CONTEXT_PREFIX, HALF_ADDER_CONTEXT_PREFIX, BRANCH_BFS_CONTEXT_PREFIX, BRANCH_HALF_ADDER_CONTEXT_PREFIX,
]

/** Recorded conditions supported by native, read-only scene playback. */
export type ArtifactQuestionReplayState =
  | {
    readonly kind: 'particle-system'
    readonly checkpoint: ParticleCheckpoint
    readonly gravityY?: number
    readonly values: { readonly time: number; readonly particles: readonly Readonly<ParticleObservation['particles'][number]>[] }
  }
  | {
    readonly kind: 'function-plot'
    readonly functionId: string
    readonly x: number
    readonly parameters: Readonly<Record<string, number>>
    readonly values: FunctionAnalysis
  }
  | {
    readonly kind: 'csv-bar-chart'
    readonly group: CsvBarChartSpec['groups'][number]
  }

/** Validated native source and selection projected from the historical question text. */
export interface ArtifactQuestionReplay {
  readonly artifact: SceneArtifactSnapshot
  readonly state: ArtifactQuestionReplayState
}

/** Validated display data for a program-reported checkpoint and its original HTML source. */
export interface HtmlQuestionReplay {
  readonly artifact: HtmlArtifactSnapshot
  readonly state: ArtifactHtmlCheckpoint
}

/** Durable returned notice reference carried by a continued experiment question. */
export interface HtmlQuestionOrigin {
  readonly eventSeq: number
  readonly messageId: string
  readonly branchSessionId: string
  readonly resultSeq: number
  readonly questionSeq: number
}

interface ContextSummary {
  readonly title: string
  readonly revision: number
  readonly sessionId?: SessionId
  readonly replay?: ArtifactQuestionReplay
  readonly origin?: 'branch-evidence'
}

interface ParticleContextSummary extends ContextSummary {
  readonly stepCount: number
  readonly variantTitle?: string
  readonly variantRevision?: number
}

/** Compact display fields; the Slot keeps the original complete substring as `raw`. */
export type QuestionContextSummary = ParticleContextSummary | (ContextSummary & { readonly x: number })
  | (ContextSummary & { readonly csv: Extract<ArtifactQuestionReplayState, { kind: 'csv-bar-chart' }> })

/** Neutral display category for a complete program-reported state or error. */
export interface ProgramContextSummary {
  readonly sessionId: SessionId
  readonly title: string
  readonly revision: number
  readonly status: 'ready' | 'error'
  readonly checkpoint?: {
    readonly artifactId: string
    readonly source: string
    readonly state: ArtifactHtmlCheckpoint
    readonly origin?: HtmlQuestionOrigin
  }
}

type CsvReturnedPair = NonNullable<ArtifactCsvComparisonQuestionFacts['returns']>

interface CsvComparisonContextSummary {
  readonly sessionId: SessionId
  readonly page: ArtifactCsvComparisonPage
  readonly explanation?: CsvComparisonExplanation
  readonly attribution?: 'user-imported'
  readonly reusedFrom?: NonNullable<ArtifactCsvComparisonQuestionFacts['reusedFrom']>
  readonly invalidReuseSource?: true
  readonly returnedPair?: CsvReturnedPair
  readonly returnCards?: ArtifactCsvComparisonReturnCards
}

declare module '@agentrans/client-ui-conversation/client' {
  interface UserTextDataMap {
    /** Expandable display of a recognizable experiment-context text block, without verification claims. */
    'artifact-question-context': QuestionContextSummary
    /** A stored comparison page. Recognition of the text alone grants no authority. */
    'artifact-csv-comparison-context': CsvComparisonContextSummary
    /** Expandable program reports; the recognized format is not a verification mark. */
    'artifact-program-context': ProgramContextSummary
  }
}

function programFacts(facts: unknown) {
  if (!record(facts) || facts.kind !== 'html-runtime' || facts.attribution !== 'program-reported'
    || typeof facts.runtimeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(facts.runtimeId)
    || !record(facts.artifact) || !record(facts.capture)) return undefined
  const { artifact, capture } = facts
  if (artifact.format !== 'html' || typeof artifact.source !== 'string' || artifact.source.length === 0
    || typeof artifact.artifactId !== 'string' || artifact.artifactId.length === 0
    || typeof artifact.title !== 'string' || artifact.title.trim().length === 0 || !integer(artifact.revision, 1)
    || !isBoundedArtifactJson(capture, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES)) return undefined
  return { artifact, capture, artifactId: artifact.artifactId, source: artifact.source, title: artifact.title, revision: artifact.revision }
}

/**
 * Read the locked fields and the complete HTML source carried by a historical attachment.
 * @param facts - Untrusted parsed program facts.
 * @returns Bounded display data for the opt-in marker and valid source, or absence.
 */
export function htmlQuestionFactsReplay(facts: unknown): HtmlQuestionReplay | undefined {
  const parsed = programFacts(facts)
  if (parsed === undefined) return undefined
  const { artifact, capture, artifactId, source, title, revision } = parsed
  const { presentation } = artifact
  if (!ARTIFACT_ID.test(artifactId) || (presentation !== 'inline' && presentation !== 'focus')
    || capture.status !== 'ready' || Object.keys(capture).length !== 3
    || !isArtifactHtmlCheckpoint(capture.state) || capture.restore !== capture.state.kind) return undefined
  return { artifact: { artifactId: artifactId as ArtifactId, format: 'html', revision, title, presentation, source }, state: capture.state }
}

/**
 * Read one complete locked HTML question attachment from the selected child Session.
 * @param text - Original durable text block.
 * @param sessionId - Required Session identity recorded on the attachment.
 * @returns Display data for a valid opted-in checkpoint, or absence.
 */
export function parseHtmlQuestionReplay(text: string, sessionId: string): HtmlQuestionReplay | undefined {
  const format = HTML_CHECKPOINT_PREFIXES.find(([prefix]) => text.startsWith(prefix))
  if (format === undefined) return undefined
  const [prefix, kind] = format
  if (text.length - prefix.length > MAX_REPLAY_CONTEXT_LENGTH || text.indexOf('\n', prefix.length) !== -1) return undefined
  let input: unknown
  try { input = JSON.parse(text.slice(prefix.length)) } catch (_error) { return undefined }
  if (!record(input) || input.kind !== 'artifact-question-context' || input.sessionId !== sessionId) return undefined
  const replay = htmlQuestionFactsReplay(input.facts)
  return replay?.state.kind === kind ? replay : undefined
}

function programSummary(input: unknown, prefix: string): ProgramContextSummary | undefined {
  if (!record(input) || input.kind !== 'artifact-question-context' || typeof input.sessionId !== 'string'
    || input.sessionId.length === 0) return undefined
  const sessionId = SessionId(input.sessionId)
  if (prefix === BRANCH_BFS_CONTEXT_PREFIX || prefix === BRANCH_HALF_ADDER_CONTEXT_PREFIX) {
    const kind = prefix === BRANCH_BFS_CONTEXT_PREFIX ? 'bfs-checkpoint' : 'half-adder-checkpoint'
    return branchHtmlSummary(input.facts, kind, sessionId)
  }
  if (prefix === BFS_CONTEXT_PREFIX || prefix === HALF_ADDER_CONTEXT_PREFIX) {
    const replay = htmlQuestionFactsReplay(input.facts)
    if (replay?.state.kind !== (prefix === BFS_CONTEXT_PREFIX ? 'bfs-checkpoint' : 'half-adder-checkpoint')) return undefined
    const { artifact: { title, revision, artifactId, source }, state } = replay
    return { sessionId, title, revision, status: 'ready', checkpoint: { artifactId, source, state } }
  }
  const parsed = programFacts(input.facts)
  if (parsed === undefined) return undefined
  const { capture, title, revision } = parsed
  if (capture.status === 'ready' && Object.keys(capture).length === 2 && Object.hasOwn(capture, 'state')) {
    return { sessionId, title, revision, status: 'ready' }
  }
  if (capture.status !== 'error' || Object.keys(capture).length !== 2 || !record(capture.error)
    || Object.keys(capture.error).length !== 2 || typeof capture.error.code !== 'string'
    || !/^[A-Za-z][A-Za-z0-9._-]{0,95}$/.test(capture.error.code) || typeof capture.error.message !== 'string') return undefined
  return { sessionId, title, revision, status: 'error' }
}

function branchHtmlSummary(facts: unknown, kind: ArtifactHtmlCheckpoint['kind'], sessionId: SessionId): ProgramContextSummary | undefined {
  if (!record(facts) || facts.kind !== `branch-${kind}` || facts.attribution !== 'program-reported'
    || !record(facts.artifact) || !record(facts.branchResult)
    || !isBoundedArtifactJson(facts.state, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES)
    || !isArtifactHtmlCheckpoint(facts.state) || facts.state.kind !== kind) return undefined
  const { artifactId, source, title, revision } = facts.artifact
  const { eventSeq, messageId, branchSessionId, resultSeq, questionSeq } = facts.branchResult
  if (facts.artifact.format !== 'html' || typeof artifactId !== 'string' || !ARTIFACT_ID.test(artifactId)
    || typeof source !== 'string' || source === '' || typeof title !== 'string' || title.trim() === '' || !integer(revision, 1)
    || !integer(eventSeq, 0) || !integer(resultSeq, 0) || !integer(questionSeq, 0) || questionSeq >= resultSeq
    || typeof messageId !== 'string' || messageId === '' || typeof branchSessionId !== 'string' || branchSessionId === '') return undefined
  return { sessionId, title, revision, status: 'ready', checkpoint: { artifactId, source, state: facts.state,
    origin: { eventSeq, messageId, branchSessionId, resultSeq, questionSeq } } }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function csvComparisonReading(value: unknown): value is ArtifactCsvComparisonReading {
  return record(value) && typeof value.groupKey === 'string' && CSV_AGGREGATES.some(aggregate => aggregate === value.aggregate)
    && integer(value.count, 0) && typeof value.value === 'number' && Number.isFinite(value.value)
    && (value.valueColumn === undefined || typeof value.valueColumn === 'string')
    && (value.filter === undefined || record(value.filter) && typeof value.filter.column === 'string' && typeof value.filter.value === 'string')
}

function csvComparisonRow(value: unknown): value is ArtifactCsvComparisonRow {
  return record(value) && integer(value.record, 1)
    && (value.status === 'kept' || value.status === 'excluded' || value.status === 'added')
    && (value.value === undefined || typeof value.value === 'string')
    && (value.originalFilterValue === undefined || typeof value.originalFilterValue === 'string')
    && (value.currentFilterValue === undefined || typeof value.currentFilterValue === 'string')
}

function csvComparisonSource(value: unknown): ArtifactCsvComparisonQuestionFacts['reusedFrom'] {
  if (!record(value) || !integer(value.eventSeq, 0) || typeof value.messageId !== 'string' || value.messageId === '') return undefined
  return { eventSeq: value.eventSeq, messageId: value.messageId as NonNullable<ArtifactCsvComparisonQuestionFacts['reusedFrom']>['messageId'] }
}

function recordedComparisonOrigins(question: unknown, source: unknown): boolean {
  return record(question) && record(source) && integer(question.eventSeq, 0) && typeof question.messageId === 'string'
    && question.messageId !== '' && integer(source.eventSeq, 0) && source.eventSeq < question.eventSeq
    && typeof source.messageId === 'string' && source.messageId !== '' && typeof source.artifactId === 'string'
    && ARTIFACT_ID.test(source.artifactId) && integer(source.revision, 1)
}

function csvReturnAddress(value: unknown): CsvReturnedPair['first'] | undefined {
  if (!record(value) || typeof value.artifactId !== 'string' || !ARTIFACT_ID.test(value.artifactId)
    || !integer(value.revision, 1)) return undefined
  const address = csvComparisonSource(value)
  return address === undefined ? undefined : { ...address, artifactId: value.artifactId as ArtifactId, revision: value.revision }
}

function recordedReturnPair(value: unknown): CsvReturnedPair | undefined {
  if (!record(value) || typeof value.branchSessionId !== 'string' || value.branchSessionId === '') return undefined
  const first = csvReturnAddress(value.first)
  const second = csvReturnAddress(value.second)
  if (first === undefined || second === undefined || first.eventSeq >= second.eventSeq
    || first.messageId === second.messageId) return undefined
  return { branchSessionId: SessionId(value.branchSessionId), first, second }
}

function csvComparisonPage(comparison: unknown): ArtifactCsvComparisonPage | undefined {
  if (!record(comparison)) return undefined
  const { original, current, kept, excluded, added, total, offset, nextOffset, rows } = comparison
  if (!csvComparisonReading(original) || !csvComparisonReading(current) || original.groupKey !== current.groupKey
    || !integer(kept, 0) || !integer(excluded, 0) || !integer(added, 0) || !integer(total, 0)
    || total !== kept + excluded + added
    || original.count !== kept + excluded || current.count !== kept + added || !integer(offset, 0)
    || !Array.isArray(rows) || !rows.every(csvComparisonRow) || offset + rows.length > total
    || (nextOffset !== undefined && (!integer(nextOffset, 0) || nextOffset !== offset + rows.length || nextOffset >= total))) {
    return undefined
  }
  return { original, current, kept, excluded, added, total, offset, rows, ...(nextOffset === undefined ? {} : { nextOffset }) }
}

function csvReturnGroup(value: unknown): value is ArtifactCsvComparisonReturnCard['groups'][number] {
  return record(value) && Object.keys(value).length === 3 && typeof value.key === 'string' && value.key.length <= 256
    && typeof value.value === 'number' && Number.isFinite(value.value) && integer(value.count, 1) && value.count <= 20_000
}

function csvImportedReturnCard(value: unknown, reading: ArtifactCsvComparisonReading): ArtifactCsvComparisonReturnCard | undefined {
  if (!record(value) || Object.keys(value).length !== 5) return undefined
  const { title, revision, conclusion, groupBy, groups } = value
  if (typeof title !== 'string' || title.trim() === '' || title.length > 120 || !integer(revision, 1)
    || typeof groupBy !== 'string' || groupBy.trim() === '' || groupBy.length > 128
    || !Array.isArray(conclusion) || !conclusion.every((part): part is string => typeof part === 'string')
    || !conclusion.some(part => part.trim() !== '') || !Array.isArray(groups) || groups.length > 64 || !groups.every(csvReturnGroup)) return undefined
  if (new Set(groups.map(group => group.key)).size !== groups.length) return undefined
  const selected = groups.find(group => group.key === reading.groupKey)
  if (selected?.value !== reading.value || selected.count !== reading.count) return undefined
  return { title, revision, conclusion, groupBy, groups }
}

function csvImportedReturnCards(value: unknown, page: ArtifactCsvComparisonPage): ArtifactCsvComparisonReturnCards | undefined {
  if (!record(value) || Object.keys(value).length !== 2) return undefined
  const first = csvImportedReturnCard(value.first, page.original)
  const second = csvImportedReturnCard(value.second, page.current)
  return first === undefined || second === undefined || first.groupBy !== second.groupBy ? undefined : { first, second }
}

function csvExplanation(value: unknown, filtered: ArtifactCsvComparisonPage, imported: boolean): CsvComparisonExplanation | undefined {
  if (!record(value) || !record(value.aggregation)) return undefined
  const comparison = csvComparisonPage(value.aggregation.comparison)
  if (comparison === undefined || comparison.original.filter !== undefined || comparison.current.filter !== undefined
    || comparison.original.aggregate === comparison.current.aggregate || filtered.original.filter !== undefined
    || filtered.current.filter === undefined || comparison.current.aggregate !== filtered.current.aggregate) return undefined
  if (imported) {
    return value.aggregation.message === undefined && value.filtering === undefined ? { aggregation: { comparison } } : undefined
  }
  const aggregation = csvComparisonSource(value.aggregation.message)
  const filtering = csvComparisonSource(value.filtering)
  if (aggregation === undefined || filtering === undefined || aggregation.eventSeq === filtering.eventSeq
    || aggregation.messageId === filtering.messageId) return undefined
  return { aggregation: { message: aggregation, comparison }, filtering }
}

const CSV_COMPARISON_CONTEXT_PREFIXES = [CSV_COMPARISON_QUESTION_PREFIX, IMPORTED_CSV_COMPARISON_QUESTION_PREFIX,
  CSV_COMPARISON_EXPLANATION_PREFIX, IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX] as const

function csvComparisonSummary(
  input: unknown, prefix: typeof CSV_COMPARISON_CONTEXT_PREFIXES[number],
): CsvComparisonContextSummary | undefined {
  if (!isBoundedArtifactJson(input, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES)
    || !record(input) || input.kind !== 'artifact-question-context' || typeof input.sessionId !== 'string' || input.sessionId === ''
    || !record(input.facts) || input.facts.kind !== 'csv-question-comparison' || input.facts.sessionId !== input.sessionId) return undefined
  const { question, source, comparison, reusedFrom, attribution, explanation, returns, returnCards } = input.facts
  const imported = prefix === IMPORTED_CSV_COMPARISON_QUESTION_PREFIX || prefix === IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX
  const returnedPair = recordedReturnPair(returns)
  if (returns !== undefined) {
    if (prefix !== CSV_COMPARISON_QUESTION_PREFIX || attribution !== undefined || explanation !== undefined
      || question !== undefined || source !== undefined || returnedPair === undefined) return undefined
  } else if (imported ? attribution !== 'user-imported' || question !== undefined || source !== undefined
    : attribution !== undefined || !recordedComparisonOrigins(question, source)) return undefined
  const page = csvComparisonPage(comparison)
  if (page === undefined) return undefined
  const embeddedReturns = csvImportedReturnCards(returnCards, page)
  if (returnCards !== undefined && (prefix !== IMPORTED_CSV_COMPARISON_QUESTION_PREFIX || embeddedReturns === undefined)) return undefined
  const origin = imported ? { attribution: 'user-imported' as const } : {}
  const reuseSource = csvComparisonSource(reusedFrom)
  const reuse = reuseSource === undefined ? reusedFrom === undefined ? {} : { invalidReuseSource: true as const }
    : { reusedFrom: reuseSource }
  if (prefix === CSV_COMPARISON_EXPLANATION_PREFIX || prefix === IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX) {
    const pair = csvExplanation(explanation, page, imported)
    return pair === undefined || (!imported && reusedFrom !== undefined) ? undefined
      : { sessionId: SessionId(input.sessionId), page, explanation: pair, ...origin, ...reuse }
  }
  if (explanation !== undefined) return undefined
  return {
    sessionId: SessionId(input.sessionId), page, ...origin, ...reuse,
    ...(returnedPair === undefined ? {} : { returnedPair }), ...(embeddedReturns === undefined ? {} : { returnCards: embeddedReturns }),
  }
}

function plotReading(value: unknown): value is number | null {
  return value === null || typeof value === 'number' && Number.isFinite(value)
}

function csvContinuation(value: unknown): SceneArtifactSnapshot['csvContinuation'] {
  if (!record(value) || !record(value.source) || typeof value.groupKey !== 'string' || value.groupKey.length > 256) return undefined
  const { sessionId, eventSeq, messageId, artifactId, revision } = value.source
  if (typeof sessionId !== 'string' || sessionId.length === 0 || !integer(eventSeq, 0) || typeof messageId !== 'string'
    || messageId.length === 0 || typeof artifactId !== 'string' || !ARTIFACT_ID.test(artifactId) || !integer(revision, 1)) return undefined
  return { groupKey: value.groupKey, source: { sessionId: SessionId(sessionId), eventSeq: SessionSeq(eventSeq),
    messageId: messageId as NonNullable<SceneArtifactSnapshot['csvContinuation']>['source']['messageId'], artifactId: artifactId as ArtifactId, revision } }
}

function replaySource(artifact: Record<string, unknown>): SceneArtifactSnapshot | undefined {
  const { artifactId, title, revision, presentation, spec, comparison } = artifact
  if (typeof artifactId !== 'string' || !ARTIFACT_ID.test(artifactId) || typeof title !== 'string'
    || title !== title.trim() || title.length === 0 || title.length > 120 || !integer(revision, 1)
    || (presentation !== 'inline' && presentation !== 'focus') || !record(spec)) return undefined
  if (spec.kind === 'function-plot' && record(spec.parameters) && Object.hasOwn(spec.parameters, '__proto__')) return undefined
  let relation: ArtifactComparison | undefined
  if (comparison !== undefined) {
    if (!record(comparison) || typeof comparison.group !== 'string' || !ARTIFACT_ID.test(comparison.group)
      || (comparison.role !== 'control' && comparison.role !== 'variant')) return undefined
    relation = { group: comparison.group, role: comparison.role }
  }
  try {
    const source = normalizeSceneSpec(spec)
    const continued = csvContinuation(artifact.csvContinuation)
    if (artifact.csvContinuation !== undefined && (continued === undefined || source.kind !== 'csv-bar-chart' || revision !== 1
      || !source.groups.some(group => group.key === continued.groupKey))) return undefined
    return { artifactId: artifactId as ArtifactId, title, revision, presentation, format: 'scene', spec: source,
      ...(relation === undefined ? {} : { comparison: relation }), ...(continued === undefined ? {} : { csvContinuation: continued }) }
  } catch (_error) {
    // A recognizable summary still exposes the original text when the complete source cannot be replayed.
    return undefined
  }
}

function particleReplay(
  source: Record<string, unknown>, checkpoint: ParticleCheckpoint, particles: readonly unknown[], time: number, gravityY?: number,
): ArtifactQuestionReplay | undefined {
  const artifact = replaySource(source)
  if (artifact?.spec.kind !== 'particle-system') return undefined
  const { spec } = artifact
  if (particles.length !== spec.particles.length || time !== checkpoint.stepCount * spec.timeStep) return undefined
  const readings: ParticleObservation['particles'] = []
  for (const [index, { id }] of spec.particles.entries()) {
    const reading = particles[index]
    if (!record(reading) || reading.id !== id) return undefined
    const { x, y, vx, vy } = reading
    if (typeof x !== 'number' || typeof y !== 'number' || typeof vx !== 'number' || typeof vy !== 'number') return undefined
    readings.push({ id, x, y, vx, vy })
  }
  return { artifact, state: { kind: 'particle-system', checkpoint, ...(gravityY === undefined ? {} : { gravityY }),
    values: { time, particles: readings } } }
}

function particle(value: unknown, includeReplay = false): ParticleContextSummary | undefined {
  if (!record(value) || !record(value.artifact) || !record(value.checkpoint) || !record(value.values)) return undefined
  const { artifact, checkpoint, values, gravityY } = value
  if (artifact.format !== 'scene' || !record(artifact.spec) || artifact.spec.kind !== 'particle-system'
    || typeof artifact.artifactId !== 'string' || artifact.artifactId.length === 0
    || typeof artifact.title !== 'string' || artifact.title.trim().length === 0 || !integer(artifact.revision, 1)
    || checkpoint.runtimeVersion !== PARTICLE_RUNTIME_VERSION || !integer(checkpoint.stepCount, 0)
    || gravityY !== undefined && (typeof gravityY !== 'number' || !Number.isFinite(gravityY))
    || typeof values.time !== 'number' || !Number.isFinite(values.time) || !Array.isArray(values.particles)) return undefined
  const { stepCount } = checkpoint
  const replay = includeReplay && Object.keys(checkpoint).length === 2
    ? particleReplay(artifact, { runtimeVersion: PARTICLE_RUNTIME_VERSION, stepCount }, values.particles, values.time, gravityY)
    : undefined
  return { title: artifact.title, revision: artifact.revision, stepCount, ...(replay === undefined ? {} : { replay }) }
}

function plotParameters(spec: FunctionPlotSpec, parameters: Record<string, unknown>): Record<string, number> | undefined {
  const ranges = Object.entries(spec.parameters)
  if (ranges.length !== Object.keys(parameters).length) return undefined
  const selected: Record<string, number> = {}
  for (const [key, { min, max }] of ranges) {
    const value = Object.hasOwn(parameters, key) ? parameters[key] : undefined
    if (typeof value !== 'number' || value < min || value > max) return undefined
    selected[key] = value
  }
  return selected
}

function plotReplay(
  source: Record<string, unknown>, functionId: string, x: number, parameters: Record<string, unknown>, values: FunctionAnalysis,
): ArtifactQuestionReplay | undefined {
  const artifact = replaySource(source)
  if (artifact?.spec.kind !== 'function-plot' || !artifact.spec.functions.some(fn => fn.id === functionId)) return undefined
  const selected = plotParameters(artifact.spec, parameters)
  return selected === undefined ? undefined : { artifact, state: { kind: 'function-plot', functionId, x, parameters: selected, values } }
}

function plotSummary(facts: Record<string, unknown>, includeReplay: boolean): QuestionContextSummary | undefined {
  if (facts.kind !== 'current-function-plot' || !record(facts.artifact) || !record(facts.parameters) || !record(facts.values)
    || typeof facts.functionId !== 'string' || typeof facts.x !== 'number' || !Number.isFinite(facts.x)) return undefined
  const { artifact, parameters, values } = facts
  const { value, derivative, integral } = values
  if (artifact.format !== 'scene' || !record(artifact.spec) || artifact.spec.kind !== 'function-plot'
    || typeof artifact.artifactId !== 'string' || artifact.artifactId.length === 0
    || typeof artifact.title !== 'string' || artifact.title.trim().length === 0 || !integer(artifact.revision, 1)
    || !Object.values(parameters).every(value => typeof value === 'number' && Number.isFinite(value))
    || !plotReading(value) || !plotReading(derivative) || !plotReading(integral)) {
    return undefined
  }
  const replay = includeReplay ? plotReplay(artifact, facts.functionId, facts.x, parameters, { value, derivative, integral }) : undefined
  return { title: artifact.title, revision: artifact.revision, x: facts.x, ...(replay === undefined ? {} : { replay }) }
}

function csvSummary(facts: Record<string, unknown>): QuestionContextSummary | undefined {
  if (facts.kind !== 'current-csv-bar-chart' || !record(facts.artifact) || facts.artifact.format !== 'scene'
    || typeof facts.groupKey !== 'string' || !record(facts.values)) return undefined
  const artifact = replaySource(facts.artifact)
  if (artifact?.spec.kind !== 'csv-bar-chart') return undefined
  if (artifact.csvContinuation !== undefined && artifact.csvContinuation.groupKey !== facts.groupKey) return undefined
  const group = artifact.spec.groups.find(row => row.key === facts.groupKey)
  if (group === undefined || group.key !== facts.values.key
    || group.value !== facts.values.value || group.count !== facts.values.count) return undefined
  const state = { kind: 'csv-bar-chart', group } as const
  return { title: artifact.title, revision: artifact.revision, csv: state, replay: { artifact, state } }
}

/**
 * Validate the native scene and readings in a recorded question.
 * @param facts - Untrusted JSON facts carried in a durable question or branch result.
 * @returns Read-only replay input for the recorded native scene, if supported.
 */
export function nativeQuestionFactsReplay(facts: unknown): ArtifactQuestionReplay | undefined {
  if (!record(facts) || !isBoundedArtifactJson(facts, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES)) return undefined
  if (facts.kind === 'current-function-plot') return plotSummary(facts, true)?.replay
  if (facts.kind === 'current-csv-bar-chart') return csvSummary(facts)?.replay
  return facts.kind === 'current-particle' ? particle(facts, true)?.replay : undefined
}

/**
 * Validate the native scene and checkpoint in a saved observation.
 * @param value - Untrusted JSON observation carried in a durable branch result.
 * @returns Read-only replay input when the observation includes a complete supported particle source.
 */
export function savedParticleReplay(value: unknown): ArtifactQuestionReplay | undefined {
  if (!record(value) || typeof value.observationId !== 'string' || value.observationId === ''
    || !isBoundedArtifactJson(value, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES)) return undefined
  return particle(value, true)?.replay
}

/**
 * Read one complete recorded native question attachment.
 * @param text - Original durable text block.
 * @param sessionId - When supplied, the Session identity required by the caller.
 * @returns Read-only replay input if the full block matches the recorded attachment format.
 */
export function parseNativeQuestionReplay(text: string, sessionId?: string): ArtifactQuestionReplay | undefined {
  const prefix = NATIVE_CONTEXT_PREFIXES.find(candidate => text.startsWith(candidate))
  if (prefix === undefined || text.length - prefix.length > MAX_REPLAY_CONTEXT_LENGTH
    || text.indexOf('\n', prefix.length) !== -1) return undefined
  let input: unknown
  try { input = JSON.parse(text.slice(prefix.length)) } catch (_error) { return undefined }
  if (!record(input) || (sessionId !== undefined && input.sessionId !== sessionId)) return undefined
  return summary(input, prefix, true)?.replay
}

function summary(input: unknown, prefix: string, withinReplayLimit: boolean): QuestionContextSummary | undefined {
  if (!record(input) || input.kind !== 'artifact-question-context' || typeof input.sessionId !== 'string'
    || input.sessionId.length === 0 || !record(input.facts)) return undefined
  const facts = input.facts
  const plot = prefix === PLOT_CONTEXT_PREFIX
  if (prefix === CSV_CONTEXT_PREFIX || prefix === CONTINUED_CSV_QUESTION_PREFIX) return withinReplayLimit
    && isBoundedArtifactJson(facts, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES) ? csvSummary(facts) : undefined
  if (plot || facts.kind === 'current-particle') {
    const includeReplay = withinReplayLimit && isBoundedArtifactJson(facts, ARTIFACT_JSON_MAX_DEPTH, ARTIFACT_JSON_MAX_NODES)
    const selected = plot ? plotSummary(facts, includeReplay) : particle(facts, includeReplay)
    return selected?.replay === undefined ? selected : { ...selected, sessionId: SessionId(input.sessionId) }
  }
  if (facts.kind === 'observation') {
    if (!record(facts.observation) || typeof facts.observation.observationId !== 'string'
      || facts.observation.observationId.length === 0) return undefined
    return particle(facts.observation)
  }
  if (facts.kind !== 'comparison' || typeof facts.group !== 'string' || facts.group.length === 0
    || !record(facts.conditions)) return undefined
  const control = particle(facts.control)
  const variant = particle(facts.variant)
  if (control === undefined || variant === undefined || control.stepCount !== variant.stepCount
    || facts.conditions.runtimeVersion !== PARTICLE_RUNTIME_VERSION || facts.conditions.stepCount !== control.stepCount) return undefined
  return { ...control, variantTitle: variant.title, variantRevision: variant.revision }
}

function branchSummary(input: unknown): QuestionContextSummary | undefined {
  if (!record(input) || input.kind !== 'artifact-question-context' || typeof input.sessionId !== 'string'
    || input.sessionId.length === 0 || !record(input.facts) || input.facts.kind !== 'branch-evidence') return undefined
  const { branchResult, readings } = input.facts
  if (!record(branchResult) || !integer(branchResult.eventSeq, 0) || typeof branchResult.messageId !== 'string'
    || branchResult.messageId.length === 0 || typeof branchResult.branchSessionId !== 'string' || branchResult.branchSessionId.length === 0
    || !integer(branchResult.resultSeq, 0) || !integer(branchResult.questionSeq, 0) || branchResult.questionSeq >= branchResult.resultSeq) {
    return undefined
  }
  const replay = nativeQuestionFactsReplay(readings)
  if (replay === undefined) return undefined
  const { artifact: { title, revision }, state } = replay
  const source = { title, revision, replay, origin: 'branch-evidence' } as const
  if (state.kind === 'csv-bar-chart') return { ...source, csv: state }
  return state.kind === 'function-plot' ? { ...source, x: state.x } : { ...source, stepCount: state.checkpoint.stepCount }
}

/** Recognize a complete prefix and single JSON line; malformed or unknown text stays ordinary text. */
export const questionContextTextRule: UserTextRule<'artifact-question-context'> = {
  id: 'artifact-question-context', order: 5,
  match(text, from) {
    for (let start = text.indexOf(SELECTED_CONTEXT_START, from); start >= 0;
      start = text.indexOf(SELECTED_CONTEXT_START, start + SELECTED_CONTEXT_START.length)) {
      const prefix = QUESTION_CONTEXT_PREFIXES.find(candidate => text.startsWith(candidate, start))
      if (prefix === undefined) continue
      const jsonStart = start + prefix.length
      const nextLine = text.indexOf('\n', jsonStart)
      const end = nextLine < 0 ? text.length : nextLine
      const withinReplayLimit = end - jsonStart <= MAX_REPLAY_CONTEXT_LENGTH
      if (prefix === BRANCH_CONTEXT_PREFIX && !withinReplayLimit) continue
      let parsed: unknown
      try { parsed = JSON.parse(text.slice(jsonStart, end)) } catch (_error) {
        // Partial or authored non-JSON text remains visible.
        continue
      }
      const data = prefix === BRANCH_CONTEXT_PREFIX ? branchSummary(parsed)
        : summary(parsed, prefix, withinReplayLimit)
      if (data !== undefined) return { id: 'artifact-question-context', start, end, data }
    }
    return undefined
  },
}

/** Recognize the stored comparison and reviewed record page on an ordinary follow-up. */
export const csvComparisonContextTextRule: UserTextRule<'artifact-csv-comparison-context'> = {
  id: 'artifact-csv-comparison-context', order: 5,
  match(text, from) {
    let cursor = from
    while (cursor < text.length) {
      let start = text.length
      let prefix: typeof CSV_COMPARISON_CONTEXT_PREFIXES[number] | undefined
      for (const candidate of CSV_COMPARISON_CONTEXT_PREFIXES) {
        const index = text.indexOf(candidate, cursor)
        if (index >= 0 && index < start) { start = index; prefix = candidate }
      }
      if (prefix === undefined) break
      const jsonStart = start + prefix.length
      cursor = jsonStart
      const nextLine = text.indexOf('\n', jsonStart)
      const end = nextLine < 0 ? text.length : nextLine
      if (end - jsonStart > MAX_REPLAY_CONTEXT_LENGTH) continue
      let input: unknown
      try { input = JSON.parse(text.slice(jsonStart, end)) } catch (_error) { continue }
      const data = csvComparisonSummary(input, prefix)
      if (data === undefined) continue
      // User text concatenates blocks without separators. The source note and change appendix carry their own newlines.
      let sourceText: string | undefined
      if (prefix === IMPORTED_CSV_COMPARISON_QUESTION_PREFIX) {
        sourceText = data.returnCards === undefined ? IMPORTED_CSV_SINGLE_SOURCE_TEXT : IMPORTED_CSV_RETURN_SOURCE_TEXT
      } else if (prefix === IMPORTED_CSV_COMPARISON_EXPLANATION_PREFIX) {
        sourceText = IMPORTED_CSV_EXPLANATION_SOURCE_TEXT
      }
      let matchedEnd = end
      if (sourceText !== undefined && text.startsWith(sourceText, end)) {
        const sourceEnd = end + sourceText.length
        if (sourceEnd === text.length || text[sourceEnd] === '\n') matchedEnd = sourceEnd
      }
      const appendix = data.explanation === undefined && text.startsWith(CSV_COMPARISON_CHANGES_PREFIX, matchedEnd)
        ? csvComparisonChangesText(data.page) : undefined
      if (appendix !== undefined && text.startsWith(appendix, matchedEnd)) matchedEnd += appendix.length
      return { id: 'artifact-csv-comparison-context', start, end: matchedEnd, data }
    }
    return undefined
  },
}

/** Recognize only the program-report format; the existing evaluator orders this beside particle contexts. */
export const programContextTextRule: UserTextRule<'artifact-program-context'> = {
  id: 'artifact-program-context', order: 5,
  match(text, from) {
    for (let start = text.indexOf(PROGRAM_CONTEXT_START, from); start >= 0;
      start = text.indexOf(PROGRAM_CONTEXT_START, start + PROGRAM_CONTEXT_START.length)) {
      const prefix = PROGRAM_CONTEXT_PREFIXES.find(candidate => text.startsWith(candidate, start))
      if (prefix === undefined) continue
      const jsonStart = start + prefix.length
      const nextLine = text.indexOf('\n', jsonStart)
      const end = nextLine < 0 ? text.length : nextLine
      if (prefix !== PROGRAM_CONTEXT_PREFIX && end - jsonStart > MAX_REPLAY_CONTEXT_LENGTH) continue
      let parsed: unknown
      try { parsed = JSON.parse(text.slice(jsonStart, end)) } catch (_error) {
        // Partial or authored non-JSON text remains visible.
        continue
      }
      const data = programSummary(parsed, prefix)
      if (data !== undefined) return { id: 'artifact-program-context', start, end, data }
    }
    return undefined
  },
}
