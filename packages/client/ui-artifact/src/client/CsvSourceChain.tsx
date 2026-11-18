/** On-demand preview of the historical questions that contributed a comparison. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Modal } from '@agentrans/client-ui-primitives'
import type { PropsLocale } from '@agentrans/client-ui-slots'
import type { CsvSentQuestion } from './csv-comparison-draft.ts'
import type { CsvComparisonSourceChain } from './csv-comparison-source-chain.ts'
import css from './CsvQuestionComparison.module.css'

type OpenQuestion = (sources: readonly CsvSentQuestion[]) => void

export interface CsvSourceChainOptions {
  readonly load: (signal: AbortSignal) => Promise<CsvComparisonSourceChain>
  readonly questionLabel: (target: CsvSentQuestion) => string | undefined
  readonly captureOpen: () => OpenQuestion
}

interface Preview {
  readonly loading: boolean
  readonly open: OpenQuestion
  readonly chain?: CsvComparisonSourceChain
}

const unavailable: CsvComparisonSourceChain = { sources: [], status: 'unavailable' }

/** Preview the chain without navigating until the user chooses a question. */
export function CsvSourceChain({ captureOpen, load, questionLabel, t }: CsvSourceChainOptions & PropsLocale<'artifact'>) {
  const [preview, setPreview] = useState<Preview>()
  const activeLoad = useRef<AbortController>()
  const retryButton = useRef<HTMLButtonElement>(null)
  const firstQuestion = useRef<HTMLButtonElement>(null)
  const chainStatus = useRef<HTMLDivElement>(null)
  const focusResult = useRef(false)
  useEffect(() => () => { activeLoad.current?.abort() }, [])
  useLayoutEffect(() => {
    if (!focusResult.current) return
    focusResult.current = false
    const next = firstQuestion.current ?? chainStatus.current
    next?.focus()
  }, [preview])

  const title = t('csvCompare.fullSourceChain')
  const read = (open: OpenQuestion, previous?: CsvComparisonSourceChain): void => {
    activeLoad.current?.abort()
    const controller = new AbortController()
    activeLoad.current = controller
    setPreview({ loading: true, open, ...(previous === undefined ? {} : { chain: previous }) })
    void load(controller.signal).then(
      (chain) => {
        if (controller.signal.aborted) return
        focusResult.current = chain.status !== 'unavailable' && retryButton.current?.matches(':focus') === true
        setPreview({ loading: false, open, chain })
      },
      () => {
        if (!controller.signal.aborted) setPreview({ loading: false, open, chain: unavailable })
      },
    )
  }

  const close = (): void => {
    activeLoad.current?.abort()
    setPreview(undefined)
  }
  const sources = preview?.chain?.sources ?? []
  const mayRetry = preview?.chain?.status === 'unavailable'
  const invalid = preview?.chain?.status === 'invalid' ? preview.chain : undefined

  return <>
    <Button size="sm" variant="ghost" className={css.toggle} aria-haspopup="dialog"
      data-csv-view-full-source-chain onClick={() => { read(captureOpen()) }}>{t('csvCompare.viewFullSourceChain')}</Button>
    <Modal open={preview !== undefined} title={title} onClose={close} closeLabel={t('dock.close', { title })}
      className={css.sourceChainDialog ?? ''} contentClassName={css.sourceChainContent ?? ''}>
      {preview !== undefined && <div className={css.sourceChainContentItems}>
        <div ref={chainStatus} role="status" tabIndex={invalid === undefined ? undefined : -1} className={css.sourceChainStatus}
          data-csv-source-chain-status={preview.loading ? 'loading' : invalid !== undefined ? 'invalid'
            : mayRetry && sources.length > 0 ? 'incomplete' : undefined}
          data-csv-source-chain-level={invalid?.level}>
          {preview.loading ? t('csvCompare.fullSourceChainLoading')
            : invalid !== undefined ? t('csvCompare.fullSourceChainInvalid', { level: String(invalid.level) })
              : mayRetry && sources.length > 0 ? t('csvCompare.fullSourceChainIncomplete') : ''}
        </div>
        {!preview.loading && mayRetry && sources.length === 0 && <p role="alert" className={css.sourceChainStatus}
          data-csv-source-chain-status="unavailable">{t('csvCompare.fullSourceChainUnavailable')}</p>}
        {mayRetry && <Button ref={retryButton} size="sm" variant="outline" aria-disabled={preview.loading}
          onClick={() => { if (!preview.loading) read(preview.open, preview.chain) }}>{t('csvAnalysis.retry')}</Button>}
        {sources.length > 0 && <ol role="list" className={css.sourceChainList} data-csv-full-source-chain>
          {sources.map((target, index) => <li key={target.messageId} data-csv-source-chain-stop
            data-csv-source-event-seq={target.eventSeq} data-csv-source-message-id={target.messageId}>
            <Button ref={index === 0 ? firstQuestion : undefined} variant="ghost" className={css.sourceChainQuestion} onClick={() => {
              const visited = sources.slice(0, index + 1)
              close()
              preview.open(visited)
            }}>{questionLabel(target) ?? t('csvCompare.sourceTrailQuestion', { sequence: String(target.eventSeq) })}</Button>
          </li>)}
        </ol>}
      </div>}
    </Modal>
  </>
}
