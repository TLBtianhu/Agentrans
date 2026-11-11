/** Artifact Conversation plugin, browser registrations only. */
import z from '@agentrans/schemastery'
import { artifactHostRouteAvailable } from './artifact-route.ts'
import { ArtifactRuntimeOwner } from './runtime-owner.ts'
import type { Context as ClientContext } from '@agentrans/cordis'
import type {} from '@agentrans/api-remotes/client'
import type { ChatNode } from '@agentrans/client-ui-chat/client'
import type {} from '@agentrans/client-locale/client'
import type {} from '@agentrans/client-ui-renderer/client'
import type {} from '@agentrans/client-ui-workspace/client'
import type {} from '@agentrans/client-ui-file-actions/client'
import type { SessionBinding } from '@agentrans/api-session-controller/client'
import type { ObservableSnapshot } from '@agentrans/client-store'
import type { ArtifactSnapshot } from '@agentrans/artifact/types'
import type { ParticleRunCommand } from './particle-run.ts'
import { ArtifactInteractionOwner, particleRuntimeIdentity } from './particle-runtime-owner.ts'
import { ArtifactPromptContext, type ArtifactPromptContextInjected } from './ArtifactPromptContext.tsx'
import type { SessionId } from '@agentrans/session/types'
import { programContextTextRule, questionContextTextRule } from './question-context-text.ts'
import { ProgramContextMessage, QuestionContextMessage } from './QuestionContextMessage.tsx'
import { ArtifactNodeView } from './ArtifactNodeView.tsx'
import { ArtifactComparisonNodeView } from './ArtifactComparisonNodeView.tsx'
import { ArtifactBranchResultAction, type ArtifactBranchResultInjected } from './ArtifactBranchResultAction.tsx'
import { artifactComparisonDefinition } from './comparison-definition.ts'
import { artifactDefinition } from './definition.ts'
import { en, ja, es, fr, de, ru, pt, zh, type ArtifactKey } from './locales.ts'
import { artifactPresentationStore } from './presentation.ts'
import {
  ArtifactActionRequestError, confirmArtifactObservationComparison, recordArtifactAction, returnArtifactBranchResult,
  saveArtifactObservation, sendArtifactObservation, type ArtifactNodeInjected,
  createArtifactExport, downloadArtifactExport,
} from './protocol.ts'

export type { ArtifactKey } from './locales.ts'
export type { ArtifactId, ArtifactComparisonSnapshot, ArtifactNodeInjected, ArtifactPayload, ArtifactSnapshot, RecordArtifactAction } from './protocol.ts'

declare module '@agentrans/client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Artifact card and action confirmation copy. */
    artifact: ArtifactKey
  }
}

const NS = 'artifact'

/** Required Slot, Remote, locale, and Conversation services. */
export const inject = ['slots', 'remote', 'remote.artifacts', 'remote.artifactExports', 'remote.artifactRuntime', 'fileActions', 'locale', 'uiConversation', 'conversation', 'sessions']

/** Maximum wait for an authored program to acknowledge an actual command. */
export interface Config {
  /** Maximum wait for each program command acknowledgement, in milliseconds. */
  runtimeCommandTimeoutMs?: number
}
/** Validated Client runtime command budget. */
export const Config: z<Config, Required<Config>> = z.object({ runtimeCommandTimeoutMs: z.natural().min(1).default(10_000) })

/**
 * Register Artifact dictionaries, the whole-checkpoint Definition, and its keyed Chat renderer.
 * @param ctx - client root context.
 * @param config - Runtime command acknowledgement budget.
 */
export function apply(ctx: ClientContext, config: Config = {}): void {
  const policy = Config(config)
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-artifact: dictionaries')
  ctx.effect(() => ctx.uiConversation.userText.register(questionContextTextRule), 'ui-artifact: question context text')
  ctx.effect(() => ctx.uiConversation.userText.register(programContextTextRule), 'ui-artifact: program report text')
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'artifact-question-context', priority: 100, locale: NS,
  }, QuestionContextMessage))
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'artifact-program-context', priority: 100, locale: NS,
  }, ProgramContextMessage))
  ctx.effect(() => ctx.uiConversation.events.register(artifactDefinition), 'ui-artifact: conversation definition')
  ctx.effect(() => ctx.uiConversation.events.register(artifactComparisonDefinition), 'ui-artifact: comparison definition')
  const interactions = new WeakMap<SessionBinding, ArtifactInteractionOwner>()
  const runtimes = new WeakMap<SessionBinding, ArtifactRuntimeOwner>()
  const runtimeFor = (sessionId: SessionId): ArtifactRuntimeOwner => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error('Artifact runtime requires a live Session binding')
    const existing = runtimes.get(binding)
    if (existing !== undefined) return existing
    const owner = new ArtifactRuntimeOwner(
      (identity, signal) => ctx.remote.artifactRuntime.attach(sessionId, identity, signal), policy.runtimeCommandTimeoutMs,
    )
    runtimes.set(binding, owner)
    ctx.effect(() => binding.ctx.effect(() => () => { owner.dispose() }, 'ui-artifact: report leases'), 'ui-artifact: runtime reports')
    return owner
  }
  const t = ctx.locale.bind(NS)
  const interactionFor = (sessionId: SessionId): ArtifactInteractionOwner => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error(t('promptContext.unavailableSend'))
    const existing = interactions.get(binding)
    if (existing !== undefined) return existing
    const chat = ctx.uiConversation.binding(binding).target('chat')
    const owner = new ArtifactInteractionOwner((key): ObservableSnapshot<ArtifactSnapshot | undefined> => {
      const [nodeKey, artifactId] = particleRuntimeIdentity(key)
      const nodes = chat.getSnapshot()?.nodes
      if (nodes === undefined) throw new Error(t('promptContext.unavailableSend'))
      const source = nodes.source(nodeKey)
      return {
        getSnapshot: () => {
          const node = source.getSnapshot() as ChatNode | undefined
          if (node?.kind === 'artifact') return node.data.artifactId === artifactId ? node.data : undefined
          if (node?.kind === 'artifact-comparison') {
            return [node.data.control, node.data.variant].find(artifact => artifact?.artifactId === artifactId)
          }
          return undefined
        },
        subscribe: listener => source.subscribe(listener),
      }
    }, { sessionId, runtimeFor: key => runtimeFor(sessionId).source(key) })
    interactions.set(binding, owner)
    ctx.effect(() => binding.ctx.effect(() => () => { owner.dispose() }, 'ui-artifact: Session runtime'), 'ui-artifact: runtime and question context')
    return owner
  }
  const requireHostRoute = (sessionId: SessionId): void => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new ArtifactActionRequestError('unavailable', new Error(t('promptContext.unavailableSend')))
    if (!artifactHostRouteAvailable(binding.session.getSnapshot())) {
      throw new ArtifactActionRequestError('denied', new Error(t('route.subagentLocalOnly')))
    }
  }
  const questionInteractionFor = (sessionId: SessionId): ArtifactInteractionOwner | undefined => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error(t('promptContext.unavailableSend'))
    if (!artifactHostRouteAvailable(binding.session.getSnapshot())) return undefined
    return interactionFor(sessionId)
  }
  const runtimeCommands = (sessionId: SessionId): Pick<ArtifactNodeInjected,
    'keyedHooks' | 'runtimeActions' | 'commandParticleRuntime' | 'chooseRuntimePromptContext' | 'chooseParticlePromptContext' | 'chooseObservationPromptContext' | 'chooseComparisonPromptContext'> => ({
    keyedHooks: { particleRuntime: key => interactionFor(sessionId).runtime(key),
      artifactRuntime: key => runtimeFor(sessionId).source(key) },
    runtimeActions: runtimeFor(sessionId).actions,
    commandParticleRuntime: (key: string, command: ParticleRunCommand) => { interactionFor(sessionId).command(key, command) },
    chooseRuntimePromptContext: (key, source, identity) => { questionInteractionFor(sessionId)?.chooseHtmlRuntime(key, source, identity) },
    chooseParticlePromptContext: (key, source) => { questionInteractionFor(sessionId)?.chooseCurrent(key, source) },
    chooseObservationPromptContext: (saved) => { questionInteractionFor(sessionId)?.chooseObservation(saved) },
    chooseComparisonPromptContext: (group, control, variant) => {
      questionInteractionFor(sessionId)?.chooseComparison(group, control, variant)
    },
  })
  ctx.effect(() => ctx.conversation.registerPromptContext('artifact', (sessionId) => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) return undefined
    const owner = interactions.get(binding)
    if (owner === undefined) return undefined
    if (!artifactHostRouteAvailable(binding.session.getSnapshot()) && owner.selection.getSnapshot() !== null) {
      throw new Error(t('promptContext.subagentUnsupported'))
    }
    return owner.capture(t('promptContext.unavailableSend'))
  }), 'ui-artifact: prompt context capture')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'artifact-question-context', order: 5, locale: NS,
    inject: (sessionId: SessionId): ArtifactPromptContextInjected => ({
      hooks: { artifactPromptContext: interactionFor(sessionId).selection },
      clearArtifactPromptContext: () => { interactionFor(sessionId).clear() },
    }),
  }, ArtifactPromptContext))
  ctx.inject(['remote.artifactBranchResults', 'uiWorkspace'], (scope: ClientContext) => {
    scope.slots.inject('conversation.chat.assistant.details', () => scope.slots.register({
      name: 'conversation.chat.assistant.details',
      id: 'artifact-branch-result',
      locale: NS,
      inject: (): ArtifactBranchResultInjected => ({
        returnResult: request => returnArtifactBranchResult(scope, request),
        openSession: (sessionId) => { scope.uiWorkspace.openSession(sessionId) },
      }),
    }, ArtifactBranchResultAction))
  })
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'artifact',
    locale: NS,
    store: artifactPresentationStore,
    inject: (sessionId: SessionId): ArtifactNodeInjected => ({
      ...runtimeCommands(sessionId),
      exports: { create: async (request) => { requireHostRoute(sessionId); return createArtifactExport(ctx, sessionId, request) },
        download: async (record) => { requireHostRoute(sessionId); return downloadArtifactExport(ctx, sessionId, record) } },
      recordAction: async (artifactId, revision, action, payload, wake, requestId) => {
        requireHostRoute(sessionId)
        return recordArtifactAction(ctx, sessionId, artifactId, revision, action, payload, wake, requestId)
      },
      saveObservation: async (artifactId, revision, observationId, label, checkpoint) => {
        requireHostRoute(sessionId)
        return saveArtifactObservation(ctx, sessionId, artifactId, revision, observationId, label, checkpoint)
      },
      sendObservation: async (artifactId, observationId, wake) => {
        requireHostRoute(sessionId)
        return sendArtifactObservation(ctx, sessionId, artifactId, observationId, wake)
      },
      confirmObservationComparison: async (group, control, variant, wake) => {
        requireHostRoute(sessionId)
        return confirmArtifactObservationComparison(ctx, sessionId, group, control, variant, wake)
      },
    }),
  }, ArtifactNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'artifact-comparison',
    locale: NS,
    inject: (sessionId: SessionId): ArtifactNodeInjected => ({
      ...runtimeCommands(sessionId),
      exports: { create: async (request) => { requireHostRoute(sessionId); return createArtifactExport(ctx, sessionId, request) },
        download: async (record) => { requireHostRoute(sessionId); return downloadArtifactExport(ctx, sessionId, record) } },
      recordAction: async (artifactId, revision, action, payload, wake, requestId) => {
        requireHostRoute(sessionId)
        return recordArtifactAction(ctx, sessionId, artifactId, revision, action, payload, wake, requestId)
      },
      saveObservation: async (artifactId, revision, observationId, label, checkpoint) => {
        requireHostRoute(sessionId)
        return saveArtifactObservation(ctx, sessionId, artifactId, revision, observationId, label, checkpoint)
      },
      sendObservation: async (artifactId, observationId, wake) => {
        requireHostRoute(sessionId)
        return sendArtifactObservation(ctx, sessionId, artifactId, observationId, wake)
      },
      confirmObservationComparison: async (group, control, variant, wake) => {
        requireHostRoute(sessionId)
        return confirmArtifactObservationComparison(ctx, sessionId, group, control, variant, wake)
      },
    }),
  }, ArtifactComparisonNodeView))
}
