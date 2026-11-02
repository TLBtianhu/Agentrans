import { useRef, useState } from 'react'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './BranchResultAction.module.css'

type ReturnRequest = Parameters<ISessions['returnBranchResult']>[0]

/** Narrow operations supplied by the plugin's apply world. */
export interface BranchResultActionInjected {
  readonly returnBranchResult: (request: ReturnRequest) => ReturnType<ISessions['returnBranchResult']>
  readonly openSession: (sessionId: SessionId) => void
}

/** Full props of one assistant-detail branch-result entry. */
export type BranchResultActionProps = PropsRuntime<'conversation.chat.assistant.details'>
  & InjectFace<BranchResultActionInjected>
  & PropsLocale<'branch'>

type Phase = 'idle' | 'preview' | 'pending' | 'error'

/** Inline explicit confirmation for one durable assistant conclusion. */
export function BranchResultAction({
  sessionId, seq, text, useSessions, useAccess, returnBranchResult, openSession, t,
}: BranchResultActionProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const inFlight = useRef(false)
  const allowed = useAccess('session/returnBranchResult')
  const parentId = useSessions((state) => {
    const current = state.byId[sessionId]
    if (current?.origin === 'subagent' || current?.parentId === undefined) return undefined
    const parent = state.byId[current.parentId]
    return parent?.origin === 'subagent' ? undefined : parent?.id
  })
  if (!allowed || parentId === undefined || text.trim() === '') return null

  const confirm = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setPhase('pending')
    try {
      await returnBranchResult({ sessionId: parentId, branchSessionId: sessionId, resultSeq: seq })
      setPhase('idle')
      openSession(parentId)
    } catch (_error: unknown) {
      setPhase('error')
    } finally {
      inFlight.current = false
    }
  }

  if (phase === 'idle') {
    return (
      <div className={css.root}>
        <Button size="sm" variant="ghost" onClick={() => { setPhase('preview') }}>
          {t('result.return')}
        </Button>
      </div>
    )
  }
  const pending = phase === 'pending'
  return (
    <div className={css.root} aria-busy={pending || undefined}>
      <span>{t('result.preview')}</span>
      <div className={css.preview}>
        <p className={css.previewText}>{text}</p>
        {phase === 'error' && <p className={css.error} role="alert">{t('result.failed')}</p>}
        <div className={css.actions}>
          <Button size="sm" variant="primary" disabled={pending} onClick={() => { void confirm() }}>
            {t(phase === 'error' ? 'result.retry' : 'result.confirm')}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setPhase('idle') }}>
            {t('result.cancel')}
          </Button>
        </div>
      </div>
    </div>
  )
}
