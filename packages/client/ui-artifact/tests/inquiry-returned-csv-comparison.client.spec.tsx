// @vitest-environment jsdom
import { StrictMode } from 'react'
import type { ArtifactBranchCsvReturnedComparisonValue } from '@agentrans/artifact-branch/types'
import type { ArtifactCsvComparisonAttachment, ArtifactCsvComparisonPage } from '@agentrans/artifact-followup/types'
import type { ArtifactId } from '@agentrans/artifact/types'
import { makeTranslate } from '@agentrans/client-test-runtime'
import { MessageId } from '@agentrans/llm/brand'
import { SessionId } from '@agentrans/session/types'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { InquiryReturnedCsvComparison, type InquiryCsvReturnRef } from '../src/client/InquiryReturnedCsvComparison.tsx'
import type { ReviewCsvComparisonAttachment } from '../src/client/CsvQuestionComparison.tsx'
import { en } from '../src/client/locales.ts'

const parent = SessionId('parent')
const child = SessionId('inquiry')
const original = { eventSeq: 11, messageId: MessageId('mean-30') }
const later = { eventSeq: 29, messageId: MessageId('sum-60') }
const another = { eventSeq: 37, messageId: MessageId('sum-35') }
const options = [
  { ...original, label: 'Warm mean 30' }, { ...later, label: 'Warm sum 60' }, { ...another, label: 'Warm filtered sum 35' },
]
const originalReading = { groupKey: 'Warm', aggregate: 'mean', value: 30, count: 2, valueColumn: 'LatencyMs' } as const
const sumReading = { ...originalReading, aggregate: 'sum', value: 60 } as const
const firstPage: ArtifactCsvComparisonPage = {
  original: originalReading, current: sumReading, kept: 2, excluded: 0, added: 0,
  total: 2, offset: 0, rows: [{ record: 4, status: 'kept', value: '25' }], nextOffset: 1,
}
const secondPage: ArtifactCsvComparisonPage = {
  original: originalReading, current: sumReading, kept: 2, excluded: 0, added: 0,
  total: 2, offset: 1, rows: [{ record: 5, status: 'kept', value: '35' }],
}
const t = makeTranslate(en)
const firstChoice = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'First return' })
const secondChoice = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'Second return' })
const showComparison = () => screen.getByRole<HTMLButtonElement>('button', { name: 'View comparison' })

afterEach(() => {
  cleanup()
  sessionStorage.clear()
})

function mounted(
  loadPage: (first: InquiryCsvReturnRef, second: InquiryCsvReturnRef, offset: number) => Promise<ArtifactBranchCsvReturnedComparisonValue>,
  branchSessionId = child, reviewAttachment?: ReviewCsvComparisonAttachment,
) {
  return render(<StrictMode><InquiryReturnedCsvComparison sessionId={parent} branchSessionId={branchSessionId} options={options}
    loadPage={loadPage} reviewAttachment={reviewAttachment} onClose={vi.fn()} t={t} /></StrictMode>)
}

it('confirms exact choices chronologically, pages their records, and restores the verified pair only when opened', async () => {
  const loadPage = vi.fn().mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage).mockResolvedValueOnce(firstPage)
  const view = mounted(loadPage)
  expect(document.activeElement).toBe(firstChoice())
  expect(showComparison().disabled).toBe(true)
  fireEvent.change(firstChoice(), { target: { value: later.messageId } })
  fireEvent.change(secondChoice(), { target: { value: original.messageId } })
  expect(loadPage).not.toHaveBeenCalled()
  fireEvent.click(showComparison())
  await screen.findByRole('row', { name: '4 Kept 25' })
  expect(loadPage).toHaveBeenCalledExactlyOnceWith(original, later, 0)
  expect(firstChoice().value).toBe(original.messageId)
  expect(secondChoice().value).toBe(later.messageId)
  const panel = view.baseElement.querySelector('[data-inquiry-return-comparison]')!
  expect(panel.querySelector('[data-csv-compare-reading="original"]')?.textContent).toContain('Earlier return')
  expect(panel.querySelector('[data-csv-compare-reading="locked"]')?.textContent).toContain('Later return')
  expect(panel.querySelector('[data-csv-compare-count="kept"]')?.textContent).toBe('2')
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
  await screen.findByRole('row', { name: '5 Kept 35' })
  expect(loadPage).toHaveBeenLastCalledWith(original, later, 1)
  expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(JSON.stringify([original, later]))

  view.unmount()
  const otherView = mounted(loadPage, SessionId('sibling'))
  expect(firstChoice().value).toBe('')
  expect(secondChoice().value).toBe('')
  expect(loadPage).toHaveBeenCalledTimes(2)
  otherView.unmount()
  mounted(loadPage)
  expect(firstChoice().value).toBe(original.messageId)
  expect(secondChoice().value).toBe(later.messageId)
  await screen.findByRole('row', { name: '4 Kept 25' })
  expect(loadPage).toHaveBeenCalledTimes(3)
  expect(loadPage).toHaveBeenLastCalledWith(original, later, 0)
})

it('ignores a settled comparison after the user changes the selected pair', async () => {
  const delayed = Promise.withResolvers<ArtifactCsvComparisonPage>()
  const filtered = { ...firstPage, current: { ...sumReading, value: 35, count: 1 }, nextOffset: 1 }
  const loadPage = vi.fn().mockReturnValueOnce(delayed.promise).mockResolvedValueOnce(filtered)
  const view = mounted(loadPage)
  fireEvent.change(firstChoice(), { target: { value: original.messageId } })
  fireEvent.change(secondChoice(), { target: { value: later.messageId } })
  fireEvent.click(showComparison())
  await waitFor(() => { expect(loadPage).toHaveBeenCalledExactlyOnceWith(original, later, 0) })
  fireEvent.change(secondChoice(), { target: { value: another.messageId } })
  fireEvent.click(showComparison())
  await screen.findByRole('row', { name: '4 Kept 25' })
  expect(loadPage).toHaveBeenLastCalledWith(original, another, 0)
  await act(async () => { delayed.resolve(firstPage) })
  const amount = view.baseElement.querySelector('[data-csv-compare-reading="locked"] [data-csv-reading="value"]')
  expect(amount?.textContent).toBe('35')
  expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(JSON.stringify([original, another]))
})

it('locks the exact reviewed page and leaves it alone while browsing another pair', async () => {
  const attachment: ArtifactCsvComparisonAttachment = {
    proof: 'authorized-test-proof',
    facts: { kind: 'csv-question-comparison', sessionId: parent, comparison: secondPage,
      returns: { branchSessionId: child,
        first: { ...original, artifactId: 'latency' as ArtifactId, revision: 1 },
        second: { ...later, artifactId: 'latency' as ArtifactId, revision: 2 },
      } },
  }
  const filtered = { ...firstPage, current: { ...sumReading, value: 35, count: 1 }, attachment }
  const loadPage = vi.fn().mockResolvedValueOnce(firstPage)
    .mockResolvedValueOnce({ ...secondPage, attachment }).mockResolvedValueOnce(filtered)
  const confirm = vi.fn(async () => true)
  const reviewAttachment = vi.fn<ReviewCsvComparisonAttachment>(() => ({ confirm, replacesContext: true }))
  mounted(loadPage, child, reviewAttachment)
  fireEvent.change(firstChoice(), { target: { value: original.messageId } })
  fireEvent.change(secondChoice(), { target: { value: later.messageId } })
  fireEvent.click(showComparison())
  await screen.findByRole('row', { name: '4 Kept 25' })
  expect(screen.queryByRole('button', { name: en['csvCompare.attach'] })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
  await screen.findByRole('row', { name: '5 Kept 35' })
  fireEvent.click(screen.getByRole('button', { name: en['csvCompare.attach'] }))
  const review = screen.getByRole('region', { name: en['csvCompare.review'] })
  expect(within(review).queryByRole('row', { name: '4 Kept 25' })).toBeNull()
  expect(within(review).getByRole('row', { name: '5 Kept 35' })).toBeDefined()
  expect(within(review).getByText(en['csvCompare.replaceContext'])).toBeDefined()
  expect(reviewAttachment).toHaveBeenCalledExactlyOnceWith(attachment)
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(within(review).getByRole('button', { name: en['csvCompare.confirm'] }))
  await screen.findByText(en['csvCompare.attached'])
  expect(confirm).toHaveBeenCalledOnce()

  fireEvent.change(secondChoice(), { target: { value: another.messageId } })
  fireEvent.click(showComparison())
  await screen.findByRole('row', { name: '4 Kept 25' })
  expect(loadPage).toHaveBeenLastCalledWith(original, another, 0)
  // The alternate browse returned the prior proof. It is readable but cannot pass review for the new pair.
  expect(screen.queryByRole('button', { name: en['csvCompare.attach'] })).toBeNull()
  expect(reviewAttachment).toHaveBeenCalledOnce()
  expect(confirm).toHaveBeenCalledOnce()
})
