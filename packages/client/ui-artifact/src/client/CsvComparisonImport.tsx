import { useEffect, useRef, useState } from 'react'
import type { ArtifactCsvComparisonPage, ArtifactCsvComparisonReturnCards } from '@agentrans/artifact-followup/types'
import { Button } from '@agentrans/client-ui-primitives'
import type { PropsLocale } from '@agentrans/client-ui-slots'
import type { CsvComparisonExplanation } from './csv-comparison-explanation.ts'
import { CsvComparisonReviewContents } from './CsvQuestionComparison.tsx'
import rowsCss from './BranchEvidenceMessage.module.css'
import css from './CsvQuestionComparison.module.css'

const CSV_COMPARISON_FILE_LIMIT = 64 * 1024

interface ImportReview {
  readonly page: ArtifactCsvComparisonPage
  readonly explanation?: CsvComparisonExplanation | undefined
  readonly returnCards?: ArtifactCsvComparisonReturnCards | undefined
  readonly replacesContext: boolean
  readonly confirm: () => Promise<boolean>
}

export type LoadCsvComparisonImport = (json: string, signal: AbortSignal) => Promise<ImportReview>

const importErrors = {
  invalid: 'csvCompare.importInvalid', 'too-large': 'csvCompare.importTooLarge',
  'prompt-limit': 'csvCompare.importPromptLimit', failed: 'csvCompare.importFailed',
} as const
type ImportError = keyof typeof importErrors

type ImportState = { readonly kind: 'idle' | 'loading' | ImportError }
  | { readonly kind: 'review'; readonly review: ImportReview; readonly status?: 'saving' | 'failed' }

function importFailure(error: unknown): ImportError {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'artifact-branch/csv-comparison-import-invalid'
    || !('details' in error) || typeof error.details !== 'object' || error.details === null || !('reason' in error.details)) return 'failed'
  if (error.details.reason === 'SNAPSHOT_TOO_LARGE') return 'too-large'
  if (error.details.reason === 'PROMPT_LIMIT') return 'prompt-limit'
  return 'invalid'
}

/** Open a user-selected portable snapshot as a review in the current composer. */
export function CsvComparisonImport({ load, disabled, t }: PropsLocale<'artifact'> & {
  readonly load: LoadCsvComparisonImport
  readonly disabled: boolean
}) {
  const [state, setState] = useState<ImportState>({ kind: 'idle' })
  const input = useRef<HTMLInputElement>(null)
  const picker = useRef<HTMLButtonElement>(null)
  const pending = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => { pending.current?.abort() }, [])
  const active = (request: AbortController): boolean => pending.current === request && !request.signal.aborted

  const choose = async (file: File): Promise<void> => {
    pending.current?.abort()
    if (file.size > CSV_COMPARISON_FILE_LIMIT) { setState({ kind: 'too-large' }); return }
    const request = new AbortController()
    pending.current = request
    setState({ kind: 'loading' })
    try {
      const bytes = await file.arrayBuffer()
      if (!active(request)) return
      let json: string
      try { json = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
        setState({ kind: 'invalid' })
        return
      }
      const review = await load(json, request.signal)
      if (active(request)) setState({ kind: 'review', review })
    } catch (error) {
      if (active(request)) setState({ kind: importFailure(error) })
    }
  }

  const confirm = async (): Promise<void> => {
    const request = pending.current
    if (disabled || state.kind !== 'review' || state.status === 'saving' || request === undefined || !active(request)) return
    const { review } = state
    setState({ kind: 'review', review, status: 'saving' })
    try {
      const accepted = await review.confirm()
      if (active(request)) setState(accepted ? { kind: 'idle' } : { kind: 'review', review, status: 'failed' })
    } catch {
      if (active(request)) setState({ kind: 'review', review, status: 'failed' })
    }
  }

  const busy = state.kind === 'loading' || state.kind === 'review' && state.status === 'saving'
  return <div className={rowsCss.csvParticipants}>
    <Button ref={picker} size="sm" variant="ghost" className={css.toggle} data-csv-import-comparison
      disabled={disabled || busy} onClick={() => { input.current?.click() }}>{t('csvCompare.import')}</Button>
    <input ref={input} type="file" accept=".json,application/json" hidden disabled={disabled || busy}
      data-csv-import-comparison-input onChange={(event) => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (file !== undefined && !disabled && !busy) void choose(file)
      }} />
    {state.kind === 'loading' && <p role="status">{t('csvCompare.importLoading')}</p>}
    {state.kind !== 'idle' && state.kind !== 'loading' && state.kind !== 'review'
      && <p role="alert">{t(importErrors[state.kind])}</p>}
    {state.kind === 'review' && <section className={`${css.panel} ${css.review}`} data-csv-import-review aria-label={t('csvCompare.review')}>
      <CsvComparisonReviewContents page={state.review.page} explanation={state.review.explanation}
        returnCards={state.review.returnCards} replacesContext={state.review.replacesContext} userImported t={t} />
      <div className={rowsCss.csvAnalysisFailure}>
        <Button size="sm" variant="primary" data-csv-compare-confirm autoFocus disabled={disabled || busy}
          aria-busy={busy} onClick={() => { void confirm() }}>{t('csvCompare.confirm')}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
          pending.current?.abort()
          setState({ kind: 'idle' })
          picker.current?.focus()
        }}>{t('promptContext.cancelReadings')}</Button>
      </div>
      {state.status === 'failed' && <p role="alert">{t('csvCompare.attachFailed')}</p>}
    </section>}
  </div>
}
