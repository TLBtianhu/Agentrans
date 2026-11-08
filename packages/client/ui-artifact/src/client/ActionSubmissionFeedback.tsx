/** Review and recovery for one captured Artifact input, independent of the current preview. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ArtifactActionSubmissionState } from './action-submission.ts'
import type { ArtifactActionFailure } from './protocol.ts'
import css from './ArtifactNodeView.module.css'

interface Props {
  readonly state: ArtifactActionSubmissionState
  readonly sentText?: string
  readonly available: boolean
  readonly retry: () => void
  readonly dismiss: () => void
  readonly t: PropsLocale<'artifact'>['t']
}
const FAILURE_COPY = {
  invalid: 'actionSubmission.invalid', denied: 'actionSubmission.denied', stale: 'actionSubmission.stale',
  'source-unavailable': 'actionSubmission.sourceUnavailable', 'too-large': 'actionSubmission.tooLarge',
  conflict: 'actionSubmission.conflict', unavailable: 'actionSubmission.unavailable', unknown: 'actionSubmission.unknown',
} as const satisfies Record<ArtifactActionFailure, string>

/** @param props - The captured operation and explicit recovery callbacks. @returns Visible outcome with original request disclosure. */
export function ActionSubmissionFeedback({ state, available, retry, dismiss, t, sentText }: Props) {
  if (state.phase === 'idle') return null
  if (state.phase === 'sent') return <p role="status">{sentText ?? t('actionSubmission.sent')}</p>
  return <section className={css.observations} data-artifact-action-submission={state.phase}>
    <p role={state.phase === 'sending' ? 'status' : 'alert'} className={state.phase === 'sending' ? undefined : css.error}>
      {t(state.phase === 'sending' ? 'send.sending' : FAILURE_COPY[state.failure])}
    </p>
    {state.phase === 'unknown' && state.failure !== 'unknown' && <p>{t('actionSubmission.retained')}</p>}
    <details><summary>{t('actionSubmission.original')}</summary>
      <pre className={css.source}>{JSON.stringify(state.request, null, 2)}</pre>
    </details>
    {state.phase !== 'sending' && <div className={css.observationToolbar}>
      {state.phase === 'unknown' && <Button size="sm" variant="outline" disabled={!available} onClick={retry}>
        {t('actionSubmission.retry')}
      </Button>}
      <Button size="sm" variant="ghost" onClick={dismiss}>{t('actionSubmission.dismiss')}</Button>
    </div>}
  </section>
}
