/** Visible composer choice for the next ordinary question. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@agentrans/client-ui-slots'
import type { ObservableSnapshot } from '@agentrans/client-store'
import { Button } from '@agentrans/client-ui-primitives'
import type { ArtifactPromptBinding } from './particle-runtime-owner.ts'
import { artifactHostRouteAvailable } from './artifact-route.ts'
import css from './ArtifactNodeView.module.css'

/** Session-local presentation selection and its explicit removal. */
export interface ArtifactPromptContextInjected {
  readonly hooks: { readonly artifactPromptContext: ObservableSnapshot<ArtifactPromptBinding | null> }
  readonly clearArtifactPromptContext: () => void
}

/** Display selected source identity without claiming the model has already received it. */
export function ArtifactPromptContext({ useArtifactPromptContext, useSession, clearArtifactPromptContext, t }:
  PropsRuntime<'conversation.input.dock'> & PropsLocale<'artifact'> & InjectFace<ArtifactPromptContextInjected>) {
  const context = useArtifactPromptContext(value => value)
  const questionContextAvailable = useSession(artifactHostRouteAvailable)
  if (context === null) return null
  const title = context.kind === 'current-particle' || context.kind === 'html-runtime' ? context.title : context.kind === 'observation'
    ? context.observation.title : `${context.control.title} / ${context.variant.title}`
  const description = !questionContextAvailable ? t('promptContext.subagentUnsupported') : context.kind === 'current-particle'
    ? t(context.available ? 'promptContext.live' : 'promptContext.unavailable', { revision: String(context.revision) })
    : context.kind === 'html-runtime' ? t(`promptContext.program.${context.availability}`)
      : context.kind === 'observation'
        ? t('promptContext.saved', { label: context.observation.label, revision: String(context.observation.revision), step: String(context.observation.stepCount) })
        : t('promptContext.comparison', { control: context.control.label, variant: context.variant.label, step: String(context.control.stepCount) })
  return <section className={css.observations} aria-label={t('promptContext.label')} data-artifact-prompt-context={context.kind}>
    <strong>{title}</strong>
    {context.kind === 'html-runtime' && <span>{t('revision', { revision: String(context.identity.revision) })}</span>}
    <p role={!questionContextAvailable || context.kind === 'current-particle' && !context.available
      || context.kind === 'html-runtime' && context.availability !== 'state' && context.availability !== 'error' ? 'alert' : 'status'}>{description}</p>
    <Button size="sm" variant="ghost" onClick={clearArtifactPromptContext}>{t('promptContext.clear')}</Button>
  </section>
}
