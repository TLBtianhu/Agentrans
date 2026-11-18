/** Compare one returned CSV revision with Host-computed aggregations and exact filters. */
import { useId, useRef, useState } from 'react'
import type { ArtifactBranchCsvFilterOptionsValue, ArtifactBranchCsvRowsValue } from '@agentrans/artifact-branch/types'
import { CSV_AGGREGATES, type CsvAggregate, type CsvBarChartSpec, type CsvExactFilter } from '@agentrans/artifact/scene'
import { Button } from '@agentrans/client-ui-primitives'
import type { PropsLocale } from '@agentrans/client-ui-slots'
import { CsvBarChartView, csvGroupLabel } from './CsvBarChartView.tsx'
import { CsvParticipatingRows } from './CsvParticipatingRows.tsx'
import css from './BranchEvidenceMessage.module.css'

export interface CsvAnalysisCommands {
  readonly recalculate: (aggregate: CsvAggregate, filter?: CsvExactFilter) => Promise<CsvBarChartSpec>
  readonly lock: (aggregate: CsvAggregate, groupKey: string, filter?: CsvExactFilter) => Promise<boolean>
  readonly filterOptions: (column?: string) => Promise<ArtifactBranchCsvFilterOptionsValue>
  readonly participatingRows: (
    recipe: Pick<CsvBarChartSpec, 'aggregate' | 'filter'>, groupKey: string, offset: number,
  ) => Promise<ArtifactBranchCsvRowsValue>
}

interface Preview {
  readonly aggregate: CsvAggregate
  readonly spec: CsvBarChartSpec
  readonly baseline: CsvBarChartSpec
  readonly filter: CsvExactFilter | undefined
  readonly phase: 'ready' | 'loading' | 'failed'
}

interface Props extends PropsLocale<'artifact'> {
  readonly source: CsvBarChartSpec
  readonly groupKey: string
  readonly commands: CsvAnalysisCommands
}

type FilterColumns = { readonly status: 'loading' } | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly values: readonly string[] }
type FilterEditorProps = Pick<Props, 'commands' | 't'> & {
  readonly columns: FilterColumns
  readonly reloadColumns: () => void
  readonly disabled: boolean
  readonly applied: CsvExactFilter | undefined
  readonly onApply: (filter: CsvExactFilter | undefined) => void
}

function CsvAnalysisFilter({ columns, reloadColumns, disabled, applied, onApply, commands, t }: FilterEditorProps) {
  const [column, setColumn] = useState('')
  const [options, setOptions] = useState<ArtifactBranchCsvFilterOptionsValue>()
  const [loading, setLoading] = useState(false)
  const [choice, setChoice] = useState('')
  const [custom, setCustom] = useState('')
  const generation = useRef(0)

  const chooseColumn = async (next: string): Promise<void> => {
    const request = ++generation.current
    setColumn(next)
    setOptions(undefined)
    setChoice('')
    setCustom('')
    setLoading(next !== '')
    if (next === '') return
    try {
      const result = await commands.filterOptions(next)
      if (request === generation.current) setOptions(result)
    } catch (_error) {
      if (request === generation.current) setChoice('custom')
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }

  if (columns.status === 'loading') return null
  if (columns.status === 'failed') return <div className={css.csvAnalysisFailure}>
    <p role="alert">{t('csvAnalysis.columnsFailed')}</p>
    <Button size="sm" variant="outline" onClick={reloadColumns}>{t('csvAnalysis.retry')}</Button>
  </div>

  const value = choice === 'custom' ? custom : choice === '' ? undefined : options?.values[Number(choice)]
  return <form className={css.csvFilter} onSubmit={(event) => {
    event.preventDefault()
    if (column !== '' && value !== undefined && !disabled) onApply({ column, value })
  }}>
    <label className={css.csvAnalysisSelect}>
      <span>{t('csvAnalysis.filterColumn')}</span>
      <select data-csv-filter-column value={column} disabled={disabled}
        onChange={(event) => { void chooseColumn(event.currentTarget.value) }}>
        <option value="">{t('csvAnalysis.chooseColumn')}</option>
        {columns.values.map(name => <option key={name} value={name}>{csvGroupLabel(name, t)}</option>)}
      </select>
    </label>
    {column !== '' && <label className={css.csvAnalysisSelect}>
      <span>{t('csvAnalysis.filterValue')}</span>
      <select data-csv-filter-value value={choice} disabled={disabled || loading}
        onChange={(event) => { setChoice(event.currentTarget.value) }}>
        <option value="">{t(loading ? 'csvAnalysis.loadingValues' : 'csvAnalysis.chooseValue')}</option>
        {options?.values.map((entry, index) => <option key={entry} value={String(index)}>{csvGroupLabel(entry, t)}</option>)}
        <option value="custom">{t('csvAnalysis.customValue')}</option>
      </select>
    </label>}
    {choice === 'custom' && column !== '' && <label className={css.csvAnalysisSelect}>
      <span>{t('csvAnalysis.customValue')}</span>
      <textarea data-csv-filter-custom-value rows={2} value={custom} disabled={disabled}
        onChange={(event) => { setCustom(event.currentTarget.value) }} />
    </label>}
    {column !== '' && <Button size="sm" variant="outline" type="submit" data-csv-filter-apply disabled={disabled || value === undefined}>
      {t('csvAnalysis.applyFilter')}
    </Button>}
    {applied !== undefined && <Button size="sm" variant="ghost" type="button" data-csv-filter-clear disabled={disabled}
      onClick={() => { void chooseColumn(''); onApply(undefined) }}>{t('csvAnalysis.clearFilter')}</Button>}
  </form>
}

function CsvAnalysisPanel({ source, groupKey, commands, t, columns, reloadColumns }: Props & Pick<FilterEditorProps, 'columns' | 'reloadColumns'>) {
  const [preview, setPreview] = useState<Preview>({ aggregate: source.aggregate, spec: source, baseline: source, filter: undefined, phase: 'ready' })
  const [selectedGroup, selectGroup] = useState(groupKey)
  const [locking, setLocking] = useState(false)
  const generation = useRef(0)
  const unfilteredCache = useRef(new Map<CsvAggregate, CsvBarChartSpec>([[source.aggregate, source]]))

  const recalculate = async (aggregate: CsvAggregate, filter: CsvExactFilter | undefined): Promise<void> => {
    const request = ++generation.current
    setPreview(current => ({ ...current, aggregate, filter, phase: 'loading' }))
    const unfiltered = async (): Promise<CsvBarChartSpec> => {
      const saved = unfilteredCache.current.get(aggregate)
      if (saved !== undefined) return saved
      const spec = await commands.recalculate(aggregate)
      unfilteredCache.current.set(aggregate, spec)
      return spec
    }
    try {
      const baselineTask = unfiltered()
      const filteredTask = filter === undefined ? baselineTask : commands.recalculate(aggregate, filter)
      const [spec, sameAggregate] = await Promise.all([filteredTask, baselineTask])
      if (request === generation.current) {
        selectGroup(current => spec.groups.some(group => group.key === current) ? current : spec.groups[0]?.key ?? current)
        setPreview({ aggregate, spec, baseline: filter === undefined ? source : sameAggregate, filter, phase: 'ready' })
      }
    } catch (_error) {
      if (request === generation.current) setPreview(current => ({ ...current, phase: 'failed' }))
    }
  }

  const lock = async (key: string): Promise<boolean> => {
    setLocking(true)
    try {
      const { aggregate, filter } = preview.spec
      return await (filter === undefined ? commands.lock(aggregate, key) : commands.lock(aggregate, key, filter))
    } finally { setLocking(false) }
  }

  const hasSelection = preview.spec.groups.some(group => group.key === selectedGroup)
  const ready = preview.phase === 'ready'
  const changed = preview.spec.aggregate !== source.aggregate || preview.spec.filter !== undefined
  const previewKey = JSON.stringify([preview.spec.aggregate, preview.spec.filter])
  const aggregates: readonly CsvAggregate[] = source.valueColumn === undefined ? ['count'] : CSV_AGGREGATES
  return <div className={css.csvAnalysis} data-csv-analysis>
    <label className={css.csvAnalysisSelect}>
      <span>{t('csvAnalysis.aggregate')}</span>
      <select data-csv-analysis-aggregate value={preview.aggregate} disabled={locking || aggregates.length === 1}
        onChange={(event) => {
          const aggregate = CSV_AGGREGATES.find(value => value === event.target.value)
          if (aggregate !== undefined) void recalculate(aggregate, preview.filter)
        }}>
        {aggregates.map(aggregate => <option key={aggregate} value={aggregate}>{t(`csvChart.aggregate.${aggregate}`)}</option>)}
      </select>
    </label>
    <CsvAnalysisFilter columns={columns} reloadColumns={reloadColumns} commands={commands} disabled={locking} applied={preview.filter}
      onApply={(filter) => { void recalculate(preview.aggregate, filter) }} t={t} />
    {preview.phase === 'loading' && <p role="status">{t('csvAnalysis.calculating')}</p>}
    {preview.phase === 'failed' && <div className={css.csvAnalysisFailure}>
      <p role="alert">{t('csvAnalysis.failed')}</p>
      <Button size="sm" variant="outline" onClick={() => { void recalculate(preview.aggregate, preview.filter) }}>{t('csvAnalysis.retry')}</Button>
    </div>}
    <CsvBarChartView key={previewKey} spec={preview.spec} selectedGroupKey={selectedGroup} onSelectGroup={selectGroup}
      baseline={preview.baseline} onAttachCsvQuestion={ready && changed ? lock : undefined} t={t} />
    {ready && hasSelection && <CsvParticipatingRows key={JSON.stringify([previewKey, selectedGroup])}
      filterColumn={preview.spec.filter?.column} valueColumn={source.valueColumn}
      loadRows={offset => commands.participatingRows(preview.spec, selectedGroup, offset)} t={t} />}
  </div>
}

/** Open a comparison inside the existing immutable returned evidence card. */
export function CsvAnalysisContinuation(props: Props) {
  const [open, setOpen] = useState(false)
  const [columns, setColumns] = useState<FilterColumns>({ status: 'loading' })
  const id = useId()
  const loadColumns = (): void => {
    setColumns({ status: 'loading' })
    void props.commands.filterOptions().then(({ columns: values }) => { setColumns({ status: 'ready', values }) },
      () => { setColumns({ status: 'failed' }) })
  }
  return <>
    <Button size="sm" variant="outline" data-csv-continue-analysis aria-expanded={open} aria-controls={id}
      onClick={() => { setOpen(!open); if (!open) loadColumns() }}>{props.t('csvAnalysis.open')}</Button>
    {open && <section id={id} aria-label={props.t('csvAnalysis.open')}>
      <CsvAnalysisPanel {...props} columns={columns} reloadColumns={loadColumns} />
    </section>}
  </>
}
