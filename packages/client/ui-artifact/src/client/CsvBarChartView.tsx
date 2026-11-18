/** Native categorical chart and reviewed readings from a saved CSV aggregate. */
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { CsvBarChartSpec } from '@agentrans/artifact/scene'
import type { RuntimeReport } from '@agentrans/artifact-runtime/types'
import type { PropsLocale } from '@agentrans/client-ui-slots'
import { Button } from '@agentrans/client-ui-primitives'
import css from './CsvBarChartView.module.css'

type Localize = PropsLocale<'artifact'>['t']
type Group = CsvBarChartSpec['groups'][number]
type Recipe = Pick<CsvBarChartSpec, 'aggregate' | 'valueColumn' | 'filter'>
type Reading = { readonly group: Group; readonly recipe: Recipe }
const INVISIBLE_LABEL_CHAR = /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u

function csvLabel(value: string, blank?: string): string {
  const quote = value.trim() !== value || value.startsWith('"') || value === blank || INVISIBLE_LABEL_CHAR.test(value)
  if (!quote) return value
  return JSON.stringify(value).replace(/[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/gu,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** @returns A label that distinguishes blank, whitespace-only and ordinary group keys. */
export function csvGroupLabel(key: string, t: Localize): string {
  const blank = t('csvChart.blankGroup')
  return key === '' ? blank : csvLabel(key, blank)
}

/** @returns The localized metric name with its exact CSV column when applicable. */
export function csvMetricLabel({ aggregate, valueColumn }: Recipe, t: Localize): string {
  const metric = t(`csvChart.aggregate.${aggregate}`)
  return valueColumn === undefined ? metric : t('csvChart.metric', { metric, column: csvLabel(valueColumn) })
}

/** Show the same source reading in live review, the composer, and replay. */
export function CsvGroupReading({ group, recipe, showNoFilter = false, t }:
  Reading & { readonly showNoFilter?: boolean; readonly t: Localize }) {
  return <dl className={css.reading}>
    <div><dt>{t('csvChart.group')}</dt><dd data-csv-reading="key">{csvGroupLabel(group.key, t)}</dd></div>
    <div><dt>{t('csvChart.metricLabel')}</dt><dd data-csv-reading="aggregate">{csvMetricLabel(recipe, t)}</dd></div>
    <div><dt>{t('csvChart.value')}</dt><dd data-csv-reading="value">{String(group.value)}</dd></div>
    <div><dt>{t('csvChart.count')}</dt><dd data-csv-reading="count">{String(group.count)}</dd></div>
    {recipe.filter !== undefined && <div><dt>{t('csvChart.filter')}</dt><dd data-csv-reading="filter">
      <bdi>{csvLabel(recipe.filter.column)}</bdi>{' = '}<bdi>{csvGroupLabel(recipe.filter.value, t)}</bdi>
    </dd></div>}
    {recipe.filter === undefined && showNoFilter && <div>
      <dt>{t('csvChart.filter')}</dt><dd data-csv-reading="filter">{t('csvCompare.noFilter')}</dd>
    </div>}
  </dl>
}

interface Props {
  readonly spec: CsvBarChartSpec
  readonly revision?: number | undefined
  readonly readOnly?: boolean | undefined
  readonly selectedGroupKey?: string | undefined
  readonly onSelectGroup?: ((groupKey: string) => void) | undefined
  readonly baseline?: CsvBarChartSpec | undefined
  readonly onAttachCsvQuestion?: ((groupKey: string) => boolean | Promise<boolean>) | undefined
  readonly onRuntimeReport?: ((report: RuntimeReport) => void) | undefined
  readonly t: Localize
}

/** Render an exact series of grouped values. User input only selects a group key. */
export function CsvBarChartView({
  spec, revision, readOnly, selectedGroupKey, onSelectGroup, baseline, onAttachCsvQuestion, onRuntimeReport, t,
}: Props) {
  const [selection, selectGroup] = useState(spec.groups[0]?.key)
  const [review, setReview] = useState<Group | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const pending = useRef(false)
  const reviewId = useId()
  const activeKey = selectedGroupKey ?? selection
  const active = spec.groups.find(group => group.key === activeKey)
  const original = baseline?.groups.find(group => group.key === activeKey)

  useEffect(() => { onRuntimeReport?.({ status: 'ready', capabilities: { state: false, commands: [] } }) }, [onRuntimeReport])

  const attach = (): void => {
    if (review === null || onAttachCsvQuestion === undefined || pending.current) return
    const finish = (accepted: boolean): void => {
      pending.current = false
      setAttaching(false)
      if (accepted) setReview(null)
      else setUnavailable(true)
    }
    const result = onAttachCsvQuestion(review.key)
    if (typeof result === 'boolean') { finish(result); return }
    pending.current = true
    setAttaching(true)
    setUnavailable(false)
    void result.then(finish, () => { finish(false) })
  }

  const lowest = Math.min(0, ...spec.groups.map(group => group.value))
  const highest = Math.max(0, ...spec.groups.map(group => group.value))
  const magnitude = Math.max(Math.abs(lowest), highest) || 1
  const extent = highest / magnitude - lowest / magnitude || 1
  const toPercent = (value: number): number => (value / magnitude - lowest / magnitude) / extent * 100
  const origin = toPercent(0)
  const chartLabel = t('csvChart.title', { metric: csvMetricLabel(spec, t), groupBy: csvLabel(spec.groupBy) })

  return <section className={css.chart} data-csv-bar-chart aria-label={chartLabel}>
    <p className={css.metric}>{chartLabel}</p>
    <ul className={css.bars}>
      {spec.groups.map((group) => {
        const coordinate = toPercent(group.value)
        const style = { '--origin': `${origin}%`, '--start': `${Math.min(origin, coordinate)}%`,
          '--width': `${Math.abs(coordinate - origin)}%` } as CSSProperties
        const content = <>
          <bdi className={css.key}>{csvGroupLabel(group.key, t)}</bdi>{' '}
          <span className={css.track} style={style} aria-hidden="true"><i /></span>
          <span className={css.number}>{String(group.value)}</span>
        </>
        const selected = group.key === activeKey
        return <li key={group.key} data-selected={selected ? '' : undefined}>
          {readOnly === true ? <div className={css.row} aria-current={selected ? 'true' : undefined}>{content}</div>
            : <button type="button" className={css.row} data-csv-group-key={group.key} aria-pressed={selected}
              onClick={() => { (onSelectGroup ?? selectGroup)(group.key) }}>{content}</button>}
        </li>
      })}
    </ul>
    {baseline !== undefined && original !== undefined ? <div className={css.compared}>
      <div data-csv-analysis-original>
        <p>{t(spec.filter === undefined ? 'csvAnalysis.original' : 'csvAnalysis.beforeFilter')}</p>
        <CsvGroupReading group={original} recipe={baseline} t={t} />
      </div>
      <div aria-live="polite" data-csv-active-reading data-csv-analysis-current>
        <p>{t(spec.filter === undefined ? 'csvAnalysis.current' : 'csvAnalysis.afterFilter')}</p>
        {active === undefined ? <span>{t('csvAnalysis.noRows')}</span> : <CsvGroupReading group={active} recipe={spec} t={t} />}
      </div>
    </div> : active === undefined
      ? <p role="status" className={css.metric}>{t('csvAnalysis.noRows')}</p>
      : <div aria-live="polite" data-csv-active-reading><CsvGroupReading group={active} recipe={spec} t={t} /></div>}
    {readOnly !== true && onAttachCsvQuestion !== undefined && active !== undefined && <div>
      <Button size="sm" variant="outline" aria-expanded={review !== null} aria-controls={reviewId} disabled={attaching}
        onClick={() => { setReview(active); setUnavailable(false) }}>{t('promptContext.attach')}</Button>
    </div>}
    {review !== null && onAttachCsvQuestion !== undefined && <section id={reviewId} className={css.review}
      data-csv-question-review aria-label={t('csvChart.review')}>
      <strong>{t('csvChart.review')}</strong>
      {revision !== undefined && <p>{t('revision', { revision: String(revision) })}</p>}
      <CsvGroupReading group={review} recipe={spec} t={t} />
      <div className={css.actions}>
        <Button size="sm" variant="primary" disabled={attaching} aria-busy={attaching} onClick={attach}>
          {t('promptContext.confirmReadings')}
        </Button>
        <Button size="sm" variant="ghost" disabled={attaching} onClick={() => { setReview(null) }}>{t('promptContext.cancelReadings')}</Button>
      </div>
      {unavailable && <p role="alert">{t('promptContext.unavailable')}</p>}
    </section>}
  </section>
}
