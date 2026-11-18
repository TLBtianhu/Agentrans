/** Fields shown before attaching or reopening a program-reported checkpoint. */
import { useState } from 'react'
import type { ArtifactHtmlCheckpoint } from '@agentrans/artifact/runtime-values'
import type { PropsLocale } from '@agentrans/client-ui-slots'
import { Button } from '@agentrans/client-ui-primitives'
import cardCss from './ArtifactNodeView.module.css'
import css from './QuestionContextMessage.module.css'

/** Serializable readings from a program or a historical text node. */
export type HtmlCheckpointReadings = Readonly<Extract<ArtifactHtmlCheckpoint, { kind: 'half-adder-checkpoint' }>>
  | { readonly kind: 'bfs-checkpoint'; readonly current: string | null; readonly queue: readonly string[]; readonly visited: readonly string[] }

/** @param state - Locked or reported checkpoint. @returns A detached copy suitable for review. */
export function copyHtmlCheckpoint(state: HtmlCheckpointReadings): ArtifactHtmlCheckpoint {
  return state.kind === 'bfs-checkpoint' ? { ...state, queue: [...state.queue], visited: [...state.visited] } : { ...state }
}

/** @param kind - Supported checkpoint discriminator. @returns The matching review and restoration labels. */
export function htmlCheckpointLabels(kind: ArtifactHtmlCheckpoint['kind']) {
  return kind === 'bfs-checkpoint'
    ? { name: 'bfs', review: 'bfs.review', reopen: 'bfs.reopen', waiting: 'bfs.waiting', restoring: 'bfs.restoring', failed: 'bfs.restoreFailed' } as const
    : { name: 'half-adder', review: 'halfAdder.review', reopen: 'halfAdder.reopen', waiting: 'halfAdder.waiting',
      restoring: 'halfAdder.restoring', failed: 'halfAdder.restoreFailed' } as const
}

/** @param props - The exact checkpoint fields and locale seat. @returns Localized checkpoint readings. */
export function HtmlCheckpointReadingsView({ state, t }: { readonly state: HtmlCheckpointReadings } & PropsLocale<'artifact'>) {
  if (state.kind === 'half-adder-checkpoint') return <dl className={css.bfsReadings}>
    <div><dt>{t('halfAdder.a')}</dt><dd data-artifact-half-adder-a>{state.a}</dd></div>
    <div><dt>{t('halfAdder.b')}</dt><dd data-artifact-half-adder-b>{state.b}</dd></div>
    <div><dt>{t('halfAdder.sum')}</dt><dd data-artifact-half-adder-sum>{state.sum}</dd></div>
    <div><dt>{t('halfAdder.carry')}</dt><dd data-artifact-half-adder-carry>{state.carry}</dd></div>
  </dl>
  return <dl className={css.bfsReadings}>
    <div><dt>{t('bfs.current')}</dt><dd data-artifact-bfs-current>{state.current ?? '—'}</dd></div>
    <div><dt>{t('bfs.queue')}</dt><dd data-artifact-bfs-queue>{state.queue.length === 0 ? '[]' : state.queue.join(', ')}</dd></div>
    <div><dt>{t('bfs.visited')}</dt><dd data-artifact-bfs-visited>{state.visited.length === 0 ? '[]' : state.visited.join(', ')}</dd></div>
  </dl>
}

/**
 * Show one frozen set of checkpoint fields until the user attaches or discards it.
 * @param props - Reviewed state, selection callbacks and locale seat.
 * @returns The same confirmation surface for a current or restored experiment.
 */
export function HtmlCheckpointReview({ state, attach, close, t }: {
  readonly state: ArtifactHtmlCheckpoint
  readonly attach: (state: ArtifactHtmlCheckpoint) => boolean
  readonly close: () => void
} & PropsLocale<'artifact'>) {
  const [failed, setFailed] = useState(false)
  const { name, review } = htmlCheckpointLabels(state.kind)
  return <section className={cardCss.observations} aria-label={t(review)} {...{ [`data-artifact-${name}-review`]: '' }}>
    <strong>{t(review)}</strong>
    <p>{t('bfs.reported')}</p>
    <HtmlCheckpointReadingsView state={state} t={t} />
    <div className={cardCss.observationToolbar}>
      <Button size="sm" variant="primary" onClick={() => {
        if (attach(state)) close()
        else setFailed(true)
      }}>{t('promptContext.confirmReadings')}</Button>
      <Button size="sm" variant="ghost" onClick={close}>{t('promptContext.cancelReadings')}</Button>
    </div>
    {failed && <p className={cardCss.error} role="alert">{t('promptContext.unavailable')}</p>}
  </section>
}
