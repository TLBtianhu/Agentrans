/** Read-only rendering of a recorded experiment source and conditions. */
import { useId, useMemo, useState } from 'react'
import { Button } from '@agentrans/client-ui-primitives'
import type { PropsLocale } from '@agentrans/client-ui-slots'
import { ParticleRuntimeError, restoreParticleCheckpoint } from '@agentrans/artifact/particle-runtime'
import type { ParticleSystemSpec } from '@agentrans/artifact/scene'
import type { SceneArtifactSnapshot } from '@agentrans/artifact/types'
import { ArtifactRuntimePreview } from './ArtifactRuntimePreview.tsx'
import { CsvParticipatingRows, type CsvRowsLoader } from './CsvParticipatingRows.tsx'
import { CsvQuestionComparison, type ChooseCsvComparison, type CsvComparisonLoader } from './CsvQuestionComparison.tsx'
import type { ParticleRun } from './particle-run.ts'
import type { ArtifactQuestionReplayState } from './question-context-text.ts'
import css from './QuestionContextMessage.module.css'

interface ReplayProps {
  readonly snapshot: SceneArtifactSnapshot
  readonly replay: ArtifactQuestionReplayState
  readonly readCsvRows?: CsvRowsLoader | undefined
  readonly loadCsvComparison?: CsvComparisonLoader | undefined
  readonly chooseCsvComparison?: ChooseCsvComparison | undefined
  readonly t: PropsLocale<'artifact'>['t']
}

/** The exact draft or saved comparison that opened a returned CSV replay. */
export interface CsvReplayReturn {
  readonly kind: 'draft' | 'comparison'
  readonly open: () => void
}

function restoreParticleRun(spec: ParticleSystemSpec, replay: Extract<ArtifactQuestionReplayState, { kind: 'particle-system' }>): ParticleRun | null {
  try {
    const state = restoreParticleCheckpoint(spec, replay.checkpoint)
    if (state.time !== replay.values.time || state.particles.length !== replay.values.particles.length
      || !state.particles.every((particle, index) => {
        const reading = replay.values.particles[index]
        return reading !== undefined && particle.id === reading.id && particle.x === reading.x && particle.y === reading.y
          && particle.vx === reading.vx && particle.vy === reading.vy
      })) return null
    return { state, playing: false, failed: false }
  } catch (error) {
    if (!(error instanceof ParticleRuntimeError)) throw error
    return null
  }
}

/**
 * @param props - Validated historical source, selected conditions, and locale seat.
 * @returns A paused native preview independent of the current Artifact runtime.
 */
export function ArtifactQuestionReplay({ snapshot, replay, readCsvRows, loadCsvComparison, chooseCsvComparison, t }: ReplayProps) {
  const { spec: sourceSpec, artifactId, revision, title } = snapshot
  const gravityY = replay.kind === 'particle-system' ? replay.gravityY : undefined
  const spec = useMemo(() => sourceSpec.kind === 'particle-system' && gravityY !== undefined
    ? { ...sourceSpec, gravity: { ...sourceSpec.gravity, y: gravityY } } : sourceSpec, [sourceSpec, gravityY])
  const particleRun = useMemo(() => spec.kind === 'particle-system' && replay.kind === 'particle-system'
    ? restoreParticleRun(spec, replay) : null, [spec, replay])
  const failedText = t('runtime.failed')
  if (spec.kind !== replay.kind || (replay.kind === 'particle-system' && particleRun === null)) {
    return <p role="alert">{failedText}</p>
  }

  return <div data-artifact-question-replay-revision={revision} data-artifact-question-replay-id={artifactId}>
    <ArtifactRuntimePreview snapshot={snapshot} title={title} failedText={failedText}
      native={{ spec, artifactId, revision, placement: 'inline', particleRun,
        replayPlot: replay.kind === 'function-plot' ? replay : undefined,
        replayCsvGroupKey: replay.kind === 'csv-bar-chart' ? replay.group.key : undefined, particleGravityY: gravityY,
        onParticleCommand: () => {}, recordAction: () => Promise.resolve(), readOnly: true, canRecord: false, t }} />
    {spec.kind === 'csv-bar-chart' && readCsvRows !== undefined && <div className={css.replayAction}>
      <CsvParticipatingRows filterColumn={spec.filter?.column} valueColumn={spec.valueColumn} loadRows={readCsvRows} t={t} />
    </div>}
    {spec.kind === 'csv-bar-chart' && loadCsvComparison !== undefined && <div className={css.replayAction}>
      <CsvQuestionComparison loadPage={loadCsvComparison} onAttach={chooseCsvComparison} t={t} />
    </div>}
  </div>
}

/**
 * Open and close a recorded experiment without mounting its renderer while closed.
 * @param props - Recorded source, replay conditions, and locale seat.
 * @returns A keyboard-accessible disclosure and a read-only experiment preview.
 */
export function ArtifactReplayDisclosure({
  snapshot, replay, readCsvRows, loadCsvComparison, chooseCsvComparison, messageControl, returnToOrigin, t,
}: ReplayProps & { readonly messageControl?: string | undefined; readonly returnToOrigin?: CsvReplayReturn | undefined }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  return <>
    <div className={css.replayAction}>
      <Button size="sm" variant="outline" aria-expanded={open} aria-controls={panelId}
        data-artifact-question-replay-toggle data-chat-message-control={messageControl} onClick={() => { setOpen(value => !value) }}>
        {t('questionContext.replay')}
      </Button>
    </div>
    <div id={panelId} hidden={!open} className={css.replayPanel} data-artifact-question-replay-panel>
      {open && <>
        {returnToOrigin !== undefined && <div className={css.replayAction}>
          <Button size="sm" variant="outline" data-csv-return-to-comparison={returnToOrigin.kind === 'comparison' || undefined}
            data-csv-return-to-draft={returnToOrigin.kind === 'draft' || undefined} onClick={returnToOrigin.open}>
            {t(returnToOrigin.kind === 'draft' ? 'csvCompare.returnToDraft' : 'csvCompare.returnToComparison')}
          </Button>
        </div>}
        <ArtifactQuestionReplay snapshot={snapshot} replay={replay} t={t}
          readCsvRows={readCsvRows} loadCsvComparison={loadCsvComparison} chooseCsvComparison={chooseCsvComparison} />
      </>}
    </div>
  </>
}
