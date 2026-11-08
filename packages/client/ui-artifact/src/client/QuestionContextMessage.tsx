/** Compact experiment text presentation; raw copying and admission stay with their existing owners. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './question-context-text.ts'
import css from './QuestionContextMessage.module.css'

/** Show source conditions with an explicit original-text disclosure, without asserting verification. */
export function QuestionContextMessage({ node, raw, t }:
  PropsRuntime<'conversation.user.text.node', 'artifact-question-context'> & PropsLocale<'artifact'>) {
  const data = node.data
  const label = data.variantRevision === undefined
    ? t('questionContext.single', { title: data.title, revision: String(data.revision), step: String(data.stepCount) })
    : t('questionContext.pair', { control: data.title, variant: data.variantTitle ?? '', controlRevision: String(data.revision),
      variantRevision: String(data.variantRevision), step: String(data.stepCount) })
  return <details className={css.context} data-artifact-question-context>
    <summary>{label}</summary>
    <span className={css.label}>{t('questionContext.original')}</span>
    <pre className={css.raw} data-artifact-question-context-raw>{raw}</pre>
  </details>
}

/** Present program-reported state or error as unverified text, retaining the complete original contribution. */
export function ProgramContextMessage({ node, raw, t }:
  PropsRuntime<'conversation.user.text.node', 'artifact-program-context'> & PropsLocale<'artifact'>) {
  const label = t(node.data.status === 'ready' ? 'questionContext.programReady' : 'questionContext.programError', {
    title: node.data.title, revision: String(node.data.revision),
  })
  return <details className={css.context} data-artifact-program-context>
    <summary>{label}</summary>
    <span className={css.label}>{t('questionContext.programOriginal')}</span>
    <pre className={css.raw} data-artifact-question-context-raw>{raw}</pre>
  </details>
}
