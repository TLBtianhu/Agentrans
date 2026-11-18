/** Report a source trail that could not be fully restored after refresh. */
import { Button } from '@agentrans/client-ui-primitives'
import type { PropsLocale } from '@agentrans/client-ui-slots'
import type { CsvComparisonSourceRecovery } from './csv-comparison-source-chain.ts'
import rowsCss from './BranchEvidenceMessage.module.css'
import css from './CsvQuestionComparison.module.css'

export function CsvSourceRecoveryNotice({ recovery, retry, t }: PropsLocale<'artifact'> & {
  readonly recovery: CsvComparisonSourceRecovery
  readonly retry?: (() => void) | undefined
}) {
  const pending = recovery.status === 'unavailable' && recovery.pending === true
  const message = recovery.status === 'invalid' ? t('csvCompare.fullSourceChainInvalid', { level: String(recovery.level) })
    : pending ? t('csvCompare.fullSourceChainLoading')
      : recovery.source === undefined ? t('csvCompare.fullSourceChainUnavailable') : t('csvCompare.fullSourceChainIncomplete')
  return <div className={rowsCss.csvAnalysisFailure}>
    <p role="status" className={css.sourceChainStatus} data-csv-source-recovery={recovery.status}
      data-csv-source-recovery-level={recovery.status === 'invalid' ? recovery.level : undefined}>{message}</p>
    {recovery.status === 'unavailable' && retry !== undefined && <Button size="sm" variant="outline"
      data-csv-source-recovery-retry aria-disabled={pending} onClick={() => { if (!pending) retry() }}>
      {t('csvAnalysis.retry')}
    </Button>}
  </div>
}
