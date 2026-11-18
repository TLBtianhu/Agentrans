/** Bounded parsing and grouped calculations for model-facing CSV attachments. */

import { Buffer } from 'node:buffer'
import type { AttachmentId, AttachmentStore, FileAttachmentRef } from '@agentrans/attachment'
import { HarnessError } from '@agentrans/llm'
import Papa from 'papaparse'
import type { CsvAggregate, CsvExactFilter } from './scene.ts'

const MAX_FILE_BYTES = 1_048_576
const MAX_ROWS = 20_000
const MAX_COLUMNS = 64
const MAX_COLUMN_BYTES = 128
const MAX_FIELD_BYTES = 4_096
const MAX_GROUPS = 64
const MAX_GROUP_BYTES = 256
const MAX_RESULT_BYTES = 32_768
const PREVIEW_ROWS = 5
const FILTER_VALUES = 100
const PARTICIPATING_ROWS_PER_PAGE = 8
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u

export interface CsvInspection {
  attachmentId: string
  columns: string[]
  rowCount: number
  preview: string[][]
}

interface GroupOptions {
  groupBy: string
  valueColumn?: string
  aggregate: CsvAggregate
  filter?: CsvExactFilter
}

export interface CsvFilterOptions {
  readonly columns: readonly string[]
  readonly values: readonly string[]
  readonly hasMore: boolean
}

export interface CsvParticipatingRow {
  readonly record: number
  readonly filterValue?: string
  readonly value?: string
}

interface CsvRecordPage<Row> {
  readonly rows: readonly Row[]
  readonly total: number
  readonly offset: number
  readonly nextOffset?: number
}

export type CsvParticipatingRows = CsvRecordPage<CsvParticipatingRow>

export interface CsvParticipantsRequest extends Omit<GroupOptions, 'aggregate'> {
  readonly groupKey: string
  readonly offset: number
}

export interface CsvCompareParticipantsRequest extends Omit<CsvParticipantsRequest, 'filter'> {
  readonly originalFilter?: CsvExactFilter
  readonly currentFilter?: CsvExactFilter
}

interface CsvComparisonRow extends Omit<CsvParticipatingRow, 'filterValue'> {
  readonly status: 'kept' | 'excluded' | 'added'
  readonly originalFilterValue?: string
  readonly currentFilterValue?: string
}

export interface CsvComparedParticipants extends CsvRecordPage<CsvComparisonRow> {
  readonly kept: number
  readonly excluded: number
  readonly added: number
}

interface GroupReading {
  key: string
  value: number
  count: number
}

export interface CsvGrouping extends GroupOptions {
  attachmentId: AttachmentId
  rowCount: number
  groups: GroupReading[]
}

export class CsvAttachmentError extends HarnessError {}

/** Consume the entire integrity-checked store read before returning any data. */
export async function readCsvText(
  attachments: AttachmentStore,
  ref: FileAttachmentRef,
  signal: AbortSignal,
): Promise<string> {
  if (ref.bytes > MAX_FILE_BYTES) {
    throw new CsvAttachmentError(`CSV attachment exceeds ${MAX_FILE_BYTES} bytes.`, 'CSV_LIMIT')
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunks: string[] = []
  let bytes = 0
  for await (const chunk of attachments.readFileStream(ref, signal)) {
    signal.throwIfAborted()
    bytes += chunk.byteLength
    if (bytes > MAX_FILE_BYTES) throw new CsvAttachmentError(`CSV attachment exceeds ${MAX_FILE_BYTES} bytes.`, 'CSV_LIMIT')
    chunks.push(decodeUtf8(decoder, chunk))
  }
  signal.throwIfAborted()
  chunks.push(decodeUtf8(decoder))
  return chunks.join('')
}

function decodeUtf8(decoder: TextDecoder, chunk?: Uint8Array): string {
  try {
    return decoder.decode(chunk, { stream: chunk !== undefined })
  } catch (cause) {
    throw new CsvAttachmentError('CSV attachment must be valid UTF-8.', 'CSV_ENCODING', { cause })
  }
}

function parseCsv(text: string, readHeader: (columns: string[]) => void, readRow: (fields: string[], row: number) => void): number {
  let columns: string[] | undefined
  let rowCount = 0
  let failure: Error | undefined
  // Papa Parse reports a final line terminator as an extra empty record.
  const input = text.replace(/(?:\r\n|\r|\n)$/u, '')
  Papa.parse<string[]>(input, {
    delimiter: ',', header: false, dynamicTyping: false, skipEmptyLines: false,
    step(result, parser) {
      try {
        if (result.errors.length > 0) {
          throw new CsvAttachmentError(`CSV syntax error at record ${rowCount + (columns === undefined ? 1 : 2)}.`, 'CSV_INVALID')
        }
        const fields = result.data
        if (columns === undefined) {
          validateHeader(fields)
          columns = fields
          readHeader(columns)
          return
        }
        rowCount += 1
        if (rowCount > MAX_ROWS) throw new CsvAttachmentError(`CSV exceeds ${MAX_ROWS} data rows.`, 'CSV_LIMIT')
        if (fields.length !== columns.length) {
          throw new CsvAttachmentError(`CSV record ${rowCount + 1} has a different number of fields from the header.`, 'CSV_INVALID')
        }
        if (fields.some(field => Buffer.byteLength(field, 'utf8') > MAX_FIELD_BYTES)) {
          throw new CsvAttachmentError(`CSV fields are limited to ${MAX_FIELD_BYTES} UTF-8 bytes.`, 'CSV_LIMIT')
        }
        readRow(fields, rowCount)
      } catch (error) {
        failure = error instanceof Error ? error : new CsvAttachmentError('CSV parsing failed.', 'CSV_INVALID', { cause: error })
        parser.abort()
      }
    },
  })
  if (failure !== undefined) throw failure
  if (columns === undefined) throw new CsvAttachmentError('CSV requires a header row.', 'CSV_INVALID')
  return rowCount
}

function validateHeader(columns: string[]): void {
  if (columns.length > MAX_COLUMNS || columns.some(name => Buffer.byteLength(name, 'utf8') > MAX_COLUMN_BYTES)) {
    throw new CsvAttachmentError(`CSV supports at most ${MAX_COLUMNS} columns, with names up to ${MAX_COLUMN_BYTES} UTF-8 bytes.`, 'CSV_LIMIT')
  }
  if (columns.some(name => name.trim() === '') || new Set(columns).size !== columns.length) {
    throw new CsvAttachmentError('CSV requires unique, non-blank column names.', 'CSV_INVALID')
  }
}

function fitsResult(result: CsvInspection | CsvGrouping): boolean {
  return Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_RESULT_BYTES
}

export function inspectCsv(attachmentId: string, text: string): CsvInspection {
  const result: CsvInspection = { attachmentId, columns: [], rowCount: 0, preview: [] }
  result.rowCount = parseCsv(text, (columns) => { result.columns = columns }, (fields) => {
    if (result.preview.length < PREVIEW_ROWS) result.preview.push(fields)
  })
  while (result.preview.length > 0 && !fitsResult(result)) result.preview.pop()
  if (!fitsResult(result)) throw new CsvAttachmentError(`CSV column names exceed the ${MAX_RESULT_BYTES}-byte result limit.`, 'CSV_LIMIT')
  return result
}

function columnIndex(columns: string[], name: string, argument: string): number {
  const index = columns.indexOf(name)
  if (index < 0) throw new CsvAttachmentError(`CSV ${argument} does not match a column name.`, 'CSV_COLUMN')
  return index
}

function csvFilterIndex(columns: string[], filter: CsvExactFilter | undefined): number | undefined {
  return filter === undefined ? undefined : columnIndex(columns, filter.column, 'filter column')
}

export function filterOptionsCsv(text: string, column: string | undefined): CsvFilterOptions {
  let columnNames: readonly string[] = []
  let index: number | undefined
  let hasMore = false
  let bytes = 0
  const values = new Set<string>()
  parseCsv(text, (columns) => {
    columnNames = columns
    if (column !== undefined) index = columnIndex(columns, column, 'filter column')
  }, (fields) => {
    if (index === undefined) return
    const value = fields[index] ?? ''
    if (values.has(value)) return
    const size = Buffer.byteLength(JSON.stringify(value), 'utf8') + 1
    if (values.size === FILTER_VALUES || Buffer.byteLength(value, 'utf8') > 1_024 || bytes + size > MAX_RESULT_BYTES) {
      hasMore = true
      return
    }
    bytes += size
    values.add(value)
  })
  return { columns: columnNames, values: [...values], hasMore }
}

function csvRecordPage<Row>(offset: number) {
  const rows: Row[] = []
  let total = 0
  let bytes = 0
  let full = false
  return {
    add(buildRow: () => Row) {
      total += 1
      if (total <= offset || full) return
      const row = buildRow()
      const size = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
      if (rows.length === 0 && size > MAX_RESULT_BYTES) {
        throw new CsvAttachmentError(`CSV record exceeds the ${MAX_RESULT_BYTES}-byte result limit.`, 'CSV_LIMIT')
      }
      if (rows.length === PARTICIPATING_ROWS_PER_PAGE || bytes + size > MAX_RESULT_BYTES) {
        full = true
        return
      }
      bytes += size
      rows.push(row)
    },
    value(): CsvRecordPage<Row> {
      const nextOffset = offset + rows.length
      return { rows, total, offset, ...(nextOffset < total ? { nextOffset } : {}) }
    },
  }
}

export function participatingRowsCsv(text: string, options: CsvParticipantsRequest): CsvParticipatingRows {
  const { groupBy, groupKey, valueColumn, filter, offset } = options
  const page = csvRecordPage<CsvParticipatingRow>(offset)
  let keyIndex = 0
  let filterIndex: number | undefined
  let valueIndex: number | undefined
  parseCsv(text, (columns) => {
    keyIndex = columnIndex(columns, groupBy, 'groupBy')
    filterIndex = csvFilterIndex(columns, filter)
    if (valueColumn !== undefined) valueIndex = columnIndex(columns, valueColumn, 'valueColumn')
  }, (fields, row) => {
    if (fields[keyIndex] !== groupKey || filterIndex !== undefined && fields[filterIndex] !== filter?.value) return
    page.add(() => ({ record: row + 1, ...(filterIndex === undefined ? {} : { filterValue: fields[filterIndex] ?? '' }),
      ...(valueIndex === undefined ? {} : { value: fields[valueIndex] ?? '' }) }))
  })
  return page.value()
}

export function compareParticipatingRowsCsv(text: string, options: CsvCompareParticipantsRequest): CsvComparedParticipants {
  const { groupBy, groupKey, valueColumn, originalFilter, currentFilter, offset } = options
  const page = csvRecordPage<CsvComparisonRow>(offset)
  const counts = { kept: 0, excluded: 0, added: 0 }
  let keyIndex = 0
  let originalIndex: number | undefined
  let currentIndex: number | undefined
  let valueIndex: number | undefined
  parseCsv(text, (columns) => {
    keyIndex = columnIndex(columns, groupBy, 'groupBy')
    originalIndex = csvFilterIndex(columns, originalFilter)
    currentIndex = csvFilterIndex(columns, currentFilter)
    if (valueColumn !== undefined) valueIndex = columnIndex(columns, valueColumn, 'valueColumn')
  }, (fields, row) => {
    if (fields[keyIndex] !== groupKey) return
    const original = originalIndex === undefined || fields[originalIndex] === originalFilter?.value
    const current = currentIndex === undefined || fields[currentIndex] === currentFilter?.value
    if (!original && !current) return
    const status = original ? current ? 'kept' : 'excluded' : 'added'
    counts[status] += 1
    page.add(() => ({ record: row + 1, status,
      ...(valueIndex === undefined ? {} : { value: fields[valueIndex] ?? '' }),
      ...(originalIndex === undefined ? {} : { originalFilterValue: fields[originalIndex] ?? '' }),
      ...(currentIndex === undefined ? {} : { currentFilterValue: fields[currentIndex] ?? '' }),
    }))
  })
  return { ...page.value(), ...counts }
}

function numericCell(raw: string, row: number): number {
  const text = raw.trim()
  const number = Number(text)
  if (!DECIMAL.test(text) || !Number.isFinite(number)) {
    throw new CsvAttachmentError(`CSV record ${row + 1} requires a finite decimal in valueColumn.`, 'CSV_NUMBER')
  }
  return number
}

// Every finite binary64 value is an integer multiple of its smallest subnormal (2^-1074).
function binary64Units(bits: DataView, value: number): bigint {
  bits.setFloat64(0, value)
  const encoded = bits.getBigInt64(0)
  const leadingBit = 1n << 52n
  const fraction = encoded & (leadingBit - 1n)
  const exponent = (encoded >> 52n) & 0x7ffn
  const units = exponent === 0n ? fraction : (leadingBit | fraction) << (exponent - 1n)
  return encoded < 0n ? -units : units
}

// Round the exact quotient once to the nearest binary64 value, breaking ties toward even.
function roundGroupTotal(total: bigint, count: number): number {
  const magnitude = total < 0n ? -total : total
  const divisor = BigInt(count)
  const shift = Math.max(0, (magnitude / divisor).toString(2).length - 53)
  const scaledDivisor = divisor << BigInt(shift)
  let significand = magnitude / scaledDivisor
  const twiceRemainder = (magnitude % scaledDivisor) * 2n
  if (twiceRemainder > scaledDivisor || (twiceRemainder === scaledDivisor && significand % 2n !== 0n)) {
    significand += 1n
  }
  const value = Number(significand) * 2 ** (shift - 1074)
  if (!Number.isFinite(value)) throw new CsvAttachmentError('CSV grouped total exceeds the numeric range.', 'CSV_NUMBER')
  return total < 0n ? -value : value
}

/**
 * Group the matching CSV records. Sums and means round the exact result of the parsed numbers once.
 * @param attachmentId - Identity to attach to the returned groups.
 * @param text - Decoded CSV input.
 * @param options - Grouping, optional filter and aggregate to apply.
 * @returns Complete grouped readings in first-seen group order.
 * @throws {CsvAttachmentError} If the file, recipe or final readings are invalid or exceed a limit.
 */
export function groupCsv(attachmentId: AttachmentId, text: string, options: GroupOptions): CsvGrouping {
  const { groupBy, valueColumn, aggregate, filter } = options
  let keyIndex = 0
  let numberIndex: number | undefined
  let filterIndex: number | undefined
  let rowCount = 0
  const exactBits = aggregate === 'sum' || aggregate === 'mean' ? new DataView(new ArrayBuffer(8)) : undefined
  const groups = new Map<string, { count: number; extreme: number; total: bigint }>()
  parseCsv(text, (columns) => {
    keyIndex = columnIndex(columns, groupBy, 'groupBy')
    filterIndex = csvFilterIndex(columns, filter)
    if (valueColumn !== undefined) numberIndex = columnIndex(columns, valueColumn, 'valueColumn')
  }, (fields, row) => {
    if (filterIndex !== undefined && fields[filterIndex] !== filter?.value) return
    rowCount += 1
    const key = fields[keyIndex] ?? ''
    let group = groups.get(key)
    if (group === undefined && (groups.size >= MAX_GROUPS || Buffer.byteLength(key, 'utf8') > MAX_GROUP_BYTES)) {
      throw new CsvAttachmentError(`CSV supports at most ${MAX_GROUPS} groups, with keys up to ${MAX_GROUP_BYTES} UTF-8 bytes.`, 'CSV_LIMIT')
    }
    const value = numberIndex === undefined ? 1 : numericCell(fields[numberIndex] ?? '', row)
    if (group === undefined) {
      group = { count: 0, extreme: value, total: 0n }
      groups.set(key, group)
    }
    if (exactBits !== undefined) group.total += binary64Units(exactBits, value)
    else if (aggregate === 'min') group.extreme = Math.min(group.extreme, value)
    else if (aggregate === 'max') group.extreme = Math.max(group.extreme, value)
    group.count += 1
  })
  const result: CsvGrouping = {
    attachmentId, ...options, rowCount,
    groups: Array.from(groups, ([key, { count, extreme, total }]) => {
      let value = aggregate === 'count' ? count : extreme
      if (exactBits !== undefined) value = roundGroupTotal(total, aggregate === 'mean' ? count : 1)
      return { key, count, value: value === 0 ? 0 : value }
    }),
  }
  if (!fitsResult(result)) throw new CsvAttachmentError(`CSV groups exceed the ${MAX_RESULT_BYTES}-byte result limit.`, 'CSV_LIMIT')
  return result
}
