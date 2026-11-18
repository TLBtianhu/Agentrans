/** Paginated source records under a live or recorded CSV reading. */
import { useId, useState } from 'react'
import type { ArtifactBranchCsvQuestionRowsValue } from '@agentrans/artifact-branch/types'
import { Button } from '@agentrans/client-ui-primitives'
import type { PropsLocale } from '@agentrans/client-ui-slots'
import { csvGroupLabel } from './CsvBarChartView.tsx'
import css from './BranchEvidenceMessage.module.css'

/** One authorized page and the original measure heading when known to the Host. */
export type CsvRowsLoader = (offset: number) => Promise<ArtifactBranchCsvQuestionRowsValue>

interface RowsProps extends PropsLocale<'artifact'> {
  readonly filterColumn?: string | undefined
  readonly valueColumn?: string | undefined
  readonly loadRows: CsvRowsLoader
}

/** Show original CSV record numbers and the fields relevant to a single reading. */
export function CsvParticipatingRows({ filterColumn, valueColumn, loadRows, t }: RowsProps) {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<Awaited<ReturnType<CsvRowsLoader>>>()
  const [attempted, setAttempted] = useState<{ readonly offset: number; readonly history: readonly number[] }>({ offset: 0, history: [] })
  const [history, setHistory] = useState<readonly number[]>([])
  const [status, setStatus] = useState<'ready' | 'loading' | 'failed'>('ready')
  const id = useId()

  const load = async (requestedOffset: number, nextHistory: readonly number[]): Promise<void> => {
    setAttempted({ offset: requestedOffset, history: nextHistory })
    setStatus('loading')
    try {
      const next = await loadRows(requestedOffset)
      setPage(next)
      setHistory(nextHistory)
      setStatus('ready')
    } catch (_error) {
      setStatus('failed')
    }
  }

  const previousOffset = history.at(-1)
  const nextOffset = page?.nextOffset
  const measureColumn = page?.valueColumn ?? valueColumn
  return <div className={css.csvParticipants}>
    <Button size="sm" variant="outline" data-csv-participating-rows-open aria-controls={id} aria-expanded={open}
      onClick={() => { setOpen(!open); if (!open && page === undefined && status !== 'loading') void load(0, []) }}>
      {t(open ? 'csvAnalysis.hideRows' : 'csvAnalysis.viewRows')}
    </Button>
    {open && <section id={id} data-csv-participating-rows aria-label={t('csvAnalysis.viewRows')}>
      {status === 'loading' && <p role="status">{t('csvAnalysis.loadingRows')}</p>}
      {status === 'failed' && <div className={css.csvAnalysisFailure}>
        <p role="alert">{t('csvAnalysis.rowsFailed')}</p>
        <Button size="sm" variant="outline" onClick={() => { void load(attempted.offset, attempted.history) }}>{t('csvAnalysis.retry')}</Button>
      </div>}
      {page !== undefined && <>
        <p className={css.csvParticipantsTotal}>
          {t('csvAnalysis.totalRows')}{' '}<span data-csv-participating-total>{String(page.total)}</span>
        </p>
        <table>
          <thead><tr>
            <th scope="col">{t('csvAnalysis.recordNumber')}</th>
            {filterColumn !== undefined && <th scope="col">{csvGroupLabel(filterColumn, t)}</th>}
            {measureColumn !== undefined && <th scope="col">{csvGroupLabel(measureColumn, t)}</th>}
          </tr></thead>
          <tbody>{page.rows.map(row => <tr key={row.record} data-csv-participating-record={row.record}>
            <th scope="row">{String(row.record)}</th>
            {filterColumn !== undefined && <td data-csv-participating-cell="filter">{csvGroupLabel(row.filterValue ?? '', t)}</td>}
            {measureColumn !== undefined && <td data-csv-participating-cell="value">{csvGroupLabel(row.value ?? '', t)}</td>}
          </tr>)}</tbody>
        </table>
        {(nextOffset !== undefined || previousOffset !== undefined) && <div className={css.csvAnalysisFailure}>
          <Button size="sm" variant="outline" disabled={status === 'loading' || previousOffset === undefined}
            onClick={() => { if (previousOffset !== undefined) void load(previousOffset, history.slice(0, -1)) }}>
            {t('csvAnalysis.previousPage')}
          </Button>
          <Button size="sm" variant="outline" disabled={status === 'loading' || nextOffset === undefined}
            onClick={() => { if (nextOffset !== undefined) void load(nextOffset, [...history, page.offset]) }}>
            {t('csvAnalysis.nextPage')}
          </Button>
        </div>}
      </>}
    </section>}
  </div>
}
