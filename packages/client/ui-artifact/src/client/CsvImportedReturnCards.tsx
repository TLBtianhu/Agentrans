/** Read-only source cards carried by a user-imported comparison. */
import type { ArtifactCsvComparisonPage, ArtifactCsvComparisonReturnCards } from '@agentrans/artifact-followup/types'
import type { PropsLocale } from '@agentrans/client-ui-slots'
import { CsvGroupReading, csvGroupLabel } from './CsvBarChartView.tsx'
import css from './CsvQuestionComparison.module.css'

/** Open either imported source independently, without accessing conversation history. */
export function CsvImportedReturnCards({ page, cards, t }: PropsLocale<'artifact'> & {
  readonly page: ArtifactCsvComparisonPage
  readonly cards: ArtifactCsvComparisonReturnCards
}) {
  const sides = [
    { side: 'first', card: cards.first, reading: page.original, label: t('branchEvidence.inquiryCompareEarlier'), omitted: 'added' },
    { side: 'second', card: cards.second, reading: page.current, label: t('branchEvidence.inquiryCompareLater'), omitted: 'excluded' },
  ] as const
  return <div className={css.importedReturnCards}>
    {sides.map(({ side, card, reading, label, omitted }) => {
      const records = page.rows.filter(row => row.status !== omitted)
      return <details key={side} className={css.review} data-csv-imported-return-card={side}>
        <summary>{label}</summary>
        <div className={css.importedReturnContent}>
          <div className={css.importedReturnIdentity}>
            <strong data-csv-return-title>{card.title}</strong>
            <span data-csv-return-revision>{t('revision', { revision: String(card.revision) })}</span>
          </div>
          <div className={css.importedReturnConclusion}>
            <strong>{t('csvCompare.returnConclusion')}</strong>
            <div data-csv-return-conclusion>{card.conclusion.map((block, index) => <p key={index}>{block}</p>)}</div>
          </div>
          <div data-csv-return-reading>
            <CsvGroupReading group={{ key: reading.groupKey, value: reading.value, count: reading.count }}
              recipe={reading} showNoFilter t={t} />
          </div>
          <table aria-label={t('csvCompare.returnGroups')}>
            <thead><tr>
              <th scope="col" data-csv-return-group-by>{csvGroupLabel(card.groupBy, t)}</th>
              <th scope="col">{t('csvChart.value')}</th>
              <th scope="col">{t('csvChart.count')}</th>
            </tr></thead>
            <tbody>{card.groups.map(group => <tr key={group.key} data-csv-return-group>
              <th scope="row" data-csv-return-group-cell="key">{csvGroupLabel(group.key, t)}</th>
              <td data-csv-return-group-cell="value">{String(group.value)}</td>
              <td data-csv-return-group-cell="count">{String(group.count)}</td>
            </tr>)}</tbody>
          </table>
          {records.length === 0 ? <p>{t('csvCompare.returnNoPageRecords')}</p> : <table aria-label={t('csvCompare.returnPageRecords')}>
            <thead><tr>
              <th scope="col">{t('csvAnalysis.recordNumber')}</th>
              {reading.filter !== undefined && <th scope="col">{csvGroupLabel(reading.filter.column, t)}</th>}
              {reading.valueColumn !== undefined && <th scope="col">{csvGroupLabel(reading.valueColumn, t)}</th>}
            </tr></thead>
            <tbody>{records.map((row) => {
              const filter = side === 'first' ? row.originalFilterValue : row.currentFilterValue
              return <tr key={row.record} data-csv-return-record={row.record}>
                <th scope="row">{String(row.record)}</th>
                {reading.filter !== undefined && <td data-csv-return-cell="filter">{filter === undefined ? '—' : csvGroupLabel(filter, t)}</td>}
                {reading.valueColumn !== undefined && <td data-csv-return-cell="value">
                  {row.value === undefined ? '—' : csvGroupLabel(row.value, t)}
                </td>}
              </tr>
            })}</tbody>
          </table>}
        </div>
      </details>
    })}
  </div>
}
