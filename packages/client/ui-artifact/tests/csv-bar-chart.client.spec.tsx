// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { isCsvAttachmentId, type CsvBarChartSpec } from '@agentrans/artifact/scene'
import { makeTranslate } from '@agentrans/client-test-runtime'
import { CsvBarChartView } from '../src/client/CsvBarChartView.tsx'
import { CsvAnalysisContinuation, type CsvAnalysisCommands } from '../src/client/CsvAnalysisContinuation.tsx'
import { en } from '../src/client/locales.ts'
import { parseNativeQuestionReplay } from '../src/client/question-context-text.ts'

const t = makeTranslate(en)
const attachmentId = `sha256:${'a'.repeat(64)}`
if (!isCsvAttachmentId(attachmentId)) throw new Error('Invalid test attachment ID')
const spec = {
  kind: 'csv-bar-chart', attachmentId, groupBy: 'Trial', valueColumn: 'LatencyMs', aggregate: 'mean',
  rowCount: 6, groups: [{ key: 'Cold', value: -15, count: 2 }, { key: 'Warm', value: 30, count: 2 }, { key: '', value: 0, count: 2 }],
} satisfies CsvBarChartSpec

afterEach(() => { cleanup() })

it('reviews an exact group, preserves the choice while browsing, and attaches just its key', () => {
  const attach = vi.fn(() => true)
  render(<CsvBarChartView spec={spec} revision={1} onAttachCsvQuestion={attach} t={t} />)
  const cold = screen.getByRole('button', { name: /Cold -15/u })
  const warm = screen.getByRole('button', { name: /Warm 30/u })
  fireEvent.click(warm)
  expect(warm.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Use for next question' }))
  const review = within(screen.getByRole('region', { name: 'Review CSV reading' }))
  fireEvent.click(cold)
  expect(cold.getAttribute('aria-pressed')).toBe('true')
  for (const field of ['Revision 1', 'Warm', 'Mean of LatencyMs', '30', '2']) {
    expect(review.getByText(field, { exact: true })).toBeDefined()
  }
  fireEvent.click(review.getByRole('button', { name: 'Attach readings' }))
  expect(attach).toHaveBeenCalledExactlyOnceWith('Warm')
  expect(screen.queryByRole('region', { name: 'Review CSV reading' })).toBeNull()
})

it('replays only matching recorded values and distinguishes blank keys from real labels', () => {
  const prefix = 'The user selected the following experiment context for this question. '
    + 'CSV readings come from the Host-computed group result stored in the selected chart revision.\n'
  const artifact = { artifactId: 'latencies', title: 'Trial latencies', format: 'scene', presentation: 'inline', revision: 1, spec }
  const facts = { kind: 'current-csv-bar-chart', artifact, groupKey: '', values: { key: '', value: 0, count: 2 } }
  const text = (value: unknown): string => prefix + JSON.stringify({ kind: 'artifact-question-context', sessionId: 'session', facts: value })
  const replay = parseNativeQuestionReplay(text(facts), 'session')
  expect(replay?.state).toMatchObject({ kind: 'csv-bar-chart', group: facts.values })
  expect(parseNativeQuestionReplay(text({ ...facts, values: { ...facts.values, value: 1 } }), 'session')).toBeUndefined()
  expect(parseNativeQuestionReplay(text(facts), 'different')).toBeUndefined()
  const literalLabels: CsvBarChartSpec = { ...spec, rowCount: 3, groups: [
    { key: '', value: 0, count: 1 }, { key: '(blank)', value: 0, count: 1 }, { key: 'A\u202eB', value: 0, count: 1 },
  ] }
  render(<CsvBarChartView spec={literalLabels} revision={1} readOnly selectedGroupKey="" t={t} />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getByText('"(blank)"')).toBeDefined()
  expect(screen.getByText('"A\\u202eB"')).toBeDefined()
  expect(screen.getAllByText('(blank)')).toHaveLength(2)
})

it('retains the original chart while recalculating and locks the reviewed group as the active bar changes', async () => {
  const sum: CsvBarChartSpec = { ...spec, aggregate: 'sum', groups: spec.groups.map(group => ({ ...group, value: group.value * group.count })) }
  const lockResult = Promise.withResolvers<boolean>()
  const recalculate = vi.fn().mockResolvedValue(sum)
  const lock = vi.fn(() => lockResult.promise)
  const filterOptions = vi.fn().mockResolvedValue({ columns: ['Trial', 'Batch'], values: [], hasMore: false })
  const participatingRows = vi.fn()
  render(<CsvAnalysisContinuation source={spec} groupKey="Warm" commands={{ recalculate, lock, filterOptions, participatingRows }} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: 'Continue analysis' }))
  expect(recalculate).not.toHaveBeenCalled()
  const panel = screen.getByRole('region', { name: 'Continue analysis' })
  const reading = (area: 'original' | 'current') => panel.querySelector(`[data-csv-analysis-${area}] [data-csv-reading="value"]`)?.textContent
  expect(reading('original')).toBe('30')
  fireEvent.change(within(panel).getByRole('combobox', { name: 'Aggregation' }), { target: { value: 'sum' } })
  expect(recalculate).toHaveBeenCalledExactlyOnceWith('sum')
  await waitFor(() => { expect(reading('current')).toBe('60') })
  expect(reading('original')).toBe('30')
  fireEvent.click(within(panel).getByRole('button', { name: 'Use for next question' }))
  fireEvent.click(within(panel).getByRole('button', { name: 'Attach readings' }))
  expect(lock).toHaveBeenCalledExactlyOnceWith('sum', 'Warm')
  fireEvent.click(within(panel).getByRole('button', { name: /Cold -30/u }))
  expect(reading('current')).toBe('-30')
  expect(within(screen.getByRole('region', { name: 'Review CSV reading' })).getByText('60', { exact: true })).toBeDefined()
  lockResult.resolve(true)
  await waitFor(() => { expect(screen.queryByRole('region', { name: 'Review CSV reading' })).toBeNull() })
  expect(reading('original')).toBe('-15')
  expect(lock).toHaveBeenCalledTimes(1)
})

it('compares an exact filter against the same aggregate, pages participating records, and locks the reviewed recipe', async () => {
  const filter = { column: 'Batch', value: 'B' }
  const source: CsvBarChartSpec = { ...spec, groups: [
    { key: 'Warm', value: 20, count: 3 }, { key: 'Cold', value: 50, count: 2 }, { key: '', value: 0, count: 1 },
  ] }
  const sum: CsvBarChartSpec = { ...source, aggregate: 'sum', groups: source.groups.map(group => ({ ...group, value: group.value * group.count })) }
  const filtered: CsvBarChartSpec = { ...sum, filter, rowCount: 3, groups: [{ key: 'Warm', value: 35, count: 2 }, { key: 'Cold', value: 60, count: 1 }] }
  const recalculate = vi.fn<CsvAnalysisCommands['recalculate']>((_aggregate, next) => Promise.resolve(next === undefined ? sum : filtered))
  const lock = vi.fn<CsvAnalysisCommands['lock']>().mockResolvedValue(true)
  const filterOptions = vi.fn<CsvAnalysisCommands['filterOptions']>().mockResolvedValue({
    columns: ['Trial', 'LatencyMs', 'Batch'], values: ['A', 'B'], hasMore: false,
  })
  const participatingRows = vi.fn<CsvAnalysisCommands['participatingRows']>()
    .mockResolvedValueOnce({ total: 2, offset: 0, nextOffset: 1, rows: [{ record: 3, filterValue: 'B', value: '30' }] })
    .mockRejectedValueOnce(new Error('request failed'))
    .mockResolvedValueOnce({ total: 2, offset: 1, rows: [{ record: 8, filterValue: 'B', value: '5' }] })
    .mockResolvedValueOnce({ total: 2, offset: 0, nextOffset: 1, rows: [{ record: 3, filterValue: 'B', value: '30' }] })
  render(<CsvAnalysisContinuation source={source} groupKey="Warm" commands={{ recalculate, lock, filterOptions, participatingRows }} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: 'Continue analysis' }))
  const panel = within(screen.getByRole('region', { name: 'Continue analysis' }))
  fireEvent.change(panel.getByRole('combobox', { name: 'Aggregation' }), { target: { value: 'sum' } })
  fireEvent.change(await panel.findByRole('combobox', { name: 'Filter column' }), { target: { value: 'Batch' } })
  const option = await panel.findByRole<HTMLOptionElement>('option', { name: 'B' })
  fireEvent.change(panel.getByRole('combobox', { name: 'Exact match value' }), { target: { value: option.value } })
  fireEvent.click(panel.getByRole('button', { name: 'Apply filter' }))
  await panel.findByRole('button', { name: 'Warm 35' })
  expect(panel.getByText('Before filter').parentElement?.querySelector('[data-csv-reading="value"]')?.textContent).toBe('60')
  expect(panel.getByText('After filter').parentElement?.querySelector('[data-csv-reading="value"]')?.textContent).toBe('35')
  expect(panel.getByText('After filter').parentElement?.querySelector('[data-csv-reading="filter"]')?.textContent).toBe('Batch = B')
  fireEvent.click(panel.getByRole('button', { name: 'View participating rows' }))
  const rows = within(await panel.findByRole('region', { name: 'View participating rows' }))
  expect(await rows.findByRole('row', { name: '3 B 30' })).toBeDefined()
  fireEvent.click(rows.getByRole('button', { name: 'Next page' }))
  fireEvent.click(await rows.findByRole('button', { name: 'Retry' }))
  expect(await rows.findByRole('row', { name: '8 B 5' })).toBeDefined()
  fireEvent.click(rows.getByRole('button', { name: 'Previous page' }))
  expect(await rows.findByRole('row', { name: '3 B 30' })).toBeDefined()
  expect(participatingRows.mock.calls.map(([, key, offset]) => [key, offset])).toEqual([['Warm', 0], ['Warm', 1], ['Warm', 1], ['Warm', 0]])
  fireEvent.click(panel.getByRole('button', { name: 'Use for next question' }))
  fireEvent.click(panel.getByRole('button', { name: 'Cold 60' }))
  const review = panel.getByRole('region', { name: 'Review CSV reading' })
  expect(review.querySelector('[data-csv-reading="value"]')?.textContent).toBe('35')
  expect(review.querySelector('[data-csv-reading="filter"]')?.textContent).toBe('Batch = B')
  fireEvent.click(within(review).getByRole('button', { name: 'Attach readings' }))
  expect(lock).toHaveBeenCalledExactlyOnceWith('sum', 'Warm', filter)
  await waitFor(() => { expect(panel.queryByRole('region', { name: 'Review CSV reading' })).toBeNull() })
})
