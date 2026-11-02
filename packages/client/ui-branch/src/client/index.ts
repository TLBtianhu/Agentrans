/** Browser half of the manual-branch result confirmation plugin. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { BranchResultAction, type BranchResultActionInjected } from './BranchResultAction.tsx'
import { de, en, es, fr, ja, pt, ru, zh, type BranchKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Manual-branch result confirmation copy. */
    branch: BranchKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'branch'

/** Required Session commands, Workspace navigation, Slots, and locale services. */
export const inject = ['slots', 'sessions', 'uiWorkspace', 'locale']

/** Register the assistant-detail confirmation entry and all eight dictionaries. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-branch: dictionaries')
  ctx.slots.inject('conversation.chat.assistant.details', () => ctx.slots.register({
    name: 'conversation.chat.assistant.details',
    id: 'branch-result',
    locale: NS,
    inject: (): BranchResultActionInjected => ({
      returnBranchResult: request => ctx.sessions.returnBranchResult(request),
      openSession: (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
    }),
  }, BranchResultAction))
}
