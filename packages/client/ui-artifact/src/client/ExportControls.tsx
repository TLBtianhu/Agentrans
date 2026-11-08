/** Fixed-input generation requests and projected, verifiable HTML results. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ArtifactExportSource } from '@deepseek-ai/dsh-artifact/types'
import type {
  ArtifactExportId, ArtifactHtmlExportFailure, ArtifactHtmlExportRecord, ArtifactHtmlExportRequest,
} from '@deepseek-ai/dsh-artifact-export/types'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { ArtifactExportRequestError, type ArtifactExportCommands, type ArtifactExportRequestFailure } from './protocol.ts'
import css from './ArtifactNodeView.module.css'

/** Plain projected records and commands supplied by the Session-owning renderer. */
export interface ExportControlsData extends ArtifactExportCommands {
  readonly ready: boolean
  readonly records: readonly ArtifactHtmlExportRecord[]
  readonly canCreate?: boolean | undefined
  readonly canRead?: boolean | undefined
}

interface CapturedExport {
  readonly request: ArtifactHtmlExportRequest
  readonly preview: ArtifactExportSource
}

type ExportFailure = ArtifactExportRequestFailure | ArtifactHtmlExportFailure | 'download'
interface ExportState {
  readonly pending: CapturedExport | null
  readonly phase: 'idle' | 'creating' | 'downloading'
  readonly failure: ExportFailure | null
  readonly notice: 'requested' | 'saved' | 'cancelled' | null
}

/** Card-owned request identity survives source and placement changes; lists remain projection-owned. */
export interface ExportActions {
  readonly state: ExportState
  readonly begin: (source: ArtifactExportSource) => Promise<void>
  readonly retry: () => Promise<void>
  readonly dismiss: () => void
  readonly continue: (record: ArtifactHtmlExportRecord) => Promise<void>
  readonly download: (record: ArtifactHtmlExportRecord & { readonly status: 'ready' }) => Promise<void>
}

/**
 * Keep a captured export request while its result is unknown, independently of live runtime state.
 * @param commands - Projected export records and Session-scoped operations, when available.
 * @returns Local operation status and explicit generation or download commands.
 */
export function useExportActions(commands: ExportControlsData | undefined): ExportActions {
  const [state, setState] = useState<ExportState>({ pending: null, phase: 'idle', failure: null, notice: null })
  const busy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const transfer = async (record: ArtifactHtmlExportRecord & { readonly status: 'ready' }): Promise<void> => {
    if (commands === undefined) return
    if (commands.canRead === false) {
      setState({ pending: null, phase: 'idle', failure: null, notice: null })
      return
    }
    setState(previous => ({ ...previous, pending: null, phase: 'downloading', failure: null, notice: null }))
    try {
      const result = await commands.download(record)
      if (mounted.current) setState(previous => ({ ...previous, phase: 'idle', notice: result.status }))
    } catch {
      if (mounted.current) setState(previous => ({ ...previous, phase: 'idle', failure: 'download' }))
    }
  }
  const submit = async (captured: CapturedExport, previouslyUnknown = false): Promise<void> => {
    if (commands === undefined || !commands.ready || commands.canCreate === false || busy.current) return
    busy.current = true
    setState({ pending: captured, phase: 'creating', failure: null, notice: null })
    try {
      const record = await commands.create(captured.request)
      if (!mounted.current) return
      if (record.status === 'ready') await transfer(record)
      else setState({ pending: record.status === 'pending' ? captured : null, phase: 'idle',
        failure: record.status === 'pending' ? 'unknown' : record.failure, notice: null })
    } catch (error) {
      const failure = error instanceof ArtifactExportRequestError ? error.failure : 'unknown'
      if (mounted.current) setState({ pending: failure === 'unknown' || previouslyUnknown && failure !== 'conflict' ? captured : null,
        phase: 'idle', failure, notice: null })
    } finally { busy.current = false }
  }
  return {
    state,
    begin: async (source) => {
      if (state.pending !== null) return
      await submit({
        request: { exportId: randomUUID() as ArtifactExportId, format: 'html', source: source.observationId === undefined
          ? { kind: 'current', artifactId: source.artifact.artifactId, revision: source.artifact.revision,
            ...(source.checkpoint === undefined ? {} : { checkpoint: source.checkpoint }) }
          : { kind: 'observation', artifactId: source.artifact.artifactId, observationId: source.observationId } },
        preview: source,
      })
    },
    retry: async () => { if (state.pending !== null) await submit(state.pending, true) },
    dismiss: () => { if (!busy.current) setState({ pending: null, phase: 'idle', failure: null, notice: null }) },
    continue: async (record) => { if (state.pending === null) await submit({ request: record.request, preview: record.frozen }, true) },
    download: async (record) => {
      if (busy.current || state.pending !== null) return
      busy.current = true
      try { await transfer(record) } finally { busy.current = false }
    },
  }
}

/**
 * Describe exactly the source defaults or fixed particle step represented by one export.
 * @param source - Original source and optional runtime checkpoint.
 * @param t - Locale-owned Artifact copy.
 * @returns Human-readable fixed source and runtime conditions.
 */
export function exportConditions(source: ArtifactExportSource, t: PropsLocale<'artifact'>['t']): string {
  return source.checkpoint === undefined
    ? t('export.defaults', { revision: String(source.artifact.revision) })
    : t('export.checkpoint', { revision: String(source.artifact.revision), step: String(source.checkpoint.stepCount),
      runtime: String(source.checkpoint.runtimeVersion) })
}

const FAILURE_COPY = {
  unknown: 'export.unknown', limit: 'export.limit', 'source-unavailable': 'export.sourceUnavailable',
  conflict: 'export.conflict', 'service-unavailable': 'export.serviceUnavailable', download: 'export.downloadFailed',
  denied: 'export.denied', invalid: 'export.invalid',
  'input-too-large': 'export.inputTooLarge',
  RENDER_FAILED: 'export.renderFailed', OUTPUT_TOO_LARGE: 'export.tooLarge', STORAGE_FAILED: 'export.storageFailed',
} as const

/** Render durable generation history separately from browser or native save outcomes. */
export function ExportControls({ ready, records, canCreate = true, canRead = true, source, actions, t, hostOperationsAvailable = true }: Pick<ExportControlsData, 'ready' | 'records' | 'canCreate' | 'canRead'> & {
  readonly hostOperationsAvailable?: boolean
  readonly source: ArtifactExportSource | undefined
  readonly actions: ExportActions
  readonly t: PropsLocale<'artifact'>['t']
}) {
  const { state } = actions
  const busy = state.phase !== 'idle'
  return <section className={css.observations} aria-label={t('export.list')}>
    {source !== undefined && <p className={css.observationHint}>{exportConditions(source, t)}</p>}
    {source !== undefined && source.checkpoint === undefined && <p className={css.observationHint}>{t('export.defaultHint')}</p>}
    {hostOperationsAvailable && !ready && <p role="status" className={css.observationHint}>{t('export.loading')}</p>}
    {state.pending !== null && <div className={css.exportRequest} data-export-request={state.pending.request.exportId}>
      <strong>{state.pending.preview.artifact.title}</strong>
      <span>{exportConditions(state.pending.preview, t)}</span>
      <code>{state.pending.request.exportId}</code>
      <details><summary>{t('export.source')}</summary>
        <pre className={css.source}>{JSON.stringify(state.pending.preview.artifact.spec, null, 2)}</pre>
      </details>
      {state.failure !== null && state.failure !== 'unknown' && <span>{t('export.retained')}</span>}
      {state.phase === 'idle' && <div className={css.observationToolbar}>
        {hostOperationsAvailable && canCreate && <Button size="sm" variant="outline" onClick={() => { void actions.retry() }}>{t('export.retry')}</Button>}
        <Button size="sm" variant="ghost" onClick={actions.dismiss}>{t('export.dismiss')}</Button>
      </div>}
    </div>}
    {state.phase !== 'idle' && <p role="status">{t(state.phase === 'creating' ? 'export.creating' : 'export.downloading')}</p>}
    {state.failure !== null && <p role="alert" className={css.error}>{t(FAILURE_COPY[state.failure])}</p>}
    {hostOperationsAvailable && !canCreate && <p className={css.observationHint}>{t('export.denied')}</p>}
    {state.notice !== null && <p role="status" className={css.observationHint}>
      {t(state.notice === 'requested' ? 'export.requested' : state.notice === 'saved' ? 'export.saved' : 'export.cancelled')}
    </p>}
    {records.length > 0 && <ul className={css.observationList}>
      {records.map(record => <li key={record.request.exportId} data-export-id={record.request.exportId} data-export-status={record.status}>
        <div className={css.observationDescription}>
          <strong>{record.frozen.artifact.title}</strong>
          <span>{exportConditions(record.frozen, t)}</span>
          <code>{record.request.exportId}</code>
          <span>{t('export.engine', { version: String(record.frozen.exporterVersion) })}</span>
          <details>
            <summary>{t('export.source')}</summary>
            <pre className={css.source}>{JSON.stringify(record.frozen.artifact.spec, null, 2)}</pre>
          </details>
          {record.status === 'ready' ? <>
            <span>{t('export.ready', { bytes: String(record.file.bytes) })}</span>
            <code>{record.file.attachmentId}</code>
          </> : record.status === 'failed'
            ? <span>{t(FAILURE_COPY[record.failure])}</span>
            : <span>{t('export.pending')}</span>}
        </div>
        {record.status === 'ready' && hostOperationsAvailable && canRead && <Button size="sm" variant="outline" disabled={busy || state.pending !== null}
          onClick={() => { void actions.download(record) }}>{t('export.download')}</Button>}
        {record.status === 'pending' && hostOperationsAvailable && canCreate && <Button size="sm" variant="outline" disabled={busy || state.pending !== null}
          onClick={() => { void actions.continue(record) }}>{t('export.continue')}</Button>}
      </li>)}
    </ul>}
  </section>
}
