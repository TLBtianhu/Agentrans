/** Read-only source revisions in the loaded conversation window. */
import { memo, useMemo, useState } from 'react'
import type { PropsLocale } from '@agentrans/client-ui-slots'
import { Button } from '@agentrans/client-ui-primitives'
import { createParticleCheckpoint, restoreParticleCheckpoint } from '@agentrans/artifact/particle-runtime'
import { ArtifactRuntimePreview } from './ArtifactRuntimePreview.tsx'
import type { ReviewableSceneRevision, SceneRevisionHistory } from './definition.ts'
import { createParticleRun } from './particle-run.ts'
import { ExportControls, useExportActions, type ExportControlsData } from './ExportControls.tsx'
import css from './ArtifactRevisionHistory.module.css'

type Localize = PropsLocale<'artifact'>['t']

interface HistoryControls {
  readonly t: Localize
  readonly exportControls: ExportControlsData | undefined
}

function PreviousScenePreview({ snapshot, t, exportControls }: HistoryControls & { readonly snapshot: ReviewableSceneRevision }) {
  const { spec, particleContinuation } = snapshot
  const particleRun = useMemo(() => {
    if (spec.kind !== 'particle-system') return null
    if (particleContinuation === undefined) return createParticleRun(spec)
    return { state: restoreParticleCheckpoint(spec, particleContinuation.baseline.checkpoint), playing: false, failed: false }
  }, [spec, particleContinuation])
  const exportActions = useExportActions(exportControls)
  const exportSource = particleRun === null ? { artifact: snapshot }
    : { artifact: snapshot, checkpoint: createParticleCheckpoint(particleRun.state) }
  const label = t('revisionHistory.preview', { title: snapshot.title, revision: String(snapshot.revision) })
  return <section className={css.preview} aria-label={label} data-artifact-history-revision={snapshot.revision}>
    <h4>{label}</h4>
    <p>{t('revisionHistory.defaults')}</p>
    <ArtifactRuntimePreview snapshot={snapshot} title={label} failedText={t('runtime.failed')}
      native={{ spec, artifactId: snapshot.artifactId, revision: snapshot.revision, placement: 'inline',
        replayPlot: snapshot.continuation?.baseline,
        particleRun, onParticleCommand: () => {}, recordAction: () => Promise.resolve(), readOnly: true, canRecord: false, t }} />
    {exportControls !== undefined && <>
      {exportControls.canCreate !== false && <Button size="sm" variant="outline"
        disabled={!exportControls.ready || exportActions.state.phase !== 'idle' || exportActions.state.pending !== null}
        onClick={() => { void exportActions.begin(exportSource, 'revision') }}>{t('action.exportRevision')}</Button>}
      <ExportControls {...exportControls}
        records={exportControls.records.filter(record => record.request.source.kind === 'revision' && record.frozen.artifact.revision === snapshot.revision)}
        source={exportSource} actions={exportActions} t={t} />
    </>}
  </section>
}

/** Show the loaded revisions and expose export for the explicitly selected source. */
export const ArtifactRevisionHistory = memo(function ArtifactRevisionHistory({
  history, t, exportControls,
}: HistoryControls & { readonly history: SceneRevisionHistory }) {
  const [open, setOpen] = useState(false)
  const [revision, setRevision] = useState<number | null>(null)
  const choices = useMemo(() => {
    const revisions: ReviewableSceneRevision[] = []
    if (open) {
      for (let entry: SceneRevisionHistory | null = history; entry !== null; entry = entry.earlier) revisions.push(entry.snapshot)
    }
    return revisions
  }, [history, open])
  const selected = choices.find(snapshot => snapshot.revision === revision)
  return <details className={css.history} onToggle={(event) => { setOpen(event.currentTarget.open) }}>
    <summary>{t('revisionHistory.title')}</summary>
    {open && <div className={css.revisions}>
      {choices.map(snapshot => <Button key={snapshot.revision} size="sm" variant="outline" aria-pressed={revision === snapshot.revision}
        onClick={() => { setRevision(previous => previous === snapshot.revision ? null : snapshot.revision) }}>
        {t('revisionHistory.view', { revision: String(snapshot.revision) })}
      </Button>)}
    </div>}
    {selected !== undefined && <PreviousScenePreview key={selected.revision} snapshot={selected} t={t} exportControls={exportControls} />}
  </details>
})
