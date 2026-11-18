/** Download control shared by returned and sent experiment checkpoints. */
import { useRef, useState } from 'react'
import type { FileSaveResult } from '@agentrans/client-ui-file-actions/client'
import { Button } from '@agentrans/client-ui-primitives'
import type { PropsLocale } from '@agentrans/client-ui-slots'
import { HTML_DOWNLOAD_NOTICES } from './ExportControls.tsx'
import css from './QuestionContextMessage.module.css'

/** Save a fixed experiment and announce the outcome on its owning card. */
export function ExperimentDownload({ location, download, t }: {
  readonly location: 'branch' | 'question'
  readonly download: () => Promise<FileSaveResult>
} & PropsLocale<'artifact'>) {
  const [status, setStatus] = useState<keyof typeof HTML_DOWNLOAD_NOTICES | 'failed'>()
  const busy = useRef(false)
  const mark = `data-artifact-${location}-download`
  const statusMark = `${mark}-status`
  const save = async (): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setStatus('downloading')
    try {
      const result = await download()
      setStatus(result.status)
    } catch {
      setStatus('failed')
    } finally { busy.current = false }
  }
  return <div className={css.replayAction}>
    <Button size="sm" variant="outline" {...{ [mark]: true }} disabled={status === 'downloading'}
      aria-busy={status === 'downloading'} onClick={() => { void save() }}>{t('branchEvidence.downloadExperiment')}</Button>
    <div role="status" {...{ [statusMark]: status === 'failed' ? undefined : status }}>
      {status !== undefined && status !== 'failed' && t(HTML_DOWNLOAD_NOTICES[status])}
    </div>
    {status === 'failed' && <div role="alert" {...{ [statusMark]: status }}>{t('branchEvidence.downloadExperimentFailed')}</div>}
  </div>
}
