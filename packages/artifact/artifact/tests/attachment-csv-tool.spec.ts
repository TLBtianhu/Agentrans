import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import AgentRegistry, { type Agent } from '@agentrans/agent'
import AttachmentStore, { AttachmentId, type FileAttachmentRef } from '@agentrans/attachment'
import { Context } from '@agentrans/cordis'
import { createUserMessage, MessageId, ToolCallId, type UserMessage } from '@agentrans/llm'
import SessionStore, { Session, SessionId, SessionLogOffset, SessionSeq } from '@agentrans/session'
import SessionProjectionRegistry from '@agentrans/session-projection'
import SystemPrompt from '@agentrans/system-prompt'
import * as NativeToolExecutor from '@agentrans/tool-executor-native'
import { executeModelToolFixture } from '@agentrans/tool-testkit'
import ToolRuntime from '@agentrans/tools'
import * as CsvTool from '../src/attachment-csv-tool.ts'
import ArtifactService from '../src/index.ts'
import * as HtmlTool from '../src/tool.ts'
import * as SceneTool from '../src/scene-tool.ts'
import type { ArtifactId } from '../src/types.ts'

class MemoryAttachments extends AttachmentStore {
  readonly imageLimits = {
    maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImagePixels: 1, maxImageDimension: 1, mediaTypes: [],
  }
  readonly objects = new Map<AttachmentId, Uint8Array>()
  readonly reads: FileAttachmentRef[] = []

  validateImage(): never { throw new Error('Unexpected image call') }
  saveImage(): never { throw new Error('Unexpected image call') }
  readImage(): never { throw new Error('Unexpected image call') }

  upload(name: string, buffer: Uint8Array): FileAttachmentRef {
    const attachmentId = AttachmentId(`sha256:${createHash('sha256').update(buffer).digest('hex')}`)
    this.objects.set(attachmentId, buffer)
    return { attachmentId, name, bytes: buffer.byteLength }
  }

  override async *readFileStream(ref: FileAttachmentRef): AsyncIterable<Uint8Array> {
    this.reads.push(ref)
    const buffer = this.objects.get(ref.attachmentId)
    if (buffer === undefined) throw new Error('Unexpected read of unknown attachment')
    // Exercise decoding when a multi-byte character straddles chunks.
    for (let start = 0; start < buffer.byteLength; start += 9) yield buffer.subarray(start, start + 9)
  }
}

const contexts: Context[] = []
let serial = 0

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(MemoryAttachments)
  await ctx.plugin(ArtifactService)
  await ctx.plugin(CsvTool, {})
  const store = ctx.attachments as MemoryAttachments

  function execute(session: Session, args: unknown, name = 'attachment_csv') {
    const agent = { id: session.id, session, ctx } as Agent
    return executeModelToolFixture(ctx, {
      callId: ToolCallId(`csv-call-${++serial}`), name, arguments: args,
      signal: new AbortController().signal, agent,
    })
  }
  return { ctx, store, execute }
}

function appendFile(session: Session, attachment: FileAttachmentRef, source: UserMessage['source'] = { kind: 'user' }): void {
  session.append('user/message', createUserMessage({ source, content: [{ type: 'file', attachment }] }), { surfaceOp: 'append' })
}

describe('attachment_csv', () => {
  it('filters before aggregation and pages the exact contributing source records', async () => {
    const { store } = await setup()
    const warmRows = Array.from({ length: 10 }, (_, index) => `Warm,B,${index + 1}`).join('\n')
    const csv = 'Trial,Batch,LatencyMs\nWarm,b,200\nWarm, B,300\nCold,B,60\n' + warmRows + '\n'
    const ref = store.upload('batches.csv', Buffer.from(csv))
    const signal = new AbortController().signal
    const filter = { column: 'Batch', value: 'B' }
    const recipe = { groupBy: 'Trial', valueColumn: 'LatencyMs', filter }
    const spec = await CsvTool.groupCsvAttachment(store, ref, { ...recipe, aggregate: 'sum' }, signal)
    expect(spec).toMatchObject({ filter, rowCount: 11, groups: [{ key: 'Cold', value: 60, count: 1 }, { key: 'Warm', value: 55, count: 10 }] })
    expect(await CsvTool.readCsvFilterOptions(store, ref, 'Batch', signal))
      .toEqual({ columns: ['Trial', 'Batch', 'LatencyMs'], values: ['b', ' B', 'B'], hasMore: false })
    const page = await CsvTool.readCsvParticipatingRows(store, ref, { ...recipe, groupKey: 'Warm', offset: 0 }, signal)
    expect(page).toMatchObject({ total: 10, nextOffset: 8, rows: [
      ...Array.from({ length: 8 }, (_, index) => ({ record: index + 5, filterValue: 'B', value: String(index + 1) })),
    ] })
    expect(await CsvTool.readCsvParticipatingRows(store, ref, { ...recipe, groupKey: 'Warm', offset: 8 }, signal)).toEqual({
      total: 10, offset: 8, rows: [{ record: 13, filterValue: 'B', value: '9' }, { record: 14, filterValue: 'B', value: '10' }],
    })
    expect(await CsvTool.groupCsvAttachment(store, ref, { ...recipe, aggregate: 'sum', filter: { ...filter, value: 'missing' } }, signal))
      .toMatchObject({ rowCount: 0, groups: [] })
  })

  it('pages the comparison union by logical CSV record when the two row counts are equal', async () => {
    const { store } = await setup()
    const rows = Array.from({ length: 10 }, (_, index) => `Warm,${index % 2 === 0 ? 'A' : 'B'},${index + 1},"do not expose\nthis"`)
    const csv = ['Trial,Batch,LatencyMs,Private', 'Cold,A,50,ignore', 'Warm,C,41,ignore', ...rows].join('\n')
    const ref = store.upload('batches.csv', Buffer.from(csv))
    const signal = new AbortController().signal
    const recipe = { groupBy: 'Trial', groupKey: 'Warm', valueColumn: 'LatencyMs',
      originalFilter: { column: 'Batch', value: 'A' }, currentFilter: { column: 'Batch', value: 'B' } }
    const first = await CsvTool.compareCsvParticipatingRows(store, ref, { ...recipe, offset: 0 }, signal)
    expect(first).toMatchObject({ kept: 0, excluded: 5, added: 5, total: 10, offset: 0, nextOffset: 8 })
    expect(first.rows).toHaveLength(8)
    expect(first.rows[0]).toEqual({ record: 4, status: 'excluded', originalFilterValue: 'A', currentFilterValue: 'A', value: '1' })
    expect(await CsvTool.compareCsvParticipatingRows(store, ref, { ...recipe, offset: first.nextOffset ?? 10 }, signal)).toEqual({
      kept: 0, excluded: 5, added: 5, total: 10, offset: 8,
      rows: [{ record: 12, status: 'excluded', originalFilterValue: 'A', currentFilterValue: 'A', value: '9' },
        { record: 13, status: 'added', originalFilterValue: 'B', currentFilterValue: 'B', value: '10' }],
    })
  })

  it('rejects an escaped comparison record that would stall pagination', async () => {
    const { store } = await setup()
    const wideCell = '\0'.repeat(4096)
    const ref = store.upload('wide.csv', Buffer.from(`Trial,Original,Current\nWarm,A,${wideCell}\nWarm,${wideCell},B\n`))
    const signal = new AbortController().signal
    const recipe = { groupBy: 'Trial', groupKey: 'Warm', valueColumn: 'Current',
      originalFilter: { column: 'Original', value: 'A' }, currentFilter: { column: 'Current', value: 'B' } }
    await expect(CsvTool.compareCsvParticipatingRows(store, ref, { ...recipe, offset: 0 }, signal)).rejects.toMatchObject({ code: 'CSV_LIMIT' })
  })

  it('calculates bar-chart revisions from visible CSV only and keeps calculations in the original revision', async () => {
    const { ctx, store, execute } = await setup()
    await ctx.plugin(HtmlTool, {})
    await ctx.plugin(SceneTool, {})
    const session = ctx.sessions.create(SessionId('csv-chart'))
    const ref = store.upload('trials.csv', Buffer.from('Trial,LatencyMs\nBaseline,5\nWarm,20\nWarm,40\nCold,-20\n'))
    appendFile(session, ref)
    const args = { attachmentId: ref.attachmentId, groupBy: 'Trial', valueColumn: 'LatencyMs', artifactId: 'trial-latency', title: 'Trial latency' }
    const create = { ...args, operation: 'create_chart', aggregate: 'mean' }
    const injectedGroups = await execute(session, { ...create, groups: [{ key: 'Warm', value: 900, count: 2 }] })
    expect(injectedGroups.isError).toBe(true)
    expect(store.reads).toEqual([])
    const mean = await execute(session, create)
    const meanGroups = [{ key: 'Baseline', value: 5, count: 1 }, { key: 'Warm', value: 30, count: 2 }, { key: 'Cold', value: -20, count: 1 }]
    expect(mean.isError).toBe(false)
    expect(mean.value).toMatchObject({ kind: 'csv-bar-chart', artifactId: args.artifactId, revision: 1, rowCount: 4, groups: meanGroups })
    const convertHtml = await execute(session, {
      action: 'update', artifactId: args.artifactId, title: args.title, baseRevision: 1, presentation: 'inline', source: '<p>fake</p>',
    }, 'artifact')
    expect(convertHtml.isError).toBe(true)
    const convertScene = await execute(session, {
      action: 'update', sceneId: args.artifactId, kind: 'flowchart', title: args.title, baseRevision: 1, presentation: 'inline',
      spec: { nodes: [{ id: 'a', label: 'A', x: 0, y: 0 }], edges: [] },
    }, 'scene')
    expect(convertScene.isError).toBe(true)

    const update = { ...args, operation: 'update_chart', aggregate: 'sum' }
    const stale = await execute(session, { ...update, baseRevision: 3 })
    expect(stale.isError).toBe(true)
    const sum = await execute(session, { ...update, baseRevision: 1 })
    const sumGroups = [{ key: 'Baseline', value: 5, count: 1 }, { key: 'Warm', value: 60, count: 2 }, { key: 'Cold', value: -20, count: 1 }]
    expect(sum.isError).toBe(false)
    expect(sum.value).toMatchObject({ kind: 'csv-bar-chart', artifactId: args.artifactId, revision: 2, rowCount: 4, groups: sumGroups })
    const events = session.snapshotEvents().filter(event => event.type === 'artifact/upsert')
    expect(events.map(event => event.data)).toMatchObject([
      { revision: 1, artifactId: args.artifactId, spec: { kind: 'csv-bar-chart', attachmentId: ref.attachmentId, aggregate: 'mean', groups: meanGroups } },
      { revision: 2, artifactId: args.artifactId, spec: { kind: 'csv-bar-chart', attachmentId: ref.attachmentId, aggregate: 'sum', groups: sumGroups } },
    ])
    const unrelated = ctx.sessions.create(SessionId('csv-chart-unrelated'))
    expect((await execute(unrelated, create)).isError).toBe(true)
  })

  it('reports empty and oversized charts without publishing a partial revision', async () => {
    const { ctx, store, execute } = await setup()
    const session = ctx.sessions.create(SessionId('csv-chart-bounds'))
    const empty = store.upload('empty.csv', Buffer.from('x,y\n'))
    const large = store.upload('large-chart.csv', Buffer.from('x,y\n' + Array.from({ length: 35 }, (_, index) => `${'a'.repeat(240)}${index},1`).join('\n')))
    appendFile(session, empty)
    appendFile(session, large)
    for (const [ref, message] of [[empty, 'must be an integer between 1 and 20000'], [large, 'CSV chart exceeds 6500 UTF-8 bytes']] as const) {
      const result = await execute(session, {
        operation: 'create_chart', attachmentId: ref.attachmentId, groupBy: 'x', aggregate: 'count', artifactId: 'too-large', title: 'Chart',
      })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain(message)
    }
    expect(session.snapshotEvents().filter(event => event.type === 'artifact/upsert')).toHaveLength(0)
  })

  it.each([
    { aggregate: 'sum', values: [1e16, 1, -1e16], reading: 1 },
    { aggregate: 'sum', values: [1e308, 1e308, -1e308], reading: 1e308 },
    { aggregate: 'mean', values: [1e308, 1e308], reading: 1e308 },
    { aggregate: 'mean', values: [-1e308, -1e308], reading: -1e308 },
    { aggregate: 'mean', values: [1, 1 + Number.EPSILON], reading: 1 },
    { aggregate: 'mean', values: [1, 1 + Number.EPSILON, 1 + Number.EPSILON], reading: 1 + Number.EPSILON },
    { aggregate: 'mean', values: [1 + Number.EPSILON, 1 + 2 * Number.EPSILON], reading: 1 + 2 * Number.EPSILON },
    { aggregate: 'mean', values: [0, -Number.MIN_VALUE], reading: 0 },
    { aggregate: 'mean', values: [Number.MIN_VALUE, 2 * Number.MIN_VALUE], reading: 2 * Number.MIN_VALUE },
    { aggregate: 'mean', values: [1e308, 6 * Number.MIN_VALUE, -1e308], reading: 2 * Number.MIN_VALUE },
  ])('records the rounded $aggregate of $values as $reading in the chart revision', async ({ aggregate, values, reading }) => {
    const { ctx, store, execute } = await setup()
    const session = ctx.sessions.create(SessionId('csv-numeric-chart'))
    const ref = store.upload('measurements.csv', Buffer.from(['Group,Reading', ...values.map(value => `A,${value}`)].join('\n')))
    appendFile(session, ref)
    const created = await execute(session, {
      operation: 'create_chart', attachmentId: ref.attachmentId, groupBy: 'Group', valueColumn: 'Reading',
      aggregate, artifactId: 'measurements', title: 'Measurements',
    })
    const groups = [{ key: 'A', value: reading, count: values.length }]
    expect(created.isError).toBe(false)
    expect(created.value).toMatchObject({ revision: 1, aggregate, groups })
    expect(session.snapshotEvents().filter(event => event.type === 'artifact/upsert').map(event => event.data)).toMatchObject([
      { revision: 1, spec: { aggregate, groups } },
    ])
  })

  it('reads original CSV cells and calculates complete groups in input order', async () => {
    const { ctx, store, execute } = await setup()
    const session = ctx.sessions.create(SessionId('csv-main'))
    const ref = store.upload('trials.CSV', Buffer.from('\uFEFFTrial,LatencyMs,Notes\r\n"冷,启动",20,"first\r\nline"\r\n__proto__,1e1,""\r\n"冷,启动",40,"a ""quote"""\r\n__proto__,.5,plain\r\nWarm,+12,end\r\nWarm,18,end\r\n'))
    appendFile(session, ref)

    const inspect = await execute(session, { operation: 'inspect', attachmentId: ref.attachmentId })
    expect(inspect.isError).toBe(false)
    expect(inspect.value).toEqual({
      attachmentId: ref.attachmentId, columns: ['Trial', 'LatencyMs', 'Notes'], rowCount: 6,
      preview: [['冷,启动', '20', 'first\r\nline'], ['__proto__', '1e1', ''], ['冷,启动', '40', 'a "quote"'],
        ['__proto__', '.5', 'plain'], ['Warm', '+12', 'end']],
    })

    const group = await execute(session, {
      operation: 'group', attachmentId: ref.attachmentId, groupBy: 'Trial', aggregate: 'mean', valueColumn: 'LatencyMs',
    })
    expect(group.isError).toBe(false)
    expect(group.value).toEqual({
      attachmentId: ref.attachmentId, groupBy: 'Trial', aggregate: 'mean', valueColumn: 'LatencyMs', rowCount: 6,
      groups: [{ key: '冷,启动', value: 30, count: 2 }, { key: '__proto__', value: 5.25, count: 2 }, { key: 'Warm', value: 15, count: 2 }],
    })
    expect(group.content).toEqual([{ type: 'text', text: JSON.stringify(group.value) }])

    for (const [aggregate, expected] of [['sum', 60], ['min', 20], ['max', 40], ['count', 2]] as const) {
      const result = await execute(session, {
        operation: 'group', attachmentId: ref.attachmentId, groupBy: 'Trial', aggregate,
        ...(aggregate === 'count' ? {} : { valueColumn: 'LatencyMs' }),
      })
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ groups: [{ key: '冷,启动', value: expected, count: 2 }, {}, {}] })
    }
    expect(store.reads).toEqual(Array.from({ length: 6 }, () => ref))
  })

  it('allows the inherited prefix and excludes unrelated, future, queued and non-user files', async () => {
    const { ctx, store, execute } = await setup()
    const parent = ctx.sessions.create(SessionId('csv-parent'))
    const rootFile = store.upload('root.csv', Buffer.from('x,y\nroot,1'))
    appendFile(parent, rootFile)
    const seed = parent.snapshotEvents()
    const child = ctx.sessions.create(SessionId('csv-child'), {
      seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { parentSession: parent.id, isSeeded: true },
    })
    const sibling = ctx.sessions.create(SessionId('csv-sibling'), {
      seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { parentSession: parent.id, isSeeded: true },
    })
    const about = (attachmentId: string) => ({ operation: 'inspect', attachmentId })
    const lateFile = store.upload('late.csv', Buffer.from('x,y\nlate,2'))
    const siblingFile = store.upload('sibling.csv', Buffer.from('x,y\nsibling,3'))
    const projectedFile = store.upload('plugin.csv', Buffer.from('x,y\nplugin,4'))
    const queuedFile = store.upload('queued.csv', Buffer.from('x,y\nqueued,5'))
    const nonCsv = store.upload('note.txt', Buffer.from('x,y\nnote,6'))
    appendFile(parent, lateFile)
    appendFile(sibling, siblingFile)
    appendFile(child, nonCsv)
    appendFile(child, projectedFile, { kind: 'system-prompt' })
    child.append('agent/inbox/spliced', {
      target: 'next-step', start: 0,
      inserted: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'file', attachment: queuedFile }] })],
    })

    for (const ref of [lateFile, siblingFile, projectedFile, queuedFile, nonCsv]) {
      const denied = await execute(child, about(ref.attachmentId))
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('CSV attachment is unavailable in this conversation.')
    }
    const forgedPath = await execute(child, about('C:\\uploads\\root.csv'))
    expect(forgedPath.isError).toBe(true)
    expect(store.reads).toEqual([])
    expect((await execute(child, about(rootFile.attachmentId))).value).toMatchObject({ preview: [['root', '1']] })
    expect((await execute(parent, about(lateFile.attachmentId))).value).toMatchObject({ preview: [['late', '2']] })
    const restored = Session.create(child.id, child.snapshotEvents(), child.header, child.inheritedEventCount)
    expect((await execute(restored, about(rootFile.attachmentId))).value).toMatchObject({ preview: [['root', '1']] })
    expect(store.reads).toEqual([rootFile, lateFile, rootFile])
  })

  it('keeps a branch-only file outside generic CSV tool access after saving a continued chart in its parent', async () => {
    const { ctx, store, execute } = await setup()
    const parent = ctx.sessions.create(SessionId('csv-return-parent'))
    const seed = parent.snapshotEvents()
    const child = ctx.sessions.create(SessionId('csv-return-child'), {
      seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { parentSession: parent.id, isSeeded: true },
    })
    const attachment = store.upload('branch-only.csv', Buffer.from('Trial,LatencyMs\nWarm,25\nWarm,35\n'))
    appendFile(child, attachment)
    const parentAgent = { id: parent.id, session: parent, ctx } as Agent
    ctx.artifacts.commit(parentAgent, {
      artifactId: `continued-csv-${'c'.repeat(32)}` as ArtifactId, revision: 1, format: 'scene', presentation: 'inline', title: 'Total latency',
      spec: { kind: 'csv-bar-chart', attachmentId: attachment.attachmentId, groupBy: 'Trial', valueColumn: 'LatencyMs', aggregate: 'sum',
        rowCount: 2, groups: [{ key: 'Warm', value: 60, count: 2 }] },
      csvContinuation: { source: { sessionId: parent.id, eventSeq: SessionSeq(0), messageId: MessageId('notice'),
        artifactId: 'branch-chart' as ArtifactId, revision: 1 }, groupKey: 'Warm' },
    })
    const inspection = { operation: 'inspect', attachmentId: attachment.attachmentId }
    const denied = await execute(parent, inspection)
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('CSV attachment is unavailable in this conversation.')
    expect(store.reads).toEqual([])
    expect((await execute(child, inspection)).isError).toBe(false)
    expect(store.reads).toEqual([attachment])
  })

  it('rejects malformed, non-numeric, or oversized data without returning partial readings', async () => {
    const { ctx, store, execute } = await setup()
    const session = ctx.sessions.create(SessionId('csv-invalid'))
    const oversized = store.upload('large.csv', Buffer.alloc(1_048_577))
    appendFile(session, oversized)
    const tooLarge = await execute(session, { operation: 'inspect', attachmentId: oversized.attachmentId })
    expect(tooLarge.isError).toBe(true)
    expect(JSON.stringify(tooLarge.content)).toContain('exceeds 1048576 bytes')
    expect(store.reads).toEqual([])

    const tests = [
      { input: Buffer.from('a,b\nA,"broken'), expected: 'CSV syntax error at record 2' },
      { input: Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0xff, 0x2c, 0x31]), expected: 'CSV attachment must be valid UTF-8' },
      { input: Buffer.from('a,b\nA,1\nB,2,3'), expected: 'record 3 has a different number of fields' },
      { input: Buffer.from('a,b\nA,1\nB,0xff'), expected: 'record 3 requires a finite decimal' },
      { input: Buffer.from('a,b\nA,1e308\nA,1e308'), expected: 'grouped total exceeds the numeric range' },
    ]
    for (const { input, expected } of tests) {
      const ref = store.upload('invalid.csv', input)
      appendFile(session, ref)
      const failed = await execute(session, {
        operation: 'group', attachmentId: ref.attachmentId, groupBy: 'a', aggregate: 'sum', valueColumn: 'b',
      })
      expect(failed.isError).toBe(true)
      expect(failed.value).toBeUndefined()
      expect(JSON.stringify(failed.content)).toContain(expected)
    }
  })
})
