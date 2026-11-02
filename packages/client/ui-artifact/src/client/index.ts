/** Artifact Conversation plugin, browser registrations only. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ArtifactNodeView } from './ArtifactNodeView.tsx'
import { artifactDefinition } from './definition.ts'
import { en, ja, es, fr, de, ru, pt, zh, type ArtifactKey } from './locales.ts'
import { recordArtifactAction, type ArtifactNodeInjected } from './protocol.ts'

export type { ArtifactKey } from './locales.ts'
export type { ArtifactId, ArtifactNodeInjected, ArtifactPayload, ArtifactSnapshot, RecordArtifactAction } from './protocol.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Artifact card and action confirmation copy. */
    artifact: ArtifactKey
  }
}

const NS = 'artifact'

/** Required Slot, Remote, locale, and Conversation services. */
export const inject = ['slots', 'remote', 'remote.artifacts', 'locale', 'uiConversation']

/**
 * Register Artifact dictionaries, the whole-checkpoint Definition, and its keyed Chat renderer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-artifact: dictionaries')
  ctx.effect(() => ctx.uiConversation.events.register(artifactDefinition), 'ui-artifact: conversation definition')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'artifact',
    locale: NS,
    inject: (sessionId: SessionId): ArtifactNodeInjected => ({
      recordAction: (artifactId, revision, action, payload, wake) => recordArtifactAction(
        ctx, sessionId, artifactId, revision, action, payload, wake,
      ),
    }),
  }, ArtifactNodeView))
}
