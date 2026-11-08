/** Test-only framework source binding for pure card and node tests. */
import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore, type ComponentProps } from 'react'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ArtifactSnapshot } from '@deepseek-ai/dsh-artifact/types'
import { ArtifactCard as RealCard, ArtifactNodeView as RealNode } from '../src/client/ArtifactNodeView.tsx'
import { ArtifactComparisonNodeView as RealComparison } from '../src/client/ArtifactComparisonNodeView.tsx'
import { ArtifactRuntimeOwner, type ArtifactRuntimeSnapshot, type ArtifactRuntimeActions } from '../src/client/runtime-owner.ts'
import { runtimeChannel } from './runtime-channel.client.ts'
import {
  ArtifactInteractionOwner, ArtifactParticleSource, particleRuntimeIdentity, type ArtifactParticleRuntime,
} from '../src/client/particle-runtime-owner.ts'

type CardProps = ComponentProps<typeof RealCard>
type RuntimeProps = 'useArtifactRuntime' | 'runtimeActions' | 'useParticleRuntime' | 'commandParticleRuntime' | 'chooseParticlePromptContext'
  | 'chooseRuntimePromptContext' | 'chooseObservationPromptContext' | 'chooseComparisonPromptContext'
type NodeProps = Omit<ComponentProps<typeof RealNode>, RuntimeProps>
type ComparisonProps = Omit<ComponentProps<typeof RealComparison>, RuntimeProps> & { readonly runtimeCommand?: ArtifactRuntimeActions['command'] }

/** Bind the same canonical calculation used in production, without a second React reducer. */
export function ArtifactCard(props: CardProps) {
  const source = useMemo(() => createSnapshotStore<ArtifactSnapshot | undefined>(props.snapshot), [props.snapshot.artifactId])
  const runtime = useMemo(() => new ArtifactParticleSource(source), [source])
  useLayoutEffect(() => { source.set(props.snapshot) }, [source, props.snapshot])
  useEffect(() => () => { runtime.dispose() }, [runtime])
  const current = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot)
  const command = useMemo(() => runtime.command.bind(runtime), [runtime])
  return <RealCard {...props} particleRuntime={{ current, command }} />
}

function runtimeProps(
  source: ObservableSnapshot<readonly ArtifactSnapshot[]>, sessionId: SessionId,
): Pick<ComponentProps<typeof RealNode>, RuntimeProps> {
  const reports = new ArtifactRuntimeOwner(() => runtimeChannel(), 1000)
  const owner = new ArtifactInteractionOwner((key) => {
    const [, id] = particleRuntimeIdentity(key)
    return { getSnapshot: () => source.getSnapshot().find(artifact => artifact.artifactId === id),
      subscribe: listener => source.subscribe(listener) }
  }, { sessionId, runtimeFor: key => reports.source(key) })
  function useRuntime(key: string): ArtifactParticleRuntime | undefined
  function useRuntime<Selected>(key: string, selector: (value: ArtifactParticleRuntime | undefined) => Selected): Selected
  function useRuntime<Selected>(
    key: string, selector?: (value: ArtifactParticleRuntime | undefined) => Selected,
  ): Selected | ArtifactParticleRuntime | undefined {
    const runtime = owner.runtime(key)
    const value = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot)
    return selector === undefined ? value : selector(value)
  }
  function useReport(key: string): ArtifactRuntimeSnapshot | undefined
  function useReport<Selected>(key: string, selector: (value: ArtifactRuntimeSnapshot | undefined) => Selected): Selected
  function useReport<Selected>(
    key: string, selector?: (value: ArtifactRuntimeSnapshot | undefined) => Selected,
  ): Selected | ArtifactRuntimeSnapshot | undefined {
    const source = reports.source(key)
    const value = useSyncExternalStore(listener => source.subscribe(listener), () => source.getSnapshot())
    return selector === undefined ? value : selector(value)
  }
  return {
    useArtifactRuntime: useReport,
    runtimeActions: reports.actions,
    useParticleRuntime: useRuntime,
    commandParticleRuntime: (key, command) => { owner.command(key, command) },
    chooseRuntimePromptContext: (key, artifact, identity) => { owner.chooseHtmlRuntime(key, artifact, identity) },
    chooseParticlePromptContext: (key, artifact) => { owner.chooseCurrent(key, artifact) },
    chooseObservationPromptContext: (saved) => { owner.chooseObservation(saved) },
    chooseComparisonPromptContext: (group, control, variant) => { owner.chooseComparison(group, control, variant) },
  }
}

/** Supply framework-bound runtime props to the real standalone node. */
export function ArtifactNodeView(props: NodeProps) {
  const source = useMemo(() => createSnapshotStore<readonly ArtifactSnapshot[]>([props.node.data]), [props.sessionId])
  const bound = useMemo(() => runtimeProps(source, props.sessionId), [source, props.sessionId])
  useLayoutEffect(() => { source.set([props.node.data]) }, [source, props.node.data])
  return <RealNode {...props} {...bound} />
}

/** Supply framework-bound runtime props to the real comparison node. */
export function ArtifactComparisonNodeView(props: ComparisonProps) {
  const sources = (): readonly ArtifactSnapshot[] => [props.node.data.control, props.node.data.variant]
    .filter((source): source is ArtifactSnapshot => source !== undefined)
  const source = useMemo(() => createSnapshotStore(sources()), [props.sessionId])
  const bound = useMemo(() => runtimeProps(source, props.sessionId), [source, props.sessionId])
  useLayoutEffect(() => { source.set(sources()) }, [source, props.node.data])
  return <RealComparison {...props} {...bound} runtimeActions={props.runtimeCommand === undefined ? bound.runtimeActions
    : { ...bound.runtimeActions, command: props.runtimeCommand }} />
}
