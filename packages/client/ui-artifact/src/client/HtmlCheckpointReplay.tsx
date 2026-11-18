/** User-opened restoration of an immutable checkpoint in a separate sandbox. */
import { useCallback, useId, useRef, useState } from 'react'
import { Button } from '@agentrans/client-ui-primitives'
import type { HtmlArtifactSnapshot } from '@agentrans/artifact/types'
import type { ArtifactHtmlCheckpoint } from '@agentrans/artifact/runtime-values'
import type { PropsLocale } from '@agentrans/client-ui-slots'
import { ArtifactRuntimePreview } from './ArtifactRuntimePreview.tsx'
import { copyHtmlCheckpoint, htmlCheckpointLabels, HtmlCheckpointReview, type HtmlCheckpointReadings } from './HtmlCheckpointReadings.tsx'
import css from './QuestionContextMessage.module.css'

/**
 * Mount a fresh historical preview only after the user opens its disclosure.
 * @param props - Source lookup, locked program report, accessible title, and locale seat.
 * @returns A disclosure that can reopen the recorded step independently of the current experiment.
 */
export function HtmlCheckpointReplay({ resolveSource, state, title, attach, messageControl, t }: {
  readonly resolveSource: () => HtmlArtifactSnapshot | undefined | Promise<HtmlArtifactSnapshot | undefined>
  readonly state: HtmlCheckpointReadings
  readonly title: string
  readonly attach?: ((state: ArtifactHtmlCheckpoint) => boolean) | undefined
  readonly messageControl?: string | undefined
} & PropsLocale<'artifact'>) {
  const panelId = useId()
  const [opened, setOpened] = useState<HtmlArtifactSnapshot | 'loading' | 'unavailable' | null>(null)
  const loading = useRef(false)
  const labels = htmlCheckpointLabels(state.kind)
  const expanded = opened !== null && opened !== 'unavailable' && opened !== 'loading'
  const toggle = async (): Promise<void> => {
    if (loading.current) return
    if (expanded) { setOpened(null); return }
    try {
      const source = resolveSource()
      if (source instanceof Promise) {
        loading.current = true
        setOpened('loading')
        setOpened(await source ?? 'unavailable')
      } else setOpened(source ?? 'unavailable')
    } catch (_error) { setOpened('unavailable') } finally { loading.current = false }
  }
  return <>
    <div className={css.replayAction}>
      <Button size="sm" variant="outline" aria-controls={panelId} aria-expanded={expanded} disabled={opened === 'loading'}
        data-chat-message-control={messageControl}
        {...{ [`data-artifact-${labels.name}-replay-toggle`]: '' }} onClick={() => { void toggle() }}>{t(labels.reopen)}</Button>
    </div>
    {opened === 'unavailable' && <p role="alert">{t('bfs.sourceUnavailable')}</p>}
    {opened === 'loading' && <p role="status">{t(labels.restoring)}</p>}
    <div id={panelId} hidden={!expanded} className={css.replayPanel} {...{ [`data-artifact-${labels.name}-replay`]: '' }}>
      {expanded && <RestoredExperiment snapshot={opened} state={state} title={title} attach={attach} t={t} />}
    </div>
  </>
}

function RestoredExperiment({ snapshot, state, title, attach, t }: {
  readonly snapshot: HtmlArtifactSnapshot
} & Pick<Parameters<typeof HtmlCheckpointReplay>[0], 'state' | 'title' | 'attach' | 't'>) {
  const [initial] = useState(() => copyHtmlCheckpoint(state))
  const [latest, setLatest] = useState<ArtifactHtmlCheckpoint | null>(null)
  const [review, setReview] = useState<ArtifactHtmlCheckpoint | null>(null)
  const labels = htmlCheckpointLabels(initial.kind)
  const onCheckpoint = useCallback((checkpoint: ArtifactHtmlCheckpoint | null): void => {
    setLatest(checkpoint)
    if (checkpoint === null) setReview(null)
  }, [])
  return <>
    <ArtifactRuntimePreview snapshot={snapshot} title={title} failedText={t(labels.failed)}
      restoration={{ state: initial, pendingText: t(labels.restoring), restoredText: t('bfs.restored'),
        ...(attach === undefined ? {} : { onCheckpoint }) }} />
    {attach !== undefined && latest !== null && <Button size="sm" variant="outline" {...{ [`data-artifact-${labels.name}-followup`]: '' }}
      aria-expanded={review !== null} onClick={() => {
        setReview(copyHtmlCheckpoint(latest))
      }}>{t(labels.review)}</Button>}
    {attach !== undefined && review !== null && <HtmlCheckpointReview state={review} attach={attach}
      close={() => { setReview(null) }} t={t} />}
  </>
}
