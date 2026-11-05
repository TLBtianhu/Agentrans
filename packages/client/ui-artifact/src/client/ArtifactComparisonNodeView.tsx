/** Independent control/variant Artifacts with synchronized commands and one confirmed comparison result. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ArtifactCard, type SceneOrigin } from './ArtifactNodeView.tsx'
import { parseArtifactState } from './messages.ts'
import type {
  ArtifactCommand, ArtifactCommandMessage, ArtifactNodeInjected,
} from './protocol.ts'
import css from './ArtifactNodeView.module.css'

type ArtifactComparisonNodeViewProps =
  PropsRuntime<'conversation.chat.node', 'artifact-comparison'>
  & PropsLocale<'artifact'>
  & InjectFace<ArtifactNodeInjected>

type Role = 'control' | 'variant'
type Phase = 'idle' | 'sending' | 'sent' | 'failed'

/** Render one comparison group without merging the two Artifact parameter states. */
export function ArtifactComparisonNodeView({ node, sessionId, useSessions, recordAction, t }: ArtifactComparisonNodeViewProps) {
  const comparison = node.data
  const origin = useSessions((state): SceneOrigin => {
    const current = state.byId[sessionId]
    if (current?.parentId === undefined) return { kind: 'current' }
    const parent = state.byId[current.parentId]
    return { kind: 'branch', title: parent?.displayTitle ?? current.parentId }
  })
  const controlRef = useRef<HTMLIFrameElement | null>(null)
  const variantRef = useRef<HTMLIFrameElement | null>(null)
  const [states, setStates] = useState<Partial<Record<Role, JsonValue>>>({})
  const [phase, setPhase] = useState<Phase>('idle')

  const onControlFrame = useCallback((frame: HTMLIFrameElement | null) => { controlRef.current = frame }, [])
  const onVariantFrame = useCallback((frame: HTMLIFrameElement | null) => { variantRef.current = frame }, [])
  // A native SceneSpec has no iframe contentWindow, so it reports through the
  // same local channel as the iframe's artifact-state message.
  const onControlState = useCallback((state: JsonValue) => {
    setStates(previous => ({ ...previous, control: state }))
  }, [])
  const onVariantState = useCallback((state: JsonValue) => {
    setStates(previous => ({ ...previous, variant: state }))
  }, [])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const role: Role | undefined = event.source === controlRef.current?.contentWindow ? 'control'
        : event.source === variantRef.current?.contentWindow ? 'variant' : undefined
      if (role === undefined) return
      const message = parseArtifactState(event.data)
      if (message === null) return
      setStates(previous => ({ ...previous, [role]: message.state }))
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [])

  const command = (name: ArtifactCommand): void => {
    const message: ArtifactCommandMessage = { kind: 'artifact-command', command: name }
    for (const frame of [controlRef.current, variantRef.current]) {
      frame?.contentWindow?.postMessage(message, '*')
    }
  }

  const ready = comparison.control !== undefined && comparison.variant !== undefined
    && states.control !== undefined && states.variant !== undefined
  const compare = async (): Promise<void> => {
    const controlState = states.control
    const variantState = states.variant
    const control = comparison.control
    const variant = comparison.variant
    if (!ready || phase === 'sending' || control === undefined || variant === undefined || controlState === undefined || variantState === undefined) return
    setPhase('sending')
    try {
      await recordAction(control.artifactId, control.revision, 'comparison.completed', {
        group: comparison.group,
        control: { artifactId: control.artifactId, revision: control.revision, state: controlState },
        variant: { artifactId: variant.artifactId, revision: variant.revision, state: variantState },
      }, true)
      setPhase('sent')
    } catch {
      setPhase('failed')
    }
  }

  return (
    <section className={css.comparison} data-comparison-group={comparison.group}
      role="group" aria-label={t('comparison.title', { group: comparison.group })}>
      <header className={css.comparisonHeader}>
        <div className={css.heading}>
          <h3 className={css.title}>{t('comparison.title', { group: comparison.group })}</h3>
          <span className={css.origin}>{origin.kind === 'current' ? t('origin.current') : t('origin.branch', { parent: origin.title })}</span>
        </div>
        <div className={css.controls}>
          <Button size="sm" variant="outline" onClick={() => { command('play') }}>{t('comparison.play')}</Button>
          <Button size="sm" variant="outline" onClick={() => { command('pause') }}>{t('comparison.pause')}</Button>
          <Button size="sm" variant="outline" onClick={() => { command('step') }}>{t('comparison.step')}</Button>
          <Button size="sm" variant="outline" onClick={() => { command('reset') }}>{t('comparison.reset')}</Button>
          <Button size="sm" variant="primary" disabled={!ready || phase === 'sending'}
            aria-busy={phase === 'sending'} onClick={() => { void compare() }}>
            {phase === 'sending' ? t('comparison.sending') : phase === 'failed' ? t('comparison.retry') : t('comparison.send')}
          </Button>
        </div>
      </header>
      <div className={css.comparisonGrid}>
        {comparison.control === undefined
          ? <div className={css.placeholder}>{t('comparison.waiting')}</div>
          : <ArtifactCard snapshot={comparison.control} origin={origin} recordAction={recordAction} t={t}
            placement="inline" placementControls={false} onSceneState={onControlState} onFrame={onControlFrame} />}
        {comparison.variant === undefined
          ? <div className={css.placeholder}>{t('comparison.waiting')}</div>
          : <ArtifactCard snapshot={comparison.variant} origin={origin} recordAction={recordAction} t={t}
            placement="inline" placementControls={false} onSceneState={onVariantState} onFrame={onVariantFrame} />}
      </div>
      {!ready && <p className={css.comparisonStatus}>{t('comparison.waiting')}</p>}
      {phase === 'sent' && <p className={css.comparisonStatus}>{t('comparison.sent')}</p>}
    </section>
  )
}
