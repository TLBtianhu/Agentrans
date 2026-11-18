import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@agentrans/client-ui-slots'
import { Button } from '@agentrans/client-ui-primitives'
import type { BranchResultActionInjected } from './BranchResultAction.tsx'
import css from './BranchResultAction.module.css'

type InquiryBranchPathProps = PropsRuntime<'conversation.chat.assistant.details'>
  & InjectFace<Pick<BranchResultActionInjected, 'openSession'>>
  & PropsLocale<'branch'>
  & PropsRenderSlots<'conversation.chat.inquiry.actions'>

/** Link each passage to the actual branch created from this answer. */
export function InquiryBranchPath({
  sessionId, seq, messageId, useSessions, openSession, openView, renderSlot, t,
}: InquiryBranchPathProps) {
  const branches = useSessions(state => Object.values(state.byId).filter(branch => (
    branch.parentId === sessionId && branch.inquiry?.messageSeq === seq && branch.inquiry.messageId === messageId
  )), (left, right) => left.length === right.length && left.every((branch, index) => branch === right[index]))
  if (branches.length === 0) return null
  return (
    <nav className={css.root} aria-label={t('inquiry.paths')}>
      {branches.map(branch => (
        <div key={branch.id} className={css.inquiryPath}>
          <q>{branch.inquiry?.excerpt}</q>
          <Button size="sm" variant="ghost" data-inquiry-branch={branch.id} onClick={() => { openSession(branch.id) }}>
            {t('inquiry.open')}
          </Button>
          {renderSlot('conversation.chat.inquiry.actions', {
            branchSessionId: branch.id, ...(openView === undefined ? {} : { openView }),
          })}
        </div>
      ))}
    </nav>
  )
}
